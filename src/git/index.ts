/**
 * Public surface of the Git engine.
 *
 * Modules outside `src/git` import from here only, so the internal file layout
 * (safety, process layer, parsers) can change without rippling through the
 * extension.
 */

export { GitRepository } from './repo';
export type { AncestryLogOptions } from './repo';

export { runGit, GitBinaryMissingError, GitCommandError, isAbortError } from './exec';
export type { GitExecOptions, GitExecResult, GitRunner } from './exec';
export { GIT_COMMAND_TIMEOUT_MS, GIT_MAX_BUFFER_BYTES } from './exec';

export { parseCommits, parseNameStatusZ, parseBranches, parseBlamePorcelain } from './format';

export { assertSafeRepoPath, assertSafeRevision, assertSafeGitPathOrNull } from './safety';
