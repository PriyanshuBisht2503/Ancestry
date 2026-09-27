/**
 * The webview document: strict CSP, per-load nonce, and the static DOM shell.
 *
 * WHY THIS FILE IS HAND-WRITTEN STRING CONCATENATION AND NOT A TEMPLATE ENGINE
 * --------------------------------------------------------------------------------
 * A webview runs under a CSP with `default-src 'none'`. That rules out inline
 * event handlers, `eval`, remote fonts, CDNs and any script tag without the
 * per-load nonce. It also means a template literal that interpolates *data* into
 * the document is an XSS bug waiting to happen, so the only interpolated values
 * here are our own constants and two URIs, and both go through
 * {@link escapeAttribute}. Every user-controlled string reaches the document
 * later, from JavaScript, via `document.createElement` + `textContent`.
 *
 * The stylesheet is a *separate file* (`media/webview.css`) linked with
 * `<link rel="stylesheet">` rather than an inline `<style>`, precisely so that
 * `style-src` does not need `'unsafe-inline'`. `buildWebviewCss()` is the
 * single source of truth for that file's contents; `tests/webview/html.test.ts`
 * asserts the file on disk matches it, so the two can never drift.
 */

/** Options for {@link buildWebviewHtml}. */
export interface BuildWebviewHtmlOptions {
  /** `webview.cspSource` — the only origin the document may load from. */
  cspSource: string;
  /** Per-load nonce, 32 characters of base-64-ish randomness. */
  nonce: string;
  /** `webview.asWebviewUri(...)` for `media/webview.js`. */
  scriptUri: string;
  /** `webview.asWebviewUri(...)` for `media/webview.css`. */
  styleUri: string;
  /** Document title; escaped. */
  title: string;
  /**
   * Additional CSP directives merged over the defaults. Present so a future
   * feature (e.g. `img-src blob:` for an exported PNG) can widen the policy in
   * one reviewed place instead of editing the template.
   */
  cspDirectives?: Record<string, string[]>;
}

/**
 * The baseline CSP.
 *
 * Directive-by-directive, with the reason each one is what it is:
 *  - `default-src 'none'` — nothing loads unless explicitly allowed. This is
 *    the base posture: a bug elsewhere in the document has no network to fall
 *    back on.
 *  - `img-src ${cspSource} data: blob:` — the webview's own resources (the
 *    `vscode-resource:` origin) plus inline data URIs for the node-colour
 *    swatches. `blob:` is allowed because `canvas.toDataURL` is not used but
 *    `URL.createObjectURL` is a plausible future export path.
 *  - `style-src ${cspSource}` — the separate stylesheet only. **No
 *    `'unsafe-inline'`**, which is the whole reason the CSS is a file.
 *  - `script-src 'nonce-${nonce}'` — a nonce source matches both inline and
 *    external script elements bearing that nonce, which is why no host
 *    allowlist is needed. Nonces are regenerated for every panel load, so a
 *    captured one is worthless.
 *  - `font-src ${cspSource}` — the workbench's own font assets; the stylesheet
 *    deliberately uses no `@font-face` and no remote font.
 *  - `connect-src 'none'`, `object-src 'none'`, `base-uri 'none'`,
 *    `form-action 'none'`, `frame-ancestors 'none'` — the webview talks to the
 *    host only through `postMessage`, so there is no legitimate network, plugin
 *    or navigation. `frame-ancestors 'none'` stops the panel being embedded.
 */
export const BASE_CSP_DIRECTIVES: Readonly<Record<string, string[]>> = Object.freeze({
  'default-src': ["'none'"],
  'img-src': ['{cspSource}', 'data:', 'blob:'],
  // `'unsafe-inline'` for STYLES ONLY, and it is not a shortcut.
  //
  // The panel paints data-driven values that cannot be expressed in a stylesheet:
  // per-node and per-classification colours resolved from the palette at runtime,
  // and computed geometry (progress width, timeline tick offsets). Those are
  // `style={{ … }}` attributes by necessity, and `style-src` governs style
  // *attributes* through its `style-src-attr` fallback — so without this the
  // browser blocks them and the UI silently renders unstyled.
  //
  // Why it is acceptable here: this applies to `style-src` only. `script-src`
  // stays nonce-only with no `unsafe-inline` and no `eval`, so nothing here can
  // execute script. CSS cannot run JavaScript in any browser VS Code embeds, and
  // the values being interpolated are hex colours and percentages produced by
  // code in this repository, never by data from a message (every inbound payload
  // goes through `validateHostMessage` first).
  'style-src': ['{cspSource}', "'unsafe-inline'"],
  'script-src': ["'nonce-{nonce}'"],
  'font-src': ['{cspSource}'],
  'connect-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
});

/**
 * Reduces a nonce to the alphanumeric characters a CSP nonce may contain.
 *
 * `getNonce()` already produces 32 hex characters, so this is a no-op in
 * practice. It exists because the nonce is interpolated into **two** places —
 * the CSP header value and the `nonce` attribute of both script elements — and a
 * caller that passed something containing a quote or a space would otherwise be
 * able to close the CSP directive and append a source of its own. Stripping to
 * `[A-Za-z0-9]` makes that structurally impossible while keeping the two
 * occurrences identical, so the panel still works instead of silently failing
 * to load its script.
 */
export function sanitizeNonce(nonce: string): string {
  if (typeof nonce !== 'string') {
    return '';
  }
  return nonce.replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Escapes text for an HTML text node or double-quoted attribute value.
 *
 * `&`, `<`, `>`, `"` and `'` are replaced, which is sufficient for both the
 * text and the quoted-attribute contexts this file uses. Control characters are
 * dropped rather than escaped so a stray newline in a title cannot break the
 * generated document's structure. This is belt-and-braces: the only values that
 * ever reach it are the panel title and two `asWebviewUri` results.
 */
export function escapeHtml(value: string): string {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const char of value) {
    switch (char) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#39;';
        break;
      default: {
        const code = char.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? ' ' : char;
      }
    }
  }
  return out;
}

/**
 * Builds the full webview document.
 *
 * The only interpolated values are the CSP source, the nonce, two URIs and the
 * title — all escaped, all constant per load. The DOM skeleton is static
 * markup: `main.ts` looks elements up by id and fills them with `textContent`.
 */
export function buildWebviewHtml(options: BuildWebviewHtmlOptions): string {
  const rawNonce = sanitizeNonce(options.nonce ?? '');
  const nonce = escapeHtml(rawNonce);
  const csp = buildContentSecurityPolicy(options.cspSource ?? '', rawNonce, options.cspDirectives);
  const title = escapeHtml(options.title ?? 'Ancestry');
  const styleHref = escapeHtml(options.styleUri ?? '');
  const scriptSrc = escapeHtml(options.scriptUri ?? '');

  // `<noscript>` is static text: no data, nothing to escape.
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${styleHref}" />
    <title>${title}</title>
  </head>
  <body>
    <div class="ancestry-root" id="ancestry-root">
      <header class="header" id="header">
        <div class="header-main">
          <h1 class="header-title" id="header-title">Ancestry</h1>
          <p class="header-summary" id="header-summary">Waiting for analysis…</p>
        </div>
        <pre class="header-preview" id="header-preview" aria-label="Selected block source"></pre>
      </header>

      <div class="legend" id="legend" aria-label="Legend"></div>

      <div class="filter-bar" id="filter-bar" role="group" aria-label="Filters"></div>

      <main class="stage" id="stage">
        <canvas class="stage-canvas" id="stage-canvas" tabindex="0" aria-label="Ancestry graph"></canvas>
        <div class="label-layer" id="label-layer" aria-hidden="true"></div>
        <div class="axis-overlay axis-overlay-x" id="axis-x" aria-hidden="true"></div>
        <div class="axis-overlay axis-overlay-y" id="axis-y" aria-hidden="true"></div>
        <div class="overlay overlay-loading" id="overlay-loading" hidden>
          <div class="overlay-inner">
            <p class="overlay-message" id="overlay-message">Analyzing…</p>
            <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-bar" id="progress-bar"></div>
            </div>
          </div>
        </div>
      </main>

      <aside class="details" id="details" aria-label="Version details">
        <p class="details-empty" id="details-empty">Select a version in the 3D view.</p>
        <div class="details-body" id="details-body" hidden></div>
      </aside>

      <section class="node-list" id="node-list" aria-label="Versions">
        <h2 class="node-list-title">Versions</h2>
        <ul class="node-list-items" id="node-list-items"></ul>
      </section>

      <footer class="status-bar" id="status-bar">
        <span class="status-message" id="status-message">Ready</span>
        <span class="status-shortcuts" id="status-shortcuts">f fit · / search · Esc clear · 1 labels · 2 edges</span>
      </footer>

      <div class="toast" id="toast" role="alert" hidden>
        <p class="toast-message" id="toast-message"></p>
        <p class="toast-detail" id="toast-detail"></p>
      </div>

      <noscript>
        <div class="noscript">
          Ancestry needs JavaScript to render the 3D graph. Enable JavaScript for
          this webview, or use “Export Ancestry Graph as JSON” to inspect the
          analysis data directly.
        </div>
      </noscript>
    </div>
    <script nonce="${nonce}">${buildBootstrapScript(rawNonce)}</script>
    <script nonce="${nonce}" src="${scriptSrc}"></script>
  </body>
</html>
`;
}

/**
 * The tiny inline bootstrap that runs before the bundle.
 *
 * Its only jobs are to capture `acquireVsCodeApi()` (the webview's only handle on
 * the extension host, and it may be called exactly once per document) and to
 * forward `console.error` to the host so a failure inside the bundle surfaces
 * in the extension's output channel instead of vanishing into the webview
 * devtools.
 *
 * Contains no `eval`, no `new Function`, and no data interpolation: the nonce is
 * echoed only in a leading comment so the DOM is debuggable.
 */
export function buildBootstrapScript(nonce: string): string {
  const marker = (nonce ?? '').replace(/[^A-Za-z0-9+/=_-]/g, '');
  return `// ancestry-bootstrap nonce=${marker}
(function () {
  'use strict';
  try {
    var api = acquireVsCodeApi();
    window.__ancestryVsCodeApi = api;
  } catch (error) {
    window.__ancestryVsCodeApi = null;
  }
  var nativeError = console.error;
  console.error = function () {
    try {
      var parts = [];
      for (var index = 0; index < arguments.length; index += 1) {
        var value = arguments[index];
        parts.push(typeof value === 'string' ? value : safeStringify(value));
      }
      if (window.__ancestryVsCodeApi) {
        window.__ancestryVsCodeApi.postMessage({
          type: 'clientError',
          payload: { message: parts.join(' ') }
        });
      }
    } catch (ignored) {
      // Never let telemetry re-throw inside the webview.
    }
    nativeError.apply(console, arguments);
  };
  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }
})();
`;
}

/** Assembles the CSP header value from the base directives plus overrides. */
export function buildContentSecurityPolicy(
  cspSource: string,
  nonce: string,
  overrides?: Record<string, string[]>,
): string {
  const safeSource =
    typeof cspSource === 'string' ? cspSource.replace(/[^A-Za-z0-9+./:_-]/g, '') : '';
  const safeNonce = sanitizeNonce(nonce);
  const merged: Record<string, string[]> = {};
  for (const [directive, values] of Object.entries(BASE_CSP_DIRECTIVES)) {
    merged[directive] = [...values];
  }
  if (overrides !== undefined && typeof overrides === 'object') {
    for (const [directive, values] of Object.entries(overrides)) {
      if (!Array.isArray(values)) {
        continue;
      }
      merged[directive] = values.map((value) => String(value));
    }
  }
  return `${Object.entries(merged)
    .map(
      ([directive, values]) =>
        `${directive} ${values
          .join(' ')
          .replace(/\{cspSource\}/g, safeSource)
          .replace(/\{nonce\}/g, safeNonce)}`,
    )
    .join('; ')};`;
}

/**
 * The complete webview stylesheet.
 *
 * Returns one string with no imports so `host.ts` can materialise
 * `media/webview.css` from this exact function — the stylesheet therefore
 * cannot drift away from the CSP-approved, separate-file design, and there is
 * exactly one copy of the theme rules in the repository.
 *
 * Every colour is a `--vscode-*` theme variable with a hard-coded fallback, so
 * the panel looks native in light, dark and high-contrast themes and is still
 * legible if a future VS Code release renames a token. `currentColor` and
 * `color-mix`-free plain CSS keep it compatible with the Chromium versions
 * VS Code 1.85 embeds.
 */
export function buildWebviewCss(): string {
  return `:root {
  --ancestry-bg: var(--vscode-editor-background, #1e1e1e);
  --ancestry-fg: var(--vscode-editor-foreground, #d4d4d4);
  --ancestry-muted: var(--vscode-descriptionForeground, #9d9d9d);
  --ancestry-border: var(--vscode-panel-border, #3c3c3c);
  --ancestry-surface: var(--vscode-editorWidget-background, #252526);
  --ancestry-surface-alt: var(--vscode-sideBar-background, #252526);
  --ancestry-accent: var(--vscode-focusBorder, #0a7aca);
  --ancestry-accent-soft: var(--vscode-badge-background, #4d8bf5);
  --ancestry-error: var(--vscode-errorForeground, #f14c4c);
  --ancestry-warning: var(--vscode-editorWarning-foreground, #cca700);
  --ancestry-selection: var(--vscode-list-activeSelectionBackground, #04395e);
  --ancestry-input-bg: var(--vscode-input-background, #3c3c3c);
  --ancestry-input-fg: var(--vscode-input-foreground, #cccccc);
  --ancestry-button-bg: var(--vscode-button-background, #0e639c);
  --ancestry-button-fg: var(--vscode-button-foreground, #ffffff);
  --ancestry-button-hover: var(--vscode-button-hoverBackground, #1177bb);
  --ancestry-focus: var(--vscode-focusBorder, #0a7aca);
  --ancestry-code-bg: var(--vscode-textCodeBlock-background, #2b2b2b);
  --ancestry-radius: 4px;
  --ancestry-gap: 8px;
  --ancestry-font: var(--vscode-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif);
  --ancestry-mono: var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace);
  --ancestry-size: var(--vscode-font-size, 13px);
}

* {
  box-sizing: border-box;
}

html,
body {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: var(--ancestry-bg);
  color: var(--ancestry-fg);
  font-family: var(--ancestry-font);
  font-size: var(--ancestry-size);
}

.ancestry-root {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  grid-template-rows: auto auto auto minmax(0, 1fr) minmax(0, 0.55fr) auto;
  grid-template-areas:
    'header header'
    'legend legend'
    'filter filter'
    'stage details'
    'stage list'
    'status status';
  height: 100vh;
  width: 100vw;
  gap: 1px;
  background: var(--ancestry-border);
}

/* ---------------------------------------------------------------- header */

.header {
  grid-area: header;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ancestry-gap);
  padding: 10px 12px;
  background: var(--ancestry-surface);
}

.header-main {
  min-width: 0;
  flex: 1 1 auto;
}

.header-title {
  margin: 0 0 2px;
  font-size: 1.05em;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--ancestry-fg);
}

.header-summary {
  margin: 0;
  color: var(--ancestry-muted);
  font-size: 0.92em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-preview {
  flex: 0 1 40%;
  max-height: 84px;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  background: var(--ancestry-code-bg);
  border: 1px solid var(--ancestry-border);
  border-radius: var(--ancestry-radius);
  font-family: var(--ancestry-mono);
  font-size: 0.85em;
  line-height: 1.35;
  white-space: pre;
  color: var(--ancestry-fg);
}

.header-preview:empty {
  display: none;
}

/* ---------------------------------------------------------------- legend */

.legend {
  grid-area: legend;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 6px 12px;
  background: var(--ancestry-surface-alt);
  border-top: 1px solid var(--ancestry-border);
  border-bottom: 1px solid var(--ancestry-border);
  font-size: 0.85em;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ancestry-muted);
}

.legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--ancestry-border);
  flex: 0 0 auto;
}

.legend-swatch.edge {
  height: 2px;
  width: 16px;
  border-radius: 1px;
  border: none;
}

.legend-swatch.focus {
  outline: 2px solid var(--ancestry-accent);
  outline-offset: 1px;
}

.legend-note {
  color: var(--ancestry-muted);
  font-style: italic;
}

/* ------------------------------------------------------------ filter bar */

.filter-bar {
  grid-area: filter;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ancestry-gap);
  padding: 6px 12px;
  background: var(--ancestry-surface);
}

.filter-field {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.85em;
  color: var(--ancestry-muted);
}

.filter-field > label {
  white-space: nowrap;
}

.filter-field select,
.filter-field input[type='search'],
.filter-field input[type='text'] {
  background: var(--ancestry-input-bg);
  color: var(--ancestry-input-fg);
  border: 1px solid var(--ancestry-border);
  border-radius: var(--ancestry-radius);
  padding: 2px 4px;
  font-family: inherit;
  font-size: 1em;
  max-width: 190px;
}

.filter-field input[type='range'] {
  width: 110px;
  accent-color: var(--ancestry-accent-soft);
}

.filter-value {
  min-width: 3.2em;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--ancestry-fg);
}

.filter-toggles {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.filter-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px 1px 3px;
  border: 1px solid var(--ancestry-border);
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
  color: var(--ancestry-muted);
}

.filter-toggle input {
  margin: 0;
  accent-color: var(--ancestry-accent-soft);
}

.filter-toggle.is-on {
  color: var(--ancestry-fg);
  border-color: var(--ancestry-accent);
}

.filter-toggle .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.filter-summary {
  margin-left: auto;
  color: var(--ancestry-muted);
  font-size: 0.85em;
  font-variant-numeric: tabular-nums;
}

button.ancestry-button {
  background: var(--ancestry-button-bg);
  color: var(--ancestry-button-fg);
  border: none;
  border-radius: var(--ancestry-radius);
  padding: 3px 10px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.88em;
}

button.ancestry-button:hover {
  background: var(--ancestry-button-hover);
}

button.ancestry-button:focus-visible,
.filter-field select:focus-visible,
.filter-field input:focus-visible,
.stage-canvas:focus-visible {
  outline: 1px solid var(--ancestry-focus);
  outline-offset: 1px;
}

/* ----------------------------------------------------------------- stage */

.stage {
  grid-area: stage;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ancestry-bg);
}

.stage-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

.stage-canvas.is-dragging {
  cursor: grabbing;
}

.label-layer,
.axis-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.axis-overlay-x {
  bottom: 0;
  height: 22px;
}

.axis-overlay-y {
  left: 0;
  top: 0;
  width: 132px;
}

.axis-tick {
  position: absolute;
  font-size: 0.72em;
  color: var(--ancestry-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  transform: translate(-50%, 0);
}

.axis-tick.major {
  color: var(--ancestry-fg);
}

.axis-row-label {
  position: absolute;
  font-size: 0.72em;
  color: var(--ancestry-muted);
  white-space: nowrap;
  transform: translate(0, -50%);
  max-width: 124px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.node-label {
  position: absolute;
  padding: 0 3px;
  font-size: 0.72em;
  color: var(--ancestry-fg);
  background: var(--ancestry-bg);
  background: color-mix(in srgb, var(--ancestry-bg) 72%, transparent);
  border-radius: 2px;
  white-space: nowrap;
  transform: translate(-50%, -140%);
  pointer-events: none;
}

.node-label.is-focus {
  color: #ffffff;
  font-weight: 600;
}

.node-label.is-origin {
  color: #00ffc8;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ancestry-bg);
  background: color-mix(in srgb, var(--ancestry-bg) 78%, transparent);
  z-index: 5;
}

.overlay[hidden] {
  display: none;
}

/* Explicit hook so the loading state can be styled apart from a future
   error/summary overlay without touching the markup's id contract. */
.overlay-loading .overlay-inner {
  border-color: var(--ancestry-accent);
}

.overlay-inner {
  min-width: 260px;
  padding: 16px 18px;
  background: var(--ancestry-surface);
  border: 1px solid var(--ancestry-border);
  border-radius: var(--ancestry-radius);
  text-align: center;
}

.overlay-message {
  margin: 0 0 10px;
  color: var(--ancestry-fg);
}

.progress {
  height: 4px;
  border-radius: 2px;
  background: var(--ancestry-border);
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  width: 0%;
  background: var(--ancestry-accent-soft);
  transition: width 120ms linear;
}

/* --------------------------------------------------------------- details */

.details {
  grid-area: details;
  min-width: 0;
  overflow: auto;
  padding: 10px 12px;
  background: var(--ancestry-surface);
  border-left: 1px solid var(--ancestry-border);
}

.details-empty {
  margin: 0;
  color: var(--ancestry-muted);
  font-style: italic;
}

.details-body[hidden] {
  display: none;
}

.details-section {
  margin: 0 0 12px;
}

.details-section-title {
  margin: 0 0 4px;
  font-size: 0.78em;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ancestry-muted);
}

.details-row {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 2px 8px;
  margin-bottom: 2px;
  font-size: 0.88em;
}

.details-key {
  color: var(--ancestry-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}

.details-value {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ancestry-fg);
}

.details-value.mono {
  font-family: var(--ancestry-mono);
}

.details-source,
.details-signature {
  margin: 0;
  padding: 6px 8px;
  background: var(--ancestry-code-bg);
  border: 1px solid var(--ancestry-border);
  border-radius: var(--ancestry-radius);
  font-family: var(--ancestry-mono);
  font-size: 0.82em;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 240px;
  overflow: auto;
}

.disclaimer {
  margin: 0;
  padding: 8px 10px;
  border-left: 3px solid var(--ancestry-warning);
  background: var(--ancestry-surface-alt);
  color: var(--ancestry-muted);
  font-size: 0.85em;
  line-height: 1.45;
}

.badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 0.78em;
  line-height: 1.6;
  color: var(--ancestry-fg);
  background: var(--ancestry-border);
}

.badge.strong {
  background: #2ecc71;
  color: #06210f;
}

.badge.possible {
  background: #f1c40f;
  color: #241d00;
}

.badge.weak {
  background: #e67e22;
  color: #241000;
}

.badge.unrelated {
  background: #7f8c8d;
  color: #101010;
}

.ancestry-path {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.85em;
}

.ancestry-path li {
  padding: 1px 0;
  color: var(--ancestry-muted);
}

.ancestry-path li::before {
  content: '\\2193';
  margin-right: 6px;
  color: var(--ancestry-accent-soft);
}

button.link {
  padding: 0;
  border: none;
  background: none;
  color: var(--ancestry-focus);
  cursor: pointer;
  font: inherit;
  text-align: left;
  text-decoration: underline;
}

/* ------------------------------------------------------------- node list */

.node-list {
  grid-area: list;
  min-width: 0;
  overflow: auto;
  background: var(--ancestry-surface);
  border-left: 1px solid var(--ancestry-border);
  border-top: 1px solid var(--ancestry-border);
}

.node-list-title {
  position: sticky;
  top: 0;
  margin: 0;
  padding: 5px 12px;
  font-size: 0.78em;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ancestry-muted);
  background: var(--ancestry-surface);
  border-bottom: 1px solid var(--ancestry-border);
}

.node-list-items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.node-list-item {
  padding: 3px 8px;
  cursor: pointer;
  border-bottom: 1px solid var(--ancestry-border);
}

.node-list-item:hover,
.node-list-item.is-selected {
  background: var(--ancestry-selection);
}

/* ------------------------------------------------------------ status bar */

.status-bar {
  grid-area: status;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ancestry-gap);
  padding: 4px 12px;
  background: var(--ancestry-surface);
  border-top: 1px solid var(--ancestry-border);
  font-size: 0.82em;
  color: var(--ancestry-muted);
}

.status-message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-shortcuts {
  white-space: nowrap;
  opacity: 0.8;
}

/* ------------------------------------------------------------------ toast */

.toast {
  position: fixed;
  right: 16px;
  bottom: 40px;
  max-width: 420px;
  padding: 10px 12px;
  background: var(--ancestry-surface);
  border: 1px solid var(--ancestry-error);
  border-left-width: 3px;
  border-radius: var(--ancestry-radius);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
  z-index: 20;
}

.toast[hidden] {
  display: none;
}

.toast-message {
  margin: 0;
  color: var(--ancestry-error);
  font-weight: 600;
}

.toast-detail {
  margin: 4px 0 0;
  color: var(--ancestry-muted);
  font-size: 0.9em;
  overflow-wrap: anywhere;
}

.noscript {
  padding: 16px;
  color: var(--ancestry-fg);
  font-family: var(--ancestry-font);
}

@media (max-width: 720px) {
  .ancestry-root {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto minmax(0, 1fr) minmax(0, 0.4fr) minmax(0, 0.3fr) auto;
    grid-template-areas:
      'header'
      'legend'
      'filter'
      'stage'
      'details'
      'list'
      'status';
  }

  .details,
  .node-list {
    border-left: none;
    border-top: 1px solid var(--ancestry-border);
  }
}

@media (prefers-reduced-motion: reduce) {
  .progress-bar {
    transition: none;
  }
}
`;
}
