import { describe, expect, it } from 'vitest';
import {
  assertWithinSizeLimit,
  decodeSource,
  isProbablyBinary,
  looksLikeText,
} from '../../src/parser';
import { AncestryError } from '../../src/types';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe('isProbablyBinary', () => {
  it('accepts ordinary source text', () => {
    expect(isProbablyBinary(Buffer.from('export const a = 1;\n', 'utf8'))).toBe(false);
    expect(isProbablyBinary(Buffer.from('', 'utf8'))).toBe(false);
  });

  it('accepts text containing tabs, CRLF and escape bytes', () => {
    const text = 'if (a) {\r\n\tb();\n}\u001b[0m';
    expect(isProbablyBinary(Buffer.from(text, 'utf8'))).toBe(false);
  });

  it('accepts multi-byte UTF-8, including one split by the 8 KiB sample boundary', () => {
    // 4096 two-byte characters is 8192 bytes, so the sample would end in the
    // middle of the final character if the boundary were not handled.
    const text = 'é'.repeat(4096);
    const bytes = Buffer.from(text, 'utf8');
    expect(bytes.length).toBe(8192);
    expect(isProbablyBinary(bytes)).toBe(false);
  });

  it('rejects content containing a NUL byte', () => {
    // A ZIP local-file header: printable magic, then NUL-filled fields.
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    expect(isProbablyBinary(bytes)).toBe(true);
  });

  it('rejects content that is mostly non-printable', () => {
    const bytes = Buffer.alloc(64, 0x01);
    expect(isProbablyBinary(bytes)).toBe(true);
  });

  it('rejects invalid UTF-8 even when every byte is printable', () => {
    // 0x80 is a continuation byte with no lead: decodes to U+FFFD, re-encodes to
    // three bytes, so the round trip fails.
    const bytes = Buffer.from([0x61, 0x80, 0x62, 0x80, 0x63, 0x80]);
    expect(isProbablyBinary(bytes)).toBe(true);
  });

  it('accepts UTF-16 with a byte-order mark', () => {
    const bytes = Buffer.from('const a = 1;', 'utf16le');
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]);
    expect(withBom.includes(0x00)).toBe(true);
    expect(isProbablyBinary(withBom)).toBe(false);
  });
});

describe('looksLikeText', () => {
  it('is the inverse of the sniffer', () => {
    expect(looksLikeText(Buffer.from('let x = 1;', 'utf8'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x00, 0x01, 0x02]))).toBe(false);
  });
});

describe('decodeSource', () => {
  it('decodes plain UTF-8 without reporting a BOM', () => {
    const result = decodeSource(Buffer.from('const a = 1;', 'utf8'));
    expect(result.text).toBe('const a = 1;');
    expect(result.hadBom).toBe(false);
  });

  it('strips a UTF-8 BOM so offsets match the editor', () => {
    const result = decodeSource(Buffer.concat([UTF8_BOM, Buffer.from('const a = 1;', 'utf8')]));
    expect(result.text).toBe('const a = 1;');
    expect(result.hadBom).toBe(true);
  });

  it('decodes UTF-16 in both byte orders', () => {
    const little = decodeSource(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo', 'utf16le')]),
    );
    expect(little.text).toBe('héllo');
    expect(little.hadBom).toBe(true);

    const source = Buffer.from('héllo', 'utf16le');
    const swapped = Buffer.from(source);
    swapped.swap16();
    const big = decodeSource(Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]));
    expect(big.text).toBe('héllo');
    expect(big.hadBom).toBe(true);
  });
});

describe('assertWithinSizeLimit', () => {
  it('accepts a file exactly at the limit', () => {
    expect(() => assertWithinSizeLimit(10, 10, 'src/a.ts')).not.toThrow();
  });

  it('throws FILE_TOO_LARGE above the limit', () => {
    let caught: unknown;
    try {
      assertWithinSizeLimit(11, 10, 'src/a.ts');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AncestryError);
    const error = caught as AncestryError;
    expect(error.code).toBe('FILE_TOO_LARGE');
    expect(error.userMessage).toContain('src/a.ts');
    expect(error.detail).toContain('11');
    expect(error.detail).toContain('10');
  });

  it('never includes file content in the failure', () => {
    const secret = 'const password = "hunter2";';
    let caught: unknown;
    try {
      assertWithinSizeLimit(secret.length + 1, secret.length, 'src/a.ts');
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain('hunter2');
  });
});
