/**
 * Hand-written runtime validators for every message that crosses the webview
 * ↔ extension-host boundary.
 *
 * WHY THIS MODULE IS THE SECURITY BOUNDARY
 * -----------------------------------------
 * A VS Code webview is a *sandboxed but not trusted* document. The CSP in
 * `html.ts` stops remote code and remote fonts, but it deliberately does not
 * stop the extension host (or a malicious `.ancestry.json` replayed by the
 * user) from handing the webview a deeply nested, gigabyte-sized, cyclic or
 * prototype-polluting object. The first thing any consumer of a message does
 * is index into it, call a renderer method with it, or write it to the DOM, so
 * the *shape* has to be proven before it travels any further.
 *
 * The rules enforced here are therefore deliberately blunt:
 *  - the value must be a plain (non-array, non-exotic) object;
 *  - it must not carry `__proto__` / `constructor` / `prototype` keys;
 *  - accessors are never invoked (own *data* properties only);
 *  - `type` must be one of a fixed set of literal strings;
 *  - every nested field is re-validated, not merely type-checked;
 *  - numbers must be finite and within their documented range;
 *  - strings and arrays are length-capped so a message cannot exhaust memory;
 *  - the result is a **freshly built** object, so downstream code can never
 *    hold a reference into the untrusted original, and no prototype trick
 *    survives the copy.
 *
 * Any failure returns `null` — never a partially trusted object. The same
 * validators run on both sides: the host uses `validateClientMessage` on
 * everything the webview sends, and the webview uses `validateHostMessage` on
 * everything the host sends, so neither side has to trust the other.
 *
 * No external schema library is used on purpose: the bundle ships into a
 * webview with `default-src 'none'`, and a dependency would be more attack
 * surface than the ~200 lines below.
 */

import type {
  AncestryEdge,
  AncestryEdgeType,
  AncestryGraph,
  AncestryNode,
  GitPerson,
  GraphStats,
  HostToWebviewMessage,
  OriginInfo,
  WebviewFilter,
  WebviewGraphPayload,
  WebviewToHostMessage,
} from '../../../types';
import { SCHEMA_URI } from '../../../types';
import {
  clamp01,
  coerceAuthor,
  coerceBlockKind,
  coerceClassification,
  coerceEdgeType,
  coerceFiniteNumber,
  coerceLanguage,
  coerceLineNumber,
  coerceScore,
  coerceString,
  coerceStringArray,
  EDGE_TYPE_SET,
  hasForbiddenKeys,
  isPlainObject,
  MAX_ARRAY_ITEMS,
  MAX_BRANCHES_PER_NODE,
  MAX_EDGES,
  MAX_FOCUS_SOURCE_LENGTH,
  MAX_ID_LENGTH,
  MAX_MESSAGE_STRING,
  MAX_NODES,
  MAX_PATH_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_UNPARSED,
  MAX_WARNINGS,
  readOwn,
} from './domain';

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** A plain object that is safe to read fields from and safe to copy. */
type SafeRecord = Record<string, unknown>;

/**
 * Asserts that `value` is a plain object free of prototype-pollution keys.
 * `null` is returned for anything else, including arrays and `null` itself.
 */
function asSafeRecord(value: unknown): SafeRecord | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (hasForbiddenKeys(value)) {
    return null;
  }
  return value;
}

/** Reads a required non-empty string. Returns `null` when missing/blank. */
function requireString(record: SafeRecord, key: string, maxLength: number): string | null {
  const raw = readOwn(record, key);
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  return raw.length > maxLength ? raw.slice(0, maxLength) : raw;
}

/** Reads an optional string, returning `undefined` when absent. */
function optionalString(record: SafeRecord, key: string, maxLength: number): string | undefined {
  return coerceString(readOwn(record, key), maxLength);
}

/** Reads an optional finite number. Returns `undefined` when absent. */
function optionalNumber(record: SafeRecord, key: string): number | undefined {
  return coerceFiniteNumber(readOwn(record, key));
}

/** Reads an optional boolean, defaulting to `false`. */
function optionalBoolean(record: SafeRecord, key: string, fallback: boolean): boolean {
  const value = readOwn(record, key);
  return typeof value === 'boolean' ? value : fallback;
}

/** Reads an optional 0..1 score, rejecting out-of-range and non-finite values. */
function optionalScore(record: SafeRecord, key: string): number | undefined {
  const value = coerceFiniteNumber(readOwn(record, key));
  if (value === undefined || value < 0 || value > 1) {
    return undefined;
  }
  return clamp01(value);
}

// ---------------------------------------------------------------------------
// Graph validators (shared by `serialize.ts` and both message directions)
// ---------------------------------------------------------------------------

/**
 * Validates and coerces a single `AncestryNode`.
 *
 * Returns `null` when the node cannot be salvaged. The only genuinely
 * unrecoverable requirements are a non-empty string `id` and a non-empty
 * string `filePath`: every other field has a safe default so that one bad
 * commit cannot silently delete an otherwise useful node.
 */
export function validateNode(value: unknown): AncestryNode | null {
  const record = asSafeRecord(value);
  if (record === null) {
    return null;
  }
  const id = requireString(record, 'id', MAX_ID_LENGTH);
  if (id === null) {
    return null;
  }
  const filePath = requireString(record, 'filePath', MAX_PATH_LENGTH);
  if (filePath === null) {
    return null;
  }
  const branches = coerceStringArray(
    readOwn(record, 'branches'),
    MAX_BRANCHES_PER_NODE,
    MAX_ID_LENGTH,
  );
  const lineStart = coerceLineNumber(readOwn(record, 'lineStart'));
  const lineEndRaw = coerceLineNumber(readOwn(record, 'lineEnd'));
  return {
    id,
    blockId: optionalString(record, 'blockId', MAX_ID_LENGTH) ?? id,
    blockName: optionalString(record, 'blockName', MAX_ID_LENGTH) ?? null,
    blockKind: coerceBlockKind(readOwn(record, 'blockKind')),
    qualifiedName: optionalString(record, 'qualifiedName', MAX_TEXT_LENGTH) ?? null,
    signature: optionalString(record, 'signature', MAX_TEXT_LENGTH) ?? null,
    filePath,
    commit: optionalString(record, 'commit', MAX_ID_LENGTH) ?? '',
    shortCommit: optionalString(record, 'shortCommit', MAX_ID_LENGTH) ?? '',
    author: coerceAuthor(readOwn(record, 'author')),
    timestamp: coerceFiniteNumber(readOwn(record, 'timestamp')) ?? 0,
    hash: optionalString(record, 'hash', MAX_ID_LENGTH) ?? '',
    lineStart,
    lineEnd: Math.max(lineStart, lineEndRaw),
    language: coerceLanguage(readOwn(record, 'language')),
    similarity: coerceScore(readOwn(record, 'similarity')),
    classification: coerceClassification(readOwn(record, 'classification')),
    isFocus: optionalBoolean(record, 'isFocus', false),
    isOrigin: optionalBoolean(record, 'isOrigin', false),
    branches: branches.length > 0 ? branches : [],
    isDeleted: optionalBoolean(record, 'isDeleted', false),
    module: optionalString(record, 'module', MAX_PATH_LENGTH) ?? '',
  };
}

/**
 * Validates and coerces a single `AncestryEdge`.
 *
 * `knownNodeIds` is mandatory: an edge whose endpoints do not both exist in
 * the *same* graph is a dangling reference that would make the renderer's
 * position lookup return `undefined` and crash the WebGL loop. Dropping it
 * here is the cheapest place to notice.
 */
export function validateEdge(
  value: unknown,
  knownNodeIds: ReadonlySet<string>,
): AncestryEdge | null {
  const record = asSafeRecord(value);
  if (record === null) {
    return null;
  }
  const type = coerceEdgeType(readOwn(record, 'type'));
  if (type === null) {
    return null;
  }
  const from = requireString(record, 'from', MAX_ID_LENGTH);
  const to = requireString(record, 'to', MAX_ID_LENGTH);
  if (from === null || to === null) {
    return null;
  }
  if (!knownNodeIds.has(from) || !knownNodeIds.has(to)) {
    return null;
  }
  const id = optionalString(record, 'id', MAX_TEXT_LENGTH);
  const lineDelta = optionalNumber(record, 'lineDelta');
  return {
    id: id !== undefined && id.length > 0 ? id : `${type}:${from}->${to}`,
    from,
    to,
    type,
    similarity: coerceScore(readOwn(record, 'similarity')),
    confidence: coerceScore(readOwn(record, 'confidence')),
    sameFile: optionalBoolean(record, 'sameFile', false),
    lineDelta: lineDelta ?? null,
    rationale: optionalString(record, 'rationale', MAX_TEXT_LENGTH) ?? '',
  };
}

/** Validates and coerces a `GitPerson`; never `null`. */
export function validateAuthor(value: unknown): GitPerson {
  const record = asSafeRecord(value);
  return record === null ? { name: '', email: '' } : coerceAuthor(record);
}

/** Validates and coerces an `OriginInfo`; returns `null` when unusable. */
export function validateOrigin(value: unknown): OriginInfo | null {
  const record = asSafeRecord(value);
  if (record === null) {
    return null;
  }
  const nodeId = requireString(record, 'nodeId', MAX_ID_LENGTH);
  if (nodeId === null) {
    return null;
  }
  const basisRaw = readOwn(record, 'basis');
  const basis: OriginInfo['basis'] =
    basisRaw === 'earliest-match' ||
    basisRaw === 'earliest-strong-match' ||
    basisRaw === 'inconclusive'
      ? basisRaw
      : 'inconclusive';
  return {
    nodeId,
    filePath: optionalString(record, 'filePath', MAX_PATH_LENGTH) ?? '',
    commit: optionalString(record, 'commit', MAX_ID_LENGTH) ?? '',
    shortCommit: optionalString(record, 'shortCommit', MAX_ID_LENGTH) ?? '',
    author: validateAuthor(readOwn(record, 'author')),
    timestamp: coerceFiniteNumber(readOwn(record, 'timestamp')) ?? 0,
    similarity: coerceScore(readOwn(record, 'similarity')),
    basis,
    disclaimer: optionalString(record, 'disclaimer', MAX_TEXT_LENGTH) ?? '',
  };
}

/** Validates and coerces a `GraphStats`; every field has a numeric default. */
export function validateGraphStats(value: unknown): GraphStats {
  const record = asSafeRecord(value);
  if (record === null) {
    return emptyGraphStats();
  }
  const earliest = optionalNumber(record, 'earliestTimestamp');
  const latest = optionalNumber(record, 'latestTimestamp');
  return {
    nodeCount: nonNegativeInteger(optionalNumber(record, 'nodeCount')),
    edgeCount: nonNegativeInteger(optionalNumber(record, 'edgeCount')),
    fileCount: nonNegativeInteger(optionalNumber(record, 'fileCount')),
    authorCount: nonNegativeInteger(optionalNumber(record, 'authorCount')),
    commitCount: nonNegativeInteger(optionalNumber(record, 'commitCount')),
    branchCount: nonNegativeInteger(optionalNumber(record, 'branchCount')),
    earliestTimestamp: earliest === undefined ? null : earliest,
    latestTimestamp: latest === undefined ? null : latest,
    avgSimilarity: clamp01(optionalNumber(record, 'avgSimilarity') ?? 0),
    strongCount: nonNegativeInteger(optionalNumber(record, 'strongCount')),
    possibleCount: nonNegativeInteger(optionalNumber(record, 'possibleCount')),
    truncated: optionalBoolean(record, 'truncated', false),
    filesInspected: nonNegativeInteger(optionalNumber(record, 'filesInspected')),
    blocksCompared: nonNegativeInteger(optionalNumber(record, 'blocksCompared')),
  };
}

/** A fully zeroed `GraphStats`, used when the incoming value is unusable. */
export function emptyGraphStats(): GraphStats {
  return {
    nodeCount: 0,
    edgeCount: 0,
    fileCount: 0,
    authorCount: 0,
    commitCount: 0,
    branchCount: 0,
    earliestTimestamp: null,
    latestTimestamp: null,
    avgSimilarity: 0,
    strongCount: 0,
    possibleCount: 0,
    truncated: false,
    filesInspected: 0,
    blocksCompared: 0,
  };
}

function nonNegativeInteger(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/** Options for {@link validateGraph}. */
export interface ValidateGraphOptions {
  /**
   * Receives a human-readable line for every dropped or repaired field, so the
   * host can surface the reason a graph looks smaller than the analysis said.
   */
  readonly warnings?: string[];
  /**
   * Cap on retained nodes. Defaults to `MAX_NODES`; lowered by the webview
   * when a huge graph arrives, because a 20k-node WebGL scene is unusable.
   */
  readonly maxNodes?: number;
  /** Cap on retained edges. Defaults to `MAX_EDGES`. */
  readonly maxEdges?: number;
}

/** The outcome of {@link validateGraph}: a usable graph plus a summary. */
export interface ValidatedGraph {
  readonly graph: AncestryGraph;
  readonly droppedNodes: number;
  readonly droppedEdges: number;
  readonly truncated: boolean;
}

/**
 * Validates and coerces an entire `AncestryGraph`.
 *
 * This is the single implementation behind three call sites — the host's
 * `sanitizeGraph`, the host's inbound-message check and the webview's inbound
 * `init`/`graph` check — so a payload can never be "cleaner" on one path than
 * another.
 *
 * Beyond per-field coercion this enforces graph-level invariants:
 *  - duplicate node ids are dropped (the first wins, so input order is
 *    meaningful and the focus node wins when it is listed first);
 *  - nodes beyond `maxNodes` are dropped and flagged as truncation;
 *  - edges are dropped when either endpoint is missing, when the type is not
 *    one of the five known types, or beyond `maxEdges`;
 *  - every string is length-capped before it can reach the DOM.
 */
export function validateGraph(value: unknown, options?: ValidateGraphOptions): ValidatedGraph {
  const warnings = options?.warnings;
  const maxNodes = Math.max(0, Math.min(options?.maxNodes ?? MAX_NODES, MAX_NODES));
  const maxEdges = Math.max(0, Math.min(options?.maxEdges ?? MAX_EDGES, MAX_EDGES));
  const record = asSafeRecord(value);

  if (record === null) {
    return {
      graph: emptyGraph(),
      droppedNodes: 0,
      droppedEdges: 0,
      truncated: false,
    };
  }

  const rawNodes = readOwn(record, 'nodes');
  const rawEdges = readOwn(record, 'edges');
  const nodes: AncestryNode[] = [];
  const seenIds = new Set<string>();
  let droppedNodes = 0;
  let truncated = false;

  if (Array.isArray(rawNodes)) {
    for (const candidate of rawNodes) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        droppedNodes += 1;
        continue;
      }
      const node = validateNode(candidate);
      if (node === null) {
        droppedNodes += 1;
        continue;
      }
      if (seenIds.has(node.id)) {
        droppedNodes += 1;
        continue;
      }
      seenIds.add(node.id);
      nodes.push(node);
    }
  }

  const edges: AncestryEdge[] = [];
  const seenEdgeIds = new Set<string>();
  let droppedEdges = 0;
  if (Array.isArray(rawEdges)) {
    for (const candidate of rawEdges) {
      if (edges.length >= maxEdges) {
        truncated = true;
        droppedEdges += 1;
        continue;
      }
      const edge = validateEdge(candidate, seenIds);
      if (edge === null) {
        droppedEdges += 1;
        continue;
      }
      if (seenEdgeIds.has(edge.id)) {
        droppedEdges += 1;
        continue;
      }
      seenEdgeIds.add(edge.id);
      edges.push(edge);
    }
  }

  if (truncated) {
    pushWarning(warnings, `Graph truncated: kept ${nodes.length} of the supplied nodes/edges.`);
  }

  const unparsed: Array<{ filePath: string; reason: string }> = [];
  const rawUnparsed = readOwn(record, 'unparsed');
  if (Array.isArray(rawUnparsed)) {
    for (const entry of rawUnparsed) {
      if (unparsed.length >= MAX_UNPARSED) {
        break;
      }
      const entryRecord = asSafeRecord(entry);
      if (entryRecord === null) {
        continue;
      }
      const filePath = optionalString(entryRecord, 'filePath', MAX_PATH_LENGTH);
      if (filePath === undefined) {
        continue;
      }
      unparsed.push({
        filePath,
        reason: optionalString(entryRecord, 'reason', MAX_TEXT_LENGTH) ?? '',
      });
    }
  }

  const retainedWarnings: string[] = [];
  const rawWarnings = readOwn(record, 'warnings');
  if (Array.isArray(rawWarnings)) {
    for (const entry of rawWarnings) {
      if (retainedWarnings.length >= MAX_WARNINGS) {
        break;
      }
      const text = coerceString(entry, MAX_TEXT_LENGTH);
      if (text !== undefined && text.length > 0) {
        retainedWarnings.push(text);
      }
    }
  }

  const graph: AncestryGraph = {
    id: optionalString(record, 'id', MAX_ID_LENGTH) ?? 'graph',
    schema: optionalString(record, 'schema', MAX_ID_LENGTH) ?? SCHEMA_URI,
    engineVersion: optionalString(record, 'engineVersion', MAX_ID_LENGTH) ?? '0.0.0',
    focusBlockId: optionalString(record, 'focusBlockId', MAX_ID_LENGTH) ?? '',
    repositoryRoot: optionalString(record, 'repositoryRoot', MAX_PATH_LENGTH) ?? '',
    generatedAt: optionalNumber(record, 'generatedAt') ?? 0,
    nodes,
    edges,
    origin: validateOrigin(readOwn(record, 'origin')),
    stats: validateGraphStats(readOwn(record, 'stats')),
    warnings: retainedWarnings,
    unparsed,
  };

  if (droppedNodes > 0) {
    pushWarning(warnings, `Dropped ${droppedNodes} malformed or duplicate node(s).`);
  }
  if (droppedEdges > 0) {
    pushWarning(warnings, `Dropped ${droppedEdges} malformed, unknown-type or dangling edge(s).`);
  }

  return { graph, droppedNodes, droppedEdges, truncated };
}

/** Appends a warning, respecting the retention cap. */
export function pushWarning(target: string[] | undefined, message: string): void {
  if (target === undefined || target.length >= MAX_WARNINGS) {
    return;
  }
  target.push(message);
}

/** A valid, empty `AncestryGraph` — the safe result for any unusable input. */
export function emptyGraph(id = 'graph'): AncestryGraph {
  return {
    id,
    schema: SCHEMA_URI,
    engineVersion: '0.0.0',
    focusBlockId: '',
    repositoryRoot: '',
    generatedAt: 0,
    nodes: [],
    edges: [],
    origin: null,
    stats: emptyGraphStats(),
    warnings: [],
    unparsed: [],
  };
}

/** Validates and coerces a `WebviewFilter`; returns `null` when malformed. */
export function validateFilter(value: unknown): WebviewFilter | null {
  const record = asSafeRecord(value);
  if (record === null) {
    return null;
  }
  const filter: WebviewFilter = {};

  const branches = readOwn(record, 'branches');
  if (branches !== undefined) {
    if (!Array.isArray(branches)) {
      return null;
    }
    filter.branches = coerceStringArray(branches, MAX_ARRAY_ITEMS, MAX_ID_LENGTH);
  }

  const files = readOwn(record, 'files');
  if (files !== undefined) {
    if (!Array.isArray(files)) {
      return null;
    }
    filter.files = coerceStringArray(files, MAX_ARRAY_ITEMS, MAX_PATH_LENGTH);
  }

  const authors = readOwn(record, 'authors');
  if (authors !== undefined) {
    if (!Array.isArray(authors)) {
      return null;
    }
    filter.authors = coerceStringArray(authors, MAX_ARRAY_ITEMS, 200);
  }

  const minSimilarity = optionalScore(record, 'minSimilarity');
  if (minSimilarity !== undefined) {
    filter.minSimilarity = minSimilarity;
  }

  const fromTimestamp = optionalNumber(record, 'fromTimestamp');
  if (fromTimestamp !== undefined) {
    filter.fromTimestamp = fromTimestamp;
  }
  const toTimestamp = optionalNumber(record, 'toTimestamp');
  if (toTimestamp !== undefined) {
    filter.toTimestamp = toTimestamp;
  }

  const edgeTypes = readOwn(record, 'edgeTypes');
  if (edgeTypes !== undefined) {
    if (!Array.isArray(edgeTypes)) {
      return null;
    }
    filter.edgeTypes = coerceStringArray(
      edgeTypes,
      EDGE_TYPE_SET.size,
      64,
      EDGE_TYPE_SET,
    ) as AncestryEdgeType[];
  }

  const search = optionalString(record, 'search', MAX_MESSAGE_STRING);
  if (search !== undefined) {
    filter.search = search;
  }

  return filter;
}

/** Validates and coerces a `WebviewGraphPayload`; returns `null` when malformed. */
export function validateGraphPayload(value: unknown): WebviewGraphPayload | null {
  const record = asSafeRecord(value);
  if (record === null) {
    return null;
  }
  const graphRecord = asSafeRecord(readOwn(record, 'graph'));
  if (graphRecord === null) {
    return null;
  }
  const { graph } = validateGraph(graphRecord);
  const statsRecord = asSafeRecord(readOwn(record, 'stats'));
  return {
    graph,
    focusSource: coerceString(readOwn(record, 'focusSource'), MAX_FOCUS_SOURCE_LENGTH) ?? '',
    engineVersion: optionalString(record, 'engineVersion', MAX_ID_LENGTH) ?? graph.engineVersion,
    stats: {
      durationMs: Math.max(
        0,
        statsRecord === null ? 0 : (optionalNumber(statsRecord, 'durationMs') ?? 0),
      ),
      cacheHits: Math.max(
        0,
        statsRecord === null ? 0 : (optionalNumber(statsRecord, 'cacheHits') ?? 0),
      ),
      cacheMisses: Math.max(
        0,
        statsRecord === null ? 0 : (optionalNumber(statsRecord, 'cacheMisses') ?? 0),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Host → webview
// ---------------------------------------------------------------------------

const HOST_MESSAGE_TYPES: ReadonlySet<string> = new Set<HostToWebviewMessage['type']>([
  'init',
  'graph',
  'filter',
  'focus',
  'highlight',
  'clearHighlight',
  'loading',
  'error',
  'status',
]);

/**
 * Validates a message received from the extension host.
 *
 * Returns a freshly allocated, fully coerced message, or `null` when the value
 * is not a recognisable `HostToWebviewMessage`. The webview calls this on the
 * raw `MessageEvent.data` before touching anything in it.
 */
export function validateHostMessage(value: unknown): HostToWebviewMessage | null {
  const record = asSafeRecord(value);
  if (record === null) {
    return null;
  }
  const type = readOwn(record, 'type');
  if (typeof type !== 'string' || !HOST_MESSAGE_TYPES.has(type)) {
    return null;
  }
  switch (type) {
    case 'init':
    case 'graph': {
      const payload = validateGraphPayload(readOwn(record, 'payload'));
      return payload === null ? null : { type, payload };
    }
    case 'filter': {
      const filter = validateFilter(readOwn(record, 'payload'));
      return filter === null ? null : { type, payload: filter };
    }
    case 'focus': {
      const payload = asSafeRecord(readOwn(record, 'payload'));
      if (payload === null) {
        return null;
      }
      const nodeId = requireString(payload, 'nodeId', MAX_ID_LENGTH);
      return nodeId === null ? null : { type, payload: { nodeId } };
    }
    case 'highlight': {
      const payload = asSafeRecord(readOwn(record, 'payload'));
      if (payload === null) {
        return null;
      }
      const nodeIdsRaw = readOwn(payload, 'nodeIds');
      if (!Array.isArray(nodeIdsRaw)) {
        return null;
      }
      const nodeIds = coerceStringArray(nodeIdsRaw, MAX_ARRAY_ITEMS, MAX_ID_LENGTH).filter(
        (id) => id.length > 0,
      );
      const reason = optionalString(payload, 'reason', MAX_MESSAGE_STRING) ?? '';
      return { type, payload: { nodeIds, reason } };
    }
    case 'clearHighlight':
      return { type };
    case 'loading': {
      const payload = asSafeRecord(readOwn(record, 'payload'));
      if (payload === null) {
        return null;
      }
      const message = optionalString(payload, 'message', MAX_MESSAGE_STRING);
      const ratio = optionalScore(payload, 'ratio');
      if (message === undefined || ratio === undefined) {
        return null;
      }
      return { type, payload: { message, ratio } };
    }
    case 'error': {
      const payload = asSafeRecord(readOwn(record, 'payload'));
      if (payload === null) {
        return null;
      }
      const message = optionalString(payload, 'message', MAX_MESSAGE_STRING);
      if (message === undefined) {
        return null;
      }
      return {
        type,
        payload: { message, detail: optionalString(payload, 'detail', MAX_MESSAGE_STRING) },
      };
    }
    case 'status': {
      const payload = asSafeRecord(readOwn(record, 'payload'));
      if (payload === null) {
        return null;
      }
      const message = optionalString(payload, 'message', MAX_MESSAGE_STRING);
      return message === undefined ? null : { type, payload: { message } };
    }
    default:
      return null;
  }
}

/** Type guard form of {@link validateHostMessage}. */
export function isHostMessage(value: unknown): value is HostToWebviewMessage {
  return validateHostMessage(value) !== null;
}

// ---------------------------------------------------------------------------
// Webview → host
// ---------------------------------------------------------------------------

const CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set<WebviewToHostMessage['type']>([
  'ready',
  'selectNode',
  'setFilter',
  'requestExport',
  'requestDetails',
  'clientError',
  'viewport',
]);

/**
 * Validates a message received from the webview.
 *
 * The extension host calls this on `webview.onDidReceiveMessage` before the
 * message reaches any command handler. Nothing in the webview is trusted: a
 * compromised bundle (or a user poking at devtools) can post anything, and the
 * host must be able to say "that is not a message I understand" without
 * throwing.
 */
export function validateClientMessage(value: unknown): WebviewToHostMessage | null {
  const record = asSafeRecord(value);
  if (record === null) {
    return null;
  }
  const type = readOwn(record, 'type');
  if (typeof type !== 'string' || !CLIENT_MESSAGE_TYPES.has(type)) {
    return null;
  }
  switch (type) {
    case 'ready':
    case 'requestExport':
      return { type };
    case 'selectNode':
    case 'requestDetails': {
      const payload = asSafeRecord(readOwn(record, 'payload'));
      if (payload === null) {
        return null;
      }
      const nodeId = requireString(payload, 'nodeId', MAX_ID_LENGTH);
      return nodeId === null ? null : { type, payload: { nodeId } };
    }
    case 'setFilter': {
      const filter = validateFilter(readOwn(record, 'payload'));
      return filter === null ? null : { type, payload: filter };
    }
    case 'clientError': {
      const payload = asSafeRecord(readOwn(record, 'payload'));
      if (payload === null) {
        return null;
      }
      const message = optionalString(payload, 'message', MAX_MESSAGE_STRING);
      return message === undefined ? null : { type, payload: { message } };
    }
    case 'viewport': {
      const payload = asSafeRecord(readOwn(record, 'payload'));
      if (payload === null) {
        return null;
      }
      const cameraRaw = readOwn(payload, 'camera');
      if (!Array.isArray(cameraRaw) || cameraRaw.length !== 3) {
        return null;
      }
      const camera: [number, number, number] = [0, 0, 0];
      for (let index = 0; index < 3; index += 1) {
        const component = coerceFiniteNumber(cameraRaw[index]);
        if (component === undefined) {
          return null;
        }
        camera[index] = Math.max(-1e6, Math.min(1e6, component));
      }
      return { type, payload: { camera } };
    }
    default:
      return null;
  }
}

/** Type guard form of {@link validateClientMessage}. */
export function isClientMessage(value: unknown): value is WebviewToHostMessage {
  return validateClientMessage(value) !== null;
}

// NOTE: the shared whitelists and caps (`EDGE_TYPES`, `MAX_NODES`, …) are
// deliberately *not* re-exported from here — they live in `./domain`, which is
// the single source of truth, and re-exporting them here would make the
// `core` barrel ambiguous.
