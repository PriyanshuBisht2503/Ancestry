/**
 * Shared, side-effect-free primitives used by every Ancestry validation path.
 *
 * This module is the bottom of the dependency graph for the webview's pure
 * core: it has no imports beyond the frozen domain model, touches no DOM and
 * no WebGL, and is therefore safe to unit test in a plain Node process.
 *
 * WHY IT EXISTS: the same untrusted-shaped data reaches this codebase from two
 * directions — the extension host (via `postMessage`) and an exported/replayed
 * JSON file. Both must be funnelled through exactly the same coercion rules,
 * otherwise one entry point becomes a bypass of the other. Keeping the rules
 * here means there is a single place to audit.
 */

import type {
  AncestryEdgeType,
  CodeBlockKind,
  GitPerson,
  MatchClassification,
  SupportedLanguage,
} from '../../../types';

/** Whitelisted match classifications, strongest first. */
export const CLASSIFICATIONS = [
  'strong',
  'possible',
  'weak',
  'unrelated',
] as const satisfies readonly MatchClassification[];

/** Whitelisted code-block kinds; `unknown` is the safe default. */
export const CODE_BLOCK_KINDS = [
  'function',
  'arrow-function',
  'method',
  'constructor',
  'class',
  'interface',
  'type-alias',
  'enum',
  'namespace',
  'variable',
  'object-literal',
  'block',
  'unknown',
] as const satisfies readonly CodeBlockKind[];

/** Whitelisted languages; `unknown` is the safe default. */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'unknown',
] as const satisfies readonly SupportedLanguage[];

/**
 * Edge types in *display* order — the order a user reads an ancestry story in:
 * the block refined, then adjusted, then relocated, then duplicated, then
 * re-converged through a merge. `HostToWebviewMessage.filter.edgeTypes` and the
 * filter-bar toggle row both use this ordering so the UI never reshuffles.
 */
export const EDGE_TYPES = [
  'EVOLVED_FROM',
  'MODIFIED_FROM',
  'MOVED_FROM',
  'COPIED_FROM',
  'MERGED_FROM',
] as const satisfies readonly AncestryEdgeType[];

/** Row label used for a node that is reachable from no branch ref. */
export const DETACHED_BRANCH = '(detached)';

/** Cap on `webview.css` / `webview.js` payload comments. Documentation only. */
export const MAX_NODES = 20_000;

/**
 * Cap on edges. Deliberately ~3x the node cap: a dense "lineage" analysis can
 * legitimately connect many pairs, and anything beyond this is far past the
 * point where a human can read the picture.
 */
export const MAX_EDGES = 60_000;

/** Cap on strings that end up in DOM text nodes (subjects, messages, …). */
export const MAX_TEXT_LENGTH = 2_000;

/** Cap on identifiers (node/block/edge ids, commit shas). */
export const MAX_ID_LENGTH = 256;

/** Cap on repository-relative paths. */
export const MAX_PATH_LENGTH = 1_024;

/** Cap on the single focus-block source preview carried to the webview. */
export const MAX_FOCUS_SOURCE_LENGTH = 200_000;

/** Cap on any short free-text message exchanged over the message channel. */
export const MAX_MESSAGE_STRING = 8_192;

/** Cap on small arrays in a message payload (branches, nodeIds, …). */
export const MAX_ARRAY_ITEMS = 1_000;

/** Cap on `branches` attached to a single node. */
export const MAX_BRANCHES_PER_NODE = 64;

/** Cap on retained `graph.warnings` after sanitisation. */
export const MAX_WARNINGS = 100;

/** Cap on retained `graph.unparsed` entries after sanitisation. */
export const MAX_UNPARSED = 500;

/** Upper bound for 1-based line numbers, to keep axis maths finite. */
export const MAX_LINE_NUMBER = 10_000_000;

/**
 * Property names that must never appear on a payload we are about to copy.
 *
 * A hostile payload could try to reach `Object.prototype` through a copied
 * `__proto__` / `constructor` / `prototype` key. We reject rather than
 * sanitise: the legitimate data model has no use for them, and a silent
 * strip is harder to reason about than a hard reject.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const CLASSIFICATION_SET: ReadonlySet<string> = new Set<string>(CLASSIFICATIONS);
const CODE_BLOCK_KIND_SET: ReadonlySet<string> = new Set<string>(CODE_BLOCK_KINDS);
const LANGUAGE_SET: ReadonlySet<string> = new Set<string>(LANGUAGES);

/**
 * The five edge types as a lookup set, so `coerceEdgeType` and the filter
 * validator can whitelist against it without allocating per call.
 */
export const EDGE_TYPE_SET: ReadonlySet<string> = new Set<string>(EDGE_TYPES);

/**
 * True when `value` is a null-prototype-free "plain" object.
 *
 * Rejects arrays, class instances, exotic host objects and anything whose
 * prototype was tampered with (for example `Object.create({ evil: 1 })` used to
 * smuggle inherited properties past an own-key check).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    // A throwing `getPrototypeOf` means a Proxy is involved. Refuse it.
    return false;
  }
}

/** True when the object carries any prototype-pollution-capable own key. */
export function hasForbiddenKeys(value: object): boolean {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return true;
    }
  }
  return false;
}

/**
 * Reads an own *data* property.
 *
 * Accessor properties are deliberately ignored: a getter on an untrusted
 * payload is arbitrary code that would run inside this process (and could
 * throw or hang), and the webview never needs getters on its messages.
 */
export function readOwn<T = unknown>(source: object, key: string): T | undefined {
  const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    return undefined;
  }
  return descriptor.value as T;
}

/** Returns `value` when it is a string, truncated to `maxLength` characters. */
export function coerceString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/** Returns `value` when it is a finite number, rejecting `NaN`/`Infinity`. */
export function coerceFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

/** Returns `value` when it is a boolean. */
export function coerceBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Clamps to the closed interval [0, 1]; non-finite input becomes 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/** Clamps to the closed interval [min, max]; non-finite input becomes `min`. */
export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/** Coerces to a non-negative integer line number, capped for layout safety. */
export function coerceLineNumber(value: unknown): number {
  const numeric = coerceFiniteNumber(value);
  if (numeric === undefined) {
    return 0;
  }
  return Math.floor(clampNumber(numeric, 0, MAX_LINE_NUMBER));
}

/** Coerces to a 0..1 score, defaulting to 0 for anything unusable. */
export function coerceScore(value: unknown): number {
  const numeric = coerceFiniteNumber(value);
  return numeric === undefined ? 0 : clamp01(numeric);
}

/** Whitelists a `MatchClassification`, defaulting to the weakest bucket. */
export function coerceClassification(value: unknown): MatchClassification {
  return typeof value === 'string' && CLASSIFICATION_SET.has(value)
    ? (value as MatchClassification)
    : 'unrelated';
}

/** Whitelists a `CodeBlockKind`, defaulting to `unknown`. */
export function coerceBlockKind(value: unknown): CodeBlockKind {
  return typeof value === 'string' && CODE_BLOCK_KIND_SET.has(value)
    ? (value as CodeBlockKind)
    : 'unknown';
}

/** Whitelists a `SupportedLanguage`, defaulting to `unknown`. */
export function coerceLanguage(value: unknown): SupportedLanguage {
  return typeof value === 'string' && LANGUAGE_SET.has(value)
    ? (value as SupportedLanguage)
    : 'unknown';
}

/** Whitelists an `AncestryEdgeType`; returns `null` for unknown values. */
export function coerceEdgeType(value: unknown): AncestryEdgeType | null {
  return typeof value === 'string' && EDGE_TYPE_SET.has(value) ? (value as AncestryEdgeType) : null;
}

/** True when `value` is one of the five known edge types. */
export function isEdgeType(value: unknown): value is AncestryEdgeType {
  return typeof value === 'string' && EDGE_TYPE_SET.has(value);
}

/**
 * Coerces an array of short strings: non-strings are dropped, the result is
 * de-duplicated (preserving first-seen order) and truncated to `maxItems`.
 */
export function coerceStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
  allowed?: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= maxItems) {
      break;
    }
    const text = coerceString(entry, maxItemLength);
    if (text === undefined || text.length === 0) {
      continue;
    }
    if (allowed !== undefined && !allowed.has(text)) {
      continue;
    }
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Coerces a `{ name, email }` author record. Never returns `undefined`: the
 * renderer and detail panel always expect an object, and an anonymous author is
 * a legitimate (if sad) state for a commit with a missing identity.
 */
export function coerceAuthor(value: unknown): GitPerson {
  if (!isPlainObject(value) || hasForbiddenKeys(value)) {
    return { name: '', email: '' };
  }
  return {
    name: coerceString(readOwn(value, 'name'), 200) ?? '',
    email: coerceString(readOwn(value, 'email'), 200) ?? '',
  };
}

/**
 * Strips characters that could break a single-line DOM text node or a VS Code
 * output line. This is *not* an HTML escaper — the webview builds DOM with
 * `textContent` — but it keeps log output and axis labels readable.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeLabel(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').trim();
}
