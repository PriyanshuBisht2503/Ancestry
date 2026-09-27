/**
 * Cache and settings commands.
 *
 * The cache commands exist because a user who distrusts a tool's local storage
 * must be able to inspect and destroy it without leaving the editor or editing
 * `settings.json`. `clearCache` is also the documented remedy in
 * `hintForCode('CACHE_CORRUPT')`, so it has to actually work from a notification.
 */
import * as vscode from 'vscode';
import { guard } from './errors';
import { formatBytes, formatCount, formatTimestamp } from './format';
import type { CommandContext } from './context';

const CONFIRM_CLEAR = 'Clear Ancestry Index';

/** Wipes the local index. Requires explicit confirmation — it is destructive. */
export async function clearCacheCommand(context: CommandContext): Promise<void> {
  await guard(
    context.logger,
    context.status,
    'Ancestry: Clear Ancestry Index Cache',
    'clear the local index',
    async () => {
      const store = await context.cache();
      if (store === null) {
        void vscode.window.showInformationMessage(
          'The Ancestry local index is disabled, so there is nothing to clear.',
        );
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        "This deletes Ancestry's local index: cached commits, parsed blocks, normalisations, and similarity results. Nothing in your repository is touched. The next analysis will be slower because it runs cold.",
        { modal: true },
        CONFIRM_CLEAR,
      );
      if (confirmation !== CONFIRM_CLEAR) {
        context.status.hide();
        return;
      }
      const location = store.info.location;
      const entriesBefore = (await store.stats()).entries;
      await store.clear();
      context.status.showDone('Local index cleared');
      void vscode.window.showInformationMessage(
        `Ancestry local index cleared: ${formatCount(entriesBefore)} entr${entriesBefore === 1 ? 'y' : 'ies'} removed from ${location}. Nothing in your repository was touched.`,
      );
    },
  );
}

/** Reports what is in the index. Read-only, so no confirmation is needed. */
export async function showCacheStatsCommand(context: CommandContext): Promise<void> {
  await guard(
    context.logger,
    context.status,
    'Ancestry: Show Ancestry Cache Statistics',
    'read the index statistics',
    async () => {
      const store = await context.cache();
      if (store === null) {
        void vscode.window.showInformationMessage(
          'The Ancestry local index is disabled. Enable "ancestry.cache.enabled" to use it.',
        );
        return;
      }
      const stats = await store.stats();
      const hitRate =
        stats.hits + stats.misses === 0
          ? 'n/a'
          : `${Math.round((stats.hits / (stats.hits + stats.misses)) * 100)}%`;

      const lines = [
        `backend:        ${stats.backend}${store.info.native ? '' : ' (fallback)'}`,
        `location:       ${store.info.location}`,
        `schema:         v${store.info.schemaVersion}`,
        `entries:        ${formatCount(stats.entries)}`,
        `repositories:   ${formatCount(stats.repositoryCount)}`,
        `size:           ${formatBytes(stats.bytes)}`,
        `hit rate:       ${hitRate} (${formatCount(stats.hits)} hits / ${formatCount(stats.misses)} misses, this session)`,
        `evictions:      ${formatCount(stats.evictions)}`,
        `oldest entry:   ${formatTimestamp(stats.oldestEntryTimestamp)} UTC`,
        `newest entry:   ${formatTimestamp(stats.newestEntryTimestamp)} UTC`,
      ];
      if (store.info.note !== null) {
        lines.push(`note:           ${store.info.note}`);
      }

      const choice = await vscode.window.showInformationMessage(
        `Ancestry index — ${formatCount(stats.entries)} entries, ${formatBytes(stats.bytes)}, ${hitRate} cache hit rate.`,
        'Details',
        'Open Folder',
        CONFIRM_CLEAR,
      );
      if (choice === 'Details') {
        void vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
      } else if (choice === 'Open Folder') {
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(store.info.location),
        );
      } else if (choice === CONFIRM_CLEAR) {
        await clearCacheCommand(context);
      }
    },
  );
}

/** Opens the extension's settings, optionally scrolled to one key. */
export async function showSettingsCommand(context: CommandContext, key?: string): Promise<void> {
  await vscode.commands.executeCommand(
    'workbench.action.openSettings',
    key === undefined ? 'ancestry' : `ancestry.${key}`,
  );
  context.status.showDone('Opened Ancestry settings');
}

/**
 * Cancels any in-flight analysis. Bound to Escape in the webview's status line
 * and reachable from the command palette, so a long run is always stoppable even
 * if the progress notification has already gone.
 */
export async function cancelAnalysisCommand(context: CommandContext): Promise<void> {
  const count = context.cancellation.activeCount;
  if (count === 0) {
    void vscode.window.showInformationMessage('No Ancestry analysis is running.');
    return;
  }
  context.cancellation.cancelAll();
  context.status.showDone(`Cancelled ${count} running analys${count === 1 ? 'is' : 'es'}`);
}
