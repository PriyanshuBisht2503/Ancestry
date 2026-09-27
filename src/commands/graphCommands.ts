/**
 * Commands that operate on an already-computed graph: replay, export, and the
 * webview → editor navigation round trip.
 *
 * The round trip is the part worth explaining. When the user clicks a node in the
 * 3D view, Ancestry does three things: opens that node's file at that node's
 * line range, highlights the full ancestry path in the graph, and — only if the
 * file exists in the working tree — reveals it. Two safety rules apply:
 *
 *  1. **Node ids are resolved against the retained graph, never used as paths.**
 *     The webview is not a trust boundary we should be casual with, even though
 *     `AncestryWebviewPanel` already validates it. Defence in depth is cheap here
 *     and the failure mode (opening an arbitrary file) is not.
 *  2. **A path from a commit is joined onto the repository root, then re-checked**
 *     that the result is still inside the root. A crafted node with
 *     `filePath: "../../etc/passwd"` must not read anything, and `vscode.Uri.file`
 *     would happily accept it.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { graphToJson, toWebviewPayload, type RunStats } from '../webview/serialize';
import { originPath } from '../graph';
import { AncestryError, type WebviewToHostMessage } from '../types';
import { guard } from './errors';
import type { AncestryWebviewPanel } from '../webview/host';
import type { CommandContext } from './context';

/** Re-renders the most recent analysis without re-running it. */
export async function replayLastAnalysisCommand(context: CommandContext): Promise<void> {
  await guard(
    context.logger,
    context.status,
    'Ancestry: Replay Last Analysis',
    'replay the last analysis',
    async () => {
      const result = context.engine.lastResult();
      if (result === null) {
        throw new AncestryError(
          'NO_MATCHES',
          'No analysis has been run in this session yet. Run "Ancestry: Analyze Selected Code" first.',
        );
      }
      const panel = context.webview.panel;
      if (panel === null) {
        // No live panel: open a fresh one and re-send the retained graph.
        context.webview.revealForGraph(result.graph, '', {
          durationMs: result.durationMs,
          cacheHits: result.cache.hits,
          cacheMisses: result.cache.misses,
        });
      } else {
        panel.setGraph(
          toWebviewPayload(result.graph, '', {
            durationMs: result.durationMs,
            cacheHits: result.cache.hits,
            cacheMisses: result.cache.misses,
          } satisfies RunStats),
        );
        panel.reveal();
      }
      context.status.showDone('Replayed the last analysis');
    },
  );
}

/** Writes the current graph to a JSON file the user chooses. */
export async function exportGraphCommand(context: CommandContext): Promise<void> {
  await guard(
    context.logger,
    context.status,
    'Ancestry: Export Ancestry Graph',
    'export the graph',
    async () => {
      const json = context.webview.panel?.exportGraphJson() ?? graphForLastResult(context);
      if (json === null) {
        throw new AncestryError(
          'NO_MATCHES',
          'There is no ancestry graph to export. Run "Ancestry: Analyze Selected Code" first.',
        );
      }

      const focus = focusNameOf(context);
      const defaultName = `${sanitizeFileName(focus)}.ancestry.json`;
      const target = await vscode.window.showSaveDialog({
        title: 'Export Ancestry Graph',
        defaultUri: vscode.Uri.file(path.join(workspaceRoot(context), defaultName)),
        filters: { JSON: ['json'] },
        saveLabel: 'Export',
      });
      if (target === undefined) {
        context.status.hide();
        return;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
      context.status.showDone(`Exported to ${path.basename(target.fsPath)}`);
      void vscode.window.showInformationMessage(`Ancestry graph exported to ${target.fsPath}`);
    },
  );
}

function graphForLastResult(context: CommandContext): string | null {
  const result = context.engine.lastResult();
  return result === null ? null : graphToJson(result.graph);
}

function focusNameOf(context: CommandContext): string {
  const graph = context.engine.lastResult()?.graph;
  const focus = graph?.nodes.find((node) => node.isFocus);
  return focus?.qualifiedName ?? focus?.blockName ?? 'ancestry';
}

/** Filesystem-safe name: keeps word characters, replaces everything else. */
function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'ancestry';
}

function workspaceRoot(context: CommandContext): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder !== undefined) {
    return folder.uri.fsPath;
  }
  return context.extensionPath;
}

/**
 * Joins a repository-relative path onto the root and proves the result stayed
 * inside. This is the defence against a node whose `filePath` contains `..`.
 */
export function resolveRepoFile(repositoryRoot: string, repoRelativePath: string): string | null {
  if (
    typeof repoRelativePath !== 'string' ||
    repoRelativePath.length === 0 ||
    repoRelativePath.includes('\0')
  ) {
    return null;
  }
  const normalized = repoRelativePath.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }
  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(root, normalized);
  const withSeparator = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved === root || resolved.startsWith(withSeparator) ? resolved : null;
}

/**
 * Handles one validated message from the webview.
 *
 * Only three of the six message types need host action; the rest are webview
 * bookkeeping. Each branch is total: an unknown node id is a no-op, not a throw.
 */
export function handleWebviewMessage(
  context: CommandContext,
  panel: AncestryWebviewPanel,
  message: WebviewToHostMessage,
): void {
  switch (message.type) {
    case 'selectNode':
      onSelectNode(context, panel, message.payload.nodeId);
      return;
    case 'setFilter':
      context.logger.debug(`Webview filter: ${JSON.stringify(summarizeFilter(message.payload))}`);
      return;
    case 'requestExport':
      void exportGraphCommand(context);
      return;
    case 'clientError':
      context.logger.warn(`Webview reported an error: ${cap(message.payload.message, 500)}`);
      return;
    case 'ready':
      return;
    case 'requestDetails':
      onRequestDetails(context, message.payload.nodeId);
      return;
    default:
      return;
  }
}

function onSelectNode(context: CommandContext, panel: AncestryWebviewPanel, nodeId: string): void {
  const graph = panel.lastPayload?.graph;
  if (graph === undefined) {
    return;
  }
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    return;
  }
  // Highlight the lineage, then optionally open the file. Highlighting is the
  // cheap, always-correct action; opening the file is best-effort because the
  // node may be from a commit that is not in the working tree.
  const path_ = originPath(graph, nodeId);
  const lineage = path_.length > 0 ? path_ : [nodeId];
  panel.highlight(lineage, 'ancestry path from your selection');
  context.status.showDone(
    `${node.qualifiedName ?? node.blockName ?? 'version'} · ${node.shortCommit}`,
  );

  const absolute = resolveRepoFile(graph.repositoryRoot, node.filePath);
  if (absolute === null) {
    return;
  }
  const line = Math.max(0, node.lineStart - 1);
  const range = new vscode.Range(line, 0, Math.max(line, node.lineEnd - 1), 0);
  void vscode.window
    .showTextDocument(vscode.Uri.file(absolute), {
      preview: true,
      preserveFocus: true,
      selection: range,
    })
    .then(undefined, (error: unknown) => {
      // The file may have been deleted since the commit was recorded. That is
      // expected, not exceptional — log it and leave the user in the graph.
      context.logger.debug(`Could not open ${node.filePath}: ${cap(String(error), 200)}`);
    });
}

function onRequestDetails(context: CommandContext, nodeId: string): void {
  const graph = context.engine.lastResult()?.graph;
  const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
  if (graph === undefined || node === undefined) {
    return;
  }
  const parent = graph.origin;
  void vscode.window.showInformationMessage(
    [
      `${node.qualifiedName ?? node.blockName ?? '(anonymous)'} — ${node.blockKind}`,
      `${node.filePath}:${node.lineStart}`,
      `${node.shortCommit} by ${node.author.name} on ${new Date(node.timestamp).toISOString().slice(0, 10)}`,
      `similarity ${(node.similarity * 100).toFixed(1)}% (${node.classification})`,
      parent === null ? 'no origin detected' : `earliest detected match: ${parent.shortCommit}`,
    ].join('\n'),
  );
}

function summarizeFilter(filter: {
  branches?: string[];
  files?: string[];
  authors?: string[];
  minSimilarity?: number;
  search?: string;
}): Record<string, string | number> {
  const summary: Record<string, string | number> = {};
  if (filter.branches !== undefined) summary.branches = filter.branches.join(',');
  if (filter.files !== undefined) summary.files = filter.files.join(',');
  if (filter.authors !== undefined) summary.authors = filter.authors.join(',');
  if (filter.minSimilarity !== undefined) summary.minSimilarity = filter.minSimilarity;
  if (filter.search !== undefined) summary.search = cap(filter.search, 100);
  return summary;
}

function cap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Restores a webview tab after a window reload, without re-running anything. */
export function createWebviewSerializer(context: CommandContext): vscode.WebviewPanelSerializer {
  return {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
      // The graph is never persisted (it contains source text), so a restored
      // panel starts empty and tells the user what to do rather than showing a
      // blank canvas. This is also why the extension needs no extra state store.
      panel.webview.options = { enableScripts: true };
      panel.webview.html = restorePlaceholderHtml();
      context.logger.info('Restored an empty Ancestry webview; a re-analysis is required');
    },
  };
}

function restorePlaceholderHtml(): string {
  const escaped =
    'Ancestry restores webviews without stored analysis data, so this tab is empty. Run "Ancestry: Analyze Selected Code" to rebuild it.';
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\';">',
    '<title>Ancestry</title>',
    '<style>body{font-family:var(--vscode-font-family,system-ui,sans-serif);color:var(--vscode-foreground,#ccc);background:var(--vscode-editor-background,#1e1e1e);display:grid;place-items:center;height:100vh;margin:0;padding:2rem;text-align:center}</style>',
    '</head><body>',
    `<p>${escaped}</p>`,
    '</body></html>',
  ].join('\n');
}
