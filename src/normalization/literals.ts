/**
 * Literal normalisation.
 *
 * Literals are where a naive normaliser either destroys behaviour or leaks the
 * program. Ancestry takes a deliberately conservative middle path:
 *
 *  - **Numbers keep their value.** A different number is a different program
 *    (`i * 60` vs `i * 60_000` really is a behaviour change), so the value is
 *    canonicalised — not bucketed, not dropped. Radix prefixes and `_`
 *    separators are removed, floats are rounded to 6 decimal places (beyond that
 *    the difference is below the precision of any realistic comparison) and
 *    `-0` collapses to `0`.
 *  - **Strings are reduced to shape.** Raw string contents are never emitted:
 *    they are usually configuration, SQL, URLs or secrets rather than logic, and
 *    hashing them would turn a block's tokens into a fingerprint of its
 *    contents. The trade-off is explicit and accepted: a block whose *only*
 *    change is inside a string literal is reported as unchanged. What survives
 *    is `lit:str:<length>:<class>`, which keeps the two distinctions that do
 *    affect structure — how much text there is, and whether it looks like an
 *    identifier, a URL, a path or something else.
 *  - **Templates keep their holes.** The quasi text (the literal chunks around
 *    `${}`) is discarded for the same reason as strings, but the *number* of
 *    holes is kept and every interpolated expression is normalised in full, so
 *    the logic inside `` `total: ${a + b}` `` still counts.
 *  - **BigInts and regexes keep only their kind.** A BigInt's exact value is
 *    irrelevant to structure; a regex *pattern* is arbitrary text that is very
 *    often an opaque, user-authored blob, so only the flag set survives —
 *    `/x/gi` and `/y/g` differ, `/x/gi` and `/x/i` differ, and the body never
 *    reaches the stream.
 *
 * Nothing in this module returns a substring of the original literal except the
 * numeric value and the length, both of which are derived data.
 */

import * as ts from 'typescript';

/** Decimal places kept for floating point literals. */
const FLOAT_PRECISION = 6;

/** Longest string still classified as an identifier-like value. */
const MAX_IDENT_LENGTH = 64;

/** Longest string still classified as a path-like value. */
const MAX_PATH_LENGTH = 512;

/**
 * Canonical token for an out-of-range numeric literal.
 *
 * `1e400` is a legal literal that evaluates to Infinity; emitting the word keeps
 * the stream free of host-dependent `String(Number)` output.
 */
function nonFiniteToken(numeric: number): string {
  if (Number.isNaN(numeric)) {
    return 'nan';
  }
  return numeric > 0 ? 'inf' : '-inf';
}

/** Render a float with a fixed number of decimals, dropping trailing zeros. */
function renderFloat(numeric: number): string {
  if (!Number.isFinite(numeric)) {
    return nonFiniteToken(numeric);
  }
  if (numeric === 0) {
    // Collapses both 0 and -0.
    return '0';
  }
  const rounded = Number(numeric.toFixed(FLOAT_PRECISION));
  return String(rounded);
}

/**
 * Raw source text of a numeric literal.
 *
 * `NumericLiteral.text` is the *cooked* value and already loses information
 * (`12345678901234567890` becomes `12345678901234567000`, `1e400` becomes
 * `Infinity`), so the raw text is preferred and the cooked value is only a
 * fallback for detached nodes that have no reachable `SourceFile`.
 */
function rawNumericText(node: ts.NumericLiteral): string {
  try {
    const raw = node.getText();
    if (raw.length > 0) {
      return raw;
    }
  } catch {
    // No reachable SourceFile; fall through to the cooked value.
  }
  return node.text;
}

/**
 * Canonical value of a numeric literal: `lit:num:<value>`.
 *
 * - `_` separators are removed (`1_000` → `1000`).
 * - `0x` / `0b` / `0o` and legacy octal become decimal.
 * - Plain integers keep full precision via `BigInt`, so arbitrarily long integer
 *   literals are not rounded.
 * - Floats are rounded to 6 decimal places; `-0` becomes `0`.
 * - Non-finite results are `inf`, `-inf` or `nan`.
 */
export function normalizeNumericLiteral(node: ts.NumericLiteral): string {
  let raw = rawNumericText(node).trim();
  let negative = false;
  if (raw.startsWith('-')) {
    negative = true;
    raw = raw.slice(1);
  } else if (raw.startsWith('+')) {
    raw = raw.slice(1);
  }
  // A leading `-`/`+` is normally a *separate* prefix-unary node rather than part
  // of the literal's text, so `-1e400` reaches us as the literal `1e400` with a
  // parent `PrefixUnaryExpression`. Reading the sign from the parent is what makes
  // the negative forms report `-inf`/`-<value>` instead of silently losing it.
  const sign = parentSign(node);
  if (sign === '-') {
    negative = !negative;
  }
  const digits = stripDigitSeparators(raw);
  if (digits.length === 0) {
    return 'lit:num:0';
  }

  const radix = detectRadix(digits);
  // Legacy octal has no two-character prefix, so it must not be sliced the way
  // `0x`/`0b`/`0o` are: `0777` is 511 in total, not `0o77` = 63.
  const legacyOctal = radix === 8 && !hasExplicitRadixPrefix(digits);
  const body = radix === 10 || legacyOctal ? digits : digits.slice(2);
  const integerLike =
    radix === 10 ? isDecimalInteger(body) : isRadixInteger(body, legacyOctal ? 10 : radix);

  let rendered: string;
  if (integerLike && (radix === 10 || legacyOctal)) {
    // Legacy octal arrives as plain digits, so it is converted explicitly rather
    // than handed to `BigInt`, which would read `0777` as decimal 777.
    rendered = legacyOctal
      ? BigInt(`0o${body.replace(/^0+/, '') || '0'}`).toString()
      : BigInt(body).toString();
  } else if (integerLike) {
    rendered = BigInt(`${radixPrefix(radix)}${body}`).toString();
  } else {
    rendered = renderFloat(Number(digits));
    if (rendered === '0' || rendered === '-0') {
      negative = false;
    }
  }
  if (negative && rendered !== '0') {
    rendered = `-${rendered}`;
  }
  return `lit:num:${rendered}`;
}

/**
 * Sign contributed by an enclosing prefix-unary operator, or `null`.
 *
 * `+` is treated as positive rather than ignored so that a caller-provided leading
 * sign and a parent-provided one compose correctly instead of cancelling.
 */
function parentSign(node: ts.NumericLiteral): '-' | '+' | null {
  try {
    const parent = node.parent;
    if (parent === undefined || !ts.isPrefixUnaryExpression(parent)) {
      return null;
    }
    return parent.operator === ts.SyntaxKind.MinusToken ? '-' : '+';
  } catch {
    // A detached node with no parent chain contributes no sign.
    return null;
  }
}

/** Remove `1_000_000`-style separators without regex. */
function stripDigitSeparators(text: string): string {
  if (!text.includes('_')) {
    return text;
  }
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char !== '_') {
      out += char;
    }
  }
  return out;
}

/** Radix of a numeric literal, honouring `0x`/`0b`/`0o` and legacy leading-zero octal. */
function detectRadix(digits: string): 2 | 8 | 10 | 16 {
  if (digits.length < 2 || digits.charCodeAt(0) !== 0x30) {
    return 10;
  }
  switch (digits.charCodeAt(1)) {
    case 0x78: // x
    case 0x58: // X
      return 16;
    case 0x62: // b
    case 0x42: // B
      return 2;
    case 0x6f: // o
    case 0x4f: // O
      return 8;
    default:
      break;
  }
  // Legacy octal: `0777` is 511, not 777. Only honoured when *every* trailing
  // digit is a valid octal digit — `08` and `09` are not octal, and `0.5`/`0e3`
  // are not integers at all, so both stay decimal.
  if (digits.charCodeAt(1) >= 0x30 && digits.charCodeAt(1) <= 0x37) {
    for (let i = 1; i < digits.length; i += 1) {
      const code = digits.charCodeAt(i);
      if (code < 0x30 || code > 0x37) {
        return 10;
      }
    }
    return 8;
  }
  return 10;
}

/** True when the literal carries an explicit `0x`/`0b`/`0o` radix prefix. */
function hasExplicitRadixPrefix(digits: string): boolean {
  if (digits.length < 2 || digits.charCodeAt(0) !== 0x30) {
    return false;
  }
  const next = digits.charCodeAt(1);
  return (
    next === 0x78 ||
    next === 0x58 ||
    next === 0x62 ||
    next === 0x42 ||
    next === 0x6f ||
    next === 0x4f
  );
}

function radixPrefix(radix: 2 | 8 | 10 | 16): string {
  if (radix === 16) {
    return '0x';
  }
  if (radix === 8) {
    return '0o';
  }
  if (radix === 2) {
    return '0b';
  }
  return '';
}

function isDecimalInteger(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x30 || code > 0x39) {
      return false;
    }
  }
  return text.length > 0;
}

function isRadixInteger(text: string, radix: number): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const digit = parseInt(text.charAt(i), radix);
    if (Number.isNaN(digit)) {
      return false;
    }
  }
  return text.length > 0;
}

/**
 * Character-class test for identifier-ish string contents.
 *
 * Implemented with explicit code-point comparisons rather than a regular
 * expression: the project forbids regex-based parsing of source code, and a
 * hand-rolled test keeps the intent ("is this a bare name?") obvious and free of
 * Unicode-flag ambiguity.
 */
function isIdentifierCharCode(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x24 ||
    code === 0x2d ||
    code === 0x2e
  );
}

/**
 * Non-ASCII code points that are whitespace rather than identifier characters.
 *
 * JavaScript identifiers admit a very large slice of Unicode (so `café` and `日本`
 * are perfectly ordinary names). Reproducing the full ID_Start table would be a
 * lot of code for a value that is never emitted — only the *shape class* reaches
 * the stream — so the rule is: any non-ASCII code point counts as
 * identifier-like unless it is one of the recognised Unicode spaces. The
 * trade-off is documented: a string of CJK prose is classified `ident` rather than
 * `other`. That costs a little discrimination and leaks nothing.
 */
function isNonAsciiSpace(code: number): boolean {
  return (
    code === 0xa0 || // no-break space
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || // en/em spaces, thin space, …
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff // zero-width no-break space / BOM
  );
}

/** A Windows drive separator, e.g. the `:` in `C:\tmp`. */
function isDriveLetterColon(value: string, index: number): boolean {
  if (index !== 1) {
    return false;
  }
  const first = value.charCodeAt(0);
  return (first >= 0x61 && first <= 0x7a) || (first >= 0x41 && first <= 0x5a);
}

/**
 * Classify string contents by *shape only*, never by value.
 *
 * - `empty` — nothing at all.
 * - `url`   — has a scheme separator (`https://…`, `file://…`) or starts with `www.`.
 * - `ident` — a bare, dotted or dash-separated name, e.g. `json`, `a.b.c`, `utf-8`.
 * - `path`  — contains a separator and no whitespace, e.g. `./a/b`, `C:\tmp`.
 * - `other` — anything with whitespace, control characters, punctuation, or an
 *   implausible length; this is the catch-all that hides prose, SQL, markup and
 *   long text.
 *
 * The class is the only part of a string literal that reaches the stream, so a
 * secret, a query or a sentence can never be recovered from it.
 */
export function classifyStringContent(value: string): 'empty' | 'ident' | 'url' | 'path' | 'other' {
  if (value.length === 0) {
    return 'empty';
  }
  if (hasUrlScheme(value)) {
    return 'url';
  }
  if (value.length > MAX_PATH_LENGTH) {
    return 'other';
  }
  let hasSeparator = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x2f || code === 0x5c) {
      hasSeparator = true;
      continue;
    }
    // A drive separator (`C:\tmp`) is a path, not punctuation. Anywhere else a
    // colon means prose, a `key: value` pair or a time, all of which are `other`.
    if (code === 0x3a && isDriveLetterColon(value, i)) {
      hasSeparator = true;
      continue;
    }
    if (code >= 0x80) {
      if (isNonAsciiSpace(code)) {
        return 'other';
      }
      continue;
    }
    if (!isIdentifierCharCode(code)) {
      return 'other';
    }
  }
  if (hasSeparator) {
    return value.length <= MAX_PATH_LENGTH ? 'path' : 'other';
  }
  return value.length <= MAX_IDENT_LENGTH ? 'ident' : 'other';
}

/** `scheme://…` or `www.…`; compared without a regular expression. */
function hasUrlScheme(value: string): boolean {
  if (value.startsWith('www.')) {
    return true;
  }
  const separator = value.indexOf('://');
  if (separator <= 0) {
    return false;
  }
  for (let i = 0; i < separator; i += 1) {
    const code = value.charCodeAt(i);
    const isLetter = (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
    const isDigit = code >= 0x30 && code <= 0x39;
    const isSchemeChar = code === 0x2b || code === 0x2d || code === 0x2e;
    if (i === 0 ? !isLetter : !(isLetter || isDigit || isSchemeChar)) {
      return false;
    }
  }
  return true;
}

/**
 * Canonical value of a string literal: `lit:str:<length>:<class>`.
 *
 * `<length>` is the decoded character count (escape sequences resolved, since
 * `"\n"` and a newline are the same string). It is a magnitude hint only, kept
 * because the size of a configuration blob is a real structural difference; the
 * contents themselves are discarded.
 */
export function normalizeStringLiteral(node: ts.StringLiteral): string {
  const value = node.text;
  return `lit:str:${value.length}:${classifyStringContent(value)}`;
}

/**
 * Canonical value of a BigInt literal: `lit:bigint`.
 *
 * The magnitude is discarded: a BigInt in a code block is nearly always an
 * identifier for a constant (a timeout, a salt) rather than arithmetic, and
 * keeping the digits would let a secret constant leak into the stream.
 */
export function normalizeBigIntLiteral(node: ts.BigIntLiteral): string {
  // `node.text` is read so the value is genuinely discarded rather than
  // accidentally retained; the token is a constant.
  void node.text;
  return 'lit:bigint';
}

/**
 * Canonical value of a template literal: `lit:tmpl:<holeCount>`.
 *
 * Quasi text is discarded (it is string-literal content). The hole count is kept
 * because `` `a` `` and `` `a${b}` `` are structurally different, and the
 * tokenizer normalises every hole's expression separately so the interpolated
 * logic still contributes to the hash.
 *
 * `NoSubstitutionTemplateLiteral` has no holes, so it yields `lit:tmpl:0`, which
 * is also what the `TemplateHead` / `TemplateMiddle` / `TemplateTail` spans
 * yield; the tokenizer never emits those spans, it emits the whole expression.
 */
export function normalizeTemplateLiteral(
  node:
    | ts.NoSubstitutionTemplateLiteral
    | ts.TemplateExpression
    | ts.TemplateHead
    | ts.TemplateMiddle
    | ts.TemplateTail,
): string {
  if (ts.isTemplateExpression(node)) {
    return `lit:tmpl:${node.templateSpans.length}`;
  }
  return 'lit:tmpl:0';
}
