# Contributing to Ancestry

**Please read [docs/contributing.md](docs/contributing.md) before opening a pull
request.** It documents the development setup, the module ownership rules, the
code style, how to add a language, how to re-tune the similarity thresholds
against the accuracy tests, and the pull-request checklist.

The short version:

1. `npm install` then `npm run build:dev`, then <kbd>F5</kbd> to launch the
   Extension Development Host.
2. Own your directory. Do not edit files another module owns; open an issue
   instead.
3. `npm run verify` (lint, type check, unit tests) before you push.
4. Add a test for every behaviour change, especially in `src/similarity` and
   `src/normalization`.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
Security reports go through [SECURITY.md](SECURITY.md), not the public tracker.
