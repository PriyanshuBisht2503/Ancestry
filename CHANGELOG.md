# Changelog

All notable changes to Ancestry are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`tests/analysis/scenarios.test.ts`** — the end-to-end seam suite that
  `tests/analysis/helpers.ts` already referenced but which did not exist. Covers
  selection resolution, partial and inverted selections, out-of-range clamping,
  origin wording against `ORIGIN_DISCLAIMER`, node/edge invariants, and determinism
  across two runs.
- **`tests/performance/`** - cache effectiveness (cold vs warm), scaling shape,
  heap bounds and abort behaviour. Written as *relative* assertions so it guards
  against order-of-magnitude regressions instead of flaking on machine load.
  `npm run test:perf` previously pointed at a directory that did not exist.
- **`tests/accuracy/accuracy.test.ts`** - the phase 12 accuracy suite. Publishes
  precision, recall, F1, false-positive rate and the confusion matrix against the
  labelled demo corpus, including its two shape-alike decoys, on every run. The
  thresholds now have evidence behind them instead of being asserted by comment.
- **`tests/webview/boundary.test.ts`** - the host to webview message boundary
  exercised with a *real* analysed graph rather than a fixture. The protocol and
  serialize suites both use hand-written values, which is right for testing a
  validator but leaves schema drift between the host's serialiser and the
  webview's validator completely uncovered - and that failure is silent: the
  extension analyses correctly, the panel opens, and nothing renders.
- **`scripts/preview-webview.mjs`** (`npm run webview:preview`) - renders the
  webview outside VS Code. Writes a standalone `preview.html` that runs the real
  `media/webview.js` against a real analysed graph using the real document
  builder, stubbing only `acquireVsCodeApi()`. This is the only way to confirm the
  bundle boots and the canvas draws, because the Three.js renderer needs a real
  WebGL context and the toolchain has no headless browser.
- **`README.md`** — overview, privacy posture, install and build, usage, every
  command and setting, measured behaviour, known limitations, and a
  Definition-of-Done table.
- `ancestry.cancelAnalysis` is now contributed in `package.json`, so the command
  the extension registers actually appears in the Command Palette.

### Changed

- **The cross-file sweep is no longer suppressed by a busy same-file history.**
  `CROSS_FILE_TRIGGER` was applied to *every* accepted candidate, including earlier
  versions of the block in its own file. A function that evolved across five commits
  therefore skipped the sweep every time — exactly backwards, since the more
  interesting a selection's own history is, the likelier a copy of it is elsewhere.
  The trigger now applies only to candidates that reached outside the focus
  **module**, so a run whose accepted candidates are all same-module always sweeps.
  Measured effect on the demo repository: **cross-file recall 0.000 → 0.500**; the
  renamed copy `checkToken` is now found. Module rather than exact path, because with
  renames followed a same-file ancestor carries its *old* path and an exact
  comparison would score it as a cross-file hit.
- Coverage exclusions in `vitest.config.ts` now name the files that exist. They
  still listed `main.ts` and `panel.ts`, neither of which survived the webview's
  move to React.
- **Cache write concurrency raised from 24 to 64** (`src/cache/fileStore.ts`).
  A 2 000-record batch took 8.8 s idle and over 16 s under load, while SQLite did
  the same batch in ~2.5 s, so the gap was concurrency rather than work. 64 sits
  comfortably inside the open-handle limit the surrounding comment already
  describes, and each write remains independently atomic and checksummed, so a
  wider batch cannot leave a partial state behind — it can only finish sooner or
  fail sooner.
- **The cache throughput test now measures a property that cannot flake.** It
  originally asserted wall-clock time inside a suite that runs ~52 files in
  parallel, so it was measuring machine load: the same batch measured ~4 s alone
  and ~19 s while the other files ran, and it failed on CI for reasons unrelated
  to the code. The first replacement compared the file backend's time against
  SQLite's in the same run, on the theory that the load would cancel in the ratio.
  That was wrong, and the failure was informative: the ratio *grew* under load —
  3.7x idle, 6.6x on a moderately busy machine, 14.8x on a busy one — because the
  two backends are not bounded by the same thing. The file store is
  filesystem-latency bound and inflates hard under contention; SQLite barely
  moves. Dividing two differently-bottlenecked measurements does not cancel load,
  it weights it.
  The test now scales the **same** backend against itself, from 250 to 2 000
  records, so both measurements share one bottleneck and one load. Measured 8.1x
  for 8x the work, against a 20x ceiling — O(n) predicts ~8x and O(n^2) ~64x, so
  the assertion separates them cleanly while tolerating a noisy machine. Absolute
  ceilings remain as order-of-magnitude guards. The file also completes in ~6.7 s
  rather than ~24.4 s, because the batch now runs once instead of three times.
- Coverage exclusions in `vitest.config.ts` now name the files that exist. They
  still listed `main.ts` and `panel.ts`, neither of which survived the webview's
  move to React.

### Fixed

- **CI was silently running zero integration tests.** The integration job filtered
  `npx vitest run tests/git tests/cache tests/integration`, but `tests/integration`
  is not a directory. Vitest treats a filter as a substring match, so a path that
  matches nothing is not an error — the step went green having run no integration
  tests at all, and the demo-repository suite never ran anywhere in CI. The job now
  targets the real integration surface: `tests/git tests/analysis tests/cache tests/demo`.
- **A lint suppression had quietly stopped applying.** `src/commands/context.ts`
  carried `// eslint-disable-next-line no-control-regex` on the `return value` line
  while the regex literal sat on the line below. When Prettier split the chain
  across lines the comment no longer covered the regex, so the rule began failing
  the lint gate with no obvious cause. Restructured so the comment is always
  adjacent to the literal it suppresses.
- **A selection always resolved to the last line of the file.** `clampLine`'s
  signature is `(value, fallback, minimum)`, but `resolveFocus` called it as
  `clampLine(request.startLine, 1, lastLine)` — passing the line *count* as the
  *minimum*. `Math.max(lastLine, startLine)` therefore pushed every selection to
  the file's final line, so "analyse the function I selected" silently analysed
  whatever happened to be at the bottom of the file. Every unit test passed
  because each stage was correct in isolation and nothing exercised the wiring.
  Replaced with `clampLineTo`, whose bounds are read low-to-high at the call site
  and so cannot be transposed; inverted ranges are now normalised instead of
  producing an empty block. On the demo repository this restored origin detection
  (previously "could not be established"), took the graph from 3 nodes / 1 edge to
  6 / 8, and cut runtime from 6.8 s to 1.9 s.
- **The phase-12 scenario fixture had never been executed.** Every `commit()` in
  `makeScenarioRepo()` ran *before* the `writeFile()` belonging to it, so the
  first commit staged an empty repository and `git commit` exited 1 with the
  reason on stdout and nothing on stderr.
- **`parseBlamePorcelain` misattributed lines** (`src/git/format.ts`). Git writes
  a commit's porcelain metadata only on that commit's *first* appearance; the
  parser carried a single "last-seen author" and charged the intervening author's
  lines to the wrong person whenever blame returned to an already-described
  commit. Author and author-time are now cached per commit hash.
- **`getRepository` could return a record for a different repository**
  (`src/cache/sqliteStore.ts`). `UPDATE repositories SET repo_root = 42` is
  silently coerced to `'42'` by TEXT affinity, so the hydrated root was not
  verifiable. The root is now checked and a mismatch reported as corruption — a
  miss, never a fatal error. This also closed a latent parity gap: the file
  backend already matched on the normalised key, the SQL one did not.
- **`getMatch`'s damage-fallback path could never fire**
  (`src/cache/sqliteStore.ts`). The `SELECT` omitted `source_id` and
  `candidate_id`, which is exactly what `hydrateMatch` falls back to when a
  result document is damaged, so a damaged document always degraded to a miss
  instead of using the intact columns.
- **`getBlocksForFile` missed rows on path-separator mismatch**
  (`src/cache/fileStore.ts`). The `WHERE` clause did not normalise `filePath`, so
  a Windows-style read could not see rows written with POSIX separators.
- **The build was broken.** `scripts/build.mjs` still referenced
  `src/webview/client/main.ts`, which the webview's move to React deleted, so the
  script failed to resolve its entry point. The webview is now built solely by
  Vite, which is what the `build` script already chained.
- `ancestry.analyzeCurrentFile` is titled "Analyze a Block in File", matching what
  the command actually does (it offers a picker) rather than claiming to analyse
  every block at once.
- The repository is now Prettier-clean throughout. It was not: 74 files failed
  `npm run format:check`, which CI runs in the `lint` job — and since every other
  job declares `needs: lint`, formatting alone would have blocked the entire
  pipeline.

### Removed

- Duplicated `export type` block in `src/commands/index.ts`, and a stale
  `Set<CommandId>` in `src/commands/registry.ts` that could not accept the
  manifest's `string` ids.

## [0.1.0] - 2026-09-27

The first public build. Ancestry is a VS Code extension that reconstructs the
**semantic evolution** of a code block — who wrote it, when, how it changed, and
where copies of it ended up — by walking the real Git history of the workspace
and comparing ASTs rather than text.

### Added

- **Extension skeleton** — `ancestry.analyzeSelection` and
  `ancestry.analyzeCurrentFile` commands, an editor context-menu entry, an
  output channel, a progress indicator, and cancellation. Configuration lives
  under the `ancestry.*` settings namespace.
- **Git engine** (`src/git`) — a thin, injection-proof wrapper over the `git`
  CLI invoked through `child_process.spawn` with an argv array and no shell.
  Repository probing, commit history with renames followed, per-commit file
  blobs, `blame`, branch enumeration, and `merge-base` queries.
- **AST extraction** (`src/parser`) — TypeScript compiler API based block
  extraction for JavaScript, TypeScript, TSX and JSX. Functions, arrow
  functions, methods, constructors, classes, interfaces, type aliases, enums,
  namespaces, variables and object literals become addressable blocks with
  1-based line ranges, containment parents and qualified names. Regex is never
  the primary parser.
- **Normalisation** (`src/normalization`) — identifier canonicalisation to
  `id:<n>` in first-occurrence order, formatting and comment removal, literal
  classing, and depth-aware token streams. `add`/`a`/`b` and `sum`/`x`/`y`
  normalise identically; behaviour-changing information is deliberately
  retained.
- **Similarity engine** (`src/similarity`) — a four-component score combining
  MinHash-estimated Jaccard over k-gram shingles, SimHash hamming similarity,
  normalised LCS over token streams, and cosine similarity of structural feature
  vectors. Candidates are pre-filtered so the expensive comparison never runs
  over every block. Results are classified `strong` / `possible` / `weak`.
- **Ancestry graph** (`src/graph`) — `EVOLVED_FROM`, `COPIED_FROM`,
  `MODIFIED_FROM`, `MOVED_FROM` and `MERGED_FROM` edges with a confidence score
  and a human-readable rationale per edge, plus origin detection that reports
  the **earliest detected match** with an explicit disclaimer.
- **3D webview** (`src/webview`) — a Three.js visualisation with time on X,
  branch on Y and module on Z; zoom, pan, orbit, node selection, ancestry-path
  highlighting, and filters for branch, file, author, similarity, edge type and
  time range. Filtering happens in the host and the sanitised payload is
  serialised into the panel.
- **Local index** (`src/cache`) — a persistent store of blocks, normalisations
  and match results with hash-based invalidation. Uses `node:sqlite` where the
  runtime provides it and falls back to a checksummed JSON store otherwise.
- **Tests** — unit suites for the git parser, extraction, normalisation,
  hashing, similarity and graph construction; integration suites that build
  real Git repositories on disk; a deterministic demo-repository generator; and
  accuracy and performance harnesses.
- **Project hygiene** — MIT license, changelog, contribution guide, code of
  conduct, security policy and threat model, troubleshooting and performance
  guides, a version roadmap, Dependabot, and a Windows + Ubuntu CI matrix.

### Changed

Nothing. This is the initial release.

### Fixed

Nothing. This is the initial release.

### Removed

Nothing. This is the initial release.

## Known limitations

These are deliberate scope decisions for v0.1, not bugs. They are listed here so
that a surprising result is never mistaken for a broken engine.

- **JavaScript and TypeScript only.** `ts`, `mts`, `cts`, `tsx`, `js`, `mjs`,
  `cjs` and `jsx` are analysed. Every other file is readable as text but is
  reported as unparsed rather than guessed at.
- **No embeddings and no LLM.** Similarity is entirely deterministic and
  structural: AST, normalisation, SimHash, MinHash, LCS and feature vectors.
  Nothing in the analysis path calls out to a model, a service or the network.
  The optional embedding path is not implemented — see `docs/roadmap.md`.
- **"Origin" means earliest detected match, not proven authorship.** Git
  history does not record intent, and the earliest match Ancestry can find is
  bounded by how much history was actually scanned. A shallow clone, a truncated
  scan, a force-push or a repository imported without its original history will
  all produce an origin that is earlier than the true origin. The UI states this
  in the disclaimer on the origin node and Ancestry never claims authorship.
- **Similarity thresholds are tuned, not universal.** The `0.90` / `0.75`
  defaults were chosen against a synthetic corpus, not validated at scale. They
  are user-tunable, and `docs/contributing.md` documents the accuracy-test
  procedure for re-tuning them.
- **Optimised for small and medium repositories.** Large-history safeguards
  exist and are configurable, but no large-repository scalability claim is made
  until it has been benchmarked. See `docs/performance.md`.
- **Single-file and whole-file starting points.** Ancestry traces one code
  block (or one file) at a time. There is no repository-wide "everything copied
  from everywhere" view.
- **Git CLI is required.** Ancestry shells out to the `git` executable. A
  workspace using a pure-JavaScript VCS implementation is not supported.

[Unreleased]: https://github.com/ancestry-tools/ancestry/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ancestry-tools/ancestry/releases/tag/v0.1.0
