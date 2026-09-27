# Security Policy

Ancestry reads your source code and your entire Git history to build a graph.
That makes "what does this thing do with my code" a reasonable first question,
and the answer is short: **everything happens in a local process. Ancestry
makes no network requests in v0.1.** See [docs/security.md](docs/security.md)
for the full threat model.

## Supported versions

| Version | Supported | Notes                                         |
| ------- | --------- | --------------------------------------------- |
| 0.1.x   | Yes       | Current line; receives bug and security fixes |
| < 0.1   | No        | No pre-1.0 releases were ever published       |

Security fixes are released for the supported line only. Because Ancestry is
pre-1.0 and does not yet publish a signed release pipeline, the practical advice
is to build from source at the latest commit on `main` if you cannot wait for a
published release.

## Reporting a vulnerability

> [!IMPORTANT]
> **TODO — replace before publishing.** The address below is a placeholder. Set
> `security@` to a real, monitored mailbox owned by the maintainers, or replace
> this section with a link to a private GitHub Security Advisory
> (`https://github.com/ancestry-tools/ancestry/security/advisories/new`).
> A placeholder address that nobody reads is worse than no address at all —
> a stale or unmonitored channel turns a private disclosure into a public one.
> This callout must be removed in the same commit that configures the channel.

Report privately to: **security@ancestry-tools.invalid** (placeholder — see
above)

Please do **not** open a public issue for a security problem. A public issue
tells everyone about the flaw before the maintainers have a chance to ship a
fix.

### What to include

- The Ancestry version (`Help → About`, or the VS Code extension details pane)
  and your VS Code version.
- Your operating system and Node.js version.
- A **minimal reproduction**. Synthetic repositories are strongly preferred over
  real code; `scripts/make-demo-repo.mjs` builds one with a known history.
- The impact you observed: what an attacker could read, write, or execute.
- Whether the issue is already public anywhere.

### What happens next

| Stage                  | Target                      |
| ---------------------- | --------------------------- |
| Acknowledgement        | 3 business days             |
| Triage and severity    | 7 business days             |
| Fix or mitigation plan | 14 business days            |
| Release, if applicable | Coordinated with the report |

A fix ships as a normal version bump with a `CHANGELOG.md` entry, and the
reporter is credited in the release notes unless they ask not to be. We are
happy to credit privately while the fix is still embargoed, and we will tell you
before the advisory is published.

### Out of scope

- Vulnerabilities in Git itself, in VS Code, in Three.js, in d3, or in any
  dependency. Report those upstream; we will help you trace a dependency path
  if that is useful.
- Findings that require the user to have already granted an attacker code
  execution in the extension host.
- "Ancestry showed me an origin commit that is not the real original." That is a
  documented limitation, not a vulnerability: the origin is the _earliest
  detected match_, bounded by the history that was actually scanned.
- Missing hardening that has no demonstrable impact.

## Hardening notes for researchers

- The Git layer passes an argv array to `child_process.spawn` and never uses a
  shell. Paths and revisions are validated in `src/git/safety.ts` before they
  reach argv.
- The webview runs under a restrictive Content Security Policy with
  `localResourceRoots` limited to `media/`, and every inbound message is
  validated against the `WebviewToHostMessage` union before it is acted on.
- Source text is not written to the output channel or any log by default.
