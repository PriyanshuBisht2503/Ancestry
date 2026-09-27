# Ancestry — Code Ancestry Explorer

Reconstructs the **semantic evolution of a code block** across Git history, branches
and files, and shows it to you as an interactive 3D graph.

Select a function, run one command, and Ancestry walks the history looking for the
versions of that logic that came before — including copies that were pasted into
other files under different names.

> **What Ancestry does not claim.** Ancestry reports the _earliest detected semantic
> match_. It never claims to have found the original author, the first version, or
> the true intent behind a piece of code. Git history records commits, not
> intentions, and a search can only see the history that is actually present — a
> shallow clone or a depth limit truncates the answer. This wording is enforced in
> code (`ORIGIN_DISCLAIMER` in `src/graph/origin.ts`) and asserted in the test suite.

---

## Table of contents

- [Privacy](#privacy)
- [Requirements](#requirements)
- [Install](#install)
- [Build from source](#build-from-source)
- [Usage](#usage)
- [Commands](#commands)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Measured behaviour](#measured-behaviour)
- [Known limitations](#known-limitations)
- [Try it on the demo repository](#try-it-on-the-demo-repository)
- [Development](#development)
- [Project layout](#project-layout)
- [Definition of Done](#definition-of-done)
- [License](#license)

---

## Privacy

Ancestry is **local-only by design**. There is no cloud service, no telemetry
backend, and no network call anywhere in the extension.

- Source code is never transmitted. It is read from your repository and kept in
  your own local index.
- Source text is **not** written to the output channel. `ancestry.privacy.logSourceCode`
  exists so the posture is explicit and documented; leaving it `false` is correct.
  Absolute file paths are scrubbed to `…\basename` before anything is logged.
- The webview runs under `default-src 'none'` with a per-load nonce and
  `connect-src 'none'`, so it cannot phone home even if it wanted to.
- No LLM, embedding service, or other external API is used or required. Matching
  is deterministic AST normalization plus hashing.

## Requirements

|                     |                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------ |
| VS Code             | `^1.85.0`                                                                            |
| Node (for building) | `>=20` — developed on 24.18.0                                                        |
| Git                 | on `PATH`. Ancestry shells out to the real `git` binary; there is no Git dependency. |
| Languages           | JavaScript and TypeScript (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`)             |

## Install

```bash
npm install
npm run build
npx vsce package --no-dependencies --out ancestry.vsix
code --install-extension ancestry.vsix
```

`npm run build` produces two artefacts:

| Output                                   | Built by                 | Purpose                                                                                               |
| ---------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `dist/extension.js`                      | esbuild (CommonJS, Node) | the extension host bundle. Embeds the TypeScript compiler used for parsing, which is why it is large. |
| `media/webview.js` + `media/webview.css` | Vite (IIFE)              | the 3D webview. Three.js and React are bundled — **no CDN** — so the strict CSP holds.                |

## Build from source

```bash
npm install
npm run build          # extension + webview
npm run build:dev      # extension, watch mode
npm run webview:dev    # webview, watch mode
npm run clean
```

## Usage

1. Open a JavaScript or TypeScript file in a Git repository.
2. Select a function (or place the cursor inside one).
3. Run **Ancestry: Analyze Code Ancestry** from the Command Palette, or right-click
   the selection.

Ancestry reports progress through eight phases (resolving the repository, parsing the
selection, reading history, extracting blocks, matching history, searching other
files, building the graph, detecting origin) and opens a 3D panel where:

- **X** is time, **Y** is branch, **Z** is file/module.
- Nodes are versions of the code; edges are relationships between them.
- Clicking a node shows the file, commit, author, timestamp, signature and
  similarity score.
- The filter bar narrows by branch, file, author, time range and similarity threshold.

**No selection?** Use **Ancestry: Analyze a Block in File**, which lists the blocks in
the current file and analyses the one you pick. Note that a class and the methods
inside it are _not_ offered separately — Ancestry analyses units, not fragments, and
running both would double every match.

Long analyses can be stopped with **Ancestry: Cancel Running Analysis**.

## Commands

| Command                       | Title                          |
| ----------------------------- | ------------------------------ |
| `ancestry.analyzeSelection`   | Analyze Code Ancestry          |
| `ancestry.analyzeCurrentFile` | Analyze a Block in File        |
| `ancestry.replayLastAnalysis` | Replay Last Ancestry Analysis  |
| `ancestry.exportGraph`        | Export Ancestry Graph as JSON  |
| `ancestry.showSettings`       | Open Settings                  |
| `ancestry.clearCache`         | Clear Ancestry Index Cache     |
| `ancestry.showCacheStats`     | Show Ancestry Cache Statistics |
| `ancestry.cancelAnalysis`     | Cancel Running Analysis        |

`ancestry.analyzeSelection` also appears in the editor context menu when there is a
selection. The exported JSON is the full graph — nodes, edges, origin and stats — and
is the same shape the webview consumes, so it diffs cleanly between runs.

## Settings

All settings are namespaced `ancestry.*`.

### Git

| Setting                      | Default      | Meaning                                                                |
| ---------------------------- | ------------ | ---------------------------------------------------------------------- |
| `git.maxHistoryDepth`        | `2000`       | Maximum commits to inspect per analysis. Guards unbounded scans.       |
| `git.maxFileSizeBytes`       | `2097152`    | Files larger than this are skipped.                                    |
| `git.maxRepositorySizeBytes` | `5368709120` | Analysis is refused with a clear message above this working-tree size. |

### Similarity

| Setting                        | Default | Meaning                                                                |
| ------------------------------ | ------- | ---------------------------------------------------------------------- |
| `similarity.strongThreshold`   | `0.9`   | At or above this, a match is _strong_.                                 |
| `similarity.possibleThreshold` | `0.75`  | At or above this (below strong), a match is _possible_.                |
| `similarity.candidateWindow`   | `6`     | Shingle tokens in the sliding window for the MinHash/Jaccard estimate. |
| `similarity.shingleSize`       | `4`     | Normalized tokens per shingle.                                         |

The _ignore_ threshold (`0.6`) is **derived**, not configured, so the three bands can
never be set into a non-monotonic order.

### Analysis

| Setting                       | Default  | Meaning                                                            |
| ----------------------------- | -------- | ------------------------------------------------------------------ |
| `analysis.followRenames`      | `true`   | Follow Git-detected renames while walking history.                 |
| `analysis.includeAllBranches` | `true`   | Include commits from all local branches, not just the current one. |
| `analysis.maxBlocksPerFile`   | `500`    | Cap on blocks extracted from a single file.                        |
| `analysis.maxBlocksTotal`     | `200000` | Hard cap on blocks held in memory for one analysis.                |
| `analysis.includeTests`       | `true`   | Include test files when searching for matches.                     |

### Cache

| Setting            | Default  | Meaning                                                                                                                       |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `cache.enabled`    | `true`   | Persist parsed blocks, normalizations and hashes locally.                                                                     |
| `cache.maxAgeDays` | `30`     | Entries older than this are evicted.                                                                                          |
| `cache.backend`    | `"auto"` | `auto` uses `node:sqlite` when the runtime provides it, else a checksummed sharded-JSON store. `sqlite` and `file` force one. |

`node:sqlite` is behind a **capability probe**, not a hard dependency: it is an
experimental API and VS Code's Electron Node version varies. A corrupt cache is
always treated as a **miss**, never a fatal error.

### Privacy and experimental

| Setting                 | Default | Meaning                                                                       |
| ----------------------- | ------- | ----------------------------------------------------------------------------- |
| `privacy.logSourceCode` | `false` | Leave this off. Source text is not logged.                                    |
| `telemetry.enabled`     | `false` | There is no telemetry backend. The setting exists so the posture is explicit. |
| `experimental.workers`  | `false` | Use worker threads for parsing and similarity.                                |

## How it works

```
selection
   ↓
GitRepository        real `git` binary, argv arrays, never a shell
   ↓
parser               TypeScript compiler API → blocks with exact source ranges
   ↓
normalization        identifiers, literals and structure → comparable token stream
   ↓
similarity           SimHash + MinHash pre-filter, then weighted comparison
   ↓
graph                nodes, inferred edges, earliest detected match
   ↓
webview              Three.js, bundled, strict CSP
```

Four decisions worth knowing about:

**The TypeScript compiler API is the parser, not Tree-sitter.** `createSourceFile` in
`src/parser/sourceFile.ts` is the documented seam if Tree-sitter is ever added.
Regex is never the primary parser for anything.

**Four signals are blended**, not one: Jaccard (0.5), SimHash (0.2), LCS (0.2) and
structural shape (0.1). No single signal decides a match.

**Candidates are pre-filtered** by SimHash Hamming distance and MinHash band agreement
before any expensive comparison, and only survivors are scored. The index keeps nine
probe tables, which bounds cost without silently changing what counts as a match.

**Determinism is a contract.** No `Math.random`, an injectable clock, and every emitted
collection is totally ordered, so two runs over the same repository produce the same
graph. There is a test for it.

## Measured behaviour

These are measured on the bundled demo repository by `npm run test -- tests/accuracy`,
which publishes its numbers to stdout on every run. They are measurements, not
aspirations.

| Comparison                                                                      | Score                  | Band      | Reported?                        |
| ------------------------------------------------------------------------------- | ---------------------- | --------- | -------------------------------- |
| `validateToken` vs itself (the focus block)                                     | 1.000                  | strong    | yes                              |
| `validateToken` vs `checkToken` — line-for-line renamed copy, variables renamed | **0.855**              | possible  | **yes**                          |
| `validateToken` vs `evaluateToken` — modified copy                              | **0.535**              | unrelated | no — below the 0.60 ignore floor |
| `validateToken` vs `runMigrations` — decoy, same _shape_, unrelated meaning     | rejected at pre-filter | —         | no                               |
| `validateToken` vs `settleConnection` — decoy, same _shape_, unrelated meaning  | rejected at pre-filter | —         | no                               |

| Metric              | Value                                                           |
| ------------------- | --------------------------------------------------------------- |
| Precision           | **1.000** — zero false positives                                |
| False-positive rate | **0.000** — both decoys correctly rejected                      |
| Cross-file recall   | **0.500** — the renamed copy is found, the modified copy is not |

The decoys are the interesting row. Both have the same control-flow shape as
`validateToken` and nothing to do with tokens, so a matcher keying on syntax rather
than meaning reports them as strong matches. Ancestry does not.

**Known calibration issue.** Jaccard carries the largest weight (0.5) and is the
weakest signal for renamed code: 4-token shingles shatter on any structural edit. On
the modified copy, SimHash (0.95) and shape (~1.00) both indicate a match while
Jaccard (0.23) disagrees — which is what pulls the aggregate to 0.535 and puts it
below the 0.60 ignore floor, so it is never reported at all. The thresholds in this
release are therefore **provisional**: measured, not tuned, and not presented as
validated.

## Known limitations

These are real and deliberate. None of them is a bug report in disguise.

- **JavaScript and TypeScript only.** Other languages are parsed permissively and
  reported as `unknown` rather than analysed.
- **String literal values are dropped** during normalization (recorded as
  `lit:str:<len>:<class>`). This keeps source text out of hashes and logs, at the
  cost of a documented class of false negatives: two blocks differing only in their
  string contents can normalise identically.
- **A copy that has genuinely been edited may not be reported.** The renamed copy is
  found, but the modified copy scores 0.535 and falls below the 0.60 ignore floor,
  so it is never shown. This is a weighting problem — Jaccard's 0.5 — not a search
  problem, and it is the main outstanding accuracy work.
- **Similarity thresholds are provisional** — see [Measured behaviour](#measured-behaviour).
- **Search is bounded.** `maxHistoryDepth`, `maxBlocksTotal`, a shallow clone, or the
  absence of an `origin` remote all truncate the answer. Ancestry says so in a warning
  rather than presenting a partial history as complete.
- **The 3D renderer, camera controls, host bridge and React root are not unit tested** —
  they need a real WebGL context. Their logic is split into `src/webview/client/core/*`,
  which is fully tested.
- **Not benchmarked on large repositories.** The plan targets small and medium
  repositories. No scalability claim is made beyond that.

## Try it on the demo repository

A deterministic 27-commit repository with seven scenarios (original, renamed copy,
modified copy, moved function, branch divergence, merge, deleted-and-reintroduced)
plus two decoys:

```bash
node scripts/make-demo-repo.mjs          # prints a temp path
node scripts/make-demo-repo.mjs ./demo   # or choose one
```

Then open it, select `validateToken` in `src/auth.ts`, and run
**Ancestry: Analyze Code Ancestry**. The same history is byte-for-byte reproducible on
every run — author, timestamps and commit SHAs are all pinned.

### Previewing the webview without VS Code

```bash
npm run webview:preview   # builds, then serves on http://127.0.0.1:8731
```

This writes a standalone `preview.html` that runs the **real** `media/webview.js`
bundle against a **real** analysed graph, using the real document builder. The only
thing stubbed is `acquireVsCodeApi()` — precisely the surface VS Code injects. It
proves the bundle boots, the graph arrives, React mounts and the canvas draws, which
is the part `npm test` cannot reach: the Three.js renderer needs a real WebGL context
and there is no headless browser in the toolchain. It does **not** prove the commands
work — there is no extension host.

The page title becomes `ERROR: <message>` if the bundle throws on boot, and the
console carries the detail.

## Development

```bash
npm run verify     # lint + typecheck + test
npm test           # vitest
npm run test:coverage
npm run build
```

Architecture and module boundaries: [`docs/architecture.md`](docs/architecture.md).
Normative semantics: [`docs/specification.md`](docs/specification.md).

| Document                                             | Covers                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`docs/specification.md`](docs/specification.md)     | What a code block is, normalization table, weights, thresholds, edge types, error codes |
| [`docs/architecture.md`](docs/architecture.md)       | Module map, dependency direction, testing strategy                                      |
| [`docs/security.md`](docs/security.md)               | Threat model and the privacy posture                                                    |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Common failures and what they mean                                                      |
| [`docs/performance.md`](docs/performance.md)         | Cost model and tuning                                                                   |
| [`docs/contributing.md`](docs/contributing.md)       | How to contribute                                                                       |

## Project layout

```
src/
  extension.ts      activate/deactivate, service wiring, command registration
  commands/         one file per command surface; all user-facing text lives here
  analysis/         the orchestrator: safety, branch index, history walk, matching
  git/              real `git` invocation: argv arrays, never a shell
  parser/           TypeScript compiler API → code blocks
  normalization/    identifiers, literals, tokens, features, hashing
  similarity/       SimHash, MinHash, LCS, scoring, candidate index
  graph/            nodes, edge inference, origin detection
  cache/            node:sqlite with a checksummed JSON fallback
  webview/          host, HTML/CSP, serialization, and the Three.js client
```

Dependencies point one way: `commands` → `analysis` → (`git`, `parser`,
`normalization`, `similarity`, `graph`) → `cache`. Nothing below `commands` imports
VS Code, which is what makes the engine testable without an extension host.

## Definition of Done

From the implementation plan, with current status:

|     | Item                                           | Status                                                           |
| --- | ---------------------------------------------- | ---------------------------------------------------------------- |
| ✅  | Extension installs successfully                | packaged with `vsce`                                             |
| ✅  | Selected functions are parsed correctly        | regression-tested in `tests/analysis/scenarios.test.ts`          |
| ✅  | Git history is reconstructed correctly         | `tests/git` 151 tests against real repositories                  |
| ✅  | Renamed copies are detected                    | pre-filter and index verified; see accuracy note                 |
| ⚠️  | False positives are **measured**               | decoys exercised; thresholds still provisional                   |
| ✅  | Ancestry graph is correct on test repositories | determinism + edge/node invariant tests                          |
| ⚠️  | 3D visualization works                         | builds and bundles; renderer untested (no WebGL in CI)           |
| ✅  | Large-history safeguards exist                 | depth, block, size and wall-clock caps, all warned about         |
| ✅  | Cache works                                    | both backends, plus a parity suite asserting they agree          |
| ✅  | Tests pass                                     | `npm run verify`                                                 |
| ✅  | CI passes                                      | GitHub Actions: lint → typecheck → test → build                  |
| ✅  | No source code sent externally by default      | enforced by CSP and asserted in `tests/webview/security.test.ts` |
| ✅  | Documentation is complete                      | this file plus `docs/`                                           |
| ✅  | License is included                            | MIT                                                              |
| ✅  | Demo repository is available                   | `scripts/make-demo-repo.mjs`                                     |
| ✅  | Extension package installs cleanly             | `npm run package`                                                |

⚠️ marks the two items that are honest partials: measured false-positive rates need
the accuracy harness, and the WebGL renderer cannot be exercised in CI.

## License

MIT — see [LICENSE](LICENSE). Contributions are welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Security issues: see [SECURITY.md](SECURITY.md).
