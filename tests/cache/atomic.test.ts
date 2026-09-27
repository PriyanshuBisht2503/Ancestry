import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDir, removeWithRetries, writeFileAtomic } from '../../src/cache';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ancestry-atomic-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

/** Every file in `dir` whose name looks like a leftover temporary. */
async function tempResidue(): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.name.includes('.tmp-')).map((entry) => entry.name);
}

describe('ensureDir', () => {
  it('creates a directory and its parents', async () => {
    const nested = path.join(dir, 'a', 'b', 'c');
    await ensureDir(nested);
    expect((await fs.stat(nested)).isDirectory()).toBe(true);
  });

  it('is idempotent for an existing directory', async () => {
    const existing = path.join(dir, 'once');
    await ensureDir(existing);
    await expect(ensureDir(existing)).resolves.toBeUndefined();
  });

  it('rejects a path whose parent is a file', async () => {
    const file = path.join(dir, 'file');
    await fs.writeFile(file, 'x');
    await expect(ensureDir(path.join(file, 'child'))).rejects.toThrow();
  });
});

describe('writeFileAtomic', () => {
  it('creates the file with the exact content', async () => {
    const file = path.join(dir, 'record.json');
    await writeFileAtomic(file, '{"a":1}');
    expect(await fs.readFile(file, 'utf8')).toBe('{"a":1}');
  });

  it('creates missing parent directories', async () => {
    const file = path.join(dir, 'deep', 'nested', 'record.json');
    await writeFileAtomic(file, 'ok');
    expect(await fs.readFile(file, 'utf8')).toBe('ok');
  });

  it('accepts a Buffer', async () => {
    const file = path.join(dir, 'bytes.bin');
    await writeFileAtomic(file, Buffer.from([0, 1, 2, 253, 254, 255]));
    expect([...new Uint8Array(await fs.readFile(file))]).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it('leaves no temporary file behind on success', async () => {
    await writeFileAtomic(path.join(dir, 'a.json'), 'a');
    await writeFileAtomic(path.join(dir, 'b.json'), 'b');
    expect(await tempResidue()).toEqual([]);
  });

  it('overwrites an existing file atomically', async () => {
    const file = path.join(dir, 'record.json');
    await writeFileAtomic(file, 'first');
    await writeFileAtomic(file, 'second');
    expect(await fs.readFile(file, 'utf8')).toBe('second');
    expect(await tempResidue()).toEqual([]);
  });

  it('keeps the old content when the new content cannot be written', async () => {
    const file = path.join(dir, 'record.json');
    await writeFileAtomic(file, 'original');
    // A directory cannot be replaced by a rename, so the final step fails after
    // the temporary file already exists.
    const target = path.join(dir, 'occupied');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'child'), 'keep me');
    await expect(writeFileAtomic(target, 'replacement')).rejects.toThrow();
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(target, 'child'), 'utf8')).toBe('keep me');
    expect(await tempResidue()).toEqual([]);
    // The unrelated file must be untouched by the failed write.
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('serialises concurrent writes to distinct files', async () => {
    const targets = Array.from({ length: 25 }, (_, index) => path.join(dir, `f${index}.json`));
    await Promise.all(targets.map((file, index) => writeFileAtomic(file, `value-${index}`)));
    const contents = await Promise.all(targets.map((file) => fs.readFile(file, 'utf8')));
    expect(contents).toEqual(targets.map((_file, index) => `value-${index}`));
    expect(await tempResidue()).toEqual([]);
  });

  it('serialises concurrent writes to the same file without interleaving', async () => {
    const file = path.join(dir, 'hot.json');
    const payloads = Array.from({ length: 10 }, (_, index) => `${'x'.repeat(2000)}${index}`);
    await Promise.all(payloads.map((payload) => writeFileAtomic(file, payload)));
    const final = await fs.readFile(file, 'utf8');
    expect(payloads).toContain(final);
    expect(await tempResidue()).toEqual([]);
  });
});

describe('removeWithRetries', () => {
  it('removes an existing file', async () => {
    const file = path.join(dir, 'gone.json');
    await fs.writeFile(file, 'x');
    await expect(removeWithRetries(file)).resolves.toBe(true);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('reports success for a file that was never there', async () => {
    await expect(removeWithRetries(path.join(dir, 'absent.json'))).resolves.toBe(true);
  });

  it('does not throw when the target is a directory', async () => {
    const sub = path.join(dir, 'sub');
    await fs.mkdir(sub);
    await expect(removeWithRetries(sub, 2)).resolves.toBe(false);
    expect((await fs.stat(sub)).isDirectory()).toBe(true);
  });

  it('accepts a custom attempt count', async () => {
    await expect(removeWithRetries(path.join(dir, 'nope'), 1)).resolves.toBe(true);
  });
});
