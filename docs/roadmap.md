# Ancestry — roadmap

This is the plan's version roadmap, expanded into per-version scope with
**exit criteria**. A version ships when its exit criteria are met, not when its
feature list is checked off.

The sequencing rationale is the most important thing on this page, so it comes
first.

---

## Sequencing rationale

> **Do not chase features before proving the semantic matching engine works.**

The plan names the decisive technical milestone:

> Given two pieces of source code with renamed variables and moderate structural
> changes, correctly determine whether they represent substantially similar
> logic.

Everything else — the history walker, the graph builder, the 3D view, the cache
— exists to _present_ the answer to that question. If the answer is wrong, a
beautiful visualisation of the wrong answer is worse than no tool, because it
looks authoritative.

So the order is deliberately inverted relative to how a product is usually
built:

1. **Prove the judgement first.** AST extraction, normalisation, and a scored
   similarity function, measured against a labelled corpus, before any UI.
2. **Then add reach.** History walking, branches, merges, cross-file search.
3. **Then add presentation.** The 3D webview, once the data is trustworthy.
4. **Then add speed.** Caching, workers, incremental scanning.
5. **Then harden.** Tests, security, error handling, large-repository
   safeguards.

The tempting move at step 3 is to jump to step 4 for a nicer demo, or to add
embeddings to fix disappointing accuracy numbers. Both skip the work that makes
the accuracy numbers mean something. If the deterministic engine is wrong, an
embedding model makes it wrong in a way nobody can explain, and it also makes
Ancestry a tool that sends your source code to a third party.

The project is treated as three separate engineering problems:

| Problem                           | Core                                     | Fails how                              |
| --------------------------------- | ---------------------------------------- | -------------------------------------- |
| **A — Code understanding**        | AST, normalisation, similarity           | wrong scores; the graph is a lie       |
| **B — Historical reconstruction** | Git history, cross-file/branch relations | missing or invented edges              |
| **C — Human understanding**       | Interactive 3D visualisation             | unusable, or over-claims what it shows |

The project is strong when all three are integrated **and evaluated
quantitatively**. An unevaluated integration is three demos stapled together.

---

## v0.1 — Proof of concept

**Status: shipped 2026-09-27.** See [CHANGELOG.md](../CHANGELOG.md).

Scope: the extension skeleton, a real Git engine, AST extraction for JS/TS,
normalisation, a scored similarity function, the ancestry graph, a local index,
the 3D webview, and the test/CI/documentation floor.

### Exit criteria

- [x] Selecting a function and running the command produces a graph, not a crash.
- [x] The same function is recognised after a formatting-only change.
- [x] A variable-renamed copy scores in the `strong` band on the synthetic corpus.
- [x] `src/types.ts` is frozen and every module conforms to it.
- [x] Every anticipated failure is an `AncestryError`; no unhandled rejection.
- [x] No source text in logs; no network call in the engine.
- [x] CI green on Windows and Ubuntu: lint, type check, unit, integration, build,
      package.
- [x] Documentation complete: architecture, specification, contributing,
      troubleshooting, security, performance, roadmap.
- [x] The demo repository generator produces a deterministic history covering
      all seven Phase 12 integration scenarios.

### Known debt carried into v0.2

- Only JS/TS/TSX/JSX.
- No accuracy numbers on a real-world corpus.
- No cache warm-up measurement; the "second run is faster" claim is
  unquantified.
- No large-repository behaviour measured. `maxBlocksTotal` defaults are
  guesses.
- No published Marketplace package; `package.json` still needs `repository` and
  an `icon`.

---

## v0.2 — Semantic detection

**Theme: make the judgement defensible.** This is the version that decides
whether the project is viable.

Scope:

- Tune normalisation rules against a real corpus, not just synthetic fixtures.
- Calibrate the four similarity components and the band thresholds with measured
  precision/recall/F1, and record the procedure in
  [contributing.md §5](contributing.md#5-tuning-the-similarity-thresholds).
- Expand the accuracy harness: a labelled corpus of at least a few hundred
  block pairs drawn from public permissively-licensed repositories, covering
  copy-paste, rename, refactor, reformat, generated code, vendored code and
  unrelated look-alikes.
- Improve copy-detection for the hard cases the v0.1 corpus does not contain:
  reordered statements, inverted conditions, `if`/`else` → guard-clause rewrites,
  wrapper extraction, and vendor directories.
- Add per-node-type handling for every construct the extractor can emit, so no
  node type falls through to the depth-only default.
- Report the full `breakdown` and `componentsUsed` in the UI, and let the user
  see _why_ a candidate was surfaced.
- Make thresholds comfortable to tune live: apply a threshold change without
  re-running the analysis.

### Exit criteria

- [ ] Accuracy is measured on a labelled corpus and the numbers are published in
      the README, with the corpus described well enough to reproduce them.
- [ ] **False-positive rate on unrelated look-alikes is the headline number**,
      and it is good enough that a `strong` edge can be trusted at a glance. A
      spurious `strong` edge is worse than a missing `possible` one.
- [ ] Renamed-variable copies are detected at a rate that makes copy detection
      feel reliable on real repositories.
- [ ] Moderate structural rewrites are classified `possible` rather than
      ignored, without dragging the false-positive rate up.
- [ ] Every threshold in the shipped defaults has a documented derivation.
- [ ] The accuracy suite runs in CI and a regression in F1 fails the build.
- [ ] A method is published for reproducing a score against a specific block, so
      a user can argue with it.

---

## v0.3 — Ancestry

**Theme: cover the history honestly.**

Scope:

- Cross-file history walking: when a block's own file history goes cold, search
  the repository for candidates instead of stopping.
- Branch-aware reconstruction: distinguish a line that was abandoned on a branch
  from one that shipped on `main`. `includeAllBranches` stops being a boolean and
  becomes a set of refs to walk.
- Merge semantics: a merge commit resolves two histories; decide and document how
  edges are attributed across it, and represent both parents rather than picking
  one.
- Delete-and-restore: detect a block that was removed and reintroduced, which
  currently produces a gap in the timeline.
- Refactor-shape awareness: a pure move, a rename-plus-edit, and a
  wrap-in-a-new-function are different relationships and should stop being
  interchangeable.
- Origin detection: make the `earliest-match` rule better defined and make the
  disclaimer more precise about what was and was not scanned.
- Blame integration: per-line author attribution on a node's diff against its
  parent.

### Exit criteria

- [ ] A moved, a copied, and a modified block are distinguishable in the graph
      and the edge `rationale` explains which heuristic fired.
- [ ] Branch divergence and merge both reconstruct without inventing edges
      that no commit supports.
- [ ] Delete-and-restore is a visible, connected path in the timeline, not a
      discontinuity.
- [ ] Origin detection reports `inconclusive` rather than guessing when
      confidence is low.
- [ ] Every edge in the graph is traceable to either a Git fact or a recorded
      similarity computation. No edge exists "because it looked right".
- [ ] History walks respect `maxHistoryDepth` and report `truncated: true` when
      they hit it.

---

## v0.4 — Visualisation

**Theme: make the answer readable.**

Scope:

- Interaction quality: camera framing, keyboard navigation, a focus-follow mode,
  and a way to walk the ancestry path one hop at a time.
- Filtering: by branch, file, author, similarity floor, edge type, and time
  range — all applied host-side so the payload shrinks as well as the drawing.
- Detail panel: the node's source, its diff against its parent, the full
  similarity breakdown, and the commit metadata.
- Compare mode: put two or more versions side by side as a diff.
- Time-scale control (linear/log) and a branch lane per branch.
- Export: the existing JSON export, plus a shareable static HTML view with no
  extension installed.
- Performance: instanced rendering and level-of-detail so a 20,000-node graph
  stays interactive.
- Onboarding: a first-run walkthrough against the generated demo repository, so
  nobody meets an empty graph first.

### Exit criteria

- [ ] A user can go from "select a function" to "understand where it came from"
      without reading documentation.
- [ ] A 20,000-node graph remains interactive; the FPS measurement is published.
- [ ] The panel never claims more certainty than the data supports: no "original
      author", no bare verdict without a score, and the origin disclaimer is
      visible.
- [ ] Exported output is self-contained and readable without VS Code.
- [ ] The webview remains CSP-clean, and the payload carries no more than the
      focus block's source text.

---

## v0.5 — Performance

**Theme: make it fast on real repositories.**

Scope:

- Incremental scanning driven by `getChangedFilesSince`, so a repeat analysis
  only looks at commits the index has not seen.
- Warm-up measurement: publish real cache hit rates and second-run timings rather
  than asserting that caching helps.
- Worker threads for parsing and similarity, behind the existing
  `ancestry.experimental.workers` flag — measured, then promoted out of
  `experimental` with a real speedup number.
- Candidate pre-filter tightening: the cost is dominated by the number of blocks
  that reach full comparison, so the pre-filter is the highest-leverage work.
- Index compaction, incremental similarity-match persistence, and a smaller
  on-disk footprint.
- Cancellation that is actually prompt: a cancelled analysis should stop within
  a frame or two, not at the next commit boundary.
- Publish the benchmark harness described in
  [performance.md §5](performance.md#5-benchmark-methodology) as a repeatable
  command, with a results table anyone can regenerate.

### Exit criteria

- [ ] Published numbers, from a real run, for repository scan time, analysis
      time, peak memory, cache hit rate and visualisation FPS, at three
      repository sizes.
- [ ] A warm second run is demonstrably faster than a cold run, by a stated
      factor, on the same machine.
- [ ] No O(n²) path remains in the cross-file search.
- [ ] Workers measurably help before the flag is promoted out of `experimental`.
- [ ] Memory stays bounded on a large repository; no OOM, no runaway heap.
- [ ] A cancellation is honoured promptly and leaves no partial index state.

---

## v0.6 — Production hardening

**Theme: earn trust.**

Scope:

- Error handling completed against the full Phase 14 list, each with a
  user-facing message and a `docs/troubleshooting.md` entry.
- Large-repository safeguards calibrated against measurements rather than
  guesses; a clear refusal above the ceiling instead of a hang.
- Security review of the whole surface, with the findings recorded and the
  non-goals in [security.md §10](security.md#10-known-non-goals-for-v01) still
  true.
- Accessibility: keyboard-only operation, focus order, contrast, and
  screen-reader labels in the webview.
- Internationalisation of user-facing strings.
- Telemetry: **still none**, and this is a deliberate v0.6 line. If it is ever
  added it is opt-in, disclosed in the README and the release notes, and does
  not carry source code. This decision gets its own changelog entry.
- Support for VS Code's extension profile, workspace trust, and virtual
  workspaces — see the later section for why virtual workspaces are _not_ v0.6.
- Marketplace polish: icon, screenshots, a demo GIF, and a real `repository` URL.

### Exit criteria

- [ ] Every anticipated failure produces a message a user can act on.
- [ ] One unanalysable file never ends an analysis.
- [ ] An external security review finds no known critical issues.
- [ ] Keyboard-only operation completes the full analyse → explore → export flow.
- [ ] `package.json` is publishable: `repository`, `icon`, `README`, `CHANGELOG`,
      `LICENSE`, and a signed release path.
- [ ] Installing the packaged VSIX and running it against the demo repository
      works end to end, with no repository checked out by hand.

---

## v1.0 — Public release

**Theme: hand it over.**

Scope:

- A stable, documented, semver-honest public release on the Marketplace and as an
  open-source repository.
- Documentation treated as a product: architecture, specification, the
  extension guide, the accuracy methodology, and a benchmark page with
  reproducible numbers.
- The demo repository as a first-class artefact, generated by a command a user
  can run, with a recorded walkthrough of what each of its seven scenarios
  demonstrates.
- A published, versioned similarity methodology — including the accuracy
  figures and their limitations — so a user can judge the tool on evidence.
- A published security policy with a working reporting channel.
- Contribution onboarding: a good first issue list, and the contributor guide
  actually matching how the project works.
- A written policy on what Ancestry will never do with your code.

### Exit criteria

- [ ] Every item on the plan's Definition of Done is checked.
- [ ] The accuracy methodology and its numbers are public, with limitations
      stated as prominently as the results.
- [ ] The security reporting channel is monitored and acknowledged within the
      published timeline.
- [ ] A new user reaches a meaningful graph within five minutes of installing,
      using only the demo repository and the README.
- [ ] The project can be handed to a new maintainer: build, test, release and
      incident response are all documented well enough to run without the
      original author.

---

## Later, not scheduled

These are the things that are genuinely wanted and genuinely not ready. They are
listed with the reason they are not on the roadmap, so the decision can be
revisited instead of re-argued.

### Embeddings — the important one

A local embedding model over normalised token streams, used as a fifth similarity
component to catch the rewrites that structural comparison cannot.

**Why it is not scheduled.** It is both an accuracy question and a data-egress
question, and the second is not answerable by a benchmark. An embedding model
means a model artifact, a dependency, and — if the model is not local — a
third party receiving your source code. Ancestry's entire privacy posture rests
on the claim in
[security.md §4](security.md#4-the-local-processing-guarantee), and adding
remote inference would retract it.

**Conditions for doing it.**

- The v0.2 accuracy harness exists and shows where the deterministic engine
  actually fails. Embeddings without a baseline are unfalsifiable.
- The model is local and on-device, with no network path at all. Anything else is
  a different product with a different threat model.
- It is off by default, opt-in per repository, and disclosed in the README, the
  release notes and `security.md`.
- The deterministic components remain available, and a user can turn the
  embedding component off and get the old numbers back.

### Tree-sitter and multi-language

A tree-sitter grammar per language family, behind the `LanguageAdapter` interface
already in place, so the parser stops being a TypeScript-only component.

**Why it is not scheduled.** v1 chose a single deterministic parser precisely so
that similarity behaviour would have one explanation. Grammar-per-language means
per-language normalisation decisions, per-language accuracy results, and a
matrix of bugs. Adopting it before the v0.2 numbers exist would make it
impossible to tell whether a recall improvement came from the new grammar or
from a threshold change.

**Conditions for doing it.** A measured, documented recall loss on a second
language; a normaliser that handles multiple node-type vocabularies; and an
accuracy corpus per language, not one shared one.

### Worktree and virtual-repository support

Running Ancestry against a linked git worktree, a bare repository, or a virtual
workspace such as `vscode-vfs://` and a remote SSH workspace.

**Why it is not scheduled.** It is not a small feature, it is a different
execution model. A virtual workspace has no `.git` directory and no local
process to shell out to, so the Git engine, the cache, the "read a blob from
disk" model and the file-size heuristics all have to change. A worktree has a
different `git-dir`/`work-tree` relationship that the current path validation
assumes it does not have.

**Conditions for doing it.** Workspace-trust integration first, then an explicit
decision about whether remote execution is acceptable — which is a security
posture decision, not an implementation one, and belongs in a revision of
`docs/security.md`.

### Smaller ideas, honestly parked

| Idea                    | Why it is parked                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Team/enterprise mode    | Requires a service. Ancestry's design has no server component.                     |
| PR annotations          | Requires a Git host integration, which is out of MVP scope.                        |
| Blame heatmaps          | Depends on v0.3's blame integration being accurate first.                          |
| React in the webview    | Only if the UI genuinely becomes unmanageable. Vanilla TS was chosen deliberately. |
| Plugin API for adapters | Premature until a second non-TypeScript language exists to motivate it.            |
| Sharing a graph via URL | Contradicts "no source text leaves the process" unless made opt-in and lossy.      |

---

## How to change this document

The roadmap is a set of commitments, not a wish list. When one changes:

- Update the exit criteria, not just the scope. A version with no exit criteria
  is a version that ships whenever someone is tired.
- If a version is cut, say which criteria moved and why. "Cut for scope" is
  fine; silently dropping a criterion is how a roadmap stops being trustworthy.
- If a "later" item becomes scheduled, it gets a version, a scope and exit
  criteria — or it stays later.
- Keep the sequencing rationale at the top intact. It is the part that is
  hardest to reconstruct later and easiest to lose.
