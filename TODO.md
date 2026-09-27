# Ancestry — status

Working notes. Not documentation — see `README.md` and `docs/` for those.

Last verified: **52 test files, 1883 tests, 0 failures.**

## Gates — all green

| Gate                   | Result                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | clean, both tsconfigs                                                                                             |
| `npm run lint`         | 0 errors (5 `no-console` warnings in build scripts and metric printing)                                           |
| `npx prettier --check` | clean                                                                                                             |
| `npm run test`         | 52 files, 1883 tests, 0 failures                                                                                  |
| `npm run build`        | `dist/extension.js` (9.9 MB, embeds the TypeScript compiler) + `media/webview.js` (0.98 MB) + `media/webview.css` |

Starting point for this session was **48 files, 1840 passing, 13 failing**.

---

## Product bugs found and fixed

### 1. A selection always resolved to the last line of the file — CRITICAL

`clampLine`'s signature is `(value, fallback, minimum)`, but `resolveFocus` called it as
`clampLine(request.startLine, 1, lastLine)` — passing the line **count** as the **minimum**.
`Math.max(lastLine, startLine)` therefore pushed every selection to the file's final line, so
"Analyse the function I selected" silently analysed whatever was at the bottom of the file.

Every unit test passed because each stage was correct in isolation and nothing exercised the
wiring. `tests/analysis/scenarios.test.ts` was referenced by `helpers.ts` but had never existed.

Effect on the demo repo: `Selected requireScopes` → `Selected validateToken`; origin "could not be
established" → established; 3 nodes / 1 edge → 6 / 8; 6.8 s → 1.9 s.

Fixed with `clampLineTo`, whose bounds read low-to-high at the call site and so cannot be
transposed. Applied in `resolveFocus` and `synthesizeSelectionBlock`; inverted ranges are now
normalised instead of yielding an empty block.

### 2. The cross-file sweep was suppressed by the wrong signal

`CROSS_FILE_TRIGGER = 4` was applied to _every_ accepted candidate, including earlier versions of
the block in its own file. A function that evolved across five commits skipped the sweep every
time — exactly backwards, since the more interesting a selection's own history is, the likelier a
copy of it sits in another file.

The trigger now applies only to candidates that reached outside the focus **module**. Module rather
than exact path, deliberately: with renames followed, a same-file ancestor carries its _old_ path,
so an exact comparison would score it as a cross-file hit and suppress the sweep for precisely the
histories that need it.

**Cross-file recall 0.000 → 0.500.** The renamed copy is now found.

### 3. The phase-12 scenario fixture had never been executed

Every `commit()` in `makeScenarioRepo()` ran _before_ the `writeFile()` belonging to it, so the
first commit staged an empty repository and `git commit` exited 1 with the reason on stdout and
nothing on stderr.

### 4. `parseBlamePorcelain` misattributed lines — real, cross-platform

Git writes a commit's porcelain metadata only on that commit's **first** appearance. The parser
carried a single "last-seen author" and charged the intervening author's lines to the wrong person
whenever blame returned to an already-described commit. Now cached per commit hash.

### 5. `getRepository` could return a record for a different repository

`UPDATE repositories SET repo_root = 42` is silently coerced to `'42'` by SQLite's TEXT affinity,
so the hydrated root was unverifiable. The root is now checked and a mismatch reported as
corruption — a miss, never fatal. This also closed a latent parity gap: the file backend already
matched on the normalised key.

### 6. `getMatch`'s damage-fallback path could never fire

The `SELECT` omitted `source_id` and `candidate_id`, which is exactly what `hydrateMatch` falls
back to when a result document is damaged — so a damaged document always degraded to a miss
instead of using the intact columns.

### 7. CI was silently running zero integration tests

The job filtered `npx vitest run tests/git tests/cache tests/integration`, but `tests/integration`
is not a directory. Vitest treats a filter as a substring match, so a path matching nothing is
**not an error** — the step went green having run no integration tests, and the demo-repository
suite never ran anywhere in CI. Now targets `tests/git tests/analysis tests/cache tests/demo`.

### 8. The build was broken

`scripts/build.mjs` still referenced `src/webview/client/main.ts`, which the webview's move to
React deleted, so the script failed to resolve its entry point. Vite is now the sole owner of the
webview bundle.

### 9. A lint suppression had quietly stopped applying

`src/commands/context.ts` carried `// eslint-disable-next-line no-control-regex` on the
`return value` line while the regex sat on the next. When Prettier split the chain the comment
stopped covering the regex, so the rule began failing the gate for no visible reason.

### 10. The repo was never Prettier-clean

74 files failed `format:check`, which CI runs in the `lint` job — and every other job declares
`needs: lint`, so formatting alone would have blocked the entire pipeline.

### 11. A flaky performance assertion measured machine load, not code

The cache throughput test asserted wall-clock time inside a suite running ~52 files in parallel:
~4 s alone, ~19 s under contention. My first fix — compare the file backend's time against
SQLite's in the same run, on the theory that load cancels in the ratio — **was wrong**, and the
failure proved it: the ratio _grew_ under load (3.7x idle, 6.6x moderately busy, 14.8x busy),
because the two backends are not bounded by the same thing. The file store is
filesystem-latency bound and inflates hard; SQLite barely moves. Dividing two
differently-bottlenecked measurements weights the load rather than cancelling it.

The test now scales the **same** backend against itself, 250 → 2 000 records, so both measurements
share one bottleneck and one load. Measured **8.1x for 8x the work** against a 20x ceiling — O(n)
predicts ~8x, O(n^2) ~64x, so the assertion separates them cleanly. `WRITE_CONCURRENCY` was also
raised 24 → 64, a genuine product improvement (parity: 24.4 s → 6.7 s), not a test accommodation.

---

## Measured accuracy

`tests/accuracy` publishes these to stdout on every run.

| metric              | before | after                        |
| ------------------- | ------ | ---------------------------- |
| precision           | 1.000  | 1.000                        |
| false-positive rate | 0.000  | 0.000 — both decoys rejected |
| cross-file recall   | 0.000  | **0.500**                    |
| f1                  | 0.000  | 0.667                        |

Ground truth is deliberately two-tiered, because conflating the tiers is what first made this
harness report 0.00 precision: the focus block's own earlier versions in the same file are
_supposed_ to be reported, so recall is scoped to the cross-file copies alone.

## The host/webview boundary is verified against real data

`tests/webview/protocol.test.ts` and `serialize.test.ts` use hand-written fixtures — correct for
testing a validator, but it leaves schema drift between the host's serialiser and the webview's
validator entirely uncovered, and that failure is _silent_: the extension analyses correctly, the
panel opens, nothing renders, no error anywhere.

`tests/webview/boundary.test.ts` closes the loop with a real artefact: real engine → real host
serialiser → real webview validators → real layout, colour and filter logic. **The two sides do
agree** — the React migration's biggest risk did not materialise.

## Webview render: generated but not seen

`scripts/preview-webview.mjs` (`npm run webview:preview`) writes a standalone `preview.html` that
runs the real `media/webview.js` against a real analysed graph using the real document builder,
stubbing only `acquireVsCodeApi()`. The output is CSP-validated (`default-src 'none'`, nonced
scripts, correct `media/` URIs, `ancestry-root` mount present) and the page title becomes
`ERROR: <message>` if the bundle throws on boot.

**It has not been visually verified.** This environment has no desktop browser connected and no
headless browser or DOM shim installed, so the Three.js renderer, camera and host bridge remain
unexercised. Running `npm run webview:preview` and opening the URL is the one-step check.

---

## Open — needs a decision, deliberately not taken

### The similarity weights are the remaining accuracy gap

The modified copy (`evaluateToken`) is still not reported, but **not** because the search fails to
reach it — the sweep now runs and does visit the file. It scores 0.535, below the 0.60 ignore
floor, so it is never surfaced at all.

This is a _calibration_ problem, not a search problem:

| signal  | weight | score on that pair | reads as  |
| ------- | ------ | ------------------ | --------- |
| jaccard | 0.5    | 0.234              | unrelated |
| simhash | 0.2    | 0.953              | match     |
| lcs     | 0.2    | 0.638              | weak      |
| shape   | 0.1    | 0.998              | match     |

4-token shingles shatter on any structural edit, so Jaccard is simultaneously the heaviest-weighted
and the most brittle signal for exactly the case the product exists to catch.

The plan states the thresholds "must be experimentally validated; they are not universal
constants". The harness is now in place to do that. **Changing a weight to make a number look
better would defeat its purpose**, so nothing has been retuned.

### Not verified anywhere

- The 3D render, camera controls and host bridge (need WebGL).
- The extension host itself: no command has been run from a real VS Code session. Every engine
  result in this document came from calling `AnalysisEngine` programmatically.

## Cleanup done

- Scratch test files (`zzprofile`, `zzraw`, `scratch`, `scratch2`, `zz-scratch`) — removed.
- `.demo-repo/` and `preview.html` — git-ignored so a local run is never committed.
- Temporary harness files — removed; `scripts/preview-webview.mjs` is the permanent replacement.
