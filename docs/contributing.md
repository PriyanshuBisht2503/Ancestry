# Contributing to Ancestry

This is the long-form guide. The root [CONTRIBUTING.md](../CONTRIBUTING.md) is a
pointer; everything that matters is here.

Ancestry is a VS Code extension that reconstructs the semantic evolution of a
code block across Git history, branches and files. The interesting engineering
is not the UI — it is the judgement about what "the same code" means. Most
contributions will be about making that judgement more accurate, faster, or
more honest.

---

## 1. Development setup

### Prerequisites

| Requirement | Version                             | Notes                              |
| ----------- | ----------------------------------- | ---------------------------------- |
| Node.js     | `>=20` (`engines.node`); CI runs 22 | `engine-strict=true` in `.npmrc`   |
| npm         | ships with Node                     | the repo is npm-only, no yarn      |
| git         | 2.20+ recommended                   | the Git engine shells out to `git` |
| VS Code     | `^1.85.0`                           | the `engines.vscode` floor         |

On Windows, run everything from PowerShell. On macOS and Linux, a POSIX shell
is assumed in the examples.

```bash
git clone https://github.com/ancestry-tools/ancestry.git
cd ancestry
npm install
```

> `npm ci` is the command CI uses. Use `npm install` when you are deliberately
> changing dependencies, and commit the updated `package-lock.json`.

### First build and launch

```bash
npm run build:dev     # esbuild in --watch mode, both targets
```

Press <kbd>F5</kbd>. This compiles and launches an
[Extension Development Host](https://code.visualstudio.com/api/working-with-extensions/developing-extensions)
window with the extension loaded. In that window:

1. Open a folder that is a Git repository with meaningful history. If you do
   not have one handy, generate a synthetic one:

   ```bash
   node scripts/make-demo-repo.mjs /tmp/ancestry-demo
   code /tmp/ancestry-demo
   ```

2. Put the cursor inside a function — or select a range of statements.
3. Right-click and choose **Ancestry: Analyze Code Ancestry**, or run it from
   the command palette.
4. The 3D panel opens. X is time, Y is branch, Z is module.

`npm run build:dev` writes two artifacts:

- `dist/extension.js` — the CommonJS extension bundle (`vscode` stays external).
- `media/webview.js` — a self-contained IIFE for the webview, with Three.js and
  d3 inlined.

Do not edit either file. They are regenerated on every build and both are
`.gitignore`d.

### Everyday commands

| Command                 | What it does                                           |
| ----------------------- | ------------------------------------------------------ |
| `npm run build:dev`     | watch build (your normal loop)                         |
| `npm run build`         | one-shot production build                              |
| `npm run watch`         | `tsc -watch` type check only, for faster type feedback |
| `npm run lint`          | ESLint over `src`, `tests`, `scripts`                  |
| `npm run lint:fix`      | ESLint with `--fix`                                    |
| `npm run format`        | Prettier write                                         |
| `npm run format:check`  | Prettier check (what CI runs)                          |
| `npm run typecheck`     | `tsc --noEmit`                                         |
| `npm run test`          | the whole Vitest suite                                 |
| `npm run test:watch`    | Vitest in watch mode                                   |
| `npm run test:coverage` | V8 coverage with the configured thresholds             |
| `npm run test:perf`     | `tests/performance` only                               |
| `npm run verify`        | lint + typecheck + test — the pre-push gate            |
| `npm run clean`         | remove `out`, `dist`, `media`, `coverage`              |

### Where to look when something is wrong

Open the **Ancestry** output channel: `View → Output`, then pick `Ancestry` from
the dropdown. The logger is intentionally quiet about source text; see
`docs/security.md` §7.

---

## 2. Module map and the "own only your directory" rule

`src/` is a set of loosely coupled modules around a frozen contract. Read
`src/types.ts` first — it is the single source of truth for every shared shape
and it is not to be edited casually.

```text
src/
├── types.ts            FROZEN domain contract. Every other module imports from
│                       here and must not redefine these shapes.
├── config.ts           Typed, clamped, default-backed access to `ancestry.*`.
├── logger.ts           Output-channel logging. Source text never goes here.
├── extension.ts        Activation, command registration, panel lifecycle.
│
├── commands/           One file per command; argument validation, then a call
│                       into analysis/. No engine logic.
├── git/                The ONLY module that spawns git. safety.ts is the
│                       choke point that validates every path and revision.
├── parser/             File text → CodeBlock[]. TypeScript compiler API.
│                       One adapter per language family.
├── normalization/      CodeBlock → NormalizedBlock. Identifiers canonicalised,
│                       formatting and comments removed, hashes computed.
├── similarity/         NormalizedBlock → SimilarityResult. Four components,
│                       weighted, classified into bands.
├── graph/              Nodes, edges, origin detection, statistics. Pure data.
├── cache/              ICacheStore implementations. Never reads a repository.
├── analysis/           The orchestrator. Owns the phase pipeline, the
│                       progress ratio, the limits, and cancellation.
│
└── webview/
    ├── host.ts         Panel creation, CSP, localResourceRoots, message
    │                   validation in BOTH directions.
    └── client/         Runs in the sandbox. core/ is pure logic and IS unit
                        tested; renderer/camera/panel/main need a real GPU.
```

### The rule

> **You own your directory. You do not edit another module's directory to make
> your feature work.**

This is not bureaucracy. Ancestry has been built by several people working in
parallel, and the modules have to stay independently testable for that to work.
Concretely:

- If you need a **new shared shape**, add it to your own module's `types.ts`
  (e.g. `src/similarity/types.ts`). Do not widen `src/types.ts`.
- If you need a **behaviour change in another module**, open an issue (or a
  draft PR that only touches that module) describing what you need and why. The
  module owner implements it.
- If you genuinely need a contract change, it is a design discussion. `src/types.ts`
  is changed deliberately, in its own commit, with `ENGINE_VERSION`,
  `NORMALIZATION_VERSION` or `CACHE_SCHEMA_VERSION` bumped where it invalidates
  cached data. It is never an incidental edit inside a feature PR.
- Tests mirror `src/`: `tests/git`, `tests/parser`, and so on. `tests/**` is
  shared infrastructure — a test helper belongs wherever it is most useful, but
  a test file for module X belongs under `tests/X`.

### What may import what

```text
types  ←  everything
config, logger  ←  extension, commands, analysis
git, parser, normalization, similarity  ←  analysis
graph, cache  ←  analysis, commands
analysis  ←  commands, extension
webview/host  ←  extension, commands      (never the other way round)
```

The engine layers (`git`, `parser`, `normalization`, `similarity`, `graph`) do
**not** import `vscode`. That is what makes them testable outside an extension
host, and it is the reason the whole suite runs in plain Node under Vitest. If
you find yourself wanting `vscode.window` inside the engine, you are writing
presentation logic and it belongs in `commands/` or `webview/`.

---

## 3. Code style

### Automated

Prettier is the authority on formatting; do not hand-tune whitespace. ESLint
catches the rest. The two `eslint:recommended` layers and
`plugin:@typescript-eslint/recommended` are on, with `no-explicit-any` and
`no-console` downgraded to warnings.

```bash
npm run format      # apply
npm run format:check   # verify (CI)
npm run lint        # verify (CI)
```

Non-negotiable style, matching the existing code:

- 2-space indent, single quotes, semicolons, trailing commas, 100 columns —
  that is `.prettierrc.json`, so just let Prettier decide.
- **Named exports only.** No `export default` in `src/`. Import the type
  namespace directly: `import { AncestryError } from './types'`.
- **Every public function has a JSDoc block** with `@param`, `@returns` and
  `@throws` where it can throw. The existing files explain _why_, not _what_;
  match that. Comments that restate the code are noise.
- **`import type` for type-only imports.** This keeps the emitted CommonJS free
  of `require` calls that only existed for types.
- **Errors are `AncestryError`.** Never a bare `throw new Error(...)`. The code
  is part of the `userMessage`, so a human-readable first argument is mandatory.
- **Never throw from the engine for recoverable input.** An unparseable file, a
  binary blob, a missing blob, a file that vanished mid-scan: collect a
  diagnostic and continue. One bad file must not end an analysis.

### Git layer rules

`src/git/safety.ts` is the security boundary. If you add anything that reaches
argv, route it through `assertSafeRepoPath`, `assertSafeRevision` or
`assertSafeGitPathOrNull`. Do not hand-roll a check. Do not add a shell.

### Webview rules

- The CSP is set in `webview/host.ts` and must not be relaxed. If the webview
  needs something new, the fix is a bundler change, not a CSP change.
- `localResourceRoots` is `[media]`. Adding a second root needs a comment
  explaining why and a corresponding `.vscodeignore` entry so the file actually
  ships.
- Every message received from the webview is validated against the
  `WebviewToHostMessage` union before it is used. A `switch` over `type` with an
  `unknown` fallthrough that ignores the message is the pattern to copy.
- Nothing crosses to the webview that was not deliberately serialised. The
  payload is `WebviewGraphPayload`, not the graph object graph.

### Logging rules

`logger.ts` may log paths, commit hashes, counts, durations, similarity scores
and error codes. It may not log source text. `ancestry.privacy.logSourceCode`
exists so a developer can opt in while debugging, and it defaults to off for
exactly this reason — do not add a second path that bypasses it.

---

## 4. Adding a language

The parser is adapter-based. TypeScript's compiler API covers
`typescript`, `javascript`, `tsx` and `jsx` today; a new language family means a
new adapter, not new `if` statements in the extractor.

### The two tiers

**Tier 1 — already covered by the TypeScript compiler API.** Nothing to do.
`EXTENSION_LANGUAGES` in `src/types.ts` maps an extension to a
`SupportedLanguage`, and that union is the set of things the extractor can
handle. Adding a new _extension_ that the TS parser already understands
(for example `mjsx`) is a one-line change to that map plus a test.

**Tier 2 — a genuinely different grammar.** Needs a new adapter. A tree-sitter
grammar is the intended answer; the decision to defer it is recorded in
`docs/roadmap.md` because a deterministic single-parser baseline had to prove
itself first.

### Steps for a Tier 2 language

1. **Extend the contract, in its own commit.**

   ```ts
   // src/types.ts
   export type SupportedLanguage = 'typescript' | 'python' | /* ... */;

   export const EXTENSION_LANGUAGES: Readonly<Record<string, SupportedLanguage>> =
     Object.freeze({
       /* ... */
       py: 'python',
     });
   ```

   Bump `ENGINE_VERSION`. A new language is a breaking change to the graph
   payload, because `AncestryNode.language` is part of the serialised contract.

2. **Write the adapter in `src/parser/`.**

   ```text
   src/parser/
   ├── index.ts            parseFile() — the single entry point
   ├── typescriptAdapter.ts
   └── treeSitterAdapter.ts
   ```

   An adapter must export something with this shape:

   ```ts
   interface LanguageAdapter {
     readonly language: SupportedLanguage;
     canParse(filePath: string, text: string): boolean;
     parse(filePath: string, text: string): ParseFileResult;
   }
   ```

   `parse` returns `CodeBlock[]` with 1-based line ranges, a `parentId` for
   every nested block, and a `ParseDiagnostic` for every recoverable problem.
   Two hard requirements:

   - **Recover, do not throw.** A syntax error at line 400 must not discard the
     200 good functions above it. Parse, collect diagnostics, return what you
     have.
   - **Never use a regex as the primary parser.** A regex may pre-filter a file
     by content sniffing, but structure comes from the grammar.

3. **Wire it into `parseFile()`.** The dispatcher is one lookup on
   `languageForPath`. Do not add branching.

4. **Bump `NORMALIZATION_VERSION`.** New languages mean new normalisation
   decisions, and old cached normalisations are not comparable with new ones.
   The cache invalidates on this constant.

5. **Extend normalisation** in `src/normalization/` for the new node kinds. The
   normaliser canonicalises by node type; a new grammar produces node types it
   has never seen. The fallback rule matters: an unknown node type contributes
   _structural depth_ and _nothing else_, so an unhandled node degrades
   similarity rather than corrupting it.

6. **Extend `EXTENSION_LANGUAGES`-driven tests.** Minimum:

   - a fixture file in the new language containing at least one function, one
     class with a method, and one top-level construct;
   - assertions on the block count, the line ranges, the `parentId` chain and
     the qualified names;
   - a **broken** fixture: a file that does not parse must return diagnostics
     and the blocks that did parse, and must not throw;
   - a **renamed-variable twin** fixture: the two files must produce the same
     `tokenHash` after normalisation. This is the cheapest possible proof that
     the language is actually supported rather than merely readable.

7. **Add the language to the demo repository** in `scripts/make-demo-repo.mjs` so
   the accuracy harness has a known-positive case, and to the README language
   table.

8. **Document the limits.** `docs/specification.md` and the `Known limitations`
   section of `CHANGELOG.md` both need updating. If your adapter cannot
   distinguish two constructs, say so.

---

## 5. Tuning the similarity thresholds

The defaults are `strong ≥ 0.90`, `possible ≥ 0.75`, `ignore = 0.60`. **They are
not constants.** They were picked against a small synthetic corpus and they
should be re-derived whenever normalisation or similarity changes.

Never change a threshold and a weight in the same commit — you will not be able
to attribute the result.

### 5.1 Understand what the score is

`SimilarityResult.similarity` is a weighted aggregate of four components, each
independently inspectable in `breakdown`:

| Component | Measures                                      | Robust to              |
| --------- | --------------------------------------------- | ---------------------- |
| `jaccard` | MinHash estimate over k-gram shingle sets     | reorderings, wrapping  |
| `simhash` | 64-bit fingerprint hamming distance           | renames, reformatting  |
| `lcs`     | longest common subsequence over token streams | inserted/deleted lines |
| `shape`   | cosine over structural feature vectors        | identifiers entirely   |

`componentsUsed` records which ones actually contributed — MinHash is skipped
when either shingle set is too small to estimate. Reading a `0.88` as "the
engine is 88% sure" is the wrong mental model; it is "this weighted composite
landed here".

### 5.2 Run the accuracy procedure

`tests/accuracy` scores the engine against the labelled demo repository from
`scripts/make-demo-repo.mjs`, which contains the known positives (renamed copy,
modified copy, moved function, deleted-and-restored block) and the decoys
(unrelated functions of similar size and shape).

```bash
# 1. Regenerate the corpus so nothing is stale.
node scripts/make-demo-repo.mjs .ancestry-demo

# 2. Score the engine and write the report.
npx vitest run tests/accuracy

# 3. Read the report. Record the numbers BEFORE you change anything.
```

```bash
# 4. Sweep the thresholds rather than guessing.
npx vitest run tests/accuracy -- --sweep-thresholds
```

The sweep prints, for each candidate pair, the full
`precision / recall / F1 / false-positive rate / false-negative rate` table
across the grid. **Commit the before-and-after table into your pull request.**
A threshold change with no measured effect is a guess, and a guess in this
module is indistinguishable from a regression.

### 5.3 Read the failure modes before tuning

| Symptom in the report                   | Most likely cause                           | Fix here, not in the thresholds  |
| --------------------------------------- | ------------------------------------------- | -------------------------------- |
| Renamed copy scores ~0.6                | identifiers not canonicalised               | `src/normalization`              |
| Reformatting alone changes the score    | comments or trivia not stripped             | `src/normalization`              |
| Decoys score above 0.75                 | `shape` feature vector too coarse           | add a discriminating feature     |
| Short blocks match everything           | `minhash` skipped, `shape` dominates        | `tokenCount` floor, not the band |
| Real modification scores below `ignore` | `lcs` weight too high for restructured code | component weights                |
| Everything scores ~0.5                  | normalisation version mismatch, stale cache | bump `NORMALIZATION_VERSION`     |

That last row matters: if you changed normalisation and the numbers did not
move, you are reading the cache. Bump the constant or run
**Ancestry: Clear Ancestry Index Cache**.

### 5.4 Change the right knob

Order of preference, because each is more explicable than the one after it:

1. **Fix normalisation.** A score that is wrong because the token stream is
   wrong is a bug in `src/normalization`, and no threshold papers over it.
2. **Fix the feature vector.** A new discriminating structural count in
   `features` sharpens `shape` without moving any band.
3. **Change component weights**, and say in the PR why the balance was wrong.
4. **Change thresholds** last, and only with a measured F1 improvement.

Thresholds are also per-user settings (`ancestry.similarity.strongThreshold`,
`ancestry.similarity.possibleThreshold`). Whatever you ship as a default must
still behave sensibly if a user sets them to something absurd — `ignore` is
derived so the bands stay monotonic, and that invariant needs a test.

### 5.5 Report accuracy honestly

- Report F1, not just recall. A threshold that finds everything by matching
  everything is not an achievement.
- Report the false-positive rate separately. On a graph, a spurious `strong`
  edge is worse than a missing `possible` one.
- If you cannot improve the numbers, say so and explain what is hard about the
  case. A documented limitation is a better outcome than a quietly retuned
  constant that nobody re-measured.

---

## 6. Pull request checklist

Before you open the PR:

- [ ] `npm run verify` passes (lint, type check, tests).
- [ ] `npm run format:check` passes.
- [ ] `npm run typecheck` passes — including `tsconfig.webview.json` for any
      change under `src/webview/client`, which the root project excludes.
- [ ] A test exists for the behaviour you changed, and it fails without your
      change. Verify this; a test that cannot fail is not a test.
- [ ] New behaviour in `src/git` has a `src/git/safety.ts` validation test for
      every input shape that reaches argv.
- [ ] New behaviour in the webview has a message-validation test for every
      message variant handled.
- [ ] Anything that changes the serialised graph payload bumps `ENGINE_VERSION`
      and has a note in `CHANGELOG.md`.
- [ ] Anything that invalidates cached normalisations bumps
      `NORMALIZATION_VERSION`.
- [ ] Anything that changes the on-disk cache layout bumps `CACHE_SCHEMA_VERSION`.
- [ ] `src/types.ts` is untouched, or changed deliberately in its own commit with
      a version bump and a justification.
- [ ] You did not edit a module you do not own.
- [ ] No source text in a log line, a snapshot, or a fixture.
- [ ] `docs/` is updated if you changed behaviour a user can observe. A new
      failure mode belongs in `docs/troubleshooting.md`.
- [ ] Threshold or weight changes include the before/after accuracy table.

In the PR description, state:

1. **What** changed, in one paragraph.
2. **Why** the previous behaviour was wrong.
3. **How you know** — the test names, and the measured numbers if you touched
   the engine. "It looks better" is not a measurement.
4. **What you did not do**, and what you deliberately left out of scope.

Keep pull requests small. A refactor, a new language adapter and a threshold
change are three pull requests, not one.

---

## 7. Reporting bugs

Include:

- Ancestry version, VS Code version, OS, Node version.
- The `ancestry.*` settings you are using — they change what gets analysed.
- A **synthetic** repository that reproduces the problem.
  `node scripts/make-demo-repo.mjs /tmp/repro` gives you a starting point.
- The Ancestry output channel contents with source text redacted.

Never paste real customer or proprietary source code into an issue. See
`CODE_OF_CONDUCT.md` and `docs/security.md` §9.
