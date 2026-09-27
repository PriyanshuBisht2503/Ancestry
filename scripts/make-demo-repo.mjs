#!/usr/bin/env node
/**
 * Build a real, deterministic demonstration repository for Ancestry.
 *
 * A new user (and CI) needs something to analyse the moment they install the
 * extension, and "clone a random repository and hope it contains a copy-paste"
 * is not a test fixture. This script builds one on disk with `git`, so the
 * result is a genuine repository that `git log`, `git blame`, `git merge-base`
 * and rename detection all answer for real.
 *
 * The history deliberately contains the seven scenarios from Phase 12 of the
 * implementation plan, plus two decoys that are structurally similar to the
 * code under study and semantically unrelated to it — those exist so a false
 * positive has something to be measured against:
 *
 *   1  original function            src/auth.ts            validateToken
 *   2  renamed copy, renamed vars   src/legacy/validate.js checkToken
 *   3  modified copy                src/security/token.ts  evaluateToken
 *   4  moved function (file rename) src/utils/format.ts -> src/utils/strings.ts
 *   5  branch divergence            feature/hardening, experiment/absolute-expiry
 *   6  merge commit                 feature/hardening -> main
 *   7  deleted and re-introduced    formatUserAgent in src/utils/strings.ts
 *   -  decoy                        src/db/migrate.ts     runMigrations
 *   -  decoy                        src/db/pool.ts        settleConnection
 *
 * DETERMINISM
 * -----------
 * Every commit gets a fixed author, a fixed committer and a fixed
 * `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, `core.autocrlf` is off, and every file
 * is normalised to LF before it is written. Git's own configuration is
 * neutralised (`GIT_CONFIG_NOSYSTEM`, a `GIT_CONFIG_GLOBAL` pointing at nothing,
 * and local overrides for hooks, excludes and attributes). Two runs therefore
 * produce byte-for-byte identical commits, which is what lets the test suite
 * assert on a specific commit SHA.
 *
 * NO SHELL, EVER
 * --------------
 * Git is invoked through `node:child_process.spawnSync` with an argv array and
 * `shell: false`, which is the same discipline the extension's own Git layer
 * uses. Nothing here is ever interpolated into a command line.
 *
 * Usage:
 *   node scripts/make-demo-repo.mjs [path] [--force]
 *   node scripts/make-demo-repo.mjs --help
 *
 * With no `path`, a temporary directory is created and its location is printed.
 * The repository is idempotent: re-running against a directory this script
 * created (or that carries its marker) rebuilds it from scratch.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(SCRIPT_DIR, 'make-demo-repo.mjs');

/** Written to `<repo>/.git/<MARKER>` so a re-run can recognise its own output. */
const MARKER = 'ancestry-demo.json';
const MARKER_VERSION = 1;

const AUTHOR_NAME = 'Ada Ancestry';
const AUTHOR_EMAIL = 'ada@tokenwall.example';

/** First commit. Every later date is derived from this by `dateAt()`. */
const EPOCH_START = Date.UTC(2023, 0, 16, 9, 12, 0);

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

// `no-console` is a lint warning in this repository, and a generator script
// legitimately writes a report to stdout. Go through stdout directly rather
// than accruing warnings on every invocation.
function log(message = '') {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`[ancestry-demo] ${message}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { target: null, force: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg.startsWith('-')) {
      fail(`unknown option: ${arg}`);
      process.exit(1);
    } else if (options.target === null) {
      options.target = arg;
    } else {
      fail('only one target path may be given');
      process.exit(1);
    }
  }
  return options;
}

const USAGE = [
  'Usage: node scripts/make-demo-repo.mjs [path] [--force]',
  '',
  '  path     Directory to build the repository in. A temporary directory is',
  '           created and printed when omitted.',
  '  --force  Replace the target directory even if it is not a previous',
  '           demonstration repository.',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Deterministic dates
// ---------------------------------------------------------------------------

/**
 * A git date pinned to `hours` after the start of the timeline.
 *
 * `@<epoch> <offset>` is git's own raw date format and is parsed identically on
 * every platform, unlike an ISO string whose interpretation depends on the
 * build's locale and timezone handling.
 */
function dateAt(hours) {
  const epoch = Math.floor((EPOCH_START + hours * 3600_000) / 1000);
  return `@${epoch} +0000`;
}

// ---------------------------------------------------------------------------
// File contents
// ---------------------------------------------------------------------------

const README = `# tokenwall

A small service that issues and checks bearer tokens.

> This repository is a **synthetic demonstration fixture** generated by
> \`scripts/make-demo-repo.mjs\` from the Ancestry project. Every commit date,
> author and message is fixed, so the history is byte-for-byte reproducible.
> It is a fixture, not an example of good engineering.

## Scenarios

The history contains a handful of situations Ancestry is meant to surface.
See \`docs/scenarios.md\` for where each one lives.
`;

const SCENARIOS_DOC = `# Ancestry scenarios in this history

This file is a map for anyone reviewing the fixture. Ancestry does not read it;
it exists so a human can check the engine's output against a known answer.

| # | Scenario                          | Where                                             |
| - | --------------------------------- | ------------------------------------------------- |
| 1 | Original function                 | \`validateToken\` in \`src/auth.ts\`                 |
| 2 | Renamed copy, renamed variables   | \`checkToken\` in \`src/legacy/validate.js\`         |
| 3 | Modified copy                     | \`evaluateToken\` in \`src/security/token.ts\`       |
| 4 | Moved function (file renamed)     | \`src/utils/format.ts\` -> \`src/utils/strings.ts\`  |
| 5 | Branch divergence                 | \`feature/hardening\`, \`experiment/absolute-expiry\` |
| 6 | Merge                             | \`feature/hardening\` into \`main\`                  |
| 7 | Deleted and re-introduced         | \`formatUserAgent\` in \`src/utils/strings.ts\`      |
| - | Decoy: same shape, unrelated      | \`runMigrations\` in \`src/db/migrate.ts\`           |
| - | Decoy: same shape, unrelated      | \`settleConnection\` in \`src/db/pool.ts\`          |

The decoys are the interesting ones. Both have the same *shape* as
\`validateToken\` — an early-return ladder around a \`try\`/\`catch\`, iterating a
collection at the end — and neither has anything to do with tokens. If Ancestry
reports them as strong matches, the similarity engine is matching syntax and is
doing its job badly.
`;

const TOKEN_FORMAT_DOC = `# Token format

A token is three dot-separated segments.

\`\`\`text
header.payload.signature
\`\`\`

The payload segment is base64url-encoded JSON with at least:

| Field   | Type       | Meaning                          |
| ------- | ---------- | -------------------------------- |
| \`sub\`   | string     | subject the token was minted for |
| \`iss\`   | string     | issuer                           |
| \`exp\`   | number     | expiry, seconds since the epoch  |
| \`scopes\` | string[]  | granted scopes                   |

Expiry is compared against the caller's notion of "now", with a small allowance
for clock skew between machines. The allowance is the thing
\`experiment/absolute-expiry\` exists to argue about.
`;

const UTILS_DOC = `# Utils notes

String helpers live in \`src/utils/strings.ts\`.

The module used to be called \`format.ts\`. It was renamed because it stopped
being about formatting the moment \`chunkArray\` arrived.
`;

const EXPERIMENTS_DOC = `# Experiments

## Absolute expiry

On \`experiment/absolute-expiry\` the clock skew allowance in
\`validateToken\` is dropped, so a token is rejected the instant it expires.

This branch was never merged. It is kept in the repository on purpose: a
divergent line is the normal case, and an ancestry view that silently assumes
every branch eventually merges is not a useful ancestry view.
`;

const LEGACY_README_INITIAL = `# legacy

The JavaScript surface of the v1 API.

\`validate.js\` is a port of the validator from \`src/auth.ts\`, kept because
v1 clients still call it.
`;

const LEGACY_README = `# legacy

The JavaScript surface of the v1 API.

\`validate.js\` is a port of the validator from \`src/auth.ts\`, kept because
v1 clients still call it. It is deprecated. It is also the clearest example in
this repository of a copy: the logic is the same, the variable names are not.

## Deprecation

- v1 clients: no action required before the v2 cut-off.
- Internal callers: move to \`validateToken\` from \`src/auth.ts\`.
`;

const DEMO_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    lib: ['ES2022', 'DOM'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
  },
  include: ['src/**/*.ts'],
};

const FORMAT_V1 = `/**
 * String helpers used by the HTTP layer.
 */

export function formatUserAgent(client: string, version: string, platform: string): string {
  const parts = [client, version, platform].filter((part) => part.length > 0);
  return parts.join(' ');
}

export function padLeft(value: string, width: number, filler = ' '): string {
  let out = value;
  while (out.length < width) {
    out = filler + out;
  }
  return out;
}
`;

const FORMAT_WITH_CHUNKS = `/**
 * String helpers used by the HTTP layer.
 */

export function formatUserAgent(client: string, version: string, platform: string): string {
  const parts = [client, version, platform].filter((part) => part.length > 0);
  return parts.join(' ');
}

export function padLeft(value: string, width: number, filler = ' '): string {
  let out = value;
  while (out.length < width) {
    out = filler + out;
  }
  return out;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
`;

const FORMAT_WITHOUT_PAD = `/**
 * String helpers used by the HTTP layer.
 */

export function formatUserAgent(client: string, version: string, platform: string): string {
  const parts = [client, version, platform].filter((part) => part.length > 0);
  return parts.join(' ');
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
`;

/** After the file rename: same helpers, one more, and a new module name. */
const STRINGS_V1 = `/**
 * String helpers used by the HTTP layer.
 */

export function formatUserAgent(client: string, version: string, platform: string): string {
  const parts = [client, version, platform].filter((part) => part.length > 0);
  return parts.join(' ');
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function truncateMiddle(value: string, max: number, marker = '\u2026'): string {
  if (value.length <= max) {
    return value;
  }
  const keep = Math.max(1, max - marker.length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const suffix = tail > 0 ? value.slice(value.length - tail) : '';
  return value.slice(0, head) + marker + suffix;
}
`;

/** Scenario 7a: the formatter is deleted. */
const STRINGS_WITHOUT_UA = `/**
 * String helpers used by the HTTP layer.
 */

export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function truncateMiddle(value: string, max: number, marker = '\u2026'): string {
  if (value.length <= max) {
    return value;
  }
  const keep = Math.max(1, max - marker.length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const suffix = tail > 0 ? value.slice(value.length - tail) : '';
  return value.slice(0, head) + marker + suffix;
}
`;

/** Scenario 7b: restored byte-for-byte, which is what makes it detectable. */
const STRINGS_RESTORED = `/**
 * String helpers used by the HTTP layer.
 */

export function formatUserAgent(client: string, version: string, platform: string): string {
  const parts = [client, version, platform].filter((part) => part.length > 0);
  return parts.join(' ');
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function truncateMiddle(value: string, max: number, marker = '\u2026'): string {
  if (value.length <= max) {
    return value;
  }
  const keep = Math.max(1, max - marker.length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const suffix = tail > 0 ? value.slice(value.length - tail) : '';
  return value.slice(0, head) + marker + suffix;
}
`;

/** Scenario 1: the original. */
const AUTH_V1 = `/**
 * Bearer token issuance and validation.
 */

export interface TokenClaims {
  sub: string;
  iss: string;
  exp: number;
  scopes: string[];
}

export interface TokenResult {
  valid: boolean;
  reason?: string;
  claims?: TokenClaims;
}

/** A token stays acceptable for this long after it expires. */
export const CLOCK_SKEW_SECONDS = 30;

export function validateToken(token: string, now: number = Date.now()): TokenResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'empty' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as TokenClaims;
  } catch {
    return { valid: false, reason: 'undecodable' };
  }
  if (typeof claims.exp !== 'number') {
    return { valid: false, reason: 'missing-exp' };
  }
  if (claims.exp + CLOCK_SKEW_SECONDS < now / 1000) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}
`;

/** Scenario 1b: a small evolution on main, before the copies were taken. */
const AUTH_TRIMMED = `/**
 * Bearer token issuance and validation.
 */

export interface TokenClaims {
  sub: string;
  iss: string;
  exp: number;
  scopes: string[];
}

export interface TokenResult {
  valid: boolean;
  reason?: string;
  claims?: TokenClaims;
}

/** A token stays acceptable for this long after it expires. */
export const CLOCK_SKEW_SECONDS = 30;

export function validateToken(token: string, now: number = Date.now()): TokenResult {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'empty' };
  }
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as TokenClaims;
  } catch {
    return { valid: false, reason: 'undecodable' };
  }
  if (typeof claims.exp !== 'number') {
    return { valid: false, reason: 'missing-exp' };
  }
  if (claims.exp + CLOCK_SKEW_SECONDS < now / 1000) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}
`;

/** Scenario 5: the hardening branch adds an issuer check. */
const AUTH_HARDENED = `/**
 * Bearer token issuance and validation.
 */

export interface TokenClaims {
  sub: string;
  iss: string;
  exp: number;
  scopes: string[];
}

export interface TokenResult {
  valid: boolean;
  reason?: string;
  claims?: TokenClaims;
}

/** A token stays acceptable for this long after it expires. */
export const CLOCK_SKEW_SECONDS = 30;

/** Tokens minted by any other issuer are not ours to accept. */
export const EXPECTED_ISSUER = 'https://auth.tokenwall.example';

export function validateToken(token: string, now: number = Date.now()): TokenResult {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'empty' };
  }
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as TokenClaims;
  } catch {
    return { valid: false, reason: 'undecodable' };
  }
  if (typeof claims.exp !== 'number') {
    return { valid: false, reason: 'missing-exp' };
  }
  if (claims.iss !== EXPECTED_ISSUER) {
    return { valid: false, reason: 'wrong-issuer' };
  }
  if (claims.exp + CLOCK_SKEW_SECONDS < now / 1000) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}
`;

/** The experiment branch drops the skew allowance and nothing else. */
const AUTH_ABSOLUTE_EXPIRY = `/**
 * Bearer token issuance and validation.
 */

export interface TokenClaims {
  sub: string;
  iss: string;
  exp: number;
  scopes: string[];
}

export interface TokenResult {
  valid: boolean;
  reason?: string;
  claims?: TokenClaims;
}

/** A token stops being valid the instant it expires. */
export const CLOCK_SKEW_SECONDS = 0;

export function validateToken(token: string, now: number = Date.now()): TokenResult {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'empty' };
  }
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as TokenClaims;
  } catch {
    return { valid: false, reason: 'undecodable' };
  }
  if (typeof claims.exp !== 'number') {
    return { valid: false, reason: 'missing-exp' };
  }
  if (claims.exp < now / 1000) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}
`;

/** Main's divergence: an unrelated helper appended after validateToken. */
const AUTH_WITH_SCOPES = `/**
 * Bearer token issuance and validation.
 */

export interface TokenClaims {
  sub: string;
  iss: string;
  exp: number;
  scopes: string[];
}

export interface TokenResult {
  valid: boolean;
  reason?: string;
  claims?: TokenClaims;
}

/** A token stays acceptable for this long after it expires. */
export const CLOCK_SKEW_SECONDS = 30;

export function validateToken(token: string, now: number = Date.now()): TokenResult {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'empty' };
  }
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as TokenClaims;
  } catch {
    return { valid: false, reason: 'undecodable' };
  }
  if (typeof claims.exp !== 'number') {
    return { valid: false, reason: 'missing-exp' };
  }
  if (claims.exp + CLOCK_SKEW_SECONDS < now / 1000) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}

export function hasScope(claims: TokenClaims | undefined, scope: string): boolean {
  if (!claims || !Array.isArray(claims.scopes)) {
    return false;
  }
  return claims.scopes.indexOf(scope) !== -1;
}

export function requireScopes(claims: TokenClaims | undefined, scopes: string[]): string[] {
  if (!claims || !Array.isArray(claims.scopes)) {
    return scopes.slice();
  }
  return scopes.filter((scope) => claims.scopes.indexOf(scope) === -1);
}
`;

/** Scenario 2: a copy. Same logic, every name changed. */
const LEGACY_VALIDATE = `/**
 * Legacy token validation, kept for the v1 API surface.
 *
 * Deprecated: use \`validateToken\` from src/auth.ts instead.
 */

/** A token stays acceptable for this long after it expires. */
const CLOCK_SKEW_SECONDS = 30;

export function checkToken(rawToken, currentTime) {
  const trimmed = rawToken.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'empty' };
  }
  const segments = trimmed.split('.');
  if (segments.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  let decoded;
  try {
    decoded = JSON.parse(atob(segments[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch (err) {
    return { valid: false, reason: 'undecodable' };
  }
  if (typeof decoded.exp !== 'number') {
    return { valid: false, reason: 'missing-exp' };
  }
  if (decoded.exp + CLOCK_SKEW_SECONDS < currentTime / 1000) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims: decoded };
}
`;

/** Scenario 3: a rewrite. Same intent, different structure throughout. */
const SECURITY_TOKEN = `/**
 * Hardened token review for the internal admin surface.
 *
 * This is a rewrite of the logic in src/auth.ts rather than a port of it. The
 * failure reporting is a discriminated union instead of a reason string, and the
 * claims are checked with an accumulator instead of a chain of early returns.
 */

export interface TokenClaims {
  sub: string;
  iss: string;
  exp: number;
  scopes: string[];
}

export type TokenError = 'MALFORMED' | 'UNDECODABLE' | 'MISSING_SUBJECT' | 'EXPIRED';

export type TokenVerdict = { ok: true; claims: TokenClaims } | { ok: false; error: TokenError };

const CLOCK_SKEW_SECONDS = 30;

function readClaims(segment) {
  const json = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json);
}

export function evaluateToken(token, atMs = Date.now()) {
  const segments = token.trim().split('.');
  if (segments.length < 3) {
    return { ok: false, error: 'MALFORMED' };
  }
  let claims;
  try {
    claims = readClaims(segments[1]);
  } catch (err) {
    return { ok: false, error: 'UNDECODABLE' };
  }
  if (claims === null) {
    return { ok: false, error: 'UNDECODABLE' };
  }
  const problems = [];
  if (!claims.sub) {
    problems.push('MISSING_SUBJECT');
  }
  if (claims.exp + CLOCK_SKEW_SECONDS <= atMs / 1000) {
    problems.push('EXPIRED');
  }
  if (problems.length > 0) {
    return { ok: false, error: problems[0] };
  }
  return { ok: true, claims };
}
`;

const HARDENING = `/**
 * Hardening policy for the admin surface.
 *
 * The rules here are the narrative reason feature/hardening exists. They are
 * deliberately boring: the branch is about making a decision explicit that the
 * validator was already making implicitly.
 */

import type { TokenVerdict } from './token';

export interface Policy {
  requireSubject: boolean;
  maxLifetimeSeconds: number;
}

export const DEFAULT_POLICY: Policy = {
  requireSubject: true,
  maxLifetimeSeconds: 3600,
};

export function explain(verdict: TokenVerdict, policy: Policy = DEFAULT_POLICY): string {
  if (verdict.ok) {
    if (policy.requireSubject && !verdict.claims.sub) {
      return 'rejected: a subject is required by policy';
    }
    return 'accepted';
  }
  return 'rejected: ' + verdict.error.toLowerCase();
}

export function lifetimeSeconds(exp: number, now: number = Date.now()): number {
  return Math.max(0, exp - now / 1000);
}
`;

/** Decoy 1: an early-return ladder that has nothing to do with the auth module. */
const DB_MIGRATE = `/**
 * Migration runner.
 *
 * Nothing to do with the auth module. This file exists in the fixture so that
 * Ancestry has a genuinely unrelated neighbour with a similar shape: an
 * early-return ladder, a try/catch in the middle, and a collection built up at
 * the end.
 */

export interface Migration {
  id: string;
  up: string;
}

export interface MigrationResult {
  ok: boolean;
  applied: string[];
  failed?: string;
}

export function runMigrations(databaseUrl, pending, log) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    return { ok: false, applied: [], failed: 'no-dsn' };
  }
  const parts = databaseUrl.split('?');
  if (parts.length > 2) {
    return { ok: false, applied: [], failed: 'bad-dsn' };
  }
  const applied = [];
  try {
    for (const migration of pending) {
      log('applying ' + migration.id);
      applied.push(migration.id);
    }
  } catch (err) {
    return { ok: false, applied: applied, failed: 'apply-failed' };
  }
  if (applied.length === 0) {
    return { ok: false, applied: applied, failed: 'nothing-pending' };
  }
  return { ok: true, applied: applied };
}
`;

/** Decoy 2: the same trick one file over. */
const DB_POOL = `/**
 * Connection pool bookkeeping.
 *
 * The second decoy, and deliberately shaped like the auth validator: an
 * early-return ladder wrapped around a try/catch. It shares no semantics with
 * it, which is the entire reason it is here.
 */

export interface PoolStats {
  open: number;
  idle: number;
  waiting: number;
}

export function settleConnection(handle, stats, now = Date.now()) {
  if (typeof handle !== 'string' || handle.length === 0) {
    return { released: false, reason: 'no-handle' };
  }
  const parts = handle.split('#');
  if (parts.length !== 2) {
    return { released: false, reason: 'malformed-handle' };
  }
  let openedAt;
  try {
    openedAt = Number(parts[1]);
  } catch (err) {
    return { released: false, reason: 'unreadable-timestamp' };
  }
  if (!Number.isFinite(openedAt)) {
    return { released: false, reason: 'unreadable-timestamp' };
  }
  if (now - openedAt < 1000) {
    return { released: false, reason: 'too-young' };
  }
  stats.open = Math.max(0, stats.open - 1);
  stats.idle = stats.idle + 1;
  return { released: true };
}
`;

const TEST_AUTH = `import { describe, expect, it } from 'vitest';
import { validateToken } from '../src/auth';

function encode(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return 'h.' + body + '.s';
}

describe('validateToken', () => {
  it('rejects an empty token', () => {
    expect(validateToken('   ').reason).toBe('empty');
  });

  it('rejects a token that is not three segments', () => {
    expect(validateToken('a.b').reason).toBe('malformed');
  });

  it('rejects a token whose payload is not json', () => {
    expect(validateToken('h.@@@.s').reason).toBe('undecodable');
  });

  it('rejects a token without an expiry', () => {
    expect(validateToken(encode({ sub: 'a' })).reason).toBe('missing-exp');
  });

  it('rejects an expired token', () => {
    const now = 1_700_000_000_000;
    const token = encode({ sub: 'a', exp: now / 1000 - 600 });
    expect(validateToken(token, now).reason).toBe('expired');
  });

  it('accepts a live token', () => {
    const now = 1_700_000_000_000;
    const token = encode({ sub: 'a', exp: now / 1000 + 600 });
    expect(validateToken(token, now).valid).toBe(true);
  });
});
`;

const TEST_SECURITY = `import { describe, expect, it } from 'vitest';
import { evaluateToken } from '../src/security/token';

function encode(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return 'h.' + body + '.s';
}

describe('evaluateToken', () => {
  it('rejects a short token', () => {
    expect(evaluateToken('a.b')).toEqual({ ok: false, error: 'MALFORMED' });
  });

  it('rejects a payload that will not decode', () => {
    expect(evaluateToken('h.!!!.s').ok).toBe(false);
  });

  it('rejects a token with no subject', () => {
    const verdict = evaluateToken(encode({ exp: 4_000_000_000 }));
    expect(verdict).toEqual({ ok: false, error: 'MISSING_SUBJECT' });
  });

  it('rejects an expired token', () => {
    const verdict = evaluateToken(encode({ sub: 'a', exp: 1 }), 1_700_000_000_000);
    expect(verdict).toEqual({ ok: false, error: 'EXPIRED' });
  });

  it('accepts a live token with a subject', () => {
    const verdict = evaluateToken(encode({ sub: 'a', exp: 4_000_000_000 }), 1_700_000_000_000);
    expect(verdict.ok).toBe(true);
  });
});
`;

const TEST_HARDENING = `import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, explain, lifetimeSeconds } from '../src/security/hardening';

describe('hardening policy', () => {
  it('explains a rejection', () => {
    expect(explain({ ok: false, error: 'EXPIRED' })).toContain('expired');
  });

  it('rejects an accepted verdict that violates policy', () => {
    const verdict = { ok: true, claims: { sub: '', iss: 'i', exp: 1, scopes: [] } } as const;
    expect(explain(verdict)).toContain('subject');
  });

  it('computes a non-negative lifetime', () => {
    expect(lifetimeSeconds(1, 1_000)).toBe(0);
  });

  it('has a default policy', () => {
    expect(DEFAULT_POLICY.maxLifetimeSeconds).toBeGreaterThan(0);
  });
});
`;

const TEST_UTILS_WITHOUT_UA = `import { describe, expect, it } from 'vitest';
import { chunkArray, truncateMiddle } from '../src/utils/strings';

describe('utils', () => {
  it('chunks an array', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('leaves a short value alone', () => {
    expect(truncateMiddle('abc', 10)).toBe('abc');
  });

  it('truncates in the middle', () => {
    expect(truncateMiddle('abcdefghij', 5).length).toBeLessThanOrEqual(5);
  });
});
`;

const TEST_UTILS_WITH_UA = `import { describe, expect, it } from 'vitest';
import { chunkArray, formatUserAgent, truncateMiddle } from '../src/utils/strings';

describe('utils', () => {
  it('chunks an array', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('joins the user agent parts', () => {
    expect(formatUserAgent('curl', '8.4.0', 'windows')).toBe('curl 8.4.0 windows');
  });

  it('drops empty user agent parts', () => {
    expect(formatUserAgent('curl', '8.4.0', '')).toBe('curl 8.4.0');
  });

  it('leaves a short value alone', () => {
    expect(truncateMiddle('abc', 10)).toBe('abc');
  });

  it('truncates in the middle', () => {
    expect(truncateMiddle('abcdefghij', 5).length).toBeLessThanOrEqual(5);
  });
});
`;

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const INDEX_V1 = `export { formatUserAgent, padLeft } from './utils/format';
`;

const INDEX_WITH_AUTH = `export { validateToken } from './auth';
export { formatUserAgent, padLeft } from './utils/format';
`;

const INDEX_WITH_CHUNKS = `export { validateToken } from './auth';
export { formatUserAgent, padLeft, chunkArray } from './utils/format';
`;

const INDEX_WITH_SECURITY = `export { validateToken } from './auth';
export { evaluateToken } from './security/token';
export { formatUserAgent, padLeft, chunkArray } from './utils/format';
`;

const INDEX_STRINGS = `export { validateToken } from './auth';
export { evaluateToken } from './security/token';
export { formatUserAgent, padLeft, chunkArray } from './utils/strings';
`;

const INDEX_NO_UA = `export { validateToken } from './auth';
export { evaluateToken } from './security/token';
export { chunkArray, truncateMiddle } from './utils/strings';
`;

const INDEX_RESTORED = `export { validateToken } from './auth';
export { evaluateToken } from './security/token';
export { chunkArray, formatUserAgent, truncateMiddle } from './utils/strings';
`;

const INDEX_FINAL = `export { validateToken } from './auth';
export { evaluateToken } from './security/token';
export { settleConnection } from './db/pool';
export { chunkArray, formatUserAgent, truncateMiddle } from './utils/strings';
`;

/**
 * The commit sequence, in order. `hours` is the offset from the start of the
 * timeline and becomes the commit's author and committer date.
 */
const STEPS = [
  {
    hours: 0,
    branch: 'main',
    message: 'chore: initialise the tokenwall service',
    files: {
      'README.md': README,
      '.gitignore': 'node_modules/\ndist/\ncoverage/\n*.log\n',
      'package.json':
        JSON.stringify(
          {
            name: 'tokenwall',
            version: '0.1.0',
            private: true,
            description: 'Synthetic token service used as an Ancestry demo fixture.',
          },
          null,
          2,
        ) + '\n',
      'tsconfig.json': JSON.stringify(DEMO_TSCONFIG, null, 2) + '\n',
    },
  },
  {
    hours: 6,
    message: 'feat(utils): add user agent and padding helpers',
    files: {
      'src/index.ts': INDEX_V1,
      'src/utils/format.ts': FORMAT_V1,
    },
  },
  {
    // Scenario 1 — the original.
    hours: 48,
    message: 'feat(auth): add bearer token validation',
    files: {
      'src/auth.ts': AUTH_V1,
      'src/index.ts': INDEX_WITH_AUTH,
    },
  },
  {
    hours: 74,
    message: 'feat(utils): add chunkArray',
    files: {
      'src/index.ts': INDEX_WITH_CHUNKS,
      'src/utils/format.ts': FORMAT_WITH_CHUNKS,
    },
  },
  {
    hours: 200,
    message: 'docs: describe the token format',
    files: { 'docs/token-format.md': TOKEN_FORMAT_DOC },
  },
  {
    hours: 408,
    message: 'test: cover validateToken',
    files: { 'tests/auth.test.ts': TEST_AUTH },
  },
  {
    hours: 504,
    message: 'fix(auth): tolerate whitespace around the token',
    files: { 'src/auth.ts': AUTH_TRIMMED },
  },
  {
    // Scenario 2 — a copy with every identifier renamed.
    hours: 698,
    message: 'feat(legacy): port the validator to the v1 JavaScript surface',
    files: {
      'src/legacy/validate.js': LEGACY_VALIDATE,
      'src/legacy/README.md': LEGACY_README_INITIAL,
    },
  },
  {
    hours: 723,
    message: 'docs(legacy): mark the v1 validator deprecated',
    files: { 'src/legacy/README.md': LEGACY_README },
  },
  {
    hours: 866,
    message: 'feat(db): add the migration runner',
    files: { 'src/db/migrate.ts': DB_MIGRATE },
  },
  {
    // Scenario 3 — a modified copy.
    hours: 1134,
    message: 'feat(security): add the hardened token review',
    files: {
      'src/index.ts': INDEX_WITH_SECURITY,
      'src/security/token.ts': SECURITY_TOKEN,
    },
  },
  {
    hours: 1158,
    message: 'test: cover evaluateToken',
    files: { 'tests/security.test.ts': TEST_SECURITY },
  },
  {
    hours: 1382,
    message: 'chore(utils): drop the unused padding helper',
    files: { 'src/utils/format.ts': FORMAT_WITHOUT_PAD },
  },
  {
    // Scenario 4 — the moved function.
    hours: 1522,
    message: 'refactor(utils): rename format.ts to strings.ts',
    rename: ['src/utils/format.ts', 'src/utils/strings.ts'],
    files: {
      'src/index.ts': INDEX_STRINGS,
      'src/utils/strings.ts': STRINGS_V1,
    },
  },
  {
    hours: 1550,
    message: 'docs(utils): point the notes at the renamed module',
    files: { 'docs/utils.md': UTILS_DOC },
  },
  {
    // Scenario 7a — deleted.
    hours: 1904,
    message: 'refactor(utils): remove the user agent formatter',
    files: {
      'src/index.ts': INDEX_NO_UA,
      'src/utils/strings.ts': STRINGS_WITHOUT_UA,
    },
  },
  {
    hours: 1932,
    message: 'test(utils): drop the user agent coverage',
    files: { 'tests/utils.test.ts': TEST_UTILS_WITHOUT_UA },
  },
  {
    // Scenario 5 — a divergence that was never merged.
    hours: 2020,
    branch: 'experiment/absolute-expiry',
    message: 'feat(auth): drop the clock skew allowance',
    files: { 'src/auth.ts': AUTH_ABSOLUTE_EXPIRY },
  },
  {
    hours: 2044,
    message: 'docs(auth): record the experiment',
    files: { 'docs/experiments.md': EXPERIMENTS_DOC },
  },
  {
    // Scenario 5 — the branch that does get merged. Cut from `main`, not from
    // wherever the experiment left HEAD.
    hours: 2160,
    switch: 'main',
    branch: 'feature/hardening',
    message: 'feat(auth): verify the token issuer',
    files: { 'src/auth.ts': AUTH_HARDENED },
  },
  {
    hours: 2184,
    message: 'feat(hardening): add the hardening policy module',
    files: {
      'src/security/hardening.ts': HARDENING,
      'src/index.ts': INDEX_WITH_SECURITY,
    },
  },
  {
    hours: 2226,
    message: 'test(hardening): cover the issuer check',
    files: { 'tests/hardening.test.ts': TEST_HARDENING },
  },
  {
    // Divergence on main, touching the same file but a different region.
    hours: 2304,
    branch: 'main',
    message: 'feat(auth): add scope helpers',
    files: { 'src/auth.ts': AUTH_WITH_SCOPES },
  },
  {
    hours: 2328,
    message: 'chore: bump the service version',
    files: {
      'package.json':
        JSON.stringify(
          {
            name: 'tokenwall',
            version: '0.5.0',
            private: true,
            description: 'Synthetic token service used as an Ancestry demo fixture.',
          },
          null,
          2,
        ) + '\n',
    },
  },
  {
    // Scenario 6 — the merge commit.
    hours: 2424,
    merge: 'feature/hardening',
    message: 'merge: integrate feature/hardening',
  },
  {
    // Scenario 7b — re-introduced.
    hours: 2568,
    message: 'feat(utils): restore the user agent formatter',
    files: {
      'src/index.ts': INDEX_RESTORED,
      'src/utils/strings.ts': STRINGS_RESTORED,
    },
  },
  {
    hours: 2592,
    message: 'test(utils): cover the restored formatter',
    files: { 'tests/utils.test.ts': TEST_UTILS_WITH_UA },
  },
  {
    hours: 2736,
    message: 'feat(db): add connection pool bookkeeping',
    files: {
      'src/index.ts': INDEX_FINAL,
      'src/db/pool.ts': DB_POOL,
    },
  },
  {
    hours: 2820,
    message: 'docs: point at the ancestry scenarios in this history',
    files: { 'docs/scenarios.md': SCENARIOS_DOC },
  },
];

/** Scenario map printed in the summary and asserted by the test suite. */
const SCENARIOS = [
  { id: 1, name: 'original function', where: 'src/auth.ts :: validateToken' },
  { id: 2, name: 'renamed copy', where: 'src/legacy/validate.js :: checkToken' },
  { id: 3, name: 'modified copy', where: 'src/security/token.ts :: evaluateToken' },
  { id: 4, name: 'moved function', where: 'src/utils/format.ts -> src/utils/strings.ts' },
  { id: 5, name: 'branch divergence', where: 'feature/hardening, experiment/absolute-expiry' },
  { id: 6, name: 'merge commit', where: 'feature/hardening -> main' },
  { id: 7, name: 'deleted and re-introduced', where: 'src/utils/strings.ts :: formatUserAgent' },
  { id: '-', name: 'decoy (unrelated)', where: 'src/db/migrate.ts :: runMigrations' },
  { id: '-', name: 'decoy (unrelated)', where: 'src/db/pool.ts :: settleConnection' },
];

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

let repoRoot = null;
let env = null;

class GitError extends Error {}

/**
 * Run one git command.
 *
 * `shell: false` and an argv array, always. This is the same discipline the
 * extension's Git layer uses, and the reason nothing in this script has to think
 * about quoting: a path containing a space, a quote or a semicolon is just an
 * array element.
 */
function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    // Explicit, not the default: never, under any circumstance, a shell.
    shell: false,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env ?? env,
  });

  if (result.error) {
    throw new GitError(`git ${args[0]} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new GitError(
      `git ${args.join(' ')} exited with ${result.status}` + (stderr ? `:\n  ${stderr}` : ''),
    );
  }
  return (result.stdout ?? '').trim();
}

function gitLines(args) {
  const out = git(args);
  return out.length === 0 ? [] : out.split('\n');
}

function configInit() {
  if (!repoRoot) {
    throw new Error('internal: repository root was not set up');
  }

  // A non-existent file. Neutralises the user's global config — commit
  // templates, a global excludes file, an insteadOf redirect, signing keys —
  // so the fixture is hermetic. Requires git >= 2.32; on older git it is
  // ignored and the local settings below still win for everything we set.
  const emptyGlobal = path.join(repoRoot, '.git', 'ancestry-demo-empty-gitconfig');

  env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobal,
    GIT_CONFIG_SYSTEM: path.join(repoRoot, '.git', 'ancestry-demo-empty-system-config'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    // English messages, so the summary parses the same on every machine.
    LC_ALL: 'C',
    LANG: 'C',
  };

  git(['init', '--quiet'], { env });
  git(['config', 'user.name', AUTHOR_NAME]);
  git(['config', 'user.email', AUTHOR_EMAIL]);
  git(['config', 'init.defaultBranch', 'main']);
  // Force the unborn branch to be `main` regardless of the installed git's
  // default, so `main` exists as soon as the first commit lands.
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);

  const local = {
    'commit.gpgsign': 'false',
    'tag.gpgsign': 'false',
    'core.autocrlf': 'false',
    'core.eol': 'lf',
    'core.safecrlf': 'false',
    'core.quotepath': 'false',
    'core.fileMode': 'false',
    'core.ignorecase': 'false',
    'diff.renames': 'true',
    'diff.renameLimit': '1000',
    'gc.auto': '0',
    'advice.detachedHead': 'false',
    'merge.log': 'false',
    // Never run a hook from this machine's global config, and never honour a
    // global excludes or attributes file.
    'core.hooksPath': path.join(repoRoot, '.git', 'ancestry-demo-no-hooks'),
    'core.excludesFile': path.join(repoRoot, '.git', 'ancestry-demo-no-excludes'),
    'core.attributesFile': path.join(repoRoot, '.git', 'ancestry-demo-no-attributes'),
  };
  for (const [key, value] of Object.entries(local)) {
    git(['config', key, value]);
  }
}

function writeFile(relative, contents) {
  const target = path.join(repoRoot, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  // Normalised to LF unconditionally: the fixture's commit SHAs must not depend
  // on how the checkout of *this* repository happens to have EOLs on disk.
  writeFileSync(target, contents.replace(/\r\n/g, '\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

let currentBranch = null;

function checkout(branch) {
  const exists = gitLines(['branch', '--list', '--format=%(refname:short)', branch]);
  if (exists.length === 1) {
    git(['checkout', '--quiet', branch]);
  } else {
    // `checkout -b` rather than `switch -c` for compatibility with gits older
    // than 2.23. This is a fixture script, not the extension's Git layer.
    git(['checkout', '--quiet', '-b', branch]);
  }
  currentBranch = branch;
}

function buildHistory() {
  for (const step of STEPS) {
    // `switch` returns to an existing branch before anything else happens, which
    // matters when the next line creates a new branch: a branch created from
    // wherever HEAD happens to be is how an abandoned experiment silently ends
    // up merged into main.
    if (step.switch && step.switch !== currentBranch) {
      checkout(step.switch);
    }
    if (step.branch && step.branch !== currentBranch) {
      checkout(step.branch);
    }

    if (step.rename) {
      const [from, to] = step.rename;
      mkdirSync(path.dirname(path.join(repoRoot, to)), { recursive: true });
      git(['mv', from, to]);
    }

    for (const [relative, contents] of Object.entries(step.files ?? {})) {
      writeFile(relative, contents);
    }

    git(['add', '--all']);

    // A step that changes nothing is a bug in this table, not something to skip
    // silently: a silently dropped scenario is an Ancestry fixture that quietly
    // stops testing what it claims to test. Fail with the step named.
    if (!step.merge && git(['status', '--porcelain']).length === 0) {
      throw new Error(`step "${step.message}" would not change anything`);
    }

    const commitEnv = {
      ...env,
      GIT_AUTHOR_DATE: dateAt(step.hours),
      GIT_COMMITTER_DATE: dateAt(step.hours),
    };

    if (step.merge) {
      // `--no-ff` so the merge is a real merge commit with two parents, which
      // is what scenario 6 needs. `-m` supplies the message, so git does not
      // open an editor.
      git(['merge', '--no-ff', '-m', step.message, step.merge], { env: commitEnv });
      continue;
    }

    git(['commit', '--quiet', '--no-verify', '-m', step.message], { env: commitEnv });
  }
}

function writeMarker() {
  const marker = {
    marker: 'ancestry-demo-repository',
    version: MARKER_VERSION,
    generator: 'scripts/make-demo-repo.mjs',
    author: AUTHOR_NAME,
    commits: STEPS.length,
    scenarios: SCENARIOS,
  };
  const target = path.join(repoRoot, '.git', MARKER);
  writeFileSync(target, JSON.stringify(marker, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function summary() {
  const headOn = Number(git(['rev-list', '--count', 'HEAD']));
  const allRefs = Number(git(['rev-list', '--count', '--all']));
  const merges = Number(git(['rev-list', '--count', '--merges', 'HEAD']));
  const branches = gitLines(['branch', '--format=%(refname:short)']);
  const files = gitLines(['ls-files']);
  const head = git(['log', '-1', '--format=%h %s']);
  const headSha = git(['rev-parse', 'HEAD']);

  log('');
  log('Ancestry demonstration repository');
  log('=================================');
  log(`  path      ${repoRoot}`);
  log(`  head      ${head}`);
  log(`  commits   ${headOn} reachable from HEAD, ${allRefs} across all refs`);
  log(`  merges    ${merges}`);
  log(`  branches  ${branches.join(', ')}`);
  log(`  files     ${files.length} tracked at HEAD`);
  log(`  sha       ${headSha}`);
  log('');
  log('  Scenarios embedded in this history:');
  for (const scenario of SCENARIOS) {
    const id = String(scenario.id).padStart(2, ' ');
    log(`   ${id}  ${scenario.name.padEnd(26)} ${scenario.where}`);
  }
  log('');
  log(`  Open it:   code "${repoRoot}"`);
  log('  Analyse:  select validateToken in src/auth.ts, then');
  log('             Ancestry: Analyze Code Ancestry');
  log(`  Remove it: rm -rf "${repoRoot}"`);
  log('');

  return { headOn, allRefs, merges, branches, files, headSha };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function isDemoRepo(target) {
  return existsSync(path.join(target, '.git', MARKER));
}

/**
 * Decide where the repository goes and whether we are allowed to put it there.
 *
 * @returns {{target: string, owned: boolean}} `owned` is true when this script
 * created the directory, which is what authorises deleting it if a later step
 * fails.
 */
function prepareTarget(options) {
  if (!options.target) {
    return { target: mkdtempSync(path.join(tmpdir(), 'ancestry-demo-')), owned: true };
  }

  const target = path.resolve(options.target);

  if (existsSync(target)) {
    const reusable = isDemoRepo(target) || readdirSync(target).length === 0;
    if (!reusable && !options.force) {
      fail(
        'refusing to replace a non-empty directory that is not a demonstration\n' +
          `  repository: ${target}\n` +
          '  pass --force to replace it anyway, or choose another path.',
      );
      process.exit(1);
    }
    rmSync(target, { recursive: true, force: true });
  }

  mkdirSync(target, { recursive: true });
  return { target, owned: true };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log(USAGE);
    return;
  }

  // git must exist. Fail loudly and specifically, because "spawnSync git ENOENT"
  // is not something a new user can act on.
  const probe = spawnSync('git', ['--version'], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe.error || probe.status !== 0) {
    fail(
      'git was not found on PATH.\n' +
        "  Ancestry's demonstration repository is built with real git commands,\n" +
        '  so git has to be installed and on the PATH of the process running\n' +
        '  this script.\n' +
        (probe.error ? `  Underlying error: ${probe.error.message}\n` : '') +
        '  Install Git from https://git-scm.com/downloads and try again.',
    );
    process.exit(1);
  }
  log(`[ancestry-demo] using ${probe.stdout.trim()}`);

  const { target, owned } = prepareTarget(options);
  repoRoot = target;

  try {
    configInit();
    buildHistory();
    writeMarker();
    summary();
  } catch (error) {
    fail(`failed to build the demonstration repository: ${error.message}`);
    if (error instanceof GitError) {
      fail(`this is a bug in ${SCRIPT_PATH} — please report it.`);
    }
    // Clean up after ourselves when we created the directory. A directory the
    // user pointed at with --force is left in place: deleting something we did
    // not create would be a surprise, and a half-built fixture is enough to
    // debug from.
    if (owned) {
      rmSync(target, { recursive: true, force: true });
      fail(`removed the partially built repository at ${target}`);
    } else {
      fail(`a partial repository is left at ${target}`);
    }
    process.exit(1);
  }
}

main();
