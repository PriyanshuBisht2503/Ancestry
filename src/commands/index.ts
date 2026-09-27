/**
 * Command registration.
 *
 * Every command is registered through {@link registerCommand}, which wraps the
 * body in `guard()` so a rejection becomes a notification instead of an unhandled
 * promise rejection. In the extension host, an unhandled rejection is reported to
 * the user as an opaque "the extension host terminated unexpectedly"-class
 * failure and, depending on the VS Code version, can deactivate the extension
 * entirely — so this wrapper is the difference between one bad file and a broken
 * editor session.
 *
 * Command ids here MUST match the `contributes.commands` entries in
 * `package.json`. `assertCommandIdsMatch` checks that at activation in
 * development, so a typo fails loudly rather than becoming a dead menu item.
 */
import * as vscode from 'vscode';
import { analyzeCurrentFileCommand, analyzeSelectionCommand } from './analyze';
import {
  clearCacheCommand,
  cancelAnalysisCommand,
  showCacheStatsCommand,
  showSettingsCommand,
} from './cacheCommands';
import {
  createWebviewSerializer,
  exportGraphCommand,
  handleWebviewMessage,
  replayLastAnalysisCommand,
} from './graphCommands';
import { guard, presentError } from './errors';
import { ExtensionServices, type CommandContext } from './context';
import {
  COMMANDS,
  COMMAND_IDS,
  findUndeclaredCommands,
  findUnimplementedCommands,
  type CommandDescriptor,
  type CommandId,
} from './registry';

export { COMMANDS, COMMAND_IDS, findUndeclaredCommands, findUnimplementedCommands };
export type { CommandDescriptor, CommandId, CommandContext };

export function registerCommands(context: CommandContext): vscode.Disposable[] {
  // The behavioural half of each descriptor lives here, keyed by id, so
  // `registry.ts` stays pure data and importable without the analysis stack.
  const runners: Record<CommandId, (context: CommandContext) => Promise<void>> = {
    [COMMAND_IDS.analyzeSelection]: analyzeSelectionCommand,
    [COMMAND_IDS.analyzeCurrentFile]: analyzeCurrentFileCommand,
    [COMMAND_IDS.replay]: replayLastAnalysisCommand,
    [COMMAND_IDS.export]: exportGraphCommand,
    // Opening settings cannot fail in a way worth a toast, and a rejected
    // `executeCommand` should stay silent rather than alarming the user.
    [COMMAND_IDS.settings]: async (ctx) => showSettingsCommand(ctx),
    [COMMAND_IDS.clearCache]: clearCacheCommand,
    [COMMAND_IDS.cacheStats]: showCacheStatsCommand,
    [COMMAND_IDS.cancel]: async (ctx) => cancelAnalysisCommand(ctx),
  };

  return COMMANDS.map((command) =>
    vscode.commands.registerCommand(command.id, async () => {
      try {
        await runners[command.id](context);
      } catch (err: unknown) {
        // Commands are already `guard`-wrapped internally; this is the second
        // line of defence for a command that throws *before* reaching its guard.
        presentError(err, {
          logger: context.logger,
          status: context.status,
          title: `Ancestry: ${command.title}`,
          action: command.action,
        });
      }
    }),
  );
}

export {
  guard,
  analyzeCurrentFileCommand,
  analyzeSelectionCommand,
  cancelAnalysisCommand,
  clearCacheCommand,
  createWebviewSerializer,
  exportGraphCommand,
  handleWebviewMessage,
  replayLastAnalysisCommand,
  showCacheStatsCommand,
  showSettingsCommand,
  ExtensionServices,
};
