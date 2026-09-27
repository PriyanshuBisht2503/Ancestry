/**
 * Ancestry — canonical domain model.
 *
 * This file is the FROZEN shared contract for every module in the extension.
 * Modules (`src/git`, `src/parser`, `src/normalization`, `src/similarity`,
 * `src/graph`, `src/cache`, `src/analysis`, `src/webview`) must not redefine
 * these shapes. Anything module-specific belongs in that module's own types file.
 *
 * Design rules encoded here:
 *  - All repository paths are POSIX-style and relative to the repository root.
 *  - All offsets/columns are derived from the TypeScript AST and are 0-based for
 *    columns/offsets, 1-based for human-facing line numbers.
 *  - Similarity values are normalised to the closed interval [0, 1].
 *  - Nothing in this model carries source text to a remote destination; the webview
 *    receives a pre-serialised, sanitised payload produced by the host process.
 */

/** Semantic version of the analysis engine output format. Bump on breaking changes. */
export const ENGINE_VERSION = '0.1.0';

/** Version of the AST normalisation rules. Bumping invalidates cached normalisations. */
export const NORMALIZATION_VERSION = '1';

/** Version of the persisted index/cache schema. */
export const CACHE_SCHEMA_VERSION = '1';

export const SCHEMA_URI = 'ancestry://graph/v1';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every anticipated failure in the extension is surfaced as an `AncestryError` so
 * that a single unreadable file or commit never takes down the extension host.
 * `userMessage` is safe to render in a notification; `detail` is developer-facing.
 */
export class AncestryError extends Error {
  public readonly code: AncestryErrorCode;
  public readonly userMessage: string;
  public readonly detail?: string;
  /** Wrapped cause. `override` is required: `Error.cause` exists in ES2022. */
  public override readonly cause?: unknown;

  constructor(
    code: AncestryErrorCode,
    userMessage: string,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(`${code}: ${userMessage}${options.detail ? ` (${options.detail})` : ''}`);
    this.name = 'AncestryError';
    this.code = code;
    this.userMessage = userMessage;
    this.detail = options.detail;
    this.cause = options.cause;
  }
}

export type AncestryErrorCode =
  | 'NO_GIT_REPOSITORY'
  | 'GIT_NOT_FOUND'
  | 'GIT_COMMAND_FAILED'
  | 'DETACHED_HEAD'
  | 'SHALLOW_CLONE'
  | 'REPOSITORY_TOO_LARGE'
  | 'NO_SELECTION'
  | 'EMPTY_SELECTION'
  | 'UNSUPPORTED_LANGUAGE'
  | 'PARSE_FAILED'
  | 'BINARY_FILE'
  | 'FILE_TOO_LARGE'
  | 'FILE_DELETED'
  | 'NO_MATCHES'
  | 'CACHE_CORRUPT'
  | 'CACHE_UNAVAILABLE'
  | 'WEBSITE_FAILED'
  | 'INVALID_PATH'
  | 'CANCELLED'
  | 'INTERNAL';

// ---------------------------------------------------------------------------
// Language + parsing
// ---------------------------------------------------------------------------

/**
 * Languages supported in v1. Tree-sitter grammars are intentionally not used yet:
 * a deterministic single-parser baseline is required before a multi-language
 * strategy (see docs/architecture.md). `unknown` means "a file we can read as
 * plain text but will not structurally analyse".
 */
export type SupportedLanguage = 'typescript' | 'javascript' | 'tsx' | 'jsx' | 'unknown';

/** A file extension → language mapping is the single source of truth. */
export const EXTENSION_LANGUAGES: Readonly<Record<string, SupportedLanguage>> = Object.freeze({
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
});

export function languageForPath(filePath: string): SupportedLanguage {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot < 0) {
    return 'unknown';
  }
  return EXTENSION_LANGUAGES[base.slice(dot + 1).toLowerCase()] ?? 'unknown';
}

export function isAnalysableLanguage(language: SupportedLanguage): boolean {
  return language !== 'unknown';
}

export interface SourceRange {
  /** 0-based character offset into the source text. */
  startOffset: number;
  /** 0-based, exclusive end offset. */
  endOffset: number;
  /** 1-based line numbers. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * The kinds of construct Ancestry considers a "code block". Deliberately narrow:
 * only *named* or *semantically meaningful* constructs are blocks, so that
 * reformatting, reordering of statements, or renames do not fragment a block's
 * identity. See docs/specification.md for the rationale.
 */
export type CodeBlockKind =
  | 'function'
  | 'arrow-function'
  | 'method'
  | 'constructor'
  | 'class'
  | 'interface'
  | 'type-alias'
  | 'enum'
  | 'namespace'
  | 'variable'
  | 'object-literal'
  | 'block'
  | 'unknown';

/** A single analysable unit of code at a specific path in history. */
export interface CodeBlock {
  /** Stable id derived from `${filePath}::${kind}::${name}::${startLine}`; see `makeBlockId`. */
  id: string;
  kind: CodeBlockKind;
  /** Identifier when the construct is named, else null. */
  name: string | null;
  /** Dotted path including enclosing class/namespace, e.g. `Service.authenticate`. */
  qualifiedName: string | null;
  /** Human-readable one-line signature, e.g. `authenticate(token: string, ttl: number): Promise<void>`. */
  signature: string | null;
  filePath: string;
  language: SupportedLanguage;
  range: SourceRange;
  /** Id of the enclosing block, forming a containment tree. */
  parentId: string | null;
  /** Name of the enclosing class/function, for grouping. */
  container: string | null;
  /** Raw source text of the block. Never leaves the local process. */
  text: string;
  /** SHA-1 of the raw text; cheap change detection. */
  textHash: string;
  /** Number of tokens after normalisation; used to reject trivially small matches. */
  tokenCount: number;
}

export interface ParseFileResult {
  filePath: string;
  language: SupportedLanguage;
  blocks: CodeBlock[];
  /** Recoverable problems (e.g. a class whose member failed to resolve). */
  diagnostics: ParseDiagnostic[];
  /** Total parse time in milliseconds. */
  durationMs: number;
  sourceLength: number;
}

export interface ParseDiagnostic {
  message: string;
  line: number;
  column: number;
  severity: 'warning' | 'error';
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export type NormalizedTokenKind =
  'keyword' | 'operator' | 'literal' | 'identifier' | 'punct' | 'type' | 'property' | 'param';

/**
 * One entry of the canonical token stream. `value` is already normalised:
 * identifiers are replaced by `id:<n>` (first-occurrence order), literals by a
 * class token such as `lit:number` or `lit:str:<len>`, and formatting is gone.
 */
export interface NormalizedToken {
  kind: NormalizedTokenKind;
  value: string;
  /** TypeScript `SyntaxKind` name, retained so the stream stays debuggable. */
  nodeType: string;
  /** Nesting depth within the block, so `{a;{b}}` differs from `{a;b;}`. */
  depth: number;
}

/** Persisted, cacheable form of a normalised block. */
export interface NormalizedBlock {
  /** The `CodeBlock.id` this normalisation belongs to. */
  blockId: string;
  language: SupportedLanguage;
  tokens: NormalizedToken[];
  /** Space-joined `value` strings. The canonical text used for shingles/LCS. */
  normalizedText: string;
  /** SHA-1 of `normalizedText`. Identical structure ⇒ identical hash. */
  tokenHash: string;
  /** SimHash: 64 bits rendered as 16 lowercase hex characters. */
  simhash: string;
  /** MinHash signature: 128 band values, each 0..65535, as decimal strings. */
  minhash: string[];
  /** k-gram shingle hashes, lowercase hex. The set MinHash estimates. */
  shingles: string[];
  /** Aggregate structural counts (node types, operators, control-flow depth). */
  features: Record<string, number>;
  /** Human-readable structural summary, e.g. `params:2 returns:1 loops:1 branches:2`. */
  astSummary: string;
  /** original identifier → canonical `id:n`, retained for explainability. */
  identifierMap: Record<string, string>;
  tokenCount: number;
  maxDepth: number;
  normalizationVersion: string;
}

export interface NormalizeResult {
  normalized: NormalizedBlock;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

export type MatchClassification = 'strong' | 'possible' | 'weak' | 'unrelated';

export interface SimilarityBreakdown {
  /** MinHash-estimated Jaccard similarity of the shingle sets, 0..1. */
  jaccard: number;
  /** `1 - hammingDistance/64` over the SimHash values, 0..1. */
  simhash: number;
  /** Normalised longest-common-subsequence ratio over the token streams, 0..1. */
  lcs: number;
  /** Cosine similarity of the structural feature vectors, 0..1. */
  shape: number;
}

/** Threshold configuration for classification. Values are user-tunable. */
export interface SimilarityThresholds {
  strong: number;
  possible: number;
  /** Below this, a candidate is not even reported. */
  ignore: number;
}

export interface SimilarityResult {
  /** Id of the reference (selected) block. */
  sourceBlockId: string;
  /** Id of the candidate block. */
  candidateBlockId: string;
  /** Weighted aggregate, 0..1. This is the number the UI shows. */
  similarity: number;
  breakdown: SimilarityBreakdown;
  classification: MatchClassification;
  /** Which components actually contributed; `minhash` is skipped if both sets are tiny. */
  componentsUsed: Array<keyof SimilarityBreakdown>;
}

export interface SimilarityCandidateRef {
  blockId: string;
  simhash: string;
  minhash: string[];
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitPerson {
  name: string;
  email: string;
}

export interface GitCommit {
  /** Full 40-character SHA. */
  hash: string;
  shortHash: string;
  parents: string[];
  author: GitPerson;
  committer: GitPerson;
  /** Epoch milliseconds, author date. */
  authorTimestamp: number;
  /** Epoch milliseconds, commit date. */
  commitTimestamp: number;
  subject: string;
  body: string;
  /** Branch or tag names pointing at this commit, e.g. `main`, `origin/main`. */
  refs: string[];
  isMerge: boolean;
}

export type GitChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface GitFileChange {
  /** Path at the current commit. */
  path: string;
  /** Path at the parent commit when the change is a rename/copy. */
  oldPath: string | null;
  status: GitChangeStatus;
  additions: number;
  deletions: number;
  /** Git's own rename/copy similarity (0..100), null when not applicable. */
  similarity: number | null;
}

export interface GitBranch {
  name: string;
  ref: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  tip: string;
}

export interface GitBlameLine {
  /** 1-based line number. */
  line: number;
  commit: string;
  author: string;
  authorTimestamp: number;
}

export interface GitBlameResult {
  filePath: string;
  commit: string;
  lines: GitBlameLine[];
  /** Author → total line count, for the blame summary view. */
  authorLineCounts: Array<{ author: string; lines: number }>;
}

export interface RepoInfo {
  /** Absolute path to the working tree root. */
  root: string;
  gitDir: string;
  isBare: boolean;
  isShallow: boolean;
  isDetachedHead: boolean;
  headCommit: string | null;
  headBranch: string | null;
  branches: GitBranch[];
  /** Total reachable commit count, or null when it could not be determined cheaply. */
  commitCount: number | null;
  /** Approximate working-tree size in bytes; used for the size safeguard. */
  worktreeSizeBytes: number;
  remoteUrl: string | null;
  /** Warnings raised while probing (shallow, missing user.name, ...). */
  warnings: string[];
}

export interface LogOptions {
  limit?: number;
  /** Start from this commit instead of HEAD. */
  since?: string;
  path?: string;
  followRenames?: boolean;
  includeAllBranches?: boolean;
  skip?: number;
  /** Stop early once this predicate matches. */
  until?: (commit: GitCommit) => boolean;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export type AncestryEdgeType =
  'EVOLVED_FROM' | 'COPIED_FROM' | 'MODIFIED_FROM' | 'MOVED_FROM' | 'MERGED_FROM';

/** One point in the ancestry of a code block: a block, in a file, at a commit. */
export interface AncestryNode {
  id: string;
  blockId: string;
  blockName: string | null;
  blockKind: CodeBlockKind;
  qualifiedName: string | null;
  signature: string | null;
  filePath: string;
  /** Full commit SHA. */
  commit: string;
  shortCommit: string;
  author: GitPerson;
  /** Epoch milliseconds, author date. */
  timestamp: number;
  /** SHA-1 of the raw block text at this point in history. */
  hash: string;
  /** 1-based inclusive line range in the file at this commit. */
  lineStart: number;
  lineEnd: number;
  language: SupportedLanguage;
  /** Similarity to the focus block, 0..1. Always present for the focus node (1). */
  similarity: number;
  classification: MatchClassification;
  /** True for the block the user invoked the command on. */
  isFocus: boolean;
  /** True for the earliest detected match. */
  isOrigin: boolean;
  /** Short branch names that contain this commit, for the Y axis grouping. */
  branches: string[];
  /** True when the block no longer exists in the working tree. */
  isDeleted: boolean;
  /** Module/group used for the Z axis (top-level directory or file stem). */
  module: string;
}

export interface AncestryEdge {
  id: string;
  /** Child (later) node. */
  from: string;
  /** Parent (earlier) node. */
  to: string;
  type: AncestryEdgeType;
  /** 0..1 similarity between the two endpoints. */
  similarity: number;
  /** 0..1 confidence in the inferred edge type. */
  confidence: number;
  /** True when both endpoints live in the same path. */
  sameFile: boolean;
  /** Signed line-count delta when the endpoints are the same path. */
  lineDelta: number | null;
  /** Human-readable justification, e.g. `git detected rename (score 96)`. */
  rationale: string;
}

/**
 * The result of origin detection. `disclaimer` is surfaced verbatim in the UI:
 * Git history cannot establish intent, and the "earliest match" is bounded by
 * how much history was actually scanned.
 */
export interface OriginInfo {
  nodeId: string;
  filePath: string;
  commit: string;
  shortCommit: string;
  author: GitPerson;
  timestamp: number;
  similarity: number;
  /** How the origin was chosen, for transparency. */
  basis: 'earliest-match' | 'earliest-strong-match' | 'inconclusive';
  disclaimer: string;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  authorCount: number;
  commitCount: number;
  branchCount: number;
  earliestTimestamp: number | null;
  latestTimestamp: number | null;
  avgSimilarity: number;
  strongCount: number;
  possibleCount: number;
  /** True when the scan hit a configured limit and the history is partial. */
  truncated: boolean;
  /** Number of files inspected while searching for matches. */
  filesInspected: number;
  /** Number of candidate blocks parsed and compared. */
  blocksCompared: number;
}

export interface AncestryGraph {
  id: string;
  schema: string;
  engineVersion: string;
  focusBlockId: string;
  repositoryRoot: string;
  generatedAt: number;
  nodes: AncestryNode[];
  edges: AncestryEdge[];
  origin: OriginInfo | null;
  stats: GraphStats;
  /** Non-fatal issues: limits hit, files skipped, unparsed sources. */
  warnings: string[];
  /** Files that were inspected but could not be parsed. */
  unparsed: Array<{ filePath: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface AnalysisOptions {
  repositoryRoot: string;
  /** File containing the user's selection, repo-relative. */
  filePath: string;
  /** 1-based inclusive selection range. Defaults to the whole file. */
  startLine: number;
  endLine: number;
  maxHistoryDepth: number;
  maxFileSizeBytes: number;
  maxBlocksPerFile: number;
  maxBlocksTotal: number;
  includeTests: boolean;
  followRenames: boolean;
  includeAllBranches: boolean;
  thresholds: SimilarityThresholds;
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
}

export interface AnalysisProgress {
  phase:
    | 'resolve-repository'
    | 'parse-selection'
    | 'read-history'
    | 'extract-blocks'
    | 'match-history'
    | 'cross-file-search'
    | 'build-graph'
    | 'detect-origin'
    | 'done';
  /** 0..1, monotonic within a run. */
  ratio: number;
  message: string;
  /** Total units for the current phase, when known. */
  total?: number;
  /** Completed units for the current phase, when known. */
  completed?: number;
}

export interface AnalysisResult {
  graph: AncestryGraph;
  durationMs: number;
  cache: { hits: number; misses: number; backend: string };
  /** Candidates that scored above the ignore threshold, strongest first. */
  matches: SimilarityResult[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export type CacheBackendName = 'sqlite' | 'file';

export interface CacheBackendInfo {
  backend: CacheBackendName;
  /** Absolute path to the store. */
  location: string;
  schemaVersion: string;
  /** False when the extension had to fall back from the preferred backend. */
  native: boolean;
  /** Human-readable note about why a fallback happened, if any. */
  note: string | null;
}

export interface CacheStats {
  backend: CacheBackendName;
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
  oldestEntryTimestamp: number | null;
  newestEntryTimestamp: number | null;
  repositoryCount: number;
}

/**
 * Local index contract. All source text stays on disk in the user's own
 * repository-adjacent storage directory and is never transmitted.
 */
export interface ICacheStore {
  readonly info: CacheBackendInfo;
  init(): Promise<void>;
  getRepository(repoRoot: string): Promise<CachedRepository | null>;
  putRepository(repo: CachedRepository): Promise<void>;
  getBlock(key: string): Promise<CachedBlock | null>;
  putBlock(block: CachedBlock): Promise<void>;
  getBlocksForFile(repoRoot: string, filePath: string, commit: string): Promise<CachedBlock[]>;
  getNormalizations(blockIds: string[]): Promise<Map<string, NormalizedBlock>>;
  putNormalizations(entries: NormalizedBlock[]): Promise<void>;
  getMatch(sourceId: string, candidateId: string): Promise<SimilarityResult | null>;
  putMatch(result: SimilarityResult): Promise<void>;
  purgeOlderThan(epochMs: number): Promise<number>;
  stats(): Promise<CacheStats>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export interface CachedRepository {
  repoRoot: string;
  headCommit: string | null;
  lastIndexedAt: number;
  indexedCommitCount: number;
}

export interface CachedBlock extends CodeBlock {
  repoRoot: string;
  commit: string;
  textHash: string;
  cachedAt: number;
}

// ---------------------------------------------------------------------------
// Webview protocol
// ---------------------------------------------------------------------------

export interface WebviewGraphPayload {
  graph: AncestryGraph;
  /** Text of the focus block only, for the header preview. Never the whole repo. */
  focusSource: string;
  engineVersion: string;
  stats: {
    durationMs: number;
    cacheHits: number;
    cacheMisses: number;
  };
}

export type WebviewFilter = {
  branches?: string[];
  files?: string[];
  authors?: string[];
  minSimilarity?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
  edgeTypes?: AncestryEdgeType[];
  search?: string;
};

export type HostToWebviewMessage =
  | { type: 'init'; payload: WebviewGraphPayload }
  | { type: 'graph'; payload: WebviewGraphPayload }
  | { type: 'filter'; payload: WebviewFilter }
  | { type: 'focus'; payload: { nodeId: string } }
  | { type: 'highlight'; payload: { nodeIds: string[]; reason: string } }
  | { type: 'clearHighlight' }
  | { type: 'loading'; payload: { message: string; ratio: number } }
  | { type: 'error'; payload: { message: string; detail?: string } }
  | { type: 'status'; payload: { message: string } };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'selectNode'; payload: { nodeId: string } }
  | { type: 'setFilter'; payload: WebviewFilter }
  | { type: 'requestExport' }
  | { type: 'requestDetails'; payload: { nodeId: string } }
  | { type: 'clientError'; payload: { message: string } }
  | { type: 'viewport'; payload: { camera: [number, number, number] } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic block id. Stable across runs for the same file + construct +
 * position, which is what makes the cache and cross-run graph identity work.
 */
export function makeBlockId(
  filePath: string,
  kind: CodeBlockKind,
  name: string | null,
  startLine: number,
): string {
  return `${filePath}::${kind}::${name ?? '<anon>'}::${startLine}`;
}

export function makeNodeId(blockId: string, commit: string): string {
  return `${blockId}@${commit.slice(0, 12)}`;
}

export function makeEdgeId(from: string, to: string, type: AncestryEdgeType): string {
  return `${type}:${from}->${to}`;
}

/** Top-level directory (or file stem) used to group nodes on the Z axis. */
export function moduleForPath(filePath: string): string {
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length <= 1) {
    return '<root>';
  }
  if (segments.length === 2) {
    return segments[0]!;
  }
  return segments.slice(0, 2).join('/');
}

export function isTestPath(filePath: string): boolean {
  return (
    /(^|\/)(__tests__|test|tests|spec)(\/|$)/i.test(filePath) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(filePath)
  );
}

/** Epoch milliseconds → `YYYY-MM-DD` in UTC. */
export function formatDateUtc(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
