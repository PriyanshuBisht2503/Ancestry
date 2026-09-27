/**
 * Test-only access to Node's `node:sqlite` builtin.
 *
 * WHY THIS SHIM EXISTS
 * --------------------
 * Vitest resolves test modules through Vite, and Vite's resolver strips the
 * `node:` prefix before checking Node's builtin list. `node:sqlite` is new enough
 * that it is missing from the list Vite ships, so the specifier becomes `sqlite`,
 * Vite looks for a package called `sqlite`, and the suite fails to load with
 * "Failed to load url sqlite" — a tooling failure that has nothing to do with the
 * code under test.
 *
 * `createRequire` re-enters Node's own resolver, which does know the builtin.
 * This is the same escape hatch `src/cache/sqliteStore.ts` already uses, for the
 * same reason.
 *
 * The types come from `@types/node`, so `typeof import('node:sqlite')` keeps the
 * real API surface and a signature change upstream is a compile error rather than
 * a silent `any`.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(__filename);

interface NodeSqliteModule {
  DatabaseSync: typeof import('node:sqlite').DatabaseSync;
}

const sqlite = nodeRequire('node:sqlite') as NodeSqliteModule;

export const DatabaseSync = sqlite.DatabaseSync;

/**
 * The instance type, under the same name as the constructor.
 *
 * A `const` only occupies the value declaration space, so a test that writes
 * `function openRaw(): DatabaseSync` would fail to compile and silently degrade
 * to `any` — taking the contextual typing of `db.prepare(...).all()` with it,
 * which turns every `row` in the file into an implicit `any` and buries the real
 * error under a pile of downstream noise.
 *
 * A local type alias is used rather than `export type { DatabaseSync } from
 * 'node:sqlite'`: the latter is an export *declaration*, which conflicts with
 * the exported const of the same name. A type alias lives in the type space, so
 * the two coexist exactly as `class`/value pairs do.
 */
type DatabaseSyncInstance = InstanceType<NodeSqliteModule['DatabaseSync']>;
export type DatabaseSync = DatabaseSyncInstance;
