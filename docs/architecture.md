# Ancestry — Architecture

> Companion to [`specification.md`](./specification.md), which defines _what_ the
> system does. This document defines _how_ it is put together and, more
> importantly, **why the boundaries are where they are**.

---

## 1. The three problems

The plan is right that this is three engineering problems wearing one trench
coat. The architecture keeps them as separate layers with a strict dependency
direction, so each can be tested and replaced independently.

| Problem                           | Layers                                    | Depends on              |
| --------------------------------- | ----------------------------------------- | ----------------------- |
| **A — Code understanding**        | `parser` → `normalization` → `similarity` | nothing                 |
| **B — Historical reconstruction** | `git` → `analysis` → `graph`              | A (for similarity only) |
| **C — Human understanding**       | `webview`                                 | `types` only            |

```
                    ┌──────────────┐
                    │ src/types.ts │   ← the only shared contract
                    └──────┬───────┘
        ┌──────────────────┼───────────────────────┐
        ▼                  ▼                       ▼
   ┌─────────┐       ┌──────────┐           ┌───────────┐
   │   git   │       │  parser  │           │  config   │
   └────┬────┘       └────┬─────┘           │  logger   │
        │                 │                  └───────────┘
        │            ┌────▼─────┐
        │            │normaliz. │
        │            └────┬─────┘
        │                 │
        │            ┌────▼─────┐        ┌──────────┐
        │            │similarity│◄───────┤  cache   │
        │            └────┬─────┘        └────┬─────┘
        │                 │                  │
        │            ┌────▼──────────────────▼────┐
        └───────────►│         analysis           │
                     └────────────┬───────────────┘
                                  │
                            ┌─────▼─────┐
                            │   graph   │
                            └─────┬─────┘
                                  │
                            ┌─────▼─────┐
                            │  webview  │
                            └───────────┘
```

**The rule that keeps this honest:** no module may import from a module _above_
it in that picture, and `src/types.ts` imports nothing. A cycle or an upward
import is a design failure, not a refactoring nuisance.

---

## 2. Module responsibilities

### `src/types.ts` — the frozen contract

Every shared shape, the `AncestryError` type, and a handful of pure helpers
(`makeBlockId`, `makeNodeId`, `moduleForPath`, `isTestPath`). It imports nothing
but is imported by everything. It is frozen because six modules were written in
parallel against it; in normal development it changes only with a deliberate
schema bump (`SCHEMA_URI` / `ENGINE_VERSION`).

### `src/git/` — the only thing that talks to git

A thin, hardened wrapper over the `git` CLI. Two sub-layers:

- `exec.ts` — process spawning. No shell, argv array, timeout, output cap,
  sanitised child environment. Every command-injection defence lives here and
  nowhere else.
- `repo.ts` — typed queries (`getCommitHistory`, `getFileAtCommit`, `getBlame`,
  `getMergeBase`, `findRenames`, …).

`format.ts` parses git's output; `safety.ts` validates every path and revision
before it reaches a command line. A path whose first character is `-` is
rejected outright, because git would otherwise read it as a flag.

**Why the CLI and not a library?** `simple-git` and isomorphic-git both wrap
plumbing we would still have to reimplement for rename/copy detection scores, and
isomorphic-git would mean shipping a second, differently-buggy implementation of
packfile parsing. The CLI is the reference implementation, it is already
installed, and `git blame --porcelain` / `diff-tree -M -C` are exactly the
primitives we need. The cost is process spawn overhead, which the cache and the
`--batch`-friendly paging in `getCommitHistory` mitigate.

### `src/parser/` — the AST adapter

Turns source text into `CodeBlock[]` using the TypeScript compiler API. Split
into `sourceFile.ts` (the seam), `kinds.ts`, `signature.ts`, `blocks.ts`,
`guards.ts`.

`createSourceFile` is the single seam between Ancestry and TypeScript. Blocks
arriving from history are re-parsed through it as standalone text, so a block
extracted in 2019 and a block in the working tree are parsed by identical code.

**Why the TypeScript compiler API and not Tree-sitter in v1** — see
specification §9. The short version: Tree-sitter is the right answer for
multi-language support, but it is the wrong _first_ answer, because it makes the
accuracy of the similarity engine unmeasurable. One deterministic parser, fully
validated, then a second one.

### `src/normalization/` — what counts as "the same code"

The intellectual centre of the project. Converts a `CodeBlock` into a
`NormalizedBlock`: a canonical token stream, a `tokenHash`, a 64-bit SimHash, a
128-band MinHash signature, a shingle set, and a structural feature vector.

The design tension, stated plainly: it must erase everything that does not change
behaviour (names, formatting, comments) while preserving everything that does
(operators, property names, type names, free identifiers). The full rule table is
specification §2.4; the interesting calls are:

- **Free identifiers are preserved.** `console.log` → `window.log` is a real
  change. Canonicalising it would have made a whole class of bugs invisible.
- **String literal values are dropped, length and class kept.** `'red'` →
  `'blue'` is _not_ detected. That is a deliberate trade: string values are
  usually configuration rather than logic, and emitting them would copy source
  text into hashes and into anything that logs a hash. Documented as a known
  false negative (specification §3.5).
- **Hash primitives are duplicated** in this module and in `similarity/`. This is
  deliberate: it keeps both modules runnable and testable in isolation, and the
  cache layer means hashing is not on a hot path for every comparison.

### `src/similarity/` — scoring, not hashing

Takes two `NormalizedBlock`s and returns a 0..1 score with a per-component
breakdown. It also owns the **candidate pre-filter** (`prefilter`, `CandidateIndex`)
that keeps the search sublinear — without it the cross-file search is `O(n²)`
full comparisons and the extension is unusable on any real repository.

`componentsUsed` is part of every result. A user seeing `0.91` should be able to
find out _why_, and a score that silently skipped two of four components is not
the same claim as one that used all four.

### `src/cache/` — the local index

`ICacheStore` with two backends: `node:sqlite` when the runtime provides it, and
a checksummed sharded JSON store otherwise. Tables `repositories`, `commits`,
`files`, `code_blocks`, `normalized_blocks`, `similarity_matches`,
`graph_edges`.

The invariant that matters: **a corrupt cache is never fatal.** Every record
carries a checksum; a mismatch, a truncated file, or invalid JSON degrades to a
miss, the file is removed, and analysis continues. `createCacheStore` never
throws for a cache problem — the caller is expected to be able to run without one.

`node:sqlite` is dynamically imported behind a capability probe rather than
statically imported, because it is still marked experimental and VS Code's
Electron Node version varies between releases. A hard dependency on it would have
been a packaging hazard for zero benefit.

### `src/analysis/` — the orchestrator

The only layer allowed to know about all the others. Its job is sequencing and
bookkeeping, not algorithms:

1. Resolve the repository, enforce the size safeguard, surface shallow/detached
   warnings.
2. Parse the current file, resolve the selection to one block (specification
   §2.2), normalise it.
3. Walk the focus file's history (`--follow` for renames), then widen to the
   paths touched by those commits, then to the wider repository — bounded by
   `maxBlocksTotal` and `maxHistoryDepth`.
4. For each historical block: parse → normalise → hash → pre-filter → full
   compare. Serve any of it from the index.
5. Build the graph, detect origin, serialise.

Progress is reported through `AnalysisProgress` with a monotonic ratio, and the
whole run is cancellable via `AbortSignal`.

**The honest-cost invariant:** `GraphStats.filesInspected` and
`blocksCompared` record what was actually examined, and `unparsed` records every
file that was skipped and why. Ancestry would rather tell you it could not read
something than quietly produce an incomplete ancestry that looks complete.

### `src/graph/` — the pure data structure

Takes `VersionCandidate[]` and produces an `AncestryGraph`. No I/O, no git, no
parsing — which means the entire relationship model is testable with plain object
fixtures and no repository. It owns edge-type inference (§4), origin detection
(§5), and the statistics.

**Determinism is a hard requirement here.** The same input produces a
byte-identical graph, and the output does not depend on the order candidates
arrive in. Tests assert this by shuffling the input. A visualisation that reshuffles
between two runs of the same analysis is not trustworthy.

### `src/webview/` — the presentation boundary

- `serialize.ts` is the **security boundary**: the graph is validated, clamped,
  capped, and whitelist-checked before it crosses into the webview.
- `client/core/` holds all the logic (layout, filtering, colour, ticks, ancestry
  paths) as **pure functions with no DOM and no Three.js**, so it is unit tested
  normally.
- `client/renderer.ts`, `camera.ts`, `panel.ts` need a real browser and are the
  only untested code in the project. That is a known, documented risk.

Three.js is bundled into `media/webview.js` by esbuild — no CDN, no runtime
script fetching, which is what makes a strict CSP possible.

### `src/extension.ts`, `src/commands/` — thin shell

Command registration, selection capture, progress UI, cancellation, and error
presentation. Contains no analysis logic. Every command is wrapped so a failure
becomes a notification with an actionable hint (`hintForCode`), never an unhandled
rejection.

---

## 3. Cross-cutting concerns

### Error handling

Every anticipated failure is an `AncestryError` with a `code` and a `userMessage`
safe to render. Codes are enumerated in specification §10 and mapped to
user-facing hints in `src/logger.ts`. A failure to analyse **one** file or commit
is recorded and skipped; only a failure to establish the repository itself aborts.

### Privacy

Enforced, not documented. `src/logger.ts` scrubs absolute paths from all output
and refuses to write source text unless `ancestry.privacy.logSourceCode` is
explicitly set. Normalised tokens never contain string-literal values, so hashes
and the graph cannot be used to recover source text. There are no network calls
anywhere in v1.

### Determinism

Required for the parser (stable block ids), the graph (byte-identical output), the
layout (same picture every time), and the normaliser (cache correctness depends on
it). `Math.random` and `Date.now` are banned inside library code; the clock is
injected (`now?: () => number`).

### Performance strategy

Four layers, in order of leverage:

1. **Do less work** — the candidate pre-filter avoids `O(n²)` full comparisons.
2. **Do it once** — the index caches parsed blocks, normalisations, hashes, and
   match results, keyed by content hash so a re-analysis is a lookup.
3. **Do it incrementally** — `getChangedFilesSince(from, to)` means a second run
   only parses what changed since the last indexed commit.
4. **Do it off the main thread** — worker threads for parsing and comparison.
   Gated behind `ancestry.experimental.workers` and off by default, because the
   baseline is not yet fast enough to need them on small repositories and the
   complexity is not yet justified.

Methodology and the (as-yet-empty) results table live in
[`performance.md`](./performance.md).

---

## 4. Testing strategy

| Layer                | Approach                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure units           | Direct calls with object fixtures. No mocks — the types are the boundary.                                                                                                          |
| Git integration      | **Real repositories** built in temp directories with fixed dates. Never a mocked `git`.                                                                                            |
| Analysis integration | Synthetic repositories containing the seven required scenarios (original, renamed copy, modified copy, move, branch divergence, merge, delete/re-introduce) plus unrelated decoys. |
| Accuracy             | A fixed corpus scored for precision/recall/F1/FP/FN, gated at F1 ≥ 0.9.                                                                                                            |
| Webview logic        | The `core/` pure modules are unit tested; the DOM/WebGL layer is not, and that gap is stated.                                                                                      |

Fixed `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` values are mandatory in every test
repository: without them, ordering and timestamp assertions are flaky, and a
flaky history test is worse than no test.

---

## 5. Extension points

| To add…                        | Change…                                                                          | Ripple                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A language                     | `EXTENSION_LANGUAGES` in `types.ts`, `getScriptKind`/`classifyNode` in `parser/` | None outside `parser/`                                                   |
| A parser backend (Tree-sitter) | `createSourceFile` + `blocks.ts`                                                 | None — normalisation works off `CodeBlock`                               |
| Embeddings                     | A new `similarity` component + weight                                            | `docs/specification.md` §3 must be updated and the accuracy suite re-run |
| A cache backend                | `ICacheStore`                                                                    | None                                                                     |
| A visualisation                | A new `webview/client/core` module                                               | None                                                                     |

The one addition that _does_ ripple is embeddings, precisely because they change
what a score means. That is why they are sequenced after the deterministic
baseline has a measured F1 to beat.
