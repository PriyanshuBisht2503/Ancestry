/**
 * Turning failures into something a user can act on.
 *
 * The extension's error contract (specification §10) is that every anticipated
 * failure is an `AncestryError` with a `code` and a `userMessage` safe to render.
 * This module is the single place that decides what a given error *looks like*,
 * so no command invents its own presentation and a user sees one consistent
 * message shape for the same underlying problem.
 *
 * Two rules that are easy to get wrong and are therefore enforced here:
 *
 *  1. **Cancellation is not an error.** It must not produce a red toast, and it
 *     must not be logged at `error` level. A user pressing Escape has done
 *     nothing wrong.
 *  2. **One notification, not two.** A long operation shows a status-bar line;
 *     when it fails, the status line is replaced by the notification rather than
 *     accompanied by one, so the user is not told about the same thing twice.
 */
import * as vscode from 'vscode';
import { AncestryError } from '../types';
import { hintForCode, type Logger } from '../logger';
import type { StatusReporter } from './context';

export interface PresentErrorOptions {
  logger: Logger;
  status?: StatusReporter;
  /** Notification title. Defaults to "Ancestry". */
  title?: string;
  /** What the user was trying to do, e.g. "analyse the selection". */
  action?: string;
  /** Report as a modal — reserved for "you must fix this before continuing". */
  modal?: boolean;
}

export interface ErrorPresentation {
  code: string;
  message: string;
  hint: string | undefined;
  /** True when the failure was a user-initiated cancellation. */
  cancelled: boolean;
}

/**
 * Computes what to show for an error, without showing it.
 *
 * Separated from {@link presentError} so tests can assert on the mapping without
 * standing up a notification host, and so other surfaces (the webview error
 * toast, the status bar) can reuse exactly the same text.
 */
export function describeFailure(err: unknown, action?: string): ErrorPresentation {
  if (err instanceof AncestryError) {
    const cancelled = err.code === 'CANCELLED';
    const prefix = action === undefined || action === '' ? '' : `Could not ${action}. `;
    const hint = err.code === 'CANCELLED' ? undefined : (hintForCode(err.code) ?? err.detail);
    return {
      code: err.code,
      message: `${prefix}${err.userMessage}`,
      hint,
      cancelled,
    };
  }
  if (err instanceof Error) {
    return {
      code: 'INTERNAL',
      message: `Unexpected error: ${err.message}`,
      hint: undefined,
      cancelled: false,
    };
  }
  return {
    code: 'INTERNAL',
    message: 'An unexpected non-error value was thrown.',
    hint: undefined,
    cancelled: false,
  };
}

/** Shows the error to the user and records it in the log. */
export function presentError(err: unknown, options: PresentErrorOptions): ErrorPresentation {
  const { logger, status, title = 'Ancestry', action, modal = false } = options;
  const presentation = describeFailure(err, action);

  if (presentation.cancelled) {
    // Not an error condition. A `debug` line is the right level: it proves the
    // cancellation path ran, without crying wolf in the output channel.
    logger.debug(`Cancelled${action === undefined ? '' : ` while trying to ${action}`}`);
    status?.hide();
    return presentation;
  }

  logger.exception(err, action === undefined ? undefined : `while trying to ${action}`);
  status?.showError(presentation.message);

  const body =
    presentation.hint === undefined ? undefined : `${presentation.message}\n\n${presentation.hint}`;
  if (modal) {
    void vscode.window.showErrorMessage(body ?? presentation.message, title);
  } else {
    void vscode.window.showErrorMessage(body ?? presentation.message, 'Show Log').then((choice) => {
      if (choice === 'Show Log') {
        logger.info('Open the Ancestry output channel with: View → Output → Ancestry');
        void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
      }
    });
  }
  return presentation;
}

/**
 * Wraps a command body so a rejection can never become an unhandled promise
 * rejection — which, in the extension host, shows the user a generic failure and
 * takes the whole extension's reliability down with it.
 */
export function guard(
  logger: Logger,
  status: StatusReporter,
  commandId: string,
  action: string,
  body: () => Promise<void>,
): Promise<void> {
  return body().catch((err: unknown) => {
    presentError(err, { logger, status, action, title: commandId });
  });
}

/** An `AncestryError` for the case where the command was invoked with no editor. */
export function noEditorError(): AncestryError {
  return new AncestryError(
    'NO_SELECTION',
    'No file is open. Open the file containing the code you want to analyse, then run the command again.',
  );
}

export function emptySelectionError(): AncestryError {
  return new AncestryError(
    'EMPTY_SELECTION',
    'The selection is empty. Select the function, method, or block you want to analyse.',
  );
}
