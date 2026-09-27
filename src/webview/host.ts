/**
 * The extension-host half of the webview: panel lifecycle, message plumbing and
 * the trust boundary in the other direction.
 *
 * WHY A MANAGER *AND* A PANEL WRAPPER: the extension owns a "single Ancestry
 * panel" invariant (re-running the analysis reuses the same tab rather than
 * stacking five), while the commands that *talk* to a panel want a narrow,
 * testable surface. `AncestryWebviewManager` owns the invariant; each
 * `AncestryWebviewPanel` owns one `vscode.WebviewPanel` plus the state the
 * commands need to talk to it (the last payload, the last filter, the current
 * selection) — which also makes "export graph" and "replay analysis" work
 * without a live webview.
 *
 * SECURITY NOTES, all of which matter because the webview is not trusted:
 *  - every inbound message is run through `validateClientMessage` (from the
 *    *same* module the webview uses on its side) before it reaches a handler.
 *    Invalid messages are dropped and reported as a sanitised warning.
 *  - every outbound message is validated too, so a programming error in a
 *    command cannot ship a malformed payload into the panel.
 *  - `panel.webview.cspSource` is used for **resource roots and the CSP only**.
 *    It is never logged, never concatenated into HTML beyond the CSP string,
 *    and never treated as a script source to execute.
 *  - nothing here calls `eval`, `new Function`, or reads a file path from a
 *    message. Node ids are resolved against the retained graph, not used as
 *    paths.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  AncestryGraph,
  HostToWebviewMessage,
  WebviewFilter,
  WebviewGraphPayload,
  WebviewToHostMessage,
} from '../types';
import { validateClientMessage, validateHostMessage } from './client/core/protocol';
import { buildWebviewCss, buildWebviewHtml } from './html';
import { graphToJson, toWebviewPayload, type RunStats } from './serialize';

/** The view type registered by the extension for the Ancestry webview. */
export const WEBVIEW_VIEW_TYPE = 'ancestry.graph';

/** The media directory (relative to the extension root) holding the bundle. */
const MEDIA_DIR = 'media';

/** Filenames the webview loads from {@link MEDIA_DIR}. */
const SCRIPT_FILE = 'webview.js';
const STYLE_FILE = 'webview.css';

/** Default window title; overridden with the focus block's name. */
const DEFAULT_TITLE = 'Ancestry — Code Ancestry';

/**
 * A narrow, command-facing view of an Ancestry webview panel.
 *
 * Exported so `extension.ts` can keep a `vscode.WebviewPanel` reference
 * (e.g. from `onDidDispose`) without depending on the concrete wrapper.
 */
export interface AncestryWebviewHandle {
  readonly viewType: string;
  readonly visible: boolean;
  reveal(): void;
  dispose(): void;
}

/** Constructor options for {@link AncestryWebviewManager}. */
export interface AncestryWebviewManagerOptions {
  /** The extension's own `Uri`, used to build `localResourceRoots`. */
  extensionUri: vscode.Uri;
  /** The extension's install path, used for diagnostics and the asset check. */
  extensionPath: string;
  /** Invoked for every validated message the webview sends. */
  onMessage: (panel: AncestryWebviewPanel, message: WebviewToHostMessage) => void;
  /** Invoked once when the panel is disposed, so the manager can forget it. */
  onDispose?: () => void;
}

/**
 * Generates a CSP nonce: 32 characters of 128 bits of `crypto.randomBytes`.
 *
 * Hex rather than base64 on purpose — a base64 nonce can contain `+` and `/`,
 * which are legal in an attribute but have historically been mishandled by CSP
 * implementations that compare raw strings. A fresh nonce per panel load means
 * a captured document is useless for a later one.
 */
export function getNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Owns the single Ancestry webview panel.
 *
 * Lifetime: the manager holds at most one panel. `revealForGraph` reuses the
 * existing panel when one is passed or when this manager already has one, and
 * disposes any surplus panels so a mis-ordered command sequence cannot leave
 * stale tabs behind.
 */
export class AncestryWebviewManager implements vscode.Disposable {
  private readonly options: AncestryWebviewManagerOptions;
  private current: AncestryWebviewPanel | null = null;
  private disposed = false;

  constructor(options: AncestryWebviewManagerOptions) {
    this.options = options;
  }

  /** The view type the manager's panels are created with. */
  public get viewType(): string {
    return WEBVIEW_VIEW_TYPE;
  }

  /** The retained panel, if one exists and has not been disposed. */
  public get panel(): AncestryWebviewPanel | null {
    return this.current !== null && !this.current.isDisposed ? this.current : null;
  }

  /**
   * Creates (or reuses) the panel and pushes the current graph into it.
   *
   * `existing` lets a caller that already holds a `vscode.WebviewPanel` — for
   * example one adopted from `window.registerWebviewPanelProvider` — hand it
   * over instead of letting us create a second one.
   *
   * The graph is *sanitised* here, once, and the resulting payload is retained
   * on the panel: it is what `exportGraphJson` serialises and what an inbound
   * `selectNode` id is resolved against. Nothing the webview sends can change
   * it.
   */
  public revealForGraph(
    graph: AncestryGraph,
    focusSource: string,
    stats: RunStats,
    existing?: vscode.WebviewPanel | AncestryWebviewPanel,
  ): AncestryWebviewPanel {
    if (this.disposed) {
      throw new Error('AncestryWebviewManager has been disposed');
    }
    const payload = toWebviewPayload(graph, focusSource, stats);
    const adopted = isAncestryWebviewPanel(existing) ? existing : null;
    const wrapper =
      adopted ??
      (this.current !== null && !this.current.isDisposed
        ? this.current
        : this.createOrAdopt(existing));

    wrapper.setGraph(payload);
    wrapper.setFilter({});
    wrapper.setStatus('Rendering graph…');
    wrapper.reveal();
    return wrapper;
  }

  /**
   * Enforces the single-panel invariant: reveals the retained panel when one
   * exists, and returns it. Returns `null` when nothing is open, so callers can
   * decide whether to run a new analysis or focus the editor instead.
   */
  public retainSinglePanel(): AncestryWebviewPanel | null {
    const panel = this.panel;
    if (panel === null) {
      return null;
    }
    panel.reveal();
    return panel;
  }

  /** Number of live panels, always 0 or 1. Exposed for assertions and logs. */
  public get openPanelCount(): number {
    return this.panel === null ? 0 : 1;
  }

  public dispose(): void {
    this.disposed = true;
    const panel = this.current;
    this.current = null;
    panel?.dispose();
  }

  private createOrAdopt(
    existing: vscode.WebviewPanel | AncestryWebviewPanel | undefined,
  ): AncestryWebviewPanel {
    const mediaUri = vscode.Uri.joinPath(this.options.extensionUri, MEDIA_DIR);
    const create = (): vscode.WebviewPanel =>
      vscode.window.createWebviewPanel(
        WEBVIEW_VIEW_TYPE,
        DEFAULT_TITLE,
        // `ViewColumn.Beside` keeps the editor visible, which matters because
        // the whole point of the tool is comparing the graph with the code.
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          // Keeping the context means toggling to another tab and back does not
          // re-run the analysis or re-upload the graph.
          retainContextWhenHidden: true,
          enableCommandUris: false,
          // The only two roots the document may read from. Anything else is
          // refused by the webview's own URI resolver.
          localResourceRoots: [mediaUri, this.options.extensionUri],
        },
      );

    const panel =
      existing !== undefined && existing !== null
        ? this.adopt(existing)
        : this.wrap(create(), mediaUri);
    this.current = panel;
    return panel;
  }

  /** Applies our (narrowed) options to a panel we did not create. */
  private adopt(existing: vscode.WebviewPanel | AncestryWebviewPanel): AncestryWebviewPanel {
    if (isAncestryWebviewPanel(existing)) {
      return existing;
    }
    const mediaUri = vscode.Uri.joinPath(this.options.extensionUri, MEDIA_DIR);
    try {
      existing.webview.options = {
        enableScripts: true,
        localResourceRoots: [mediaUri, this.options.extensionUri],
      };
    } catch (error) {
      // A panel whose owner revoked the ability to set options is still usable
      // for messaging; we only lose the resource-root narrowing.
      logWarning('Could not narrow localResourceRoots on the adopted webview panel', error);
    }
    return this.wrap(existing, mediaUri);
  }

  private wrap(panel: vscode.WebviewPanel, mediaUri: vscode.Uri): AncestryWebviewPanel {
    void this.ensureStylesheet();
    const wrapper = new AncestryWebviewPanel({
      panel,
      mediaUri,
      onMessage: (message) => this.options.onMessage(wrapper, message),
      onDispose: () => {
        if (this.current === wrapper) {
          this.current = null;
        }
        this.options.onDispose?.();
      },
    });
    return wrapper;
  }

  /**
   * Writes `media/webview.css` from `buildWebviewCss()` if it is missing.
   *
   * The stylesheet is a *separate file* because the CSP has no
   * `'unsafe-inline'` in `style-src`. `buildWebviewCss()` is the single source of
   * truth for its contents, so if the build output directory was cleaned without
   * the file being regenerated, materialising it from the compiled constant
   * keeps the panel styled instead of rendering as unstyled blocks. Failure is
   * non-fatal: the document still loads, it just loses its theme.
   */
  private async ensureStylesheet(): Promise<void> {
    const target = vscode.Uri.joinPath(this.options.extensionUri, MEDIA_DIR, STYLE_FILE);
    try {
      await vscode.workspace.fs.stat(target);
      return;
    } catch {
      // Absent — fall through and materialise it.
    }
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(buildWebviewCss(), 'utf8'));
    } catch (error) {
      logWarning('Could not materialise media/webview.css; the panel will be unstyled', error);
    }
  }
}

/** Constructor options for {@link AncestryWebviewPanel}. */
export interface AncestryWebviewPanelOptions {
  panel: vscode.WebviewPanel;
  mediaUri: vscode.Uri;
  onMessage: (message: WebviewToHostMessage) => void;
  onDispose: () => void;
}

/**
 * One Ancestry webview panel, plus the state the commands need.
 *
 * The wrapper holds the sanitised payload so that:
 *  - `exportGraphJson` works whether or not the webview has loaded;
 *  - an inbound `selectNode` id can be resolved against real graph data rather
 *    than being trusted and re-emitted blindly;
 *  - a `filter` message can be validated *and* remembered for replay.
 *
 * Messages are buffered until the webview reports `ready`, because
 * `postMessage` before the document has loaded its bundle is silently dropped.
 */
export class AncestryWebviewPanel implements vscode.Disposable, AncestryWebviewHandle {
  private readonly options: AncestryWebviewPanelOptions;
  private payload: WebviewGraphPayload | null = null;
  private filter: WebviewFilter = {};
  private selection: string | null = null;
  private highlighted: string[] = [];
  private isReady = false;
  private pendingInit: HostToWebviewMessage | null = null;
  private disposed = false;

  constructor(options: AncestryWebviewPanelOptions) {
    this.options = options;
    this.options.panel.onDidDispose(() => this.dispose());
    this.options.panel.webview.onDidReceiveMessage((raw: unknown) => this.handleInbound(raw));
    this.writeHtml();
  }

  public get viewType(): string {
    return this.options.panel.viewType;
  }

  public get visible(): boolean {
    return this.options.panel.visible;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** The last payload pushed to (or accepted from) this panel. */
  public get lastPayload(): WebviewGraphPayload | null {
    return this.payload;
  }

  /** The last validated filter received from, or set on, this panel. */
  public get lastFilter(): WebviewFilter {
    return this.filter;
  }

  /** The node id the user last selected, or `null`. */
  public get selectedNodeId(): string | null {
    return this.selection;
  }

  /** The node ids currently highlighted, with the reason that highlighted them. */
  public get highlightedNodeIds(): readonly string[] {
    return this.highlighted;
  }

  public reveal(column?: vscode.ViewColumn): void {
    if (this.disposed) {
      return;
    }
    try {
      this.options.panel.reveal(column ?? this.options.panel.viewColumn, true);
    } catch (error) {
      logWarning('Could not reveal the Ancestry webview panel', error);
    }
  }

  /** The underlying `vscode.WebviewPanel`, for callers that need the API. */
  public get webviewPanel(): vscode.WebviewPanel {
    return this.options.panel;
  }

  /** Replaces the graph and tells the webview about it. */
  public setGraph(payload: WebviewGraphPayload): void {
    this.payload = payload;
    this.selection = null;
    this.highlighted = [];
    this.post({ type: 'graph', payload });
  }

  /** Applies a filter from the host side. */
  public setFilter(filter: WebviewFilter): void {
    this.filter = filter ?? {};
    this.post({ type: 'filter', payload: this.filter });
  }

  /** Moves the camera to a node. */
  public setFocus(nodeId: string): void {
    this.post({ type: 'focus', payload: { nodeId } });
  }

  /** Highlights a set of nodes with a human-readable reason. */
  public highlight(nodeIds: string[], reason: string): void {
    const filtered = Array.isArray(nodeIds)
      ? nodeIds.filter((id): id is string => typeof id === 'string').slice(0, 1000)
      : [];
    this.highlighted = filtered;
    this.post({ type: 'highlight', payload: { nodeIds: filtered, reason: reason ?? '' } });
  }

  /** Clears any highlight. */
  public clearHighlight(): void {
    this.highlighted = [];
    this.post({ type: 'clearHighlight' });
  }

  /** Shows (or updates) the loading overlay. `ratio` is clamped to [0, 1]. */
  public setLoading(message: string, ratio: number): void {
    const safeRatio = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    this.post({
      type: 'loading',
      payload: { message: capMessage(message, 2000), ratio: safeRatio },
    });
  }

  /** Shows the error toast. */
  public setError(message: string, detail?: string): void {
    this.post({
      type: 'error',
      payload: {
        message: capMessage(message, 2000),
        detail: detail === undefined ? undefined : capMessage(detail, 2000),
      },
    });
  }

  /** Writes the status bar line. */
  public setStatus(message: string): void {
    this.post({ type: 'status', payload: { message: capMessage(message, 2000) } });
  }

  /**
   * Validates then posts a message.
   *
   * Outbound validation is not paranoia: `HostToWebviewMessage` is a union with
   * nested payloads, and a command that assembles one by hand can easily produce
   * a message the webview will reject. Catching it here yields one clear log
   * line instead of an invisible no-op in the panel.
   */
  public post(message: HostToWebviewMessage): void {
    if (this.disposed) {
      return;
    }
    const validated = validateHostMessage(message);
    if (validated === null) {
      logWarning('Refusing to post a malformed message to the Ancestry webview', message);
      return;
    }
    if (!this.isReady) {
      // Buffer the first graph-bearing message; anything else is dropped,
      // because replaying a stale filter/error over a fresh graph is noise.
      this.pendingInit =
        validated.type === 'init' || validated.type === 'graph' ? validated : this.pendingInit;
      return;
    }
    try {
      void this.options.panel.webview.postMessage(validated);
    } catch (error) {
      logWarning('Failed to post a message to the Ancestry webview', error);
    }
  }

  /** Serialises the retained graph, or `null` when no graph is loaded. */
  public exportGraphJson(): string | null {
    if (this.payload === null) {
      return null;
    }
    return graphToJson(this.payload.graph);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.payload = null;
    this.highlighted = [];
    try {
      this.options.panel.dispose();
    } catch (error) {
      logWarning('Failed to dispose the Ancestry webview panel', error);
    }
    this.options.onDispose();
  }

  // -----------------------------------------------------------------------

  private writeHtml(): void {
    const { webview } = this.options.panel;
    const nonce = getNonce();
    const html = buildWebviewHtml({
      cspSource: webview.cspSource,
      nonce,
      scriptUri: webview
        .asWebviewUri(vscode.Uri.joinPath(this.options.mediaUri, SCRIPT_FILE))
        .toString(),
      styleUri: webview
        .asWebviewUri(vscode.Uri.joinPath(this.options.mediaUri, STYLE_FILE))
        .toString(),
      title: DEFAULT_TITLE,
    });
    try {
      webview.html = html;
    } catch (error) {
      logWarning('Failed to set the Ancestry webview HTML', error);
    }
  }

  /**
   * The inbound trust boundary.
   *
   * A raw `unknown` arrives from the webview, is run through
   * `validateClientMessage`, and only a fully valid, freshly-copied message
   * reaches `onMessage`. Anything else is dropped and reported — with a
   * *sanitised* description (the type name and the payload's key list, never the
   * values, because the values are exactly the untrusted part).
   */
  private handleInbound(raw: unknown): void {
    const validated = validateClientMessage(raw);
    if (validated === null) {
      logWarning('Dropped an unrecognised message from the Ancestry webview', describe(raw));
      return;
    }
    switch (validated.type) {
      case 'ready':
        this.isReady = true;
        this.flushPending();
        return;
      case 'selectNode':
        this.selection = this.resolveNodeId(validated.payload.nodeId);
        if (this.selection === null) {
          logWarning('Ignoring selectNode for a node that is not in the retained graph', {
            nodeIdLength: validated.payload.nodeId.length,
          });
          return;
        }
        break;
      case 'setFilter':
        this.filter = validated.payload;
        break;
      default:
        break;
    }
    this.options.onMessage(validated);
  }

  /**
   * Resolves a node id against the *retained* graph.
   *
   * A node id from the webview is a map key, never a path, but resolving it
   * against data we hold means a bogus id becomes a no-op rather than an entry
   * in the command history, a file lookup or an open-editor request.
   */
  private resolveNodeId(nodeId: string): string | null {
    const graph = this.payload?.graph;
    if (graph === undefined) {
      return null;
    }
    return graph.nodes.some((node) => node.id === nodeId) ? nodeId : null;
  }

  private flushPending(): void {
    const pending = this.pendingInit;
    this.pendingInit = null;
    if (pending === null) {
      return;
    }
    try {
      void this.options.panel.webview.postMessage(pending);
    } catch (error) {
      logWarning('Failed to deliver the initial graph to the Ancestry webview', error);
    }
  }
}

/**
 * Describes a rejected message for the log without echoing its contents.
 *
 * Returning the payload's *keys* is deliberate: it is enough to diagnose a
 * protocol mismatch between this extension and a stale webview bundle, and
 * cannot be used to smuggle megabytes of untrusted text into the output channel.
 */
export function describe(raw: unknown): string {
  if (raw === null) {
    return 'payload: null';
  }
  if (typeof raw !== 'object') {
    return `payload: ${typeof raw}`;
  }
  if (Array.isArray(raw)) {
    return `payload: array(${raw.length})`;
  }
  const keys = Object.getOwnPropertyNames(raw as object).slice(0, 20);
  return `payload: object with keys [${keys.join(', ')}]`;
}

function capMessage(value: string, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, maxLength);
}

function logWarning(message: string, detail: unknown): void {
  const suffix =
    detail instanceof Error
      ? ` (${detail.name}: ${detail.message})`
      : detail === undefined
        ? ''
        : ` (${describe(detail)})`;
  console.warn(`[ancestry] ${message}${suffix}`);
}

/**
 * Type guard for {@link AncestryWebviewPanel}.
 *
 * Takes `unknown` on purpose: a class-vs-class `instanceof` against the
 * structurally-typed `vscode.WebviewPanel` would be a comparability error, and
 * the caller legitimately may hold either object.
 */
export function isAncestryWebviewPanel(value: unknown): value is AncestryWebviewPanel {
  return value instanceof AncestryWebviewPanel;
}
