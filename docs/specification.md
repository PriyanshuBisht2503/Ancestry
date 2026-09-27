# Ancestry — Specification

> Phase 0 deliverable. This document defines **what the system detects, what it
> does not detect, and the exact thresholds it uses**. Everything in
> `src/` implements this document; when code and this document disagree, this
> document is the bug report.

- **Version:** 0.1.0
- **Normalization version:** `1`
- **Graph schema:** `ancestry://graph/v1`
- **Cache schema version:** `1`

---

## 1. Problem statement

Given a code block selected in an editor, determine **how that code came to be**:
which earlier versions of it exist in the repository's Git history, where they
lived, who wrote them, when, and how each version differs from the current one —
including logic that was **copied to a different file** and evolved there
independently.

The output is a directed graph of code versions plus an interactive 3D
visualisation of that graph.

### 1.1 Non-goals

Ancestry does **not**:

- prove who originally authored a piece of logic, or why it was written;
- reconstruct intent, authorship claims, or legal provenance;
- execute code or evaluate whether it is correct;
- support languages other than JavaScript/TypeScript in v1 (see §9);
- use a language model, embedding service, or any network call in v1;
- guarantee complete history when the repository is shallow, truncated, or
  larger than the configured limits.

---

## 2. Definitions

### 2.1 Code block

A **code block** is a named or semantically meaningful syntactic construct
extracted from a source file by the TypeScript compiler API.

Recognised kinds:

| Kind             | Syntax                                                                   |
| ---------------- | ------------------------------------------------------------------------ |
| `function`       | `function f() {}`, `export default function () {}`                       |
| `arrow-function` | `const f = () => {}`, object-literal / class-property function values    |
| `method`         | class methods, object-literal methods, getters, setters, static methods  |
| `constructor`    | `constructor(...)`                                                       |
| `class`          | `class C {}`                                                             |
| `interface`      | `interface I {}`                                                         |
| `type-alias`     | `type T = ...`                                                           |
| `enum`           | `enum E {}`                                                              |
| `namespace`      | `namespace N {}`, `module N {}`                                          |
| `variable`       | a variable declaration that is not a function                            |
| `object-literal` | an object literal assigned to an exported/config-shaped variable         |
| `block`          | a bare statement block, used only as a fallback for unrecognised regions |
| `unknown`        | classified but not treated as a block                                    |

**Excluded by design:**

- Ambient declarations (`declare …`, `.d.ts` signature-only nodes).
- TypeScript overload signatures. A class with two overload signatures and one
  implementation produces **one** `method` block, containing the implementation.
- Bare statement fragments. Statements inside a function belong to that
  function, not to separate blocks.

Blocks nest. `parentId` records containment, so a class contains its methods and
a namespace contains everything inside it.

### 2.2 Selection → block

When the user selects a range, the range is resolved to **one** block by
`findBestBlockForRange`:

1. **Containment wins.** Among all blocks that fully contain the selection, take
   the smallest span. Ties break by specificity: `method` > `class`,
   `function` > `block`, any function-like kind > any container kind.
2. **Largest overlap wins** if nothing contains the selection. Ties break by
   smaller span, then by earlier start line.
3. **No block** ⇒ the extension synthesises a single `block`-kind pseudo-block
   covering exactly the selection, and normalises that. Ancestry still works on
   arbitrary code fragments; it just has no name to report.

A single-line cursor with no selection is treated as a one-line selection.

### 2.3 Code version

A **code version** (an `AncestryNode`) is the triple _(block, file, commit)_.
The same logic appearing in three files across five commits is six code
versions, not one. Nodes are uniquely identified by
`makeNodeId(blockId, commit)`.

### 2.4 Normalised form

The **normalised form** of a block is a canonical token stream that erases
differences which do not change program behaviour, while preserving differences
that do. It is defined in `src/normalization`; its normative rules are:

- Formatting, whitespace, line breaks, and comments are removed entirely.
- **Local** identifiers (variables, parameters, inner functions, class members
  declared inside the block) are canonicalised to `id:1`, `id:2`, … in
  first-occurrence order. The same original name always maps to the same
  canonical name within a block, so repeated references stay consistent.
- **Free** identifiers — globals, imports, names not declared inside the block —
  are **preserved** as `ext:<name>`. Changing `console.log` to `window.log` is a
  behavioural change and must be detected.
- **Property** names in `obj.foo`, object literals, and class members are
  **preserved** as `prop:<name>`. They are API surface.
- **Type** names are **preserved** as `type:<name>`.
- **Numeric** literals keep their value (hex/binary/octal normalised to decimal,
  `_` separators stripped, floats rounded to 6 dp, `-0` → `0`).
- **String** literals are **not** emitted verbatim. They become
  `lit:str:<len>:<class>` where class ∈ `empty | ident | url | path | other`.
  This keeps discriminating structure without copying source text into hashes
  and logs. Trade-off, stated plainly: changing `'red'` to `'blue'` does _not_
  change the normalised form. Configuration strings are not logic.
- **Boolean/null/undefined** are preserved verbatim.
- **Template literals** contribute their interpolation expressions; the quasi
  text becomes `lit:tmpl:<n>`.
- **Regex literals** become `lit:regex` plus flags; the pattern body is never
  emitted.
- Nesting `depth` is recorded and encoded for block-like tokens, so
  `{ a; { b } }` and `{ a; b; }` differ.

Two blocks with identical normalised text are **structurally identical** and
share a `tokenHash`. This is a hard equivalence, not a heuristic.

---

## 3. Similarity

### 3.1 Components

Four independent components, each in `[0, 1]`:

| Component | Method                                                           | Measures                                |
| --------- | ---------------------------------------------------------------- | --------------------------------------- |
| `jaccard` | MinHash (128 bands) estimate over k-gram shingles, default k = 4 | local edit distance robustness          |
| `simhash` | `1 - hamming/64` over 64-bit SimHashes of the token stream       | global shape, near-constant cost        |
| `lcs`     | `2·LCS/(                                                         | a                                       | +   | b   | )` over the token streams | order sensitivity, insertions/deletions |
| `shape`   | cosine similarity of the structural feature vectors              | node-kind/operator/control-flow profile |

### 3.2 Combination

Weighted mean over the components that were **actually computed**, renormalised
so a skipped component cannot drag the score down.

| Component | Weight | Rationale                                              |
| --------- | ------ | ------------------------------------------------------ |
| `jaccard` | 0.50   | most robust to small edits; the primary signal         |
| `simhash` | 0.20   | cheap global confirmation; catches gross restructuring |
| `lcs`     | 0.20   | catches reordering that set similarity ignores         |
| `shape`   | 0.10   | weak tie-breaker on control-flow profile               |

A component is skipped when it cannot be computed: `jaccard` when either side
has fewer than 3 shingles or an empty MinHash signature; `lcs` when either token
sequence is empty; `shape` when either feature map is empty. `componentsUsed` on
every `SimilarityResult` records what contributed.

**Exact-match fast path:** if `tokenHash` values are equal, the score is exactly
`1` and the classification is `strong`, without computing any component. This is
both a correctness statement and the mechanism that makes the graph and the cache
coherent.

### 3.3 Thresholds

| Score       | Classification | Meaning                                 |
| ----------- | -------------- | --------------------------------------- |
| ≥ 0.90      | `strong`       | strong candidate                        |
| 0.75 – 0.90 | `possible`     | possible candidate                      |
| 0.60 – 0.75 | `weak`         | reported only when explicitly requested |
| < 0.60      | `unrelated`    | ignored entirely                        |

> **These are empirically validated defaults, not universal constants.** They
> are the values that produced F1 ≥ 0.9 on the accuracy corpus in
> `tests/similarity/accuracy.test.ts`. They are exposed as
> `ancestry.similarity.strongThreshold` and
> `ancestry.similarity.possibleThreshold` precisely because they are not
> universal. The `ignore` floor is derived, not configured, to keep the bands
> monotonic.

### 3.4 Worked examples

| Transformation                                   | Expected              | Why                                 |
| ------------------------------------------------ | --------------------- | ----------------------------------- |
| Renamed function + renamed parameters            | `1.0` (`strong`)      | all identifiers are local           |
| Reindented, reformatted, comments added          | `1.0`                 | formatting/comments are not emitted |
| Moved to another file, renamed, doc header added | `> 0.9`               | same normalised text                |
| One extra statement added                        | `> 0.75` (`possible`) | Jaccard falls, LCS stays high       |
| A statement reordered                            | `0.75 – 0.9`          | LCS drops, Jaccord holds            |
| `+` → `-`                                        | `< 0.9`               | operator token changes              |
| `==` → `===`                                     | `< 0.9`               | operator token changes              |
| `obj.foo` → `obj.bar`                            | `< 0.9`               | property names are preserved        |
| `User` → `Account`                               | `< 0.9`               | type names are preserved            |
| `'red'` → `'blue'`                               | `≈ 1.0`               | **known limitation** — see §3.5     |
| Two unrelated functions                          | `< 0.6`               | no shared structure                 |

### 3.5 Known false negatives

Stated explicitly so they are not mistaken for bugs:

1. **String literal value changes** are invisible by design (§2.4). Ancestry
   compares _logic_, not configuration.
2. **Fully renamed free identifiers** are visible, so a version that swapped
   `fs` for a local `fileSystem` helper scores lower than its true similarity.
3. **Cross-language copies** cannot be detected in v1 — a TypeScript port of a
   Python function shares no token stream.
4. **Small blocks are unstable.** A block under ~8 normalised tokens has a noisy
   Jaccard estimate; the MinHash component is skipped and `shape`/`simhash`
   dominate. Ancestry surfaces the components, not just the total, so a user can
   see when this happens.
5. **History truncation.** A shallow clone, a shallow fetch, or a hit against
   `maxHistoryDepth` means the "earliest detected match" is the earliest _in the
   scanned window_. `GraphStats.truncated` and a warning are always set when this
   occurs, and the UI states it.

### 3.6 Candidate pre-filtering

Full comparison is `O(n²)`, which is not viable. Ancestry shortlists first:

1. SimHash Hamming distance ≤ 24 of 64.
2. `|Δ tokenCount| ≤ 0.6 · max(tokenCount)`.
3. MinHash band agreement: the 128 bands are grouped into 16 groups of 8, and at
   least 3 groups must agree completely (16 comparisons instead of 128).

Only shortlisted candidates receive a full `compareBlocks`. Measured recall of
the pre-filter against a brute-force sweep is ≥ 0.95 on the synthetic corpus;
it is a tunable trade-off, not a guarantee.

---

## 4. Ancestry relationships

| Edge type       | Direction                         | Assigned when                                                                                                                       |
| --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `EVOLVED_FROM`  | later → earlier                   | same path, similarity ≥ `possible`, and the change is a _modification of the same construct_ (same name or same line neighbourhood) |
| `MODIFIED_FROM` | later → earlier                   | same path, similarity in `[ignore, possible)` — a weak same-path relationship, kept with low confidence                             |
| `MOVED_FROM`    | later → earlier                   | different path, similarity ≥ `strong`, and either git reported a rename of the containing file or the block name matches            |
| `COPIED_FROM`   | later → earlier                   | different path, similarity ≥ `possible`, and no rename evidence                                                                     |
| `MERGED_FROM`   | merge-commit node → its parent(s) | the later commit is a merge and the block exists in a parent                                                                        |

Rules that make the graph deterministic:

- Every edge carries a `confidence` in `[0, 1]` and a human-readable
  `rationale` (e.g. `git detected rename (score 96)`).
- Evidence is ranked: an explicit git rename beats a name match, which beats
  similarity alone. `MOVED_FROM` is only emitted when there is rename or name
  evidence; similarity alone yields `COPIED_FROM`.
- Edges always point backwards in time (`from` is later, `to` is earlier). The
  graph is acyclic with respect to commit timestamps, but the builder is
  cycle-safe regardless.
- A node gets at most one **primary** incoming edge (its best predecessor); extra
  plausible predecessors become additional edges with lower confidence, which
  keeps branches and merges visible without producing a hairball.

---

## 5. Origin detection

Origin is the earliest node in the ancestry chain whose similarity to the focus
node is at least `possible`.

```
origin.basis:
  earliest-strong-match   — earliest node with similarity >= strong
  earliest-match          — earliest node with similarity >= possible
  inconclusive            — fewer than two nodes, or nothing above `ignore`
```

**Required wording.** The UI and every exported artifact call this the
**"earliest detected semantic match"**. It is never presented as the original
author, the first version ever written, or a claim of intent. The exact
disclaimer string is carried on `OriginInfo.disclaimer` and rendered verbatim:

> Git history records commits, not intentions. This is the earliest version
> Ancestry detected that is sufficiently similar to your selection — not proof
> of original authorship. The search covered the history available in this
> repository, which may be truncated by a shallow clone or by the configured
> depth limit.

---

## 6. Graph model

Canonical shape is `AncestryGraph` in `src/types.ts`. Normative additions:

- `id` — a stable hash of `(repositoryRoot, focusBlockId, generatedAt)`.
- `stats.truncated` — true when any configured limit was hit. The UI must show a
  banner when it is true.
- `stats.filesInspected` / `stats.blocksCompared` — the honest cost accounting.
- `warnings` — human-readable, non-fatal: skipped files, unparseable sources,
  limits hit, shallow history.
- `unparsed` — every file that could not be analysed and why, so a missing
  ancestor is always explainable.
- The graph serialises to JSON with `schema: 'ancestry://graph/v1'` and is
  round-trippable through `parseGraphJson`.

### 6.1 Visualisation mapping

| Axis  | Meaning                                                                     |
| ----- | --------------------------------------------------------------------------- |
| **X** | time (earliest → latest)                                                    |
| **Y** | branch (one row per distinct branch; `(detached)` for nodes with no branch) |
| **Z** | file module (`moduleForPath`: top-level dir, or top-two segments)           |

Layout is deterministic for a given graph — no `Math.random`, no iteration-order
dependence — so the same analysis always produces the same picture.

---

## 7. Search scope and its limits

For the focus block, Ancestry:

1. Walks the commit history of the selection's file (`--follow` when
   `followRenames` is on), then
2. extends to the paths in commits that touched that file, and
3. searches other files in the repository for blocks above the ignore floor,
   bounded by `maxBlocksTotal` and `maxHistoryDepth`.

`GraphStats.truncated` is set whenever step 2 or 3 stopped early. Files that are
unsupported, binary, oversized, or unparseable are recorded in `unparsed` with a
reason. **A file Ancestry skipped is always visible in the report** — silence
would misrepresent coverage.

Configuration limits (all in `package.json`):

| Setting                      | Default | Purpose                                         |
| ---------------------------- | ------- | ----------------------------------------------- |
| `git.maxHistoryDepth`        | 2000    | commits inspected per analysis                  |
| `git.maxFileSizeBytes`       | 2 MiB   | per-file ceiling                                |
| `git.maxRepositorySizeBytes` | 5 GiB   | refuse absurd repositories with a clear message |
| `analysis.maxBlocksPerFile`  | 500     | blocks from one file                            |
| `analysis.maxBlocksTotal`    | 200 000 | blocks in memory per analysis                   |
| `analysis.includeTests`      | `true`  | include test/spec paths in the search           |

v1 is optimised for **small and medium repositories**. It makes no claim about
unbounded large-repository scalability until benchmarked (`docs/performance.md`).

---

## 8. Privacy and security

Normative, and enforced in code:

1. **All processing is local.** v1 makes no network requests. There is no
   telemetry backend; `ancestry.telemetry.enabled` exists to make the posture
   explicit and is never read by an outbound path.
2. **Source code is never logged** unless the user sets
   `ancestry.privacy.logSourceCode`. `scrubPaths` additionally redacts absolute
   paths from all log output.
3. **Git is invoked without a shell**, using an argv array, a timeout, a bounded
   output buffer, and a sanitised child environment. Repository paths and
   revisions are validated; a path beginning with `-` is rejected outright to
   prevent option injection.
4. **The webview runs under `default-src 'none'`** with a per-load script nonce,
   `connect-src 'none'`, and no `eval`/`new Function`. Messages in **both**
   directions are runtime-validated. The graph payload is sanitised and capped
   before it crosses the boundary.
5. **The local index is user-owned**, stored under the extension's global storage
   directory, never uploaded, and evictable. Cache writes are atomic and
   checksummed; a corrupt entry is discarded, never fatal.
6. **The index contains source text.** It is documented, local, and clearable
   via `Ancestry: Clear Ancestry Index Cache`.

Threat model and non-goals: `docs/security.md`.

---

## 9. Language support

v1 analyses `ts`, `mts`, `cts`, `tsx`, `js`, `mjs`, `cjs`, `jsx`.

**Decision: no Tree-sitter in v1.** The plan lists Tree-sitter, and it is the
right long-term answer for multi-language support — but adding a WASM grammar
layer before a single parser is validated would make the accuracy of the
similarity engine unmeasurable. The TypeScript compiler API is deterministic,
already a dependency, already bundled with the extension, and gives an exact AST
for the v1 scope.

The parser is therefore an **adapter boundary**, not a monolith: `createSourceFile`
is the single seam, and a Tree-sitter backend is a drop-in replacement for it
without touching normalisation, similarity, the graph, or the UI. See
`docs/roadmap.md` for the migration steps and what they would cost.

Files with an unrecognised extension are reported as `UNSUPPORTED_LANGUAGE` with
a list of what _is_ supported — never silently ignored.

---

## 10. Error handling contract

Every anticipated failure is an `AncestryError` with a `code` and a
`userMessage` safe to render in a notification. **One unanalysable file or commit
must never abort an analysis.** Handled codes:

`NO_GIT_REPOSITORY`, `GIT_NOT_FOUND`, `GIT_COMMAND_FAILED`, `DETACHED_HEAD`,
`SHALLOW_CLONE`, `REPOSITORY_TOO_LARGE`, `NO_SELECTION`, `EMPTY_SELECTION`,
`UNSUPPORTED_LANGUAGE`, `PARSE_FAILED`, `BINARY_FILE`, `FILE_TOO_LARGE`,
`FILE_DELETED`, `NO_MATCHES`, `CACHE_CORRUPT`, `CACHE_UNAVAILABLE`,
`WEBSITE_FAILED`, `INVALID_PATH`, `CANCELLED`, `INTERNAL`.

`DETACHED_HEAD` and `SHALLOW_CLONE` are **warnings**, not failures: the analysis
proceeds with the history available and the limitation is recorded in
`graph.warnings`.

---

## 11. Evaluation

Correctness is measured, not asserted. `tests/similarity/accuracy.test.ts` and
`tests/integration/` report **precision, recall, F1, false-positive rate, and
false-negative rate** for the `strong` and `possible` classifications over a fixed
corpus, and gate the build on **F1 ≥ 0.9**.

`docs/performance.md` records the methodology for scan time, analysis time,
memory, cache hit rate, and visualisation FPS. Numbers are not invented; the
results table is filled from a real benchmark run.

---

## 12. Definition of done

- [x] Supported languages defined (§9)
- [x] "Code block" defined and justified (§2.1)
- [x] Selection→block resolution defined (§2.2)
- [x] Similarity thresholds defined and labelled as empirical (§3.3)
- [x] Graph node/edge types defined (§4, §6)
- [x] Origin wording fixed as "earliest detected semantic match" (§5)
- [x] Error contract enumerated (§10)
- [x] Privacy posture made normative (§8)
- [x] Known false negatives stated (§3.5)

Code-level completion against the plan's §9 checklist is tracked in `README.md`.
