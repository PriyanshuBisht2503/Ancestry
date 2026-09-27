/**
 * Extension entry point.
 *
 * Responsibilities, and nothing else:
 *  - build the service container (logger, cancellation, status bar, engine, webview),
 *  - register the commands,
 *  - route validated webview messages back to the command layer,
 *  - tear everything down cleanly on deactivate.
 *
 * There is deliberately **no analysis logic here**. Everything that reasons about
 * code lives in `src/analysis` and below, which is what makes those layers
 * testable without a VS Code host.
 *
 * Two failure modes are handled explicitly because they are the ones that make an
 * extension feel broken:
 *
 *  1. **`activate` itself throws.** VS Code shows "The extension failed to
 *     activate" and the user has no idea why. We log the reason to a channel
 *     created before anything else can fail, so the cause is recoverable.
 *  2. **Something rejects outside a command.** An analysis started by the webview,
 *     or a debounced settings reload, must not become an unhandled rejection.
 *     `installRejectionGuard` converts those into log lines.
 */
import * as vscode from 'vscode';
import { createLogger, type Logger } from './logger';
import {
  COMMAND_IDS,
  ExtensionServices,
  createWebviewSerializer,
  findUndeclaredCommands,
  handleWebviewMessage,
  registerCommands,
} from './commands';
import { WEBVIEW_VIEW_TYPE } from './webview/host';
import { errorCodeOf } from './logger';

/** The extension's own exported API surface, for tests and other extensions. */
export interface AncestryExtensionApi {
  readonly version: string;
  readonly logger: Logger;
  getLastGraphJson(): string | null;
}

let services: ExtensionServices | null = null;
let disposables: vscode.Disposable[] = [];

export function activate(context: vscode.ExtensionContext): AncestryExtensionApi {
  // Created first so even a failure below has somewhere to be reported.
  const bootstrapLogger = createLogger('Ancestry', { minLevel: 'info' });

  try {
    const instance = new ExtensionServices(context, (panel, message) => {
      handleWebviewMessage(instance, panel, message);
    });
    services = instance;

    disposables = [
      ...registerCommands(instance),
      vscode.window.registerWebviewPanelSerializer(
        WEBVIEW_VIEW_TYPE,
        createWebviewSerializer(instance),
      ),
      // Dev-only consistency check. A typo in a command id would otherwise
      // surface as a silently missing menu item.
      ...checkManifest(bootstrapLogger),
      installRejectionGuard(instance.logger),
    ];
    context.subscriptions.push(...disposables);

    const api: AncestryExtensionApi = {
      version: readVersion(context),
      logger: instance.logger,
      getLastGraphJson: () => instance.webview.panel?.exportGraphJson() ?? null,
    };
    bootstrapLogger.info('Ancestry activated');
    return api;
  } catch (err: unknown) {
    bootstrapLogger.exception(err, 'activation failed');
    void vscode.window.showErrorMessage(
      `Ancestry failed to activate: ${errorCodeOf(err)}. See the Ancestry output channel for details.`,
    );
    // Return a minimal API rather than throwing: a broken panel is recoverable by
    // reloading the window, whereas a failed activation disables every command.
    return {
      version: readVersion(context),
      logger: bootstrapLogger,
      getLastGraphJson: () => null,
    };
  }
}

export function deactivate(): void {
  for (const item of disposables.splice(0)) {
    try {
      item.dispose();
    } catch {
      // Disposal must never throw during shutdown.
    }
  }
  services?.dispose();
  services = null;
}

/**
 * Converts unhandled rejections into log lines.
 *
 * Returns a disposable that removes the listener. Only installed once, and only
 * for rejections that are *not* already being handled — Node's `unhandledRejection`
 * only fires for genuinely unhandled ones, so this cannot mask a real error path.
 */
function installRejectionGuard(logger: Logger): vscode.Disposable {
  const onRejection = (reason: unknown): void => {
    logger.exception(reason, 'unhandled rejection (outside a command)');
  };
  process.on('unhandledRejection', onRejection);
  return new vscode.Disposable(() => {
    process.off('unhandledRejection', onRejection);
  });
}

function checkManifest(logger: Logger): vscode.Disposable[] {
  const undeclared = findUndeclaredCommands(readManifest(), Object.values(COMMAND_IDS));
  if (undeclared.length > 0) {
    logger.warn(`Commands implemented but not declared in package.json: ${undeclared.join(', ')}`);
  }
  return [];
}

function readManifest(): { contributes?: { commands?: ReadonlyArray<{ command?: unknown }> } } {
  try {
    // `require` rather than `import`: this is a *synchronous* dev-only check, and
    // the project compiles to CommonJS, where a top-level `await import()` is not
    // available. The rule to silence is `no-require-imports` — `no-var-requires`
    // is a different rule and does not suppress this one.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manifest = require('../package.json') as {
      contributes?: { commands?: ReadonlyArray<{ command?: unknown }> };
    };
    return manifest;
  } catch {
    return {};
  }
}

function readVersion(context: vscode.ExtensionContext): string {
  try {
    const manifest = readManifest() as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return context.extension?.packageJSON?.version ?? '0.0.0';
  }
}
