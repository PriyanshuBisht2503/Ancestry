/**
 * The two analysis entry points: analyse the current selection, and analyse a
 * named block in the current file.
 *
 * Design notes
 * ------------
 * * **Selection → one block, always.** The user selects something and gets one
 *   graph. Silently returning several graphs would make the "which one is this?"
 *   problem the user's to solve.
 * * **A cursor with no selection analyses the enclosing block.** That is the
 *   common case — the user clicked into a method and invoked the command. Forcing
 *   a selection first would be friction for no benefit. An empty selection on a
 *   file with no recognised blocks falls back to the whole file.
 * * **The whole-file command asks, it does not guess.** A file can contain
 *   hundreds of blocks, and analysing all of them is minutes of work. A QuickPick
 *   is one keystroke and makes the cost explicit and cancellable.
 * * **Progress and cancellation are not optional on a multi-second operation.**
 */
import * as vscode from 'vscode';
import { AnalysisEngine } from '../analysis';
import { parseSource, blocksWithinFile, languageFor } from '../parser';
import {
  AncestryError,
  isAnalysableLanguage,
  type AnalysisProgress,
  type AnalysisResult,
  type AncestryGraph,
} from '../types';
import { describeFailure, emptySelectionError, guard, noEditorError } from './errors';
import { RUN_KEYS, type CommandContext, type RunKey } from './context';

/** Refuse to run on files we know we cannot parse, before doing any work. */
function assertAnalysable(document: vscode.TextDocument): void {
  const language = languageFor(document.uri.fsPath);
  if (!isAnalysableLanguage(language)) {
    throw new AncestryError(
      'UNSUPPORTED_LANGUAGE',
      `Ancestry version 1 analyses JavaScript and TypeScript files. This file is not recognised as one of them (detected: ${language}).`,
      { detail: document.uri.fsPath.slice(-120) },
    );
  }
}

/**
 * The source text of the focus block, sliced from the open document.
 *
 * Read from the editor rather than returned by the engine so the preview shows
 * exactly what the user is looking at, including unsaved edits. Falls back to an
 * empty string when the focus node cannot be located, which the panel renders as
 * "no preview" rather than as an error.
 */
export function readFocusSource(document: vscode.TextDocument, graph: AncestryGraph): string {
  const focus = graph.nodes.find((node) => node.isFocus);
  if (focus === undefined) {
    return '';
  }
  const start = Math.max(0, focus.lineStart - 1);
  const end = Math.min(document.lineCount, focus.lineEnd);
  if (end <= start) {
    return '';
  }
  return document.getText(new vscode.Range(start, 0, end, 0));
}

/** Runs the engine with a cancellable progress notification and status-bar line. */
async function runAnalysis(
  context: CommandContext,
  runKey: RunKey,
  filePath: string,
  startLine: number,
  endLine: number,
  label: string,
): Promise<AnalysisResult> {
  const engine: AnalysisEngine = context.engine;
  const signal = context.cancellation.begin(runKey);
  context.status.showRunning(`Analysing ${label}…`);

  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Ancestry: ${label}`,
        cancellable: true,
      },
      async (progress, progressToken) => {
        const onCancel = (): void => {
          void vscode.window.setStatusBarMessage('Ancestry: cancelling…', 2000);
          context.cancellation.cancel(runKey);
        };
        const subscription = progressToken.onCancellationRequested(onCancel);
        const onConfig = vscode.workspace.onDidChangeConfiguration((event) => {
          if (event.affectsConfiguration('ancestry.similarity')) {
            context.status.showRunning('Settings changed — restarting analysis…');
            context.cancellation.cancel(runKey);
          }
        });
        try {
          const result = await engine.analyze({
            filePath,
            startLine,
            endLine,
            signal,
            onProgress: (update: AnalysisProgress) => {
              progress.report({
                message: update.message,
                increment: Math.round(Math.max(0, update.ratio) * 100),
              });
              context.status.showRunning(update.message);
            },
          });
          return result;
        } finally {
          subscription.dispose();
          onConfig.dispose();
        }
      },
    );
  } finally {
    context.cancellation.finish(runKey);
  }
}

/** Shows the result in the webview, or explains why there is nothing to show. */
function reveal(context: CommandContext, result: AnalysisResult, focusSource: string): void {
  const graph = result.graph;
  if (graph.nodes.length <= 1 && graph.origin === null) {
    const reason =
      graph.warnings.length > 0
        ? graph.warnings[0]!
        : 'No earlier version of this code was found in the available history.';
    void vscode.window
      .showWarningMessage(
        `Ancestry found no ancestry for this block. ${reason}`,
        'Show Log',
        'Open Settings',
      )
      .then((choice) => {
        if (choice === 'Show Log') {
          void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
        } else if (choice === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'ancestry');
        }
      });
    context.status.showDone('No ancestry found');
    return;
  }

  context.webview.revealForGraph(
    graph,
    focusSource,
    {
      durationMs: result.durationMs,
      cacheHits: result.cache.hits,
      cacheMisses: result.cache.misses,
    },
    context.webview.panel?.webviewPanel,
  );

  const versions = Math.max(0, graph.nodes.length - 1);
  const files = graph.stats.fileCount;
  context.status.showDone(
    `${versions} earlier version${versions === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'} · ${Math.round(result.durationMs)}ms`,
  );

  if (graph.stats.truncated) {
    void vscode.window.showWarningMessage(
      'This ancestry is partial: a configured scan limit was reached. Raise "Ancestry: Git Max History Depth" or "Analysis Max Blocks Total" for more.',
    );
  }
}

/**
 * `ancestry.analyzeSelection` — the primary command.
 *
 * A second invocation while a run is in flight **cancels the first and starts
 * over**, rather than refusing or queueing. Users re-invoke after editing a
 * selection, and the newest selection is unambiguously the one they mean.
 */
export async function analyzeSelectionCommand(context: CommandContext): Promise<void> {
  await guard(
    context.logger,
    context.status,
    'Ancestry: Analyze Selected Code',
    'analyse the selection',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        throw noEditorError();
      }
      const document = editor.document;
      assertAnalysable(document);

      const hasSelection = !editor.selection.isEmpty;
      const cursorLine = editor.selection.active.line + 1;
      const startLine = hasSelection ? editor.selection.start.line + 1 : cursorLine;
      const endLine = hasSelection ? editor.selection.end.line + 1 : cursorLine;
      if (endLine < startLine) {
        throw emptySelectionError();
      }

      const cancelledPrevious = context.cancellation.cancel(RUN_KEYS.selection);
      if (cancelledPrevious) {
        context.status.showRunning('Restarting with the new selection…');
      }

      const label = describeTarget(context, document, startLine, endLine);
      const result = await runAnalysis(
        context,
        RUN_KEYS.selection,
        document.uri.fsPath,
        startLine,
        endLine,
        label,
      );

      if (context.cancellation.wasCancelled(RUN_KEYS.selection)) {
        return;
      }
      reveal(context, result, readFocusSource(document, result.graph));
    },
  );
}

/** A short human label for the status bar, e.g. `validateToken in src/auth.ts`. */
function describeTarget(
  context: CommandContext,
  document: vscode.TextDocument,
  startLine: number,
  endLine: number,
): string {
  const fileName = document.uri.fsPath.split(/[\\/]/).pop() ?? 'the file';
  try {
    const parsed = parseSource(document.uri.fsPath, document.getText(), {
      maxBytes: context.config(document.uri).git.maxFileSizeBytes,
    });
    const block = findTargetBlock(parsed.blocks, startLine, endLine);
    if (block !== null) {
      return `${block.qualifiedName ?? block.name ?? 'selection'} in ${fileName}`;
    }
  } catch (error) {
    // A cosmetic label must never fail the command. The analysis itself will
    // surface any real problem a moment later.
    context.logger.debug(`Could not build a descriptive label: ${describeFailure(error).code}`);
  }
  return `selection in ${fileName}`;
}

/**
 * Local copy of the selection→block rule (specification §2.2).
 *
 * Duplicated deliberately rather than imported from `src/parser` so this
 * cosmetic path cannot be perturbed by a parser change, and so the priority
 * order is stated in exactly one place per concern.
 */
function findTargetBlock(
  blocks: ReturnType<typeof parseSource>['blocks'],
  startLine: number,
  endLine: number,
): ReturnType<typeof parseSource>['blocks'][number] | null {
  const containing = blocks.filter(
    (block) => block.range.startLine <= startLine && block.range.endLine >= endLine,
  );
  if (containing.length > 0) {
    const rank: Record<string, number> = {
      method: 0,
      constructor: 0,
      function: 0,
      'arrow-function': 1,
      class: 2,
      interface: 2,
      'type-alias': 2,
      enum: 2,
      namespace: 2,
      'object-literal': 3,
      variable: 3,
      block: 4,
      unknown: 5,
    };
    return containing.reduce((best, block) => {
      const span = block.range.endLine - block.range.startLine;
      const bestSpan = best.range.endLine - best.range.startLine;
      if (span !== bestSpan) {
        return span < bestSpan ? block : best;
      }
      return (rank[block.kind] ?? 5) < (rank[best.kind] ?? 5) ? block : best;
    });
  }
  const overlapping = blocks
    .filter((block) => block.range.startLine <= endLine && block.range.endLine >= startLine)
    .sort(
      (a, b) =>
        Math.min(a.range.endLine, endLine) -
        Math.max(a.range.startLine, startLine) -
        (Math.min(b.range.endLine, endLine) - Math.max(b.range.startLine, startLine)),
    );
  return overlapping[0] ?? null;
}

/**
 * `ancestry.analyzeCurrentFile` — pick a block from the open file, then analyse it.
 *
 * Falls back to the whole file when the file yields no recognisable blocks, so
 * the command is never a dead end.
 */
export async function analyzeCurrentFileCommand(context: CommandContext): Promise<void> {
  await guard(
    context.logger,
    context.status,
    'Ancestry: Analyze a Block in File',
    'list the blocks in this file',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) {
        throw noEditorError();
      }
      const document = editor.document;
      assertAnalysable(document);

      const parsed = parseSource(document.uri.fsPath, document.getText(), {
        maxBytes: context.config(document.uri).git.maxFileSizeBytes,
      });

      // A discriminated shape rather than a bare QuickPick item, so the status
      // line can name what was chosen without re-deriving it from the label text.
      interface Pick {
        label: string;
        description: string;
        detail: string | undefined;
        line: number;
        endLine: number;
        /** Short name for the status bar, e.g. `Service.validate`. */
        target: string;
      }

      const wholeFile: Pick = {
        label: '$(file-code) The whole file',
        description: `lines 1–${document.lineCount}`,
        detail: 'Treat the entire file as one code block',
        line: 1,
        endLine: document.lineCount,
        target: document.uri.fsPath.split(/[\\/]/).pop() ?? 'the file',
      };

      const blockPicks: Pick[] = blocksWithinFile(parsed.blocks, 1, document.lineCount).map(
        (block) => ({
          label: `${block.qualifiedName ?? block.name ?? '(anonymous)'}  ·  ${block.kind}`,
          description: `line ${block.range.startLine}–${block.range.endLine}`,
          detail: block.signature ?? undefined,
          line: block.range.startLine,
          endLine: block.range.endLine,
          target: block.qualifiedName ?? block.name ?? 'selection',
        }),
      );

      const items: Pick[] = [wholeFile, ...blockPicks];
      const activeIndex = pickNearestToCursor(blockPicks, editor.selection.active.line + 1);
      const chosen = await vscode.window.showQuickPick(items, {
        title: 'Ancestry: which block should be analysed?',
        placeHolder: 'Choose a function, method, or class to trace through history',
        matchOnDescription: true,
        matchOnDetail: true,
        // Preselect whatever the cursor is inside, so the common case is Enter.
        ...(activeIndex === null ? {} : { activeItem: items[activeIndex + 1] }),
      });
      if (chosen === undefined) {
        context.status.hide();
        return;
      }

      const result = await runAnalysis(
        context,
        RUN_KEYS.file,
        document.uri.fsPath,
        chosen.line,
        chosen.endLine,
        `${chosen.target} in ${document.uri.fsPath.split(/[\\/]/).pop() ?? 'the file'}`,
      );
      reveal(context, result, readFocusSource(document, result.graph));
    },
  );
}

function pickNearestToCursor(
  picks: ReadonlyArray<{ line: number; endLine: number }>,
  cursorLine: number,
): number | null {
  let best: number | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  picks.forEach((pick, index) => {
    if (pick.line <= cursorLine && pick.endLine >= cursorLine) {
      const span = pick.endLine - pick.line;
      if (span < bestSpan) {
        best = index;
        bestSpan = span;
      }
    }
  });
  return best;
}
