/**
 * The migration's security regression guard.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A RUNTIME TEST
 * -----------------------------------------------
 * Every threat this file guards against is *absent* — there is nothing to
 * execute, so there is nothing to observe at runtime. A test that rendered the
 * app and asserted "no script executed" would pass just as happily with
 * `dangerouslySetInnerHTML` in the tree, because React only *uses* that prop
 * when it is present. Scanning the source is the only check that actually
 * detects the regression.
 *
 * WHY IT IS WORTH KEEPING
 * -----------------------
 * The hand-rolled DOM UI this replaced was XSS-safe by *discipline*: every piece
 * of text went through `document.createElement` + `textContent`, and a future
 * contributor under time pressure would have had to actively choose `innerHTML`
 * to break it. React is XSS-safe by *default*, which is stronger — but only as
 * long as nobody reaches for the one escape hatch. These assertions are the
 * tripwire for that, and they are cheap enough to run on every test pass.
 *
 * WHAT IS FORBIDDEN, AND WHY
 * --------------------------
 *  - `dangerouslySetInnerHTML` — the only way to inject unescaped markup in React.
 *  - `innerHTML` / `outerHTML` / `insertAdjacentHTML` — the DOM equivalents.
 *  - `eval` / `new Function` / `setTimeout` with a string — all forbidden by the
 *    webview's CSP (`script-src 'nonce-…'`, no `unsafe-eval`), and all of them
 *    would turn a text-content bug into code execution.
 *  - `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` — `connect-src` is
 *    `'none'`; the webview has no legitimate network at all (spec §8.1: "All
 *    processing is local").
 *  - `document.write`, `<iframe>`, `<embed>`, `<object>` — each is a document
 *    injection vector, and `frame-ancestors 'none'` / `object-src 'none'` mean
 *    none of them can work anyway.
 *  - `http://` / `https://` — no remote fonts, no CDN, no remote stylesheet or
 *    script. `style-src` and `script-src` are the webview origin only.
 *
 * The scan is deliberately *lexical*: it looks at the file text, not at a parsed
 * AST, because the failure it guards against is a string appearing in the file
 * at all. It is scoped to `src/webview/client/**` — the host side
 * (`host.ts`, `html.ts`, `serialize.ts`) is covered by its own tests and, unlike
 * the webview, is allowed to build an HTML document.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

import { buildContentSecurityPolicy } from '../../src/webview/html';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The directory the webview bundle is built from. */
const CLIENT_DIR = path.resolve(__dirname, '..', '..', 'src', 'webview', 'client');

/** A forbidden construct, and why it must never appear. */
const FORBIDDEN: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  { pattern: /dangerouslySetInnerHTML/, why: 'the only React escape hatch from escaping' },
  { pattern: /\.innerHTML\b/, why: 'writes unescaped markup into the document' },
  { pattern: /\.outerHTML\b/, why: 'reads/writes unescaped markup' },
  { pattern: /insertAdjacentHTML/, why: 'writes unescaped markup into the document' },
  { pattern: /document\s*\.\s*write/, why: 'replaces the whole document' },
  { pattern: /\beval\s*\(/, why: 'forbidden by the webview CSP' },
  { pattern: /new\s+Function\s*\(/, why: 'forbidden by the webview CSP' },
  { pattern: /\bfetch\s*\(/, why: 'connect-src is none; all processing is local' },
  { pattern: /XMLHttpRequest/, why: 'connect-src is none; all processing is local' },
  { pattern: /\bWebSocket\b/, why: 'connect-src is none; all processing is local' },
  { pattern: /\bEventSource\b/, why: 'connect-src is none; all processing is local' },
  { pattern: /navigator\s*\.\s*sendBeacon/, why: 'connect-src is none' },
  { pattern: /<\s*iframe/i, why: 'frame-ancestors and object-src are none' },
  { pattern: /<\s*embed\b/i, why: 'object-src is none' },
  { pattern: /<\s*object\b/i, why: 'object-src is none' },
  { pattern: /https?:\/\//, why: 'no remote font, CDN or origin' },
  { pattern: /@font-face/, why: 'font-src is the webview origin only' },
  { pattern: /@import\s/, why: 'a stylesheet import is a remote fetch' },
  { pattern: /\bimportScripts\b/, why: 'not a webview mechanism' },
];

/** Recursively lists every source file under `dir`. */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSources(full));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The scanned files, as repo-relative paths, so failures are readable. */
const SOURCES = listSources(CLIENT_DIR).map((file) => ({
  file,
  relative: path.relative(CLIENT_DIR, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * The bundle as it actually ships.
 *
 * The source-level greps above are not enough for a class of bug that only exists
 * after bundling, and the one that matters most here was found by a person opening
 * the panel: React's CommonJS entry branches on `process.env.NODE_ENV`, Vite does
 * not substitute inside a pre-bundled dependency, and the first statement the
 * bundle reached threw `ReferenceError: process is not defined`. The panel died on
 * boot with a blank canvas, and no source assertion could see it — every unit test
 * passed, because the module graph was fine and only the emitted artifact was
 * broken.
 *
 * These assertions therefore run against `media/webview.js`. They skip when the
 * bundle has not been built, so a fresh clone can still run the suite.
 */
describe('the built webview bundle', () => {
  const bundlePath = path.resolve(__dirname, '..', '..', 'media', 'webview.js');
  const built = existsSync(bundlePath);
  const bundle = built ? readFileSync(bundlePath, 'utf8') : '';

  it.skipIf(!built)('never references `process`, which a webview does not have', () => {
    // A bare identifier, not the substring: "process" appears legitimately inside
    // words like "processed", so a plain substring check would cry wolf.
    expect(bundle.match(/(^|[^.\w$])process\s*\./g) ?? []).toEqual([]);
  });

  it.skipIf(!built)('emits no eval and no Function constructor', () => {
    // A strict CSP forbids both outright, so their presence is always a bug.
    expect(bundle).not.toMatch(/(^|[^.\w$])eval\s*\(/);
    expect(bundle).not.toMatch(/new\s+Function\s*\(/);
  });

  it.skipIf(!built)('references no remote origin for any asset', () => {
    // Every asset is bundled. A CDN reference would defeat the strict CSP and
    // would mean the panel could fetch from off the machine.
    const urls = bundle.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    const offenders = urls.filter(
      (url) =>
        !/w3\.org|reactjs\.org|github\.com|threejs\.org|opensource\.org|mozilla\.org|schema\.org/.test(
          url,
        ),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the CSP permits what the panel actually needs', () => {
  it('keeps scripts nonce-only, with no inline script and no eval', () => {
    const csp = buildContentSecurityPolicy('https://example.test', 'abc123');
    expect(csp).toContain("script-src 'nonce-abc123'");
    // The point of the strict policy: scripts must never be inline.
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });

  it('allows inline styles, because the panel styles data-driven values', () => {
    // Node colours, classification colours and computed timeline geometry are
    // `style={{ ... }}` attributes. `style-src` governs style *attributes* via
    // its `style-src-attr` fallback, so without this the browser blocks them and
    // the UI renders unstyled with no error. Scoped to `style-src` deliberately:
    // `script-src` above stays nonce-only.
    const csp = buildContentSecurityPolicy('https://example.test', 'abc123');
    const styleDirective = csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('style-src'));
    expect(styleDirective).toBeDefined();
    expect(styleDirective).toContain("'unsafe-inline'");
  });
});
describe('the webview client sources exist', () => {
  it('finds the entry point, the app and the components', () => {
    const names = SOURCES.map((source) => source.relative);
    expect(names).toContain('main.tsx');
    expect(names).toContain('App.tsx');
    expect(names).toContain('renderer.ts');
    expect(names).toContain('camera.ts');
    expect(names).toContain('host-bridge.ts');
    expect(names).toContain('components/GraphCanvas.tsx');
    expect(names).toContain('components/graphState.ts');
    expect(names).toContain('core/protocol.ts');
  });

  it('has no leftover hand-rolled UI modules', () => {
    const names = SOURCES.map((source) => source.relative);
    expect(names).not.toContain('main.ts');
    expect(names).not.toContain('panel.ts');
  });
});

describe('no script execution vectors in the webview client', () => {
  for (const source of SOURCES) {
    for (const rule of FORBIDDEN) {
      it(`${source.relative} contains no ${rule.pattern.source} (${rule.why})`, () => {
        expect(source.text).not.toMatch(rule.pattern);
      });
    }
  }
});

describe('the shipped stylesheet has no remote references', () => {
  // `src/webview/webview.css` is compiled by Vite into `media/webview.css`, the
  // file the CSP-approved `<link>` loads. It lives outside `client/`, so it is
  // checked separately — and it is the one place a remote font or stylesheet
  // could plausibly sneak in.
  const cssPath = path.resolve(__dirname, '..', '..', 'src', 'webview', 'webview.css');
  // Comments are stripped before scanning. The file's own header documents the
  // ban, and a rule that prose can trip is a rule that gets "fixed" by rewording
  // the comment rather than by deleting the offending declaration. CSS block
  // comments cannot nest, so this cannot hide code.
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('imports nothing and loads no remote font', () => {
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/@font-face/);
    expect(css).not.toMatch(/url\(/);
  });

  it('references no remote origin', () => {
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('uses VS Code theme variables with fallbacks', () => {
    expect(css).toContain('var(--vscode-editor-background');
    expect(css).toContain('var(--vscode-editor-foreground');
  });

  it('styles every region the runtime fallback in html.ts styles', () => {
    // `buildWebviewCss()` is what `host.ts` materialises when `media/` has been
    // cleaned. The shipped stylesheet and the fallback must cover the same
    // regions, or one of the two paths renders an unstyled panel.
    for (const selector of [
      '.header',
      '.legend',
      '.filter-bar',
      '.details',
      '.node-list',
      '.status-bar',
      '.toast',
      '.overlay-loading',
      '.axis-tick',
      '.node-label',
    ]) {
      expect(css).toContain(selector);
    }
  });
});

describe('the message boundary is still the only way in or out', () => {
  const bridge = SOURCES.find((source) => source.relative === 'host-bridge.ts');

  it('host-bridge.ts exists', () => {
    expect(bridge).toBeDefined();
  });

  it('validates every inbound payload', () => {
    expect(bridge?.text).toContain('validateHostMessage');
  });

  it('validates every outbound payload', () => {
    expect(bridge?.text).toContain('isOutgoingMessage');
    expect(bridge?.text).toContain('postToHost');
  });

  it('does not add a raw addEventListener("message") anywhere else', () => {
    for (const source of SOURCES) {
      if (source.relative === 'host-bridge.ts') {
        continue;
      }
      expect(source.text).not.toMatch(/addEventListener\(\s*['"]message['"]/);
    }
  });

  it('does not call the VS Code API directly outside the bridge', () => {
    for (const source of SOURCES) {
      if (source.relative === 'host-bridge.ts') {
        continue;
      }
      expect(source.text).not.toContain('__ancestryVsCodeApi');
      expect(source.text).not.toContain('acquireVsCodeApi');
    }
  });
});

describe('the pure core is still framework-free', () => {
  const core = SOURCES.filter((source) => source.relative.startsWith('core/'));

  it('has files to check', () => {
    expect(core.length).toBeGreaterThan(5);
  });

  for (const source of core) {
    it(`core/${source.relative} imports neither react, react-dom nor three`, () => {
      expect(source.text).not.toMatch(/from ['"]react['"]/);
      expect(source.text).not.toMatch(/from ['"]react-dom/);
      expect(source.text).not.toMatch(/from ['"]three['"]/);
    });
  }
});

describe('the React layer does not drive the 3D scene from render', () => {
  const canvas = SOURCES.find((source) => source.relative === 'components/GraphCanvas.tsx');

  it('GraphCanvas.tsx exists', () => {
    expect(canvas).toBeDefined();
  });

  it('constructs the renderer in an effect, not in the component body', () => {
    // The mistake this guards against is `new AncestryRenderer(...)` during
    // render, or a `renderer.setGraph(...)` in the component body. Both would
    // rebuild the WebGL context on every render.
    expect(canvas?.text).toContain('new AncestryRenderer({');
    expect(canvas?.text).toContain('useEffect');
  });

  it('documents the rule it exists to enforce', () => {
    expect(canvas?.text).toContain('React must never re-render the 3D scene');
  });
});

describe('the App owns the state and the host traffic', () => {
  const app = SOURCES.find((source) => source.relative === 'App.tsx');

  it('App.tsx exists', () => {
    expect(app).toBeDefined();
  });

  it('drives everything through the pure reducer', () => {
    expect(app?.text).toContain('ancestryReducer');
    expect(app?.text).not.toMatch(/useState<.*AncestryGraph/);
  });

  it('subscribes to the host through the bridge hook', () => {
    expect(app?.text).toContain('useAncestryHost');
  });

  it('posts outbound messages through the bridge', () => {
    expect(app?.text).toContain('postToHost');
  });
});
