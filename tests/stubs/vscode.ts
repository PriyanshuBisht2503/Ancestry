/**
 * A hand-written stand-in for the `vscode` module.
 *
 * WHY THIS EXISTS
 * ---------------
 * `vscode` is injected by the extension host at runtime; it is not resolvable
 * from a normal Node process. The three ways to test a VS Code extension are:
 *
 *  1. `@vscode/test-electron` — downloads and runs a real VS Code. Highest
 *     fidelity, but far too slow to run the whole suite, and it cannot run in a
 *     headless CI container without extra setup.
 *  2. Mock the module with `vi.mock('vscode')` per test file. Workable, but every
 *     file re-declares the same fake, and the fakes drift apart.
 *  3. A single shared stub, aliased in `vitest.config.ts`. One place to extend,
 *     one set of semantics, and it makes *importing* a command module a plain
 *     module-load rather than a mocking exercise.
 *
 * This is option 3. The stub is intentionally **small and predictable**: it
 * records what it was asked to do and returns inert values. It is not a
 * simulation of VS Code, and tests that depend on real editor behaviour do not
 * belong here — those belong to `@vscode/test-electron` or to the integration
 * suite, which drives a real Git repository.
 *
 * Every call is recorded on the exported `__calls` array so a test can assert on
 * what the extension *did* without a real host. `__reset()` clears it.
 */

type Recorded = { api: string; args: unknown[] };

const calls: Recorded[] = [];

function record(api: string, ...args: unknown[]): void {
  calls.push({ api, args });
}

/** Read-only view of everything the stub was asked to do since the last reset. */
export const __calls: ReadonlyArray<Recorded> = new Proxy([] as Recorded[], {
  get(_target, prop) {
    if (prop === 'length') return calls.length;
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return calls[Number(prop)];
    if (prop === Symbol.iterator) return calls[Symbol.iterator].bind(calls);
    return calls[prop as keyof Recorded[]];
  },
});

export function __reset(): void {
  calls.length = 0;
}

/** All recorded calls for one API, for readable assertions. */
export function __callsTo(api: string): unknown[][] {
  return calls.filter((call) => call.api === api).map((call) => call.args);
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
  static from(...items: Array<{ dispose(): unknown }>): Disposable {
    return new Disposable(() => {
      for (const item of items) {
        try {
          item.dispose();
        } catch {
          // Mirror the real host: a failing dispose must not cascade.
        }
      }
    });
  }
}

export class EventEmitter<T> {
  private readonly listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    });
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners.length = 0;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(
    startLine: number | Position,
    startChar: number | Position,
    endLine?: number,
    endChar?: number,
  ) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, startChar as number);
      this.end = new Position(endLine as number, endChar as number);
    }
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = '',
    readonly fragment = '',
  ) {}
  static file(fsPath: string): Uri {
    const normalized = fsPath.replace(/\\/g, '/');
    return new Uri('file', '', normalized.startsWith('/') ? normalized : `/${normalized}`);
  }
  static parse(value: string): Uri {
    const match = /^([a-zA-Z][\w+.-]*):\/\/([^/]*)(\/[^?#]*)?/.exec(value);
    if (match === null) {
      return Uri.file(value);
    }
    return new Uri(match[1]!, match[2]!, match[3] ?? '/');
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/$/, ''), ...segments].join('/');
    return new Uri(base.scheme, base.authority, joined);
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
  with(change: { path?: string; scheme?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, this.authority, change.path ?? this.path);
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum UIKind {
  Desktop = 1,
  Web = 2,
}

export interface CancellationToken {
  isCancellationRequested: boolean;
  /**
   * Mirrors the real API: a registration *function*, not a disposable.
   *
   * Declaring this as `Disposable` made the stub a stricter, incompatible shape —
   * production code that calls `token.onCancellationRequested(listener)` would
   * compile against `@types/vscode` and then fail against the stub, so the stub
   * was hiding real extension code instead of exercising it.
   */
  onCancellationRequested: (listener: (value: void) => void) => Disposable;
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

export interface OutputChannel {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  dispose(): void;
}

export interface StatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  name: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface Webview {
  html: string;
  readonly cspSource: string;
  options: { enableScripts?: boolean; localResourceRoots?: readonly Uri[] };
  asWebviewUri(uri: Uri): Uri;
  postMessage(message: unknown): Promise<boolean>;
  onDidReceiveMessage: EventEmitter<unknown>['event'];
}

export interface WebviewPanel {
  readonly viewType: string;
  readonly visible: boolean;
  readonly viewColumn: ViewColumn;
  readonly webview: Webview;
  title: string;
  readonly onDidDispose: EventEmitter<void>['event'];
  readonly onDidChangeViewState: EventEmitter<unknown>['event'];
  reveal(column?: ViewColumn, preserveFocus?: boolean): void;
  dispose(): void;
}

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface TextDocument {
  readonly uri: Uri;
  readonly fileName: string;
  readonly lineCount: number;
  readonly isDirty: boolean;
  getText(range?: Range): string;
  lineAt(line: number): { text: string; lineNumber: number };
}

export interface TextEditor {
  readonly document: TextDocument;
  selection: {
    readonly start: Position;
    readonly end: Position;
    readonly active: Position;
    readonly isEmpty: boolean;
  };
  selections: ReadonlyArray<TextEditor['selection']>;
}

export interface CancellationTokenSource {
  readonly token: CancellationToken;
  cancel(): void;
  dispose(): void;
}

export const window = {
  activeTextEditor: undefined as TextEditor | undefined,
  visibleTextEditors: [] as TextEditor[],

  createOutputChannel(name: string): OutputChannel {
    record('window.createOutputChannel', name);
    const lines: string[] = [];
    return {
      name,
      append: (value) => lines.push(value),
      appendLine: (value) => lines.push(value),
      clear: () => (lines.length = 0),
      show: () => record('window.output.show', name),
      hide: () => undefined,
      dispose: () => record('window.output.dispose', name),
    };
  },

  createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem {
    record('window.createStatusBarItem', alignment, priority);
    let visible = false;
    return {
      text: '',
      tooltip: undefined,
      command: undefined,
      name: undefined,
      show: () => {
        visible = true;
        record('statusBar.show');
      },
      hide: () => {
        visible = false;
        record('statusBar.hide');
      },
      dispose: () => record('statusBar.dispose'),
      get isVisible() {
        return visible;
      },
    } as StatusBarItem;
  },

  showInformationMessage(message: string, ...items: unknown[]): Promise<unknown> {
    record('window.showInformationMessage', message, ...items);
    return Promise.resolve(undefined);
  },
  showWarningMessage(message: string, ...items: unknown[]): Promise<unknown> {
    record('window.showWarningMessage', message, ...items);
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string, ...items: unknown[]): Promise<unknown> {
    record('window.showErrorMessage', message, ...items);
    return Promise.resolve(undefined);
  },
  showQuickPick(items: unknown, _options?: unknown): Promise<unknown> {
    record('window.showQuickPick', items, _options);
    return Promise.resolve(undefined);
  },
  showSaveDialog(_options?: unknown): Promise<Uri | undefined> {
    record('window.showSaveDialog', _options);
    return Promise.resolve(undefined);
  },
  showTextDocument(uri: Uri, _options?: unknown): Promise<TextEditor> {
    record('window.showTextDocument', uri.toString(), _options);
    return Promise.reject(
      new Error('vscode stub: showTextDocument is not available in unit tests'),
    );
  },
  setStatusBarMessage(message: string, timeout?: number): Disposable {
    record('window.setStatusBarMessage', message, timeout);
    return new Disposable(() => undefined);
  },
  withProgress<R>(
    _options: unknown,
    task: (progress: { report(value: unknown): void }, token: CancellationToken) => Promise<R>,
  ): Promise<R> {
    record('window.withProgress', _options);
    const emitter = new EventEmitter<void>();
    const token: CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: emitter.event,
    };
    return task({ report: (value) => record('progress.report', value) }, token);
  },
  createWebviewPanel(
    viewType: string,
    title: string,
    _column: ViewColumn,
    _options?: unknown,
  ): WebviewPanel {
    record('window.createWebviewPanel', viewType, title);
    const disposeEmitter = new EventEmitter<void>();
    const messageEmitter = new EventEmitter<unknown>();
    const viewStateEmitter = new EventEmitter<unknown>();
    return {
      viewType,
      visible: true,
      viewColumn: ViewColumn.Beside,
      title,
      webview: {
        html: '',
        cspSource: `vscode-webview://stub`,
        options: {},
        asWebviewUri: (uri) => uri,
        postMessage: (message) => {
          record('webview.postMessage', message);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: messageEmitter.event,
      },
      onDidDispose: disposeEmitter.event,
      onDidChangeViewState: viewStateEmitter.event,
      reveal: () => record('webview.reveal'),
      dispose: () => {
        record('webview.dispose');
        disposeEmitter.fire();
      },
    };
  },
  registerWebviewPanelSerializer(viewType: string, _serializer: unknown): Disposable {
    record('window.registerWebviewPanelSerializer', viewType);
    return new Disposable(() => undefined);
  },
  createTextEditorDecorationType(_options: unknown): { dispose(): void; key: string } {
    return { dispose: () => undefined, key: 'decoration' };
  },
  showTextDocumentAndReveal(): Promise<void> {
    return Promise.resolve();
  },
};

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

export interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined;
  get<T>(section: string, defaultValue: T): T;
  has(section: string): boolean;
  update(section: string, value: unknown): Promise<void>;
}

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

function makeConfiguration(values: Record<string, unknown> = {}): WorkspaceConfiguration {
  return {
    get<T>(section: string, defaultValue?: T): T | undefined {
      record('workspace.getConfiguration.get', section);
      return (values[section] as T) ?? defaultValue;
    },
    has: (section: string) => section in values,
    update: (section: string, value: unknown) => {
      record('workspace.getConfiguration.update', section, value);
      values[section] = value;
      return Promise.resolve();
    },
  };
}

export const workspace = {
  workspaceFolders: undefined as WorkspaceFolder[] | undefined,
  /** Injected by tests to drive `readConfig`. */
  __setConfigurationValues(values: Record<string, unknown> | undefined): void {
    workspace.__values = values;
  },
  __values: {} as Record<string, unknown> | undefined,
  fs: {
    stat: (uri: Uri) => {
      record('workspace.fs.stat', uri.toString());
      return Promise.reject(new Error('vscode stub: workspace.fs.stat is not available'));
    },
    writeFile: (uri: Uri, content: Uint8Array) => {
      record('workspace.fs.writeFile', uri.toString(), content.byteLength);
      return Promise.resolve();
    },
    readFile: (uri: Uri) => {
      record('workspace.fs.readFile', uri.toString());
      return Promise.reject(new Error('vscode stub: workspace.fs.readFile is not available'));
    },
    delete: (uri: Uri) => {
      record('workspace.fs.delete', uri.toString());
      return Promise.resolve();
    },
  },
  getConfiguration(_section?: string, _scope?: unknown): WorkspaceConfiguration {
    record('workspace.getConfiguration', _section);
    return makeConfiguration(workspace.__values);
  },
  onDidChangeConfiguration(listener: (event: ConfigurationChangeEvent) => void): Disposable {
    const emitter = new EventEmitter<ConfigurationChangeEvent>();
    const subscription = emitter.event(listener);
    return Disposable.from(subscription, {
      dispose: () => {
        __configEmitter = undefined;
      },
    });
  },
  openTextDocument: (uri: Uri) => {
    record('workspace.openTextDocument', uri.toString());
    return Promise.reject(new Error('vscode stub: openTextDocument is not available'));
  },
  applyEdit: () => Promise.resolve(true),
  asRelativePath: (pathOrUri: string | Uri) =>
    typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.path,
  textDocuments: [] as TextDocument[],
};

let __configEmitter: EventEmitter<ConfigurationChangeEvent> | undefined;

/** Fires a configuration change, for tests that assert on rebuild behaviour. */
export function __fireConfigurationChange(sections: string[]): void {
  __configEmitter?.fire({
    affectsConfiguration: (section: string) =>
      sections.some((changed) => section === changed || section.startsWith(`${changed}.`)),
  });
}

// ---------------------------------------------------------------------------
// commands / env / extensions
// ---------------------------------------------------------------------------

/**
 * Command ids currently registered, and the callbacks behind them.
 *
 * Tracking these is what lets a test assert that activation actually registered
 * the commands it declares. A stub whose `getCommands()` returns a hardcoded `[]`
 * cannot distinguish "registered everything" from "registered nothing", which is
 * exactly the failure that produces a silently missing Command Palette entry.
 */
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand(id: string, callback: (...args: unknown[]) => unknown): Disposable {
    record('commands.registerCommand', id);
    if (registeredCommands.has(id)) {
      // VS Code throws here, and a test that registers the same id twice is
      // usually testing the wrong thing.
      throw new Error(`command '${id}' is already registered`);
    }
    registeredCommands.set(id, callback);
    return new Disposable(() => {
      registeredCommands.delete(id);
      record('commands.unregisterCommand', id);
    });
  },
  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    record('commands.executeCommand', id, ...args);
    const callback = registeredCommands.get(id);
    if (callback === undefined) {
      return Promise.reject(new Error(`command '${id}' not found`));
    }
    return Promise.resolve(callback(...args));
  },
  getCommands(): Promise<string[]> {
    return Promise.resolve([...registeredCommands.keys()]);
  },
  /** Test-only: forget every registration, so suites cannot leak into each other. */
  __reset(): void {
    registeredCommands.clear();
  },
};

export const env = {
  appName: 'Visual Studio Code (stub)',
  language: 'en',
  machineId: 'stub-machine',
  sessionId: 'stub-session',
  uiKind: UIKind.Desktop,
  isTelemetryEnabled: false,
  clipboard: {
    writeText: (value: string) => {
      record('env.clipboard.writeText', value.length);
      return Promise.resolve();
    },
    readText: () => Promise.resolve(''),
  },
  openExternal: (uri: Uri) => {
    record('env.openExternal', uri.toString());
    return Promise.resolve(true);
  },
};

export const extensions = {
  getExtension: (_id: string) => undefined,
  all: [] as unknown[],
};

export const version = '1.85.0-stub';

/** Convenience for tests that need a cancellable token source. */
export function createCancellationTokenSource(): CancellationTokenSource {
  const emitter = new EventEmitter<void>();
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: emitter.event,
    },
    cancel: () => {
      cancelled = true;
      emitter.fire();
    },
    dispose: () => emitter.dispose(),
  };
}

export default {
  Disposable,
  EventEmitter,
  Position,
  Range,
  Uri,
  StatusBarAlignment,
  ViewColumn,
  ProgressLocation,
  ConfigurationTarget,
  UIKind,
  window,
  workspace,
  commands,
  env,
  extensions,
  version,
};
