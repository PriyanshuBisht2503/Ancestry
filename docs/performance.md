# Ancestry — performance strategy

**Status: the numbers in §5 have not been measured yet.** The methodology is
specified and the results table is deliberately empty. Do not fill it in with
plausible-looking figures — an invented benchmark is worse than none, because it
will be quoted back in an issue as if it were measured.

---

## 1. Where the time actually goes

An analysis is a pipeline, and each stage has a different cost profile. Before
optimising, know which stage you are looking at; the Ancestry output channel
reports per-phase durations and the final `AnalysisResult.durationMs`.

```text
resolve-repository      ~ms       a handful of git calls
parse-selection         ~ms       one file, TypeScript compiler API
read-history            s         git log / ls-tree, bounded by maxHistoryDepth
extract-blocks          s   ←     parse every candidate blob
match-history           ms        compare along the file's own history
cross-file-search       min ←     THE COST. Candidate discovery + comparison
build-graph             ms        pure data
detect-origin           ms        over the already-scored set
```

Two things dominate: **blob extraction** (a `ts.createSourceFile` per candidate
blob) and **cross-file search** (how many blocks you compare, and how many
full comparisons each one gets).

The second is the only one that grows quadratically with repository size if you
get it wrong, so it is where the design effort goes.

---

## 2. The strategy

### 2.1 Candidate pre-filter — avoiding O(n²)

The naive implementation compares every block in the repository against every
other block. With `n` blocks that is `n(n-1)/2` comparisons, each involving a
MinHash signature, an LCS, and a feature-vector cosine. At 20,000 blocks that is
200 million comparisons, which is not a slow feature, it is a broken extension.

Ancestry never does that. A candidate must survive a cheap gate before the
expensive comparison runs:

```text
all blocks in the repository
        │
        ▼  1. language / extension filter        cheap; drops most files
        │
        ▼  2. size filter: tokenCount within a
        │     band of the focus block            cheap; drops stubs and files
        │
        ▼  3. SimHash band distance              64-bit hamming distance
        │     must be ≤ a bound                  ~1 XOR + popcount per block
        │
        ▼  4. MinHash signature agreement        128 band comparisons
        │     must exceed a floor                 early-exit on first failure
        │
        ▼
CANDIDATE SET  ──►  full comparison: LCS + shape cosine + aggregation
```

Each gate is orders of magnitude cheaper than the full comparison, and each one
is _allowed to be wrong in the safe direction_ — a gate that lets something
through costs a wasted comparison, while a gate that rejects something true
costs a missed match. The gates are therefore tuned for recall (low false
rejection) and the final thresholds are tuned for precision. That split is the
whole design.

Complexity is now `O(n)` for discovery with a bounded, typically tiny candidate
set for the expensive stage. **Adding a gate is cheap. Adding a block to the
expensive stage is not.** Any new filter must be a gate, not a post-filter.

### 2.2 Hash-based cache invalidation

Extraction and normalisation are pure functions of the block's source text. That
makes them trivially cacheable, and it means invalidation is a content-hash
comparison rather than a timestamp heuristic:

- `CodeBlock.textHash` — SHA-1 of the raw text. If this is unchanged, the
  parsed block is unchanged, full stop. No mtime, no size, no "did the file
  change" guess.
- `NormalizedBlock.tokenHash` — SHA-1 of `normalizedText`. Identical structure
  implies an identical hash, so normalisation can be skipped entirely.
- `simhash`, `minhash` and `features` are all stored alongside, so a cached
  block needs no re-normalisation to be comparable.
- `SimilarityResult` is cached per `(sourceBlockId, candidateBlockId)` pair, so
  a repeat analysis of the same selection does almost no comparison work.

Version constants in `src/types.ts` are the cache's schema guard:
`ENGINE_VERSION`, `NORMALIZATION_VERSION` and `CACHE_SCHEMA_VERSION`. Bumping
any of them discards what it invalidates instead of trying to migrate it.
**When you change normalisation logic, bump `NORMALIZATION_VERSION`** — otherwise
you will debug a stale cache for an afternoon. This is the single most common
cause of "I changed the code and the scores did not move".

Entries expire after `ancestry.cache.maxAgeDays` (default 30) and the store is
purged on startup. Records are checksummed; a checksum failure is a rebuild, not
a best-effort parse.

### 2.3 Incremental scanning via `getChangedFilesSince`

Full-history analysis answers a question you rarely want answered. In practice
you want "what is new since I last looked", and the index already knows what it
looked at.

`CachedRepository` records `headCommit` and `lastIndexedAt`. On a repeat run
Ancestry asks git for what changed between the indexed commit and the current
`HEAD`:

```bash
git diff --name-status -M <indexedHead>..HEAD
git log --format=… <indexedHead>..HEAD
```

- Only those paths are re-extracted and re-normalised.
- A file whose blob hash is unchanged is skipped even if it appears in the diff.
- A path deleted in the window has its cached blocks evicted.
- If the indexed commit is no longer reachable from `HEAD` (a force-push, a
  rebase, a branch switch), the incremental path is abandoned and a full scan
  runs. Silently diffing against an unreachable commit would produce a
  confidently wrong graph.
- If the window exceeds `maxHistoryDepth`, the incremental path is abandoned for
  the same reason: a bounded scan must be a _prefix_ of the truth, not an
  arbitrary sample.

This is the difference between "re-reading the repository on every keystroke"
and "reading what changed".

### 2.4 Worker threads — future work

`ancestry.experimental.workers` exists and defaults to `false`. Worker threads
are the right answer for two things: `ts.createSourceFile` (CPU-bound, no I/O,
perfectly parallelisable) and the full similarity comparison (also CPU-bound).

Why it is not on yet, and what has to be true before it is:

- **`node:sqlite` is synchronous.** A worker pool plus a synchronous store means
  choosing where the store lives. IndexedDB in a worker, or a main-thread store
  fed by message passing, are both viable and both cost complexity.
- **The extension host is already multi-process.** Moving work off the host's
  thread may improve responsiveness without improving throughput, and only a
  measurement can tell the difference. The benchmark harness in §5 exists to
  answer exactly this.
- **The cross-file search is the real cost, and it is dominated by a
  pre-filter**, not by parsing. Parallelising parsing first is the cheap win;
  parallelising the search needs the candidate set to be materialisable.

The flag is experimental on purpose. When it is promoted, the promotion ships
with a measured speedup number in the changelog, and a setting that is on by
default must never make the extension slower on a small repository — the
hand-off threshold is part of the promotion.

### 2.5 The configured limits

Every limit is a user setting with a hard default, and every one of them exists
so that a hostile or enormous repository produces a bounded, clearly-labelled
partial answer instead of a hang.

| Setting                                 | Default  | What it bounds                               | Symptom when hit                        |
| --------------------------------------- | -------- | -------------------------------------------- | --------------------------------------- |
| `ancestry.git.maxHistoryDepth`          | `2000`   | Commits inspected per analysis               | `GraphStats.truncated = true`           |
| `ancestry.git.maxFileSizeBytes`         | `2 MiB`  | Bytes of any single file parsed              | `FILE_TOO_LARGE`                        |
| `ancestry.git.maxRepositorySizeBytes`   | `5 GiB`  | Working-tree size before analysis is refused | `REPOSITORY_TOO_LARGE`                  |
| `ancestry.analysis.maxBlocksPerFile`    | `500`    | Blocks extracted from one file               | Diagnostic, file continues              |
| `ancestry.analysis.maxBlocksTotal`      | `200000` | Blocks held in memory per analysis           | `truncated = true` + warning            |
| `ancestry.analysis.includeAllBranches`  | `true`   | Branches walked                              | Turn off to halve a history walk        |
| `ancestry.analysis.includeTests`        | `true`   | Test files in the candidate set              | Usually the largest single win          |
| `ancestry.analysis.followRenames`       | `true`   | Git rename detection during the walk         | `MOVED_FROM` edges become `COPIED_FROM` |
| `ancestry.cache.maxAgeDays`             | `30`     | Index entry lifetime                         | Evicted, recomputed next run            |
| `ancestry.similarity.candidateWindow`   | `6`      | Tokens per sliding window for MinHash        | Fewer, coarser shingles                 |
| `ancestry.similarity.shingleSize`       | `4`      | Normalised tokens per shingle                | Similar                                 |
| `ancestry.similarity.strongThreshold`   | `0.9`    | Classification band                          | Fewer `strong` edges                    |
| `ancestry.similarity.possibleThreshold` | `0.75`   | Classification band                          | Fewer nodes in the graph                |
| `ancestry.experimental.workers`         | `false`  | Whether the worker pool is used              | —                                       |

### 2.6 The rule about partial results

When a limit is hit, the graph is **not** silently short. `GraphStats.truncated`
is set, `warnings` explains what was dropped, and the `unparsed` list names every
file that could not be analysed. A partial answer that says it is partial is
useful; a partial answer that looks complete is a correctness bug, and
`docs/security.md` §8 treats it as one.

### 2.7 Webview performance

The host applies filters and serialises the payload; the webview does not
re-derive anything. Rendering notes:

- Filter before serialising, so a filtered view ships a smaller payload and the
  host — not the sandbox — owns the cost.
- Instanced rendering and level-of-detail for large graphs, so a 20,000-node
  graph does not create 20,000 draw calls.
- `localResourceRoots` is a single root (`media/`) and the webview loads no
  remote asset, so panel startup is a local file read and nothing more.
- `focusSource` carries the focus block only. The payload never contains the file
  or the repository.

---

## 3. Where this is today

Honest status, per the same standard as the results table:

| Area                           | State                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Candidate pre-filter           | Implemented; the gate thresholds are **not yet tuned by measurement**                       |
| Hash-based cache invalidation  | Implemented; warm-up benefit **unquantified**                                               |
| Incremental scanning           | Implemented; correctness on force-push/branch-switch **untested against real repositories** |
| Worker threads                 | Flag exists, path not implemented                                                           |
| Repository-size safeguard      | Implemented; the 5 GiB default is a guess, not a measurement                                |
| `maxHistoryDepth` / block caps | Implemented; defaults are conservative guesses                                              |
| Webview instancing / LOD       | Not implemented; measured FPS is unknown                                                    |
| Cancellation latency           | Cooperative; responsiveness not measured                                                    |
| Published benchmark numbers    | **None.** See §5.                                                                           |

---

## 4. Principles

1. **Bound everything, name every bound, and report every bound hit.** A limit
   that fires silently is worse than no limit.
2. **Filter early, compare late.** The expensive stage must see a set that is
   already small.
3. **Cache on content, not on time.** Hashes invalidate exactly; timestamps
   guess.
4. **Measure before optimising, and measure before claiming.** No number enters
   this document without a command that produces it.
5. **Partial is acceptable; silently partial is not.**
6. **Do not trade the extension host's stability for speed.** Memory is bounded
   before throughput is improved, because an OOM kills the host and the user's
   editor with it.

---

## 5. Benchmark methodology

Everything in this section is a procedure, not a result. The results table in
§5.6 is empty on purpose.

### 5.1 Rules for a valid measurement

- **Fixed corpus.** The same three repositories every time. Record their URLs
  and the exact commit SHA in the report; a benchmark against an unpinned
  `HEAD` is not reproducible.
- **Fixed focus block.** One named, named-line-range selection per repository.
  "Whatever the default was" changes between runs.
- **Same settings.** Record the full `ancestry.*` configuration. A run with
  `includeAllBranches: false` is a different benchmark.
- **Warm-up discarded.** One throwaway run before measuring, to page in the file
  cache and let the JIT settle.
- **At least 5 runs.** Report median and min, not mean and not a single run.
- **No other load.** Close the editor, the browser and the build. A CI runner
  with a sibling job is not a benchmark environment.
- **State the machine.** CPU model, core count, RAM, OS, Node version, VS Code
  version. A number without a machine is not a number.

### 5.2 Corpora

Three sizes, so the shape of the curve is visible rather than guessed:

| Label | Corpus                                                 | Probes                                           |
| ----- | ------------------------------------------------------ | ------------------------------------------------ |
| S     | `scripts/make-demo-repo.mjs` output (~25 commits)      | The known seven scenarios; ground truth is known |
| M     | A small permissively-licensed TS repository, pinned    | Real copy-paste, not synthetic                   |
| L     | A large monorepo, pinned, with `node_modules` excluded | Where the limits actually bite                   |

The demo repository is the one corpus where ground truth is certain, because the
generator knows which block it copied from where. It is the regression baseline;
M and L are where the real numbers come from.

### 5.3 What to measure

| Metric                   | Instrument                                                                                    | Notes                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Repository scan time** | The `read-history` phase duration, plus wall time for the git subprocesses                    | Separates git's cost from ours                                          |
| **Analysis time**        | `AnalysisResult.durationMs`, and per-phase durations from `AnalysisProgress`                  | Report the phase breakdown, not just the total                          |
| **Memory**               | `process.memoryUsage()` — `heapUsed` peak and `rss` peak, sampled during the run              | Sample on every progress callback so the peak is not missed             |
| **Cache hit rate**       | `AnalysisResult.cache.hits / (hits + misses)`                                                 | Report cold and warm separately; the warm number is the interesting one |
| **Visualisation FPS**    | `requestAnimationFrame` delta in the webview, with a fixed node count and a fixed camera path | Report p50 and the 1% low; the low frame is what users feel             |
| Blocks compared          | `GraphStats.blocksCompared`                                                                   | The direct measure of whether the pre-filter is working                 |
| Files inspected          | `GraphStats.filesInspected`                                                                   | Should be much larger than `blocksCompared` after gating                |

`blocksCompared / filesInspected` and `filesInspected / totalFiles` are the two
ratios that tell you whether §2.1 is actually working. A ratio that climbs toward
1 means the gates have stopped gating.

### 5.4 Cold versus warm

The single most important comparison in the whole exercise:

```text
cold  = index cleared, then analyse        → the honest "first run" number
warm  = re-analyse the same selection      → the number that proves caching works
```

Report both, and report `cold / warm` as a factor. If warm is not
demonstrably faster, the cache is not earning its storage, and that is a finding
worth acting on.

### 5.5 Reproducing a run

Record, for every published number:

1. Corpus URL and commit SHA.
2. Focus block: repository, path, and 1-based line range.
3. Full `ancestry.*` settings.
4. Machine: CPU, cores, RAM, OS, Node, VS Code.
5. The command, verbatim, and the raw output.
6. Median and min of 5+ runs, cold and warm separately.

Anything missing item 1, 2 or 3 is not a measurement.

### 5.6 Results

> **To be filled in from a real run. Do not invent numbers.**
>
> Every cell below is empty because no benchmark has been run yet. Fill a cell
> only from a run that satisfies all of §5.4 and §5.5, and record the corpus SHA
> and the machine in the same commit as the number. A number without its corpus
> and machine is a guess with a decimal point, and it will be quoted back at you
> in a bug report.

#### Analysis performance

| Metric             | S (demo repo) | M (small TS repo) | L (large monorepo) |
| ------------------ | ------------- | ----------------- | ------------------ |
| Repository scan    | —             | —                 | —                  |
| Analysis, cold     | —             | —                 | —                  |
| Analysis, warm     | —             | —                 | —                  |
| Cold / warm factor | —             | —                 | —                  |
| Cache hit rate     | —             | —                 | —                  |
| Peak `heapUsed`    | —             | —                 | —                  |
| Peak `rss`         | —             | —                 | —                  |
| `filesInspected`   | —             | —                 | —                  |
| `blocksCompared`   | —             | —                 | —                  |
| Truncated          | —             | —                 | —                  |

#### Visualisation

| Metric          | 1,000 nodes | 10,000 nodes | 20,000 nodes |
| --------------- | ----------- | ------------ | ------------ |
| FPS p50         | —           | —            | —            |
| FPS 1% low      | —           | —            | —            |
| Panel open time | —           | —            | —            |
| Payload size    | —           | —            | —            |

#### Environment

| Field       | Value |
| ----------- | ----- |
| CPU         | —     |
| Cores       | —     |
| RAM         | —     |
| OS          | —     |
| Node        | —     |
| VS Code     | —     |
| Date of run | —     |

#### Worker threads (`ancestry.experimental.workers`)

| Metric                      | `false` | `true` | Verdict |
| --------------------------- | ------- | ------ | ------- |
| Analysis, cold              | —       | —      | —       |
| Analysis, warm              | —       | —      | —       |
| Peak `rss`                  | —       | —      | —       |
| Small-repository regression | —       | —      | —       |

#### The benchmark command

Not written yet. When it is, it goes here and it must print this table, so that
§5.6 is regenerated by a command rather than by hand:

```bash
# TODO: implement scripts/benchmark.mjs
node scripts/benchmark.mjs --corpus <path> --focus <path>:<start>-<end> --runs 5
```

---

## 6. Optimisation history

| Change                                      | Measured effect | Corpus | Landed in |
| ------------------------------------------- | --------------- | ------ | --------- |
| Candidate pre-filter gates added            | —               | —      | v0.1      |
| Hash-based cache invalidation               | —               | —      | v0.1      |
| Incremental scan via `getChangedFilesSince` | —               | —      | v0.1      |
| _(planned)_ Worker threads for extraction   | —               | —      | v0.5      |
| _(planned)_ Tightened pre-filter bounds     | —               | —      | v0.5      |
| _(planned)_ Instanced rendering + LOD       | —               | —      | v0.4      |

A row with an em dash in the "Measured effect" column is a change we believe
helps. That belief is not evidence. Fill the column, or say so plainly in the row
and do not cite the change in a performance claim.
