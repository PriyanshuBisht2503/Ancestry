/**
 * Command metadata, separated from the wiring.
 *
 * Keeping the ids and the human-readable titles in their own module means the
 * manifest-consistency check can be unit tested without importing `analyze.ts`,
 * which in turn pulls in the whole analysis stack. Manifest data and behaviour
 * live in different files for the same reason `types.ts` is frozen: they change
 * for different reasons, and only one of those reasons should ever require
 * touching a test.
 */

/** Every command id the extension contributes. Keys are the internal names. */
export const COMMAND_IDS = {
  analyzeSelection: 'ancestry.analyzeSelection',
  analyzeCurrentFile: 'ancestry.analyzeCurrentFile',
  replay: 'ancestry.replayLastAnalysis',
  export: 'ancestry.exportGraph',
  settings: 'ancestry.showSettings',
  clearCache: 'ancestry.clearCache',
  cacheStats: 'ancestry.showCacheStats',
  cancel: 'ancestry.cancelAnalysis',
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

export interface CommandDescriptor {
  id: CommandId;
  /** Title shown in an error notification, e.g. "Analyze Selected Code". */
  title: string;
  /**
   * What the user was trying to do, phrased to complete "Could not ___".
   * Kept as a gerund phrase so error messages read as a sentence.
   */
  action: string;
}

/**
 * Declaration order matches the `contributes.commands` order in `package.json`,
 * which is the order they appear in the Command Palette.
 */
export const COMMANDS: ReadonlyArray<CommandDescriptor> = Object.freeze([
  {
    id: COMMAND_IDS.analyzeSelection,
    title: 'Analyze Selected Code',
    action: 'analyse the selection',
  },
  {
    id: COMMAND_IDS.analyzeCurrentFile,
    title: 'Analyze a Block in File',
    action: 'list the blocks in this file',
  },
  {
    id: COMMAND_IDS.replay,
    title: 'Replay Last Ancestry Analysis',
    action: 'replay the last analysis',
  },
  { id: COMMAND_IDS.export, title: 'Export Ancestry Graph as JSON', action: 'export the graph' },
  { id: COMMAND_IDS.settings, title: 'Open Settings', action: 'open the settings' },
  {
    id: COMMAND_IDS.clearCache,
    title: 'Clear Ancestry Index Cache',
    action: 'clear the local index',
  },
  {
    id: COMMAND_IDS.cacheStats,
    title: 'Show Ancestry Cache Statistics',
    action: 'read the index statistics',
  },
  {
    id: COMMAND_IDS.cancel,
    title: 'Cancel Running Analysis',
    action: 'cancel the running analysis',
  },
]);

/** A shape loose enough to accept a parsed `package.json`. */
export interface CommandManifest {
  contributes?: { commands?: ReadonlyArray<{ command?: unknown }> };
}

/**
 * Reports command ids that are implemented but absent from the manifest.
 *
 * A non-empty result is a development bug, never a user error, so callers log it
 * rather than throwing: an extension that refuses to activate over a manifest
 * typo is worse than one with a missing palette entry.
 */
export function findUndeclaredCommands(
  manifest: CommandManifest,
  declared: ReadonlyArray<string> = COMMANDS.map((command) => command.id),
): string[] {
  const manifestIds = new Set(
    (manifest.contributes?.commands ?? [])
      .map((entry) => entry.command)
      .filter((id): id is string => typeof id === 'string'),
  );
  return declared.filter((id) => !manifestIds.has(id));
}

/** Reports manifest entries that are declared but not implemented. */
export function findUnimplementedCommands(manifest: CommandManifest): string[] {
  const implemented = new Set<string>(COMMANDS.map((command) => command.id));
  return (manifest.contributes?.commands ?? [])
    .map((entry) => entry.command)
    .filter((id): id is string => typeof id === 'string' && !implemented.has(id));
}
