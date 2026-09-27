/**
 * Cheap, allocation-light guards that decide whether a blob of bytes from Git is
 * source code at all.
 *
 * Ancestry reads file contents straight out of `git cat-file`, so it will
 * eventually be handed a PNG, a `.jar`, or a lockfile full of NUL bytes. Handing
 * those to the TypeScript parser wastes hundreds of milliseconds per file and can
 * produce tens of thousands of nonsense "blocks", which then poison similarity
 * search. Everything here is a *heuristic*: the goal is a fast, safe refusal, not
 * perfect classification, so every function documents where it gives up.
 */

import { AncestryError } from '../types';

/** Bytes inspected by the binary sniffer. Enough to catch any real header. */
const SNIFF_LIMIT = 8192;

/**
 * Share of the sample that must be "printable" for the blob to count as text.
 * Tuned by hand against a mixed corpus: legitimate source sits below 2% (form
 * feeds, stray DEL bytes from copy/paste), while compressed and packed data sits
 * far above 60%. 30% is the widest margin that never rejects a real source file.
 */
const NON_PRINTABLE_LIMIT = 0.3;

const UTF8_BOM_0 = 0xef;
const UTF8_BOM_1 = 0xbb;
const UTF8_BOM_2 = 0xbf;

/**
 * True when `bytes` should be refused as non-text.
 *
 * Heuristic, with known blind spots:
 *  - **Latent false positives.** A Latin-1/CP1252 source file is full of bytes in
 *    `0x80..0x9f` that are *not* valid UTF-8, so it is rejected. That is the
 *    correct trade: a mis-encoded file that we parse yields mojibake offsets and
 *    line numbers, which is worse than skipping it. Such files are rare in the
 *    repositories this extension targets, which are UTF-8 by convention.
 *  - **Latent false negatives.** A binary format that happens to be valid UTF-8
 *    for its first 8 KiB and contains no NUL (some `.msgpack`/`.wasm` shapes, a
 *    UTF-16 file without a BOM that has no NUL in the sample) will be parsed as
 *    text. The resulting blocks are meaningless but harmless: they simply score
 *    badly against real code and never surface as matches.
 *  - **Deliberately shallow.** Only the first {@link SNIFF_LIMIT} bytes are
 *    examined, so the cost is constant per file regardless of file size.
 */
export function isProbablyBinary(bytes: Buffer | Uint8Array): boolean {
  if (hasUtf16Bom(bytes)) {
    // UTF-16 text is legitimately NUL-dense; decodeSource knows how to read it.
    return false;
  }

  const sample = bytes.length > SNIFF_LIMIT ? bytes.subarray(0, SNIFF_LIMIT) : bytes;
  if (sample.length === 0) {
    return false;
  }
  if (indexOfNul(sample) >= 0) {
    return true;
  }
  if (nonPrintableRatio(sample) > NON_PRINTABLE_LIMIT) {
    return true;
  }
  return !isValidUtf8RoundTrip(sample);
}

/**
 * Inverse of {@link isProbablyBinary}, expressed in the vocabulary callers use.
 * An empty file is text (there is nothing to misread), and UTF-16 with a BOM is
 * text.
 */
export function looksLikeText(bytes: Buffer): boolean {
  return !isProbablyBinary(bytes);
}

/**
 * Decodes file bytes to a string, reporting whether a byte-order mark was present.
 *
 * A BOM is *stripped*, not just skipped by the decoder: leaving `\uFEFF` at
 * offset 0 would offset every line/column computed from the text by one, and the
 * BOM is invisible in the editor, so the user's line 1 would appear as line 2 in
 * the ancestry graph.
 *
 * UTF-16 is handled because Windows tooling still produces it, and such a file is
 * NUL-dense enough that the binary sniffer deliberately lets it through — this
 * function is then the one place that has to read it.
 */
export function decodeSource(bytes: Buffer): { text: string; hadBom: boolean } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString('utf16le'), hadBom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: swapBytePairs(bytes.subarray(2)).toString('utf16le'), hadBom: true };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM_0 &&
    bytes[1] === UTF8_BOM_1 &&
    bytes[2] === UTF8_BOM_2
  ) {
    return { text: bytes.subarray(3).toString('utf8'), hadBom: true };
  }
  return { text: bytes.toString('utf8'), hadBom: false };
}

/**
 * Enforces the configured per-file byte budget.
 *
 * Thrown rather than returned so that the *only* place a size policy is decided is
 * this function; the message intentionally names the file and both byte counts
 * but never the content, because Ancestry never logs source text.
 */
export function assertWithinSizeLimit(byteLength: number, limit: number, filePath: string): void {
  if (byteLength > limit) {
    throw new AncestryError('FILE_TOO_LARGE', `${filePath} is too large to analyse.`, {
      detail: `${byteLength} bytes exceeds the configured limit of ${limit} bytes.`,
    });
  }
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  if (bytes.length < 2) {
    return false;
  }
  const first = bytes[0];
  const second = bytes[1];
  return (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff);
}

function indexOfNul(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Fraction of the sample that cannot appear in text.
 *
 * Bytes >= 0x80 are deliberately *not* counted: they are the continuation of
 * multi-byte UTF-8, so counting them would reject every file that contains an
 * accented word or an emoji. High bytes are instead judged by the UTF-8
 * round-trip check, which is precise. Whitespace that actually occurs in source
 * (tab, LF, CR) plus ESC (ANSI colour codes captured from a terminal) count as
 * printable.
 */
function nonPrintableRatio(bytes: Uint8Array): number {
  let bad = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte >= 0x80) {
      continue;
    }
    const printable =
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      byte === 0x1b ||
      (byte >= 0x20 && byte <= 0x7e);
    if (!printable) {
      bad++;
    }
  }
  return bad / bytes.length;
}

/**
 * Decodes and re-encodes the sample; a mismatch means the bytes were not UTF-8.
 *
 * A round trip is used instead of a hand-rolled UTF-8 validator because Node's
 * decoder is the exact inverse we actually care about: the question is not "is
 * this well-formed UTF-8?" but "would the string the parser sees differ from the
 * bytes on disk?".
 */
function isValidUtf8RoundTrip(bytes: Uint8Array): boolean {
  const end = trimPartialSequenceEnd(bytes);
  if (end === 0) {
    return true;
  }
  const slice = Buffer.from(bytes.subarray(0, end));
  const roundTripped = Buffer.from(slice.toString('utf8'), 'utf8');
  return roundTripped.length === end && roundTripped.equals(slice);
}

/**
 * Drops a trailing byte run that is an incomplete multi-byte sequence.
 *
 * Sampling at exactly 8 KiB can slice a 3-byte character in half; without this
 * the decoder emits U+FFFD for it, the round trip fails, and a perfectly good
 * file is misreported as binary.
 */
function trimPartialSequenceEnd(bytes: Uint8Array): number {
  const end = bytes.length;
  for (let i = end - 1; i >= 0 && i >= end - 4; i--) {
    const byte = bytes[i];
    if ((byte & 0xc0) === 0x80) {
      continue; // Continuation byte: keep walking backwards towards the lead byte.
    }
    const needed = continuationCount(byte);
    if (needed < 0) {
      return end; // 0x80..0xbf cannot start a sequence; nothing to trim.
    }
    return end - i > needed ? i : end;
  }
  return end;
}

/** Number of continuation bytes a lead byte promises, or -1 when it is not a lead byte. */
function continuationCount(byte: number): number {
  if (byte < 0xc2) {
    return -1; // Continuation byte in lead position, or an overlong 0xC0/0xC1 lead.
  }
  if (byte < 0xe0) {
    return 1;
  }
  if (byte < 0xf0) {
    return 2;
  }
  if (byte < 0xf5) {
    return 3;
  }
  return -1;
}

/** Big-endian UTF-16 has no decoder in Node, so the pairs are swapped by hand. */
function swapBytePairs(bytes: Uint8Array): Buffer {
  const out = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  out.swap16();
  return out;
}
