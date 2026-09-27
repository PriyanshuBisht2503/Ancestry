/**
 * Shared services for the command layer.
 *
 * WHY A CONTEXT OBJECT RATHER THAN MODULE-LEVEL SINGLETONS
 * -------------------------------------------------------
 * Every command needs the same four things: a logger, the current config, the
 * analysis engine, and the webview manager. Threading those through each command's
 * signature would be noise, but module-level singletons would be untestable and
 * would survive `deactivate()` â€” a real hazard in a test host that activates and
 * deactivates repeatedly. So they live here, constructed once in `activate()` and
 * torn down in `deactivate()`.
 *
 * WHY THE ENGINE IS REBUILT ON CONFIG CHANGE
 * ------------------------------------------
 * The engine captures `maxHistoryDepth`, the file-size limit and the similarity
 * thresholds at construction time, because reading settings per comparison would
 * dominate the cost of a comparison. Rather than plumbing a settings provider
 * through five modules, a settings change rebuilds the engine. An analysis
 * already in flight keeps the configuration it started with, which is the correct
 * behaviour â€” a running analysis should not change shape halfway through.
 */
import * as vscode from 'vscode';
import { AnalysisEngine } from '../analysis';
import { readConfig, type AncestryConfig } from '../config';
import { createLogger, type Logger } from '../logger';
import { createCacheStore, type CacheFactoryOptions } from '../cache';
import type { ICacheStore } from '../types';
import { AncestryWebviewManager, type AncestryWebviewPanel } from '../webview/host';
import type { WebviewToHostMessage } from '../types';

/** Stable keys for cancellable long-running work, used by the UI. */
export const RUN_KEYS = {
  selection: 'ancestry.analyzeSelection',
  file: 'ancestry.analyzeCurrentFile',
} as const;

export type RunKey = (typeof RUN_KEYS)[keyof typeof RUN_KEYS];

/**
 * Tracks in-flight analyses so a second invocation can cancel the first, and so a
 * configuration change can refuse to start work that would collide.
 *
 * One `AbortController` per key rather than one globally: running the selection
 * analysis and the whole-file analysis at the same time is legitimate, and
 * cancelling one must not kill the other.
 */
export class CancellationRegistry implements vscode.Disposable {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();

  /** Registers a new run for `key`, cancelling any previous one for that key. */
  public begin(key: string): AbortSignal {
    this.cancel(key);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    this.cancelled.delete(key);
    return controller.signal;
  }

  public isRunning(key: string): boolean {
    return this.controllers.has(key);
  }

  /** Any run at all in flight. */
  public get activeCount(): number {
    return this.controllers.size;
  }

  /** True when `key`'s current run has been cancelled but has not yet unwound. */
  public wasCancelled(key: string): boolean {
    return this.cancelled.has(key);
  }

  /** Aborts the run for `key`. Returns true when there was one to abort. */
  public cancel(key: string): boolean {
    const controller = this.controllers.get(key);
    if (controller === undefined) {
      return false;
    }
    this.cancelled.add(key);
    controller.abort();
    return true;
  }

  /** Clears a key once its run has finished, so the next `begin` starts clean. */
  public finish(key: string): void {
    this.controllers.delete(key);
    this.cancelled.delete(key);
  }

  public cancelAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.cancelled.clear();
    this.controllers.clear();
  }

  public dispose(): void {
    this.cancelAll();
  }
}

/**
 * The status-bar line.
 *
 * A single item rather than one per analysis, because two concurrent analyses
 * writing two items produces a status bar the user cannot read. Messages are
 * truncated and stripped of control characters because the status bar renders
 * single-line, and an untrusted commit subject could otherwise inject a newline.
 */
export class StatusReporter implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private resetTimer: NodeJS.Timeout | null = null;
  private current: string | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'Ancestry';
    this.item.command = 'ancestry.analyzeSelection';
    this.item.tooltip = 'Analyze the ancestry of the selected code (Ancestry)';
  }

  public get message(): string | null {
    return this.current;
  }

  public showRunning(message: string, cancellable = true): void {
    this.clearReset();
    this.current = sanitize(message, 120);
    this.item.text = cancellable ? `$(sync~spin) ${this.current}` : `$(sync~spin) ${this.current}`;
    this.item.show();
  }

  public showDone(message: string, resetAfterMs = 4000): void {
    this.clearReset();
    this.current = sanitize(message, 120);
    this.item.text = `$(check) ${this.current}`;
    this.item.show();
    this.resetTimer = setTimeout(() => this.hide(), resetAfterMs);
  }

  public showError(message: string, resetAfterMs = 8000): void {
    this.clearReset();
    this.current = sanitize(message, 120);
    this.item.text = `$(warning) ${this.current}`;
    this.item.show();
    this.resetTimer = setTimeout(() => this.hide(), resetAfterMs);
  }

  public hide(): void {
    this.clearReset();
    this.current = null;
    this.item.hide();
  }

  public dispose(): void {
    this.clearReset();
    this.item.dispose();
  }

  private clearReset(): void {
    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }
}

function sanitize(value: string, max: number): string {
  // Strip C0/C1 control characters.
  //
  // The disable comment must sit on the line *immediately above the regex
  // literal*. An earlier version of it was attached to the `return value` line
  // and silently stopped applying when Prettier split the chain across lines,
  // which let `no-control-regex` fail the lint gate with no obvious cause.
  // eslint-disable-next-line no-control-regex
  const printable = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return printable.trim().slice(0, max);
}

/** Everything the commands need, constructed once per activation. */
export interface CommandContext {
  readonly extensionUri: vscode.Uri;
  readonly extensionPath: string;
  readonly globalStoragePath: string;
  readonly logger: Logger;
  readonly cancellation: CancellationRegistry;
  readonly status: StatusReporter;
  readonly webview: AncestryWebviewManager;
  /** Rebuilt when relevant settings change. */
  readonly engine: AnalysisEngine;
  config(scope?: vscode.ConfigurationScope): AncestryConfig;
  /** Opens the cache lazily so activation never touches the filesystem. */
  cache(): Promise<ICacheStore | null>;
  dispose(): void;
}

export class ExtensionServices implements CommandContext {
  public readonly logger: Logger;
  public readonly cancellation: CancellationRegistry;
  public readonly status: StatusReporter;
  public readonly webview: AncestryWebviewManager;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly configDisposable: vscode.Disposable;
  private currentEngine: AnalysisEngine | null = null;
  private currentCache: ICacheStore | null = null;
  private cachePromise: Promise<ICacheStore | null> | null = null;
  private disposed = false;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    onMessage: (panel: AncestryWebviewPanel, message: WebviewToHostMessage) => void,
  ) {
    this.logger = createLogger('Ancestry', {
      allowSourceCode: false,
      minLevel: 'info',
    });
    this.cancellation = new CancellationRegistry();
    this.status = new StatusReporter();
    this.webview = new AncestryWebviewManager({
      extensionUri: extensionContext.extensionUri,
      extensionPath: extensionContext.extensionPath,
      onMessage,
      onDispose: () => this.logger.debug('Ancestry webview panel closed'),
    });

    this.configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('ancestry')) {
        this.rebuildEngine('settings changed');
      }
    });

    this.disposables.push(
      this.logger,
      this.cancellation,
      this.status,
      this.webview,
      this.configDisposable,
    );
  }

  public get extensionUri(): vscode.Uri {
    return this.extensionContext.extensionUri;
  }

  public get extensionPath(): string {
    return this.extensionContext.extensionPath;
  }

  public get globalStoragePath(): string {
    return this.extensionContext.globalStorageUri.fsPath;
  }

  public get engine(): AnalysisEngine {
    if (this.currentEngine === null) {
      this.currentEngine = this.createEngine();
      this.logger.debug('Created a new analysis engine');
    }
    return this.currentEngine;
  }

  public config(scope?: vscode.ConfigurationScope): AncestryConfig {
    return readConfig(scope, (detail) => this.logger.warn(`Invalid setting: ${detail}`));
  }

  public async cache(): Promise<ICacheStore | null> {
    if (this.currentCache !== null) {
      return this.currentCache;
    }
    if (this.cachePromise === null) {
      this.cachePromise = this.createCache();
    }
    const store = await this.cachePromise;
    this.currentCache = store;
    return store;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const item of this.disposables.splice(0)) {
      try {
        item.dispose();
      } catch (error) {
        this.logger.exception(error, 'disposing a service');
      }
    }
    void this.disposeEngine();
    this.cachePromise = null;
    this.currentCache = null;
  }

  private async disposeEngine(): Promise<void> {
    const engine = this.currentEngine;
    this.currentEngine = null;
    if (engine !== null) {
      try {
        engine.dispose();
      } catch (error) {
        this.logger.exception(error, 'disposing the analysis engine');
      }
    }
  }

  private async createCache(): Promise<ICacheStore | null> {
    const config = this.config();
    if (!config.cache.enabled) {
      this.logger.info('Local index disabled by configuration');
      return null;
    }
    const options: CacheFactoryOptions = {
      directory: this.globalStoragePath,
      backend: config.cache.backend,
      maxAgeDays: config.cache.maxAgeDays,
      logger: {
        debug: (msg) => this.logger.debug(`cache: ${msg}`),
        warn: (msg) => this.logger.warn(`cache: ${msg}`),
      },
    };
    try {
      const store = await createCacheStore(options);
      this.logger.info(
        `Local index ready (backend=${store.info.backend}, native=${store.info.native})`,
      );
      return store;
    } catch (error) {
      // The cache is an optimisation, never a requirement. Losing it must not
      // disable the extension, so this is logged and the analysis runs cold.
      this.logger.exception(error, 'Could not open the local index; continuing without it');
      return null;
    }
  }

  private createEngine(): AnalysisEngine {
    const config = this.config();
    return new AnalysisEngine({
      config,
      logger: this.logger.child('analysis'),
      cache: this.currentCache,
    });
  }

  private rebuildEngine(reason: string): void {
    this.logger.info(`Rebuilding the analysis engine: ${reason}`);
    void this.disposeEngine();
    this.currentCache = null;
    this.cachePromise = null;
  }
}
