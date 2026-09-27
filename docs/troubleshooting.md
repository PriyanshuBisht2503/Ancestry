# Troubleshooting Ancestry

Ancestry surfaces anticipated failures as `AncestryError` with a code, a
`userMessage` safe to show in a notification, and a developer-facing `detail`.
The error code is the first thing to look for: it is the first segment of the
error's message, it is in the Ancestry output channel, and it maps one-to-one
onto a row in the table below.

> **Enable logging while you debug:** `View → Output → Ancestry`. The channel
> records paths, commit hashes, counts, durations, similarity scores and error
> codes. It does **not** record source text, by design — see
> [security.md](security.md) §7.

---

## Symptom → cause → fix

| #   | Symptom                                            | Error code                                            | Likely cause                                                                                       | Fix                                                                                                                                                                                              |
| --- | -------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | "No Git repository found"                          | `NO_GIT_REPOSITORY`                                   | The selected file is not inside a Git working tree, or `git rev-parse` failed                      | Open a folder that _is_ a repository. Check with `git rev-parse --show-toplevel` in the same terminal. Submodules opened from a parent workspace often trigger this — open the submodule itself. |
| 2   | "Git executable not found"                         | `GIT_NOT_FOUND`                                       | `git` is not on the `PATH` the extension host sees                                                 | Install Git, then **restart VS Code completely** (a running host does not pick up `PATH` changes). Verify with `git --version` in VS Code's integrated terminal, not your shell.                 |
| 3   | Analysis runs but the timeline is odd              | `DETACHED_HEAD`                                       | The workspace is on a detached `HEAD` (CI checkout, a tag, a bisect)                               | Ancestry analyses the detached commit, but there is no branch to group nodes on, so the Y axis is flat. `git switch main`. The analysis itself is valid — this is a warning, not a failure.      |
| 4   | Ancestry stops at a suspiciously recent commit     | `SHALLOW_CLONE`                                       | The clone is shallow (`--depth N`), so the earlier history does not exist locally                  | `git fetch --unshallow`. If the remote cannot serve full history, the earliest-match origin is bounded by the shallow point and the result is _not_ the real origin.                             |
| 5   | Analysis takes a very long time                    | —                                                     | Large history, large files, cold cache, or a scan that is not hitting the cache                    | See [§2 Performance](#2-analysis-is-slow-or-seems-to-hang). Lower `ancestry.git.maxHistoryDepth` first; it is the biggest single lever.                                                          |
| 6   | Second run gives the same stale result             | `CACHE_CORRUPT`                                       | A cached normalisation or match was written by an older engine version, or the store was truncated | **Ancestry: Clear Ancestry Index Cache**, then re-run. If it recurs, note the `ancestry.cache.backend` value and report it — a checksum failure means a real write bug.                          |
| 7   | "No matches found"                                 | `NO_MATCHES`                                          | Nothing scored above the ignore threshold, or every candidate was filtered out                     | See [§3](#3-similarity-finds-nothing). Usually a threshold that is too high, a block that is too small, or `includeTests` doing the opposite of what you expected.                               |
| 8   | A file is missing from the graph                   | `BINARY_FILE`, `PARSE_FAILED`, `UNSUPPORTED_LANGUAGE` | The file is binary, is not JavaScript/TypeScript, or does not parse                                | Expected in v0.1. Unparsed files are listed in `graph.unparsed` with a reason. Analysis continues; the graph is simply missing them.                                                             |
| 9   | The panel is blank or shows a CSP error            | `WEBSITE_FAILED`                                      | `media/` did not ship, or the panel HTML references something outside `localResourceRoots`         | See [§4](#4-the-webview-is-blank). Almost always a packaging problem, not a code problem.                                                                                                        |
| 10  | `vsce package` fails or the VSIX has no webview    | —                                                     | `media/webview.js` is missing because the build did not run, or `.vscodeignore` dropped `media/`   | Run `npm run build` and confirm `dist/extension.js` and `media/webview.js` both exist. See [§4](#4-the-webview-is-blank) and `.vscodeignore`.                                                    |
| 11  | The graph has thousands of nodes                   | —                                                     | The focus block is a container, or the similarity band is too permissive                           | See [§5](#5-too-many-nodes-in-the-graph). Select a single function. Raise `possibleThreshold`. Set `maxBlocksTotal` if you must.                                                                 |
| 12  | A moved function is not connected                  | —                                                     | Rename detection was disabled, or the file changed too much for Git to call it a rename            | See [§6](#6-renames-are-not-followed). `ancestry.analysis.followRenames` must be `true`; ancestry then falls back to similarity matching.                                                        |
| 13  | "That file path cannot be read from Git"           | `INVALID_PATH`                                        | A path or revision failed validation in `src/git/safety.ts`                                        | This is a guard, not a bug. See [§7](#7-invalid_path). Report it — a legitimate path should never trip it.                                                                                       |
| 14  | "This file is larger than the limit"               | `FILE_TOO_LARGE`                                      | The file exceeds `ancestry.git.maxFileSizeBytes`                                                   | Raise the limit if you trust the file. Generated bundles and minified assets are usually not worth analysing.                                                                                    |
| 15  | "This repository is too large to analyse"          | `REPOSITORY_TOO_LARGE`                                | The working tree exceeds `ancestry.git.maxRepositorySizeBytes`                                     | Narrow the scope: analyse a single file, or lower `maxHistoryDepth`. Do not raise the ceiling on a monorepo.                                                                                     |
| 16  | The file is gone but the command was available     | `FILE_DELETED`                                        | The file was deleted, or renamed, between the editor opening it and the command running            | Re-select the range in a file that exists. The commit history still contains the deleted content if you select a path that survives.                                                             |
| 17  | Progress stops and the notification says cancelled | `CANCELLED`                                           | The analysis was cancelled, or the extension was deactivated mid-run                               | Re-run. If it cancels itself, another extension or a workspace teardown is disposing the panel.                                                                                                  |
| 18  | A different language is not analysed               | `UNSUPPORTED_LANGUAGE`                                | Only JS/TS/TSX/JSX are structurally analysed in v0.1                                               | Expected. Adding a language is described in [contributing.md §4](contributing.md#4-adding-a-language).                                                                                           |
| 19  | The panel opens, then closes itself                | `WEBSITE_FAILED`                                      | The webview script threw during initialisation                                                     | Open the webview developer tools (**Help → Toggle Developer Tools → ancestry panel**) and read the console. Check the `engineVersion` in the payload against the installed version.              |
| 20  | `node:sqlite` errors on startup                    | `CACHE_UNAVAILABLE`                                   | The runtime does not provide `node:sqlite`, and the backend is pinned to `sqlite`                  | Set `ancestry.cache.backend` to `auto` (the default) or `file`. The file backend is a checksummed JSON store.                                                                                    |

---

## 1. No repository found

**Symptom.** "No Git repository found at or above `…/src/auth.ts`."
(`NO_GIT_REPOSITORY`.)

**Cause.** Ancestry walks up from the selected file to find a working tree root.
It fails when the file is not in a working tree, when the folder was copied
without its `.git` directory, or when the workspace root is a _parent_ of the
repository and the selection resolves to a different root than you expect.

**Check.**

```bash
cd <folder containing the selected file>
git rev-parse --show-toplevel
git rev-parse --is-inside-work-tree
```

**Fix.**

- Open the repository folder itself in VS Code, not a parent directory.
- A zip download of a repository has no `.git`; re-clone it.
- In a submodule, open the submodule folder. Ancestry does not walk _down_ from
  the parent repository's root.
- A `.git` _file_ (submodule or worktree pointer) is supported; a missing `.git`
  is not.

---

## 2. Analysis is slow or seems to hang

**Symptom.** The progress bar crawls, or the command takes minutes on a
repository you expected to be instant.

**Is it actually stuck?** Ancestry reports a phase and a ratio. If the ratio is
not moving, the Ancestry output channel will show the last phase:

| Phase               | What is happening                       |
| ------------------- | --------------------------------------- |
| `read-history`      | `git log` over the history              |
| `extract-blocks`    | parsing file blobs                      |
| `match-history`     | comparing along the file's own history  |
| `cross-file-search` | the expensive one: the whole repository |

**Fix, in order of effect.**

1. `ancestry.git.maxHistoryDepth` — the single biggest lever. The default is
   2000 commits. Drop it to 200 while exploring.
2. `ancestry.analysis.includeAllBranches` — set to `false` to walk only the
   current branch. This usually halves a history walk.
3. `ancestry.analysis.includeTests` — set to `false` if you do not care about
   test copies. Test files are frequently the bulk of a JS/TS repository.
4. Select a **function**, not a whole file. A 2000-line file yields hundreds of
   blocks and every one of them is a candidate.
5. Make sure the cache is on (`ancestry.cache.enabled`) and warm. The second
   analysis of the same selection should be much faster; if it is not, see §3 of
   [performance.md](performance.md).

**Do not** just raise the limits. A very large `maxBlocksTotal` buys time by
buying memory, and the extension host will be killed.

---

## 3. Similarity finds nothing

**Symptom.** "No matches found." (`NO_MATCHES`.) The graph contains only the
focus node.

**Work through these in order.**

1. **Was the block big enough?** Blocks under roughly 20 normalised tokens are
   rejected before scoring — there is not enough signal in ten tokens to tell one
   function from another. Selecting `return a + b;` will find nothing, and it
   should not. Select the whole function.
2. **Is the ignore threshold too high?** `ancestry.similarity.ignoreThreshold`
   is derived and is not directly exposed; the effective floor is below
   `possibleThreshold`. Lower `possibleThreshold` to 0.6 and re-run — if matches
   appear, it is a calibration problem, not a detection problem.
3. **Is the copy in a different file that you excluded?** Turn off
   `includeTests`, or turn it on if it is off. Ancestry searches the whole
   repository, not just your file's history.
4. **Is the copy in a different language family?** A Python function copied into
   a TypeScript file is not compared in v0.1. This is a documented
   non-goal, not a bug.
5. **Is the history actually there?** Run
   `git log --follow --oneline -- src/yourfile.ts` and check the dates. A
   shallow clone or a squashed import means there is nothing to find.

**Interpreting a low score.** Read the `breakdown` in the Ancestry output
channel, not just the aggregate. A `simhash` of 0.95 with an `lcs` of 0.40 means
the shape matches but the token streams diverge — usually a refactor that
changed control flow. A `simhash` of 0.2 with a `shape` of 0.95 means the
structure matches but the code was rewritten wholesale. Both are useful to see;
neither is fixed by moving a threshold. See
[contributing.md §5](contributing.md#5-tuning-the-similarity-thresholds).

---

## 4. The webview is blank

**Symptom.** The Ancestry panel opens and shows the header, but the 3D area is
empty, grey, or black. Often there is a `Refused to load the script` message in
the webview console.

**Cause, in order of likelihood.**

1. **`media/` did not ship.** The webview is created with
   `localResourceRoots: [Uri.joinPath(extUri, 'media')]` and the HTML is loaded
   from `media/index.html`. If `media/` is not in the VSIX, the webview sandbox
   refuses every script and the panel is blank. This is the single most common
   cause and it looks exactly like a rendering bug.
2. **The build did not run.** `npm run build` (not `npm run watch`, not
   `npm run compile`) produces `media/webview.js`. `tsc` alone will not.
3. **The version in the panel does not match the version in `package.json`.**
   A stale payload from an older `engineVersion` can deserialise into an
   incomplete graph.

**Check.**

```bash
ls -l dist/extension.js media/webview.js     # both must exist
grep -n "localResourceRoots" src/webview/host.ts
```

**Fix.** Run `npm run build`, then reload the Extension Development Host window
(**Developer: Reload Window**). If you are packaging, verify the VSIX contents:

```bash
unzip -l ancestry-*.vsix | grep -E "extension/(dist|media)/"
```

`extension/dist/extension.js` and `extension/media/webview.js` must both appear.
If `media/` is missing, `.vscodeignore` has an over-broad `!` ordering problem —
the negations must come **after** the exclusions, because later patterns win.

**If the panel is blank but the console is clean,** open the developer tools
(**Help → Toggle Developer Tools**, then select the Ancestry frame) and look for a
WebGL context failure. Ancestry needs a GPU; software rendering in a headless or
remote environment can produce an empty scene rather than an error. See §5.

---

## 5. Too many nodes in the graph

**Symptom.** The graph is a hairball, the frame rate collapses, or the analysis
hits `maxBlocksTotal`.

**Cause.** The focus block is a container — a class, a namespace, or a whole
file — so every method inside it is a candidate, and every historical version of
every method is a node. Ancestry then also searched the cross-file candidate set,
which is repo-wide.

**Fix.**

1. **Select a single function or method.** This is the real fix. A class
   selection gives you the class's entire history, which is not what "the
   ancestry of this code block" means.
2. Raise `ancestry.similarity.possibleThreshold` toward `0.9`. Fewer weak edges
   is a better graph.
3. Filter in the panel: branch, file, author, edge type, and a similarity floor.
   Filters are applied in the host before serialising, so filtering reduces the
   payload as well as the drawing.
4. Lower `ancestry.analysis.maxBlocksTotal` if you need a hard stop. You will get
   a `truncated: true` flag in the graph stats and a warning telling you the
   history is partial. That flag is not decoration — do not report the graph as
   complete when it is set.

**If the frame rate is bad but the node count is fine,** that is a rendering
problem, not an analysis problem. Close other WebGL panels, disable hardware
acceleration in VS Code's settings, and check `docs/performance.md` for the FPS
methodology before assuming the engine is at fault.

---

## 6. Renames are not followed

**Symptom.** A function that Git knows was moved is shown as a new file's first
appearance, with no `MOVED_FROM` edge.

**Causes, in order.**

1. `ancestry.analysis.followRenames` is `false`. It defaults to `true`; check
   per-workspace and per-folder settings, which override the default.
2. **Git itself did not detect the rename.** Rename detection is
   similarity-based on file content. A file that was also refactored below
   Git's threshold looks like a delete plus an add. Check what Git thinks:
   ```bash
   git log --follow --find-renames=20% --oneline -- src/new/location.ts
   ```
   If Git does not follow it either, Ancestry will not: Ancestry trusts Git's
   rename detection and layers similarity matching on top, it does not reimplement
   the heuristic.
3. **The file went through the cross-file path, not the rename path.** Ancestry
   still finds the content, but the edge is typed `COPIED_FROM` rather than
   `MOVED_FROM`, because Ancestry cannot distinguish a move from a copy
   followed by a delete. The node carries `branches` and the edge carries a
   `rationale` string; read the rationale before trusting the edge type.
4. **The history is truncated or shallow.** See §4 of the table.

**Fix.** Raise Git's own sensitivity for the analysis run
(`--find-renames=20%` is what Ancestry uses internally) and, if the content
changed too much for any rename heuristic, accept that the cross-file similarity
match is the correct answer. Ancestry is explicit about the difference between
"Git detected this rename" and "this looks like the same logic", and the edge
`rationale` says which one you are looking at.

---

## 7. `INVALID_PATH`

**Symptom.** "That file path cannot be read from Git." with a developer-facing
detail naming the reason.

**This is a security guard working as intended.** `src/git/safety.ts` rejects, on
purpose:

- absolute paths (`/x`), drive-qualified paths (`C:\x`) and UNC paths
  (`\\server\share`) — Ancestry only ever reads repository-relative paths;
- any `..` segment — path traversal out of the repository;
- any NUL or control character — the classic argv terminator trick, and a way to
  inject a record into `git log` output that is about to be parsed;
- any path beginning with `-` — Git would read it as an _option_, and a file
  literally named `--output=evil` would change what Git writes;
- revisions containing characters that cannot appear in a ref name.

**Fix.** If a legitimate file trips this, that is a bug in the validator and a
security-relevant one. Please report it with the file path (the validator's
`detail` field already `JSON.stringify`s the value, so it is safe to paste). If
the path came from a repository containing a genuinely weird filename, Ancestry
will skip that file and report it in `graph.unparsed` — that is the designed
behaviour.

---

## 8. "Extension could not be loaded" (or failed to activate)

Almost always one of three things, in order of likelihood.

**1. You pressed F5 and the pre-launch build was still writing `dist/extension.js`.**
The `Run Extension` configuration builds before launching, and the extension host
loads `dist/extension.js` and `media/webview.js` straight off disk. If the host
starts while the bundle is half-written, it reports a load failure that will not
reproduce on a second attempt.

_Fix:_ close the Extension Development Host window completely, run `npm run build`
and wait for it to finish, then launch again.

**2. The build never ran.** In a fresh clone there is no `dist/` and no `media/`.
The extension host cannot load a bundle that does not exist, and says so in exactly
these words.

_Fix:_ `npm install && npm run build`. Both halves are required — `dist/extension.js`
for the host process, `media/webview.js` for the panel. Confirm both exist.

**3. It is not Ancestry.** The message names no extension, and other extensions fail
this way too — a language server that cannot find its JDK, for instance. Check which
one actually failed before assuming it is this one.

_Fix:_ Command Palette → **Developer: Show Running Extensions**, and **Developer: Toggle
Developer Tools** → Console. Then look in the extension host log:
`Help → Toggle Developer Tools`, or on disk under
`%APPDATA%/Code/logs/<timestamp>/<window>/exthost/exthost.log`. A working activation
looks like this and has no error after it:

```
ExtensionService#_doActivateExtension ancestry-tools.ancestry,
  startup: false, activationEvent: 'onStartupFinished'
```

That single line is the check. Ancestry activates on `onStartupFinished`, so it
happens whether or not you run a command. If the line is present and nothing follows
it, the extension loaded fine and the problem is elsewhere — most likely a blank
panel, which is symptom 4.

**Confirming the engine works without the GUI.** If you want to rule out VS Code
entirely, `npm run webview:preview` serves the real webview bundle against a real
analysed graph at `http://127.0.0.1:8731`, and `npm test` covers the analysis
pipeline. Both exercise the same code the extension host loads.

## 9. Still stuck

Collect this before opening an issue:

1. Ancestry version, VS Code version, OS, Node version.
2. The `ancestry.*` settings you are using.
3. The Ancestry output channel contents, with any source text redacted.
4. A **synthetic** reproduction. `node scripts/make-demo-repo.mjs /tmp/repro`
   creates a repository with a known history — original function, renamed copy,
   modified copy, moved function, a branch divergence, a merge, and a
   deleted-then-restored block — which is usually enough to reproduce a history
   problem without sharing anyone's real code.

Never paste real customer or proprietary source code into a public issue. See
[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).
