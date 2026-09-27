# Ancestry — security and privacy model

This document is the implementation plan's Phase 13 written out as an actual
threat model. It describes what Ancestry trusts, where the boundaries are, what
is defended and how, what is stored on disk, and — just as importantly — what is
explicitly **not** defended in v0.1.

If you are reporting a vulnerability rather than reading for context, use
[SECURITY.md](../SECURITY.md) instead.

---

## 1. The one-paragraph version

Ancestry reads your source code and your Git history. It does so in a local
process, on your machine, and it never transmits any of it anywhere. In v0.1 the
extension makes **no network requests at all** — no telemetry, no update check
beyond VS Code's own, no model provider, no crash reporter, no remote index. The
only external program it executes is the `git` binary, with an argv array and
never a shell. The only persistent data it writes is a local index under
VS Code's extension storage directory, and it can be deleted from the command
palette at any time.

---

## 2. Assets

| Asset                     | Why it matters                                                                        | Where it lives                    |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------- |
| Your source code          | Proprietary by default; frequently regulated                                          | Your working tree and Git objects |
| Your commit history       | Contains author names, emails, internal structure, and deleted code                   | Your `.git` directory             |
| The ancestry graph        | Reveals _who copied from whom_ — an accusation the extension must not make on a guess | In memory, then the webview panel |
| The local index           | Contains extracted source text, so it is as sensitive as the repository               | Extension storage directory       |
| The webview DOM           | Runs inside your VS Code window                                                       | In memory                         |
| Your machine's filesystem | Blast radius of a bug                                                                 | —                                 |

The graph is the subtle one. Ancestry infers relationships between blocks and
attributes them to commits and authors. That is a factual claim about a
repository, and it is only ever as good as the evidence behind it. Every node
and edge therefore carries its `similarity`, its `classification`, and a
human-readable `rationale`, and the origin node carries a disclaimer. See §8.

---

## 3. Trust boundaries

```text
┌──────────────────────────────────────────────────────────────────────┐
│  YOUR MACHINE                                                        │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │  VS Code extension host (Node.js, full user privileges)     │      │
│  │                                                            │      │
│  │   commands/ ── analysis/ ── git/ parser/ normalization/     │      │
│  │                      │           similarity/ graph/         │      │
│  │                      │                                    │      │
│  │                      │  TRUST BOUNDARY 1                   │      │
│  │                      ▼                                    │      │
│  │                 child_process.spawn                        │      │
│  │                      │                                    │      │
│  │                      │  TRUST BOUNDARY 2                   │      │
│  │                      ▼                                    │      │
│  │                 git executable (argv array, no shell)      │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  ┌──────────────────────────────┐   ┌─────────────────────────────┐  │
│  │  WORKING TREE + .git         │   │  EXTENSION STORAGE           │  │
│  │  (UNTRUSTED CONTENT)         │   │  local index, as designed    │  │
│  └──────────────────────────────┘   └─────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │  WEBVIEW SANDBOX                                              │      │
│  │   TRUST BOUNDARY 3 — a separate JS realm with a strict CSP, │      │
│  │   no Node API, filesystem limited to media/                 │      │
│  │                                                            │      │
│  │                    │  TRUST BOUNDARY 4                      │      │
│  │                    ▼  postMessage, validated in BOTH directions│     │
│  └────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
                              ╎
                              ╎  BOUNDARY 5: no network egress in v0.1
                              ▼
                        (nothing)
```

**Boundary 1 — engine to git.** Untrusted paths, revisions and parsed Git
output cross here. Defended in §5.

**Boundary 2 — extension to subprocess.** Where a wrong string becomes command
execution. Defended in §5.

**Boundary 3 — host to webview.** A separate JavaScript realm with no Node API.
Defended in §6.

**Boundary 4 — the message channel.** The only way the webview can influence the
host. This is a real privilege boundary: a message handler is a public function
reachable from a sandboxed context. Defended in §6.

**Boundary 5 — the network.** There is no code path that opens a socket in v0.1.
Defended by construction, and by §9.

### Inputs, classified

| Input                              | Untrusted because                                                                                        | Handled in                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Selected source text               | It is the user's code; the selection can be anything                                                     | parsed by the TS compiler API      |
| Repository-relative paths          | Derived from editor state; may be crafted by repository content                                          | `git/safety.ts` (§5)               |
| Revisions (`HEAD`, `main`, `A..B`) | From settings, commands and internal state                                                               | `git/safety.ts` (§5)               |
| `git` stdout/stderr                | Contains filenames, refs, author names and commit messages — all attacker-chosen in a hostile repository | parsers in `git/` (§5)             |
| Blob contents                      | Arbitrary bytes, possibly binary, possibly hostile                                                       | size check, NUL sniff, parser (§8) |
| Webview → host messages            | From a sandboxed realm; validated against a closed union                                                 | `webview/host.ts` (§6)             |
| Host → webview payload             | Built by us; must not leak more than intended                                                            | `WebviewGraphPayload` (§6)         |
| `ancestry.*` settings              | User-editable, possibly wrong, possibly hostile                                                          | `config.ts`, clamped (§4)          |
| Cache directory contents           | Local, but attacker-writable by any other local process, and a corruption source on crash                | checksums (§9)                     |

---

## 4. The local-processing guarantee

This is the property the whole design is organised around, so it is stated as a
checkable claim rather than a promise.

**Claim.** For any repository, any selection and any settings, ancestry.com
performs its analysis without transmitting source code, commit history, file
paths, author identities or graph content to any other machine.

**How it is achieved.**

- There is no HTTP client in the engine. No `fetch`, no `https`/`http` require,
  no `node:net`. The engine modules (`git`, `parser`, `normalization`,
  `similarity`, `graph`, `cache`) do not import `vscode` and do not import a
  networking module. This is checkable by inspection and by
  `grep -rE "require\('(https?|net|dgram)'" src/`.
- The only subprocess is `git`, invoked for read-only inspection. Ancestry never
  runs `git push`, `git fetch`, `git remote`, or any command that contacts a
  remote.
- `ancestry.telemetry.enabled` exists in settings and defaults to `false`. It is
  **not wired to anything** — there is no telemetry backend. It is declared so
  that the privacy posture is visible and so that a future backend cannot be
  added by quietly flipping a default.
- Source text never leaves the process. The webview is not a remote context: it
  is a sandboxed iframe in the same window, served from `media/`, and it receives
  a payload that the host deliberately serialised.

**What is _not_ claimed.** Ancestry does not claim the extension host is safe in
general. The host runs with your full user privileges, and a bug in Ancestry is
a bug with your privileges. §5 and §6 are about keeping the untrusted inputs
away from the dangerous sinks.

**Settings degrade, they do not expand.** Every `ancestry.*` value has a hard
default in `DEFAULT_CONFIG` and is clamped on read. A malformed or hostile
settings file can at worst make the analysis slower or wrong — it cannot grant a
capability the extension does not have. In particular, `privacy.logSourceCode`
defaults to `false` and the only thing it changes is how much the user chooses
to write to their own output channel.

---

## 5. Git command injection defences

A wrong string reaching `git` is the highest-severity bug available in this
extension. The defences are layered so that no single mistake is fatal.

### 5.1 No shell, ever

Every Git invocation uses `child_process.spawn('git', argvArray, { shell: false })`
— explicitly, never relying on the default. Consequences:

- No `PATH` lookup surprises, no `PATHEXT` surprises on Windows.
- No shell metacharacter is interpreted. `; rm -rf ~`, `$(...)`, backticks,
  `&&`, `|`, `>` and `%VAR%` are all just characters in a string.
- No quoting bug is possible, because there is no quoting step. Arguments are
  passed as an array and are never concatenated into a command line.
- An argument beginning with `-` is still _read as an option by git itself_, so
  the array alone is not enough — see 5.3.

`demo-repo` and the test fixtures use the identical pattern, so the tests
exercise the same shape of call as production code.

### 5.2 One choke point

`src/git/safety.ts` is the only module permitted to hand a path or revision to
Git, and it exports exactly three validators:

| Function                     | Accepts                       | Used for                              |
| ---------------------------- | ----------------------------- | ------------------------------------- |
| `assertSafeRepoPath(path)`   | a repository-relative path    | pathspecs, `git show` paths           |
| `assertSafeRevision(rev)`    | a ref, object id or rev range | `HEAD`, `main`, `A..B`, `rev@{n}`     |
| `assertSafeGitPathOrNull(p)` | the same, nullable            | deleted files, renames with no source |

Nothing in `src/git/` builds an argv entry from a value that did not pass
through one of these. **A pull request that adds a new `spawn` call without a
validator is a security review failure, not a style comment.**

### 5.3 The leading-dash rule

This is the subtle one, and the reason the validators exist at all. Git parses
argv positionally _unless an entry begins with `-`_, at which point it is an
option. A repository containing a file named `--output=/tmp/pwn` would therefore
cause Ancestry to pass an **option** where it meant a filename. Passing
`--` before the pathspec does not save us, because an absolute path is not
allowed either — the only safe place to catch this is before the process starts.

So both validators reject any path or revision whose first character is `-`, and
`assertSafeRepoPath` normalises Windows separators to POSIX form _before_
checking, so `a\b`, `a/b` and mixed forms are all covered by one set of rules.

### 5.4 Path validation rules

Rejected by `assertSafeRepoPath`, with the reason in the error's `detail`:

| Rule                          | Why                                                                         |
| ----------------------------- | --------------------------------------------------------------------------- |
| Non-string input              | `undefined.path` would become the literal string `"undefined"` in argv      |
| Empty / resolves to nothing   | Prevents a no-op `git show ''` from being interpreted some other way        |
| NUL or C0/C1 control chars    | NUL truncates argv; a newline injects a record into parsed `git log` output |
| Absolute POSIX (`/x`)         | Escapes the repository root                                                 |
| Drive-qualified (`C:\x`, UNC) | Escapes the repository root on Windows                                      |
| Any `..` segment              | Path traversal out of the repository                                        |
| Leading `-`                   | Option injection (§5.3)                                                     |

`.` segments and duplicate/trailing slashes are collapsed rather than rejected,
so `a//b`, `a/./b` and `a/b/` all normalise to the same `a/b`.

`assertSafeRevision` additionally caps the length at 1024 characters (a hostile
input should not be able to build a multi-kilobyte command line) and applies a
positive allow-list of characters that can legally appear in a ref, an
abbreviated object id, or Git's ancestry operators.

The rejected value is recorded via `JSON.stringify` in the error `detail`, which
escapes NUL and newlines so the log line stays single-line and log-safe. The
value is a path, never file content.

### 5.5 Git output is untrusted input

`git log --format=…` output contains filenames, ref names, author names, commit
subjects and bodies — every one of which is chosen by whoever wrote the
repository. A hostile repository can put anything in those fields, including
terminal escape sequences, embedded newlines, and fields engineered to look like
`git`'s own separators.

Therefore:

- Field separators use control characters that cannot appear in a commit
  message, and record format is a **fixed** format string — never built from a
  value.
- The output is split into a bounded number of records; a record with a missing
  or malformed separator is a parse failure, not a lenient parse.
- Commit metadata is rendered into the webview as **text nodes**, never as
  `innerHTML`. This is the other half of §6.
- A subject or author name containing control characters is not used to build a
  further path, ref or format string.
- Blob content is size-checked, NUL-sniffed and then handed to the TypeScript
  parser as a string. It is never `eval`'d, never `require`d, never written to
  the output channel, and never used to derive a filename.

### 5.6 Environment sanitisation

Git is invoked with a curated environment rather than inheriting everything:

- `GIT_CONFIG_NOSYSTEM=1` — the system-wide `gitconfig` is not read, so a
  hostile or broken machine-level config (an `insteadOf` redirect, an external
  diff driver, a pager) cannot alter the commands we run. In CI this is set at
  workflow level for the same reason.
- `GIT_TERMINAL_PROMPT=0` — Git can never block waiting for a credential. A
  terminal prompt in a spawned, non-interactive process is a hang, and a hang is
  a denial of service.
- `GIT_OPTIONAL_LOCKS=0` — Ancestry is read-only; it will not take index locks
  in a working tree the user is actively editing.
- Pagination, colour and interactive diff are disabled; `core.pager`/`color.ui`
  cannot smuggle a pager into a `spawnSync` with a pipe.
- The working directory is the resolved repository root, from
  `git rev-parse --show-toplevel` — never a value from a file or a message.

### 5.7 Read-only by construction

Ancestry runs `rev-parse`, `log`, `show`, `cat-file`, `ls-tree`, `branch`,
`blame`, `merge-base`, `rev-list`, `for-each-ref` and `status`. It never runs a
command that writes to the repository, changes refs, or contacts a remote. There
is no `git checkout`, no `git reset`, no `git clean`, no `git push`, no
`git fetch`. `blame` and `status` are the only commands that touch the index and
they are read-only; `GIT_OPTIONAL_LOCKS=0` keeps them from writing a lock.

---

## 6. Webview hardening

### 6.1 Content Security Policy

The webview HTML is served under a strict, explicit CSP. It does not use
`unsafe-inline` for scripts, and it does not use `unsafe-eval` — which is why
`scripts/build.mjs` sets `legalComments: 'none'` and the bundle must not contain
`eval` or `new Function`. The policy allows scripts only from
`webview.cspSource`, and styles only from the same source plus `'unsafe-inline'`
for the small amount of inline style the renderer needs to size the canvas.

The CSP is not relaxed to make a feature work. If the webview needs something
new, the answer is a build change, not a policy change.

### 6.2 `localResourceRoots` and nonce

The panel is created with:

```ts
webview.options = {
  enableScripts: true,
  localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
};
```

Exactly one root, and it is `media/`. The webview therefore cannot load a
resource from anywhere else in the extension directory, let alone from
`file://` or a remote origin. The HTML references the bundle through
`webview.asWebviewUri`, and the script tag carries a per-panel **nonce** so
injected `<script>` markup cannot execute.

This is why `media/**` must be shipped in the VSIX (see `.vscodeignore`): the
sandbox refuses the bundle, the panel is blank, and the failure looks like a
rendering bug. `docs/troubleshooting.md` §4 covers it.

### 6.3 Message validation, in both directions

**Inbound (webview → host) is the one that matters.** The message channel is a
public function in the host process, reachable from a sandboxed realm.
Every message is therefore:

1. Checked to be a non-null object.
2. Checked to have a `type` that is a member of the closed `WebviewToHostMessage`
   union — an unknown `type` is **dropped and logged**, never dispatched to a
   default handler.
3. Validated for shape: `nodeId` is a non-empty string, `minSimilarity` is a
   finite number in `[0, 1]`, `branches`/`files`/`authors` are arrays of
   strings with a length cap, `camera` is a 3-tuple of finite numbers, edge
   types are members of `AncestryEdgeType`.
4. Only then handed to the command layer.

There is no `eval`, no dynamic property lookup keyed by the incoming `type`, and
no "just cast it to the union and hope". A `switch` over a narrowed `type` with
an explicit `default` that ignores the message is the required shape. This is
the reason the message union in `src/types.ts` is a closed union rather than
`{ type: string; payload: any }`.

`clientError` is a string that originates in the webview and ends up in the
output channel. It is truncated to a bounded length and stripped of control
characters before it is written. The Ancestry output channel is not a sink for
attacker-controlled terminal escapes.

**Outbound (host → webview) is a privacy control, not a security one.** The host
sends `WebviewGraphPayload` and `WebviewFilter` — never a live object graph, never
an `AncestryError` with a `cause` chain, never anything with a prototype
attached. `focusSource` carries the **focus block only**, deliberately, not the
file and never the repository. `structuredClone` or an explicit projection is
used rather than serialising a whole class instance.

### 6.4 Rendering

All Git-derived text — commit subjects, author names, paths, branch names — is
inserted as a text node, never as `innerHTML`. A repository with a commit message
of `<img src=x onerror=...>` renders as that literal string. There is no HTML
sanitiser in the webview because there is nothing to sanitise.

### 6.5 What the webview cannot do

No `require`, no `process`, no `fs`, no network beyond the panel's own origin,
no `eval`, no access to the workspace or to the Git repository, and no way to
reach the extension host except by posting a validated message. The renderer
draws a graph; it cannot read a file.

---

## 7. The "no source text in logs" rule

**Rule.** Source text is not written to the output channel, a log file, a crash
message, a notification, a `console.*` call, or a test snapshot.

**What may be logged:** repository-relative paths, commit hashes and short
hashes, author names as Git reports them, counts, durations, similarity scores
and per-component breakdowns, error codes, and error `detail` fields — which are
constructed from validated paths and Git's own stderr, never from file content.

**Why it matters.** Log files get attached to issues. Logs outlive the session
that produced them and travel between machines. A log that contains a line of a
proprietary file is a data exfiltration event with an innocent-looking
mechanism.

**The escape hatch.** `ancestry.privacy.logSourceCode` exists so a developer can
opt in while debugging. It defaults to `false`, and the logger checks it in one
place rather than at each call site so a new call site cannot forget. Its
description in `package.json` says "Never enable this." **Do not add a second
path that bypasses it, and do not include a snippet of user code in an issue
template.**

Test fixtures are held to the same standard: assert on structure, ranges, hashes
and scores, never on expected source text.

---

## 8. Truthfulness as a security property

Ancestry makes an accusatory claim about a person's work: _this block is a copy
of that block, authored by that person_. Getting that wrong is a harm to a real
person, so the following are treated as correctness requirements with tests, not
as polish.

- Similarity is always reported as a number in `[0, 1]` with its
  `breakdown`, never as a bare verdict.
- Classification bands come from user settings and are derived so they stay
  monotonic; an impossible configuration is corrected rather than silently
  hiding matches.
- Every edge carries `confidence` and a human-readable `rationale` — for
  example `git detected rename (score 96)`, which is distinguishable from
  `content similarity 0.81` at inference time. Ancestry does not present an
  inference as an observation.
- Edge types are careful about the difference between a move and a copy, which
  Git history genuinely cannot distinguish once the original is deleted.
- **Origin is the "earliest detected match", never "the original author".** The
  `OriginInfo.disclaimer` is displayed verbatim in the UI. It is bounded by how
  much history was scanned, and a shallow clone, a force-push, a squashed
  import or a truncated scan all produce an origin that is earlier than the true
  origin. The `basis` field says which rule chose the node:
  `earliest-match`, `earliest-strong-match` or `inconclusive`.
- When a scan hits a configured limit, `GraphStats.truncated` is `true`, a
  warning is emitted, and the UI is expected to say the history is partial. A
  truncated scan is not a complete answer and must not be presented as one.
- Files that could not be analysed are listed in `graph.unparsed` with a reason,
  so "not in the graph" is never confused with "not similar".

---

## 9. What is stored on disk, and where

| What                 | Default location                                         | Contains source text | Removal                                  |
| -------------------- | -------------------------------------------------------- | -------------------- | ---------------------------------------- |
| The local index      | VS Code extension storage (`context.globalStorageUri`)   | **Yes**              | **Ancestry: Clear Ancestry Index Cache** |
| Log output           | VS Code output channel (in memory, session-scoped)       | No                   | Close VS Code                            |
| The graph            | Not persisted. In memory; serialised to the webview only | Yes (focus block)    | Close the panel                          |
| Exported graph       | Wherever the user saves it, via the export command       | Yes                  | User's responsibility                    |
| The extension itself | VS Code `extensions/`                                    | No                   | Uninstall                                |
| Anything off-machine | —                                                        | —                    | —                                        |

Details on the index:

- **Location.** `context.globalStorageUri` — a per-extension, per-user directory
  under VS Code's user data directory, not a shared or system-wide path. On
  Linux `~/.config/Code/User/globalStorage/ancestry-tools.ancestry/`, on macOS
  `~/Library/Application Support/Code/User/globalStorage/…`, on Windows
  `%APPDATA%\Code\User\globalStorage\…`.
- **Backend.** `node:sqlite` where the runtime provides it, otherwise a
  checksummed JSON file. `ancestry.cache.backend` can pin either; the default is
  `auto`.
- **Contents.** Repository roots, commit hashes, file paths, extracted
  `CodeBlock`s (including `text`), `NormalizedBlock`s (token streams, hashes,
  SimHash and MinHash values), and cached `SimilarityResult`s. **This directory
  is as sensitive as the repository it describes.** It is not encrypted, and it
  is not excluded from backups or from file-indexing tools.
- **Isolation.** Entries are namespaced by repository root, so two checkouts of
  the same repository do not collide.
- **Invalidation.** Content-hash based, keyed on `ENGINE_VERSION`,
  `NORMALIZATION_VERSION` and `CACHE_SCHEMA_VERSION`. A version bump discards
  what it invalidates rather than trying to migrate it.
- **Expiry.** Entries older than `ancestry.cache.maxAgeDays` (default 30) are
  evicted, and the store is purged on startup.
- **Integrity.** Records are checksummed. A checksum failure surfaces as
  `CACHE_CORRUPT` and the store is rebuilt rather than trusted — a partially
  written record from a crash must never be parsed as if it were whole.

### 9.1 Cache-path traversal defence

Cache keys are derived from repository-relative paths, and a repository is
attacker-controlled — it chooses its own filenames. So:

- Every path is passed through `assertSafeRepoPath` **before** it becomes part
  of a cache key or a filesystem path. `..` segments, absolute paths,
  drive-qualified paths and leading dashes are rejected at that point (§5.4).
- The on-disk layout is a checksummed, flat key-value store with keys derived
  from validated, normalised paths. A key that fails validation is rejected, and
  a key that would resolve outside the store directory is never constructed —
  the store computes paths from opaque digests, not from raw repository paths,
  so a hostile filename cannot influence the destination at all.
- Reads verify the checksum and the schema version before deserialising. A
  mismatch is a rebuild, never a best-effort parse.
- Writes are atomic (write to a temporary file in the same directory, then
  rename), so a crash cannot leave a half-written store that a later run
  misreads.
- Store size is bounded and old entries are evicted, so a repository crafted to
  produce millions of unique keys cannot fill the user's disk indefinitely.
  `ancestry.cache.maxAgeDays` is the default bound.

### 9.2 The index on shared machines

`globalStorageUri` is per-user, so another OS user does not see it. It is **not**
protected from other processes running as the same user, and it is **not**
encrypted. On a shared or managed workstation, either disable the cache
(`ancestry.cache.enabled: false`) or accept that a local process can read it.
The cache is an optimisation, and turning it off costs time, not capability.

---

## 10. Known non-goals for v0.1

Stated plainly so that absence is not mistaken for oversight.

- **No network calls at all.** There is no telemetry backend, no update check,
  no crash reporting, no remote index, no model provider, no web search, no
  license check. `ancestry.telemetry.enabled` is declared and unwired.
- **The optional embeddings path is not implemented.** This is the single most
  important non-goal. The plan explicitly defers embeddings until the
  deterministic engine has measured accuracy, because an embedding model is
  also a data-egress decision and a dependency the user has to trust. There is
  no code path that embeds source text, and no setting that would turn one on.
  If embeddings are ever added, they will be opt-in, off by default, disclosed,
  and documented as a change to this document — see
  [roadmap.md](roadmap.md#later-not-scheduled).
- **No LLM anywhere in the analysis path.** No summarisation, no renaming, no
  "explain this diff".
- **No telemetry of any kind**, including anonymous counters. There is no
  measurement endpoint, so there is nothing to opt out of.
- **No multi-user or shared state.** The index is per-user, per-installation.
- **No sandboxing of the extension host itself.** Ancestry inherits VS Code's
  privileges and does not attempt to reduce them. The mitigations here reduce
  _its_ attack surface; they do not contain a compromise.
- **No hardening against a hostile local user.** Any process running as you can
  already read your repository. Defending the index against that is out of
  scope (§9.2).
- **No supply-chain hardening beyond Dependabot and CI.** Actions are pinned to
  major versions, not commit SHAs; see the follow-up in
  [roadmap.md](roadmap.md#later-not-scheduled).

---

## 11. Verifying these claims

These are the checks a reviewer should be able to run.

```bash
# No networking anywhere in the engine.
grep -rnE "require\(['\"](https?|net|dgram|tls)['\"]\)|from ['\"](https?|net|dgram|tls)['\"]" src/

# No shell anywhere. Every spawn must be an argv array.
grep -rn "spawn\|execSync\|exec(" src/ | grep -i shell

# Every spawn is behind a validator.
grep -rn "spawn\|execFile" src/git/

# The engine does not import vscode (this is what keeps it unit-testable).
grep -rn "from 'vscode'" src/git src/parser src/normalization src/similarity src/graph src/cache

# No eval in the webview bundle — the CSP forbids it.
grep -c "eval(" media/webview.js

# No source text in the log calls.
grep -rn "logger\.\|outputChannel\.append" src/ | grep -i "\.text\|getText()"
```

Plus the CI gates: lint, type check, unit tests, integration tests (which build
real repositories and would fail loudly on a Git invocation regression), and
`npm audit --audit-level=high` as a reporting step.

**Review checkpoint.** A security review finds no known critical issues. If one
is found, it is handled through [SECURITY.md](../SECURITY.md), not this
document's public history.
