#!/usr/bin/env node
/**
 * Render the webview outside VS Code, in an ordinary browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * The webview is the one part of Ancestry that a Node test cannot exercise: the
 * Three.js renderer and the camera controls need a real WebGL context, so they
 * are excluded from coverage and there is no headless browser in the toolchain.
 * The failure this guards against is a *quiet* one — the extension analyses
 * correctly, the panel opens, and the webview renders nothing, with no error
 * anywhere. Nothing in `npm test` can see that.
 *
 * So this script produces a standalone page that runs the **real** bundle
 * (`media/webview.js`) against a **real** analysed graph, using the **real**
 * document builder. The only thing stubbed is `acquireVsCodeApi()` — which is
 * precisely the surface VS Code injects, and the only thing a browser cannot
 * provide. Everything else is the shipped artifact.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a VS Code substitute. There is no extension host, no command
 * palette, no real `postMessage` transport: the host's reply is delivered with
 * `window.postMessage`, which is what the webview's `message` listener receives
 * in VS Code too. It proves the bundle boots, the graph arrives, the React tree
 * mounts and the canvas draws. It does not prove the commands work.
 *
 * USAGE
 * -----
 *   node scripts/preview-webview.mjs                  # analyse the demo repo, write preview.html
 *   node scripts/preview-webview.mjs --serve          # …and serve it on http://127.0.0.1:8731
 *   node scripts/preview-webview.mjs --graph g.json   # render an EXPORTED graph instead
 *
 * `--graph` takes the file produced by "Ancestry: Export Ancestry Graph as JSON", so
 * you can inspect a real run — including one from a repository you are working in —
 * without going through the extension host at all.
 *
 * The payload is validated with the *webview's own* `validateHostMessage` before
 * the page is written. That is deliberate: a mismatch between the host's serialiser
 * and the webview's validator produces a silently blank panel, so this script fails
 * at generation time with a real error instead of handing you an empty page.
 *
 * `preview.html` is written to the project root and is git-ignored.
 */

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serve = process.argv.includes('--serve');
const PORT = 8731;
const NONCE = 'ancestrypreviewnonce0001';

/** `--graph <path>`: render an exported graph instead of analysing the demo repo. */
const graphFlag = process.argv.indexOf('--graph');
const graphPath = graphFlag !== -1 ? process.argv[graphFlag + 1] : undefined;
if (graphFlag !== -1 && !graphPath) {
  console.error('[preview] --graph needs a path, e.g. --graph out/ancestry.json');
  process.exit(2);
}

/**
 * The driver, as TypeScript, bundled through esbuild below.
 *
 * It is written to a temp directory rather than the repository so nothing is left
 * behind, and it aliases `vscode` to the same stub the test suite uses — that is
 * the only module in the dependency chain that is not resolvable outside the
 * extension host.
 */
const DRIVER = `
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalysisEngine } from '${path.join(root, 'src', 'analysis').replace(/\\/g, '/')}';
import { DEFAULT_CONFIG } from '${path.join(root, 'src', 'config').replace(/\\/g, '/')}';
import { toWebviewPayload } from '${path.join(root, 'src', 'webview', 'serialize').replace(/\\/g, '/')}';
import { buildWebviewHtml, sanitizeNonce } from '${path.join(root, 'src', 'webview', 'html').replace(/\\/g, '/')}';
import { parseGraphJson, toWebviewPayload } from '${path.join(root, 'src', 'webview', 'serialize').replace(/\\/g, '/')}';
import { validateHostMessage } from '${path.join(root, 'src', 'webview', 'client', 'core', 'protocol').replace(/\\/g, '/')}';

const ROOT = ${JSON.stringify(root)};
const NONCE = ${JSON.stringify(NONCE)};
const GRAPH_PATH = ${JSON.stringify(graphPath ?? null)};
// Interpolated, not referenced: the driver is bundled and executed on its own, so
// it cannot see this module's scope.
const PREVIEW_PORT = ${PORT};

/** Brace-match a named top-level function, so no line numbers are hard-coded. */
function rangeOf(text, name) {
  const lines = text.split('\\n');
  const start = lines.findIndex((line) => line.includes('function ' + name));
  if (start === -1) throw new Error(name + ' not found');
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i] || '') {
      if (ch === '{') { depth += 1; opened = true; }
      else if (ch === '}') { depth -= 1; }
    }
    if (opened && depth <= 0) return { startLine: start + 1, endLine: i + 1 };
  }
  return { startLine: start + 1, endLine: start + 1 };
}

let dir = null;
let message;
let summary;

// Wrapped in an async function because the bundle is emitted as CommonJS, which
// does not allow a top-level await. (No backticks in this comment: it lives
// inside a template literal, and a backtick would end the string early.)
async function run() {
if (GRAPH_PATH) {
  // Render a real export rather than re-analysing. This is the path that matters
  // when debugging a run that already happened.
  const file = path.resolve(ROOT, GRAPH_PATH);
  const graph = parseGraphJson(fs.readFileSync(file, 'utf8'));
  if (graph === null) {
    throw new Error(
      'could not parse ' + file + ' as an Ancestry graph. Is it the file written by ' +
      '"Ancestry: Export Ancestry Graph as JSON"?',
    );
  }
  console.log('[preview] loaded exported graph: ' + file);
  summary =
    graph.nodes.length + ' nodes, ' + graph.edges.length + ' edges, origin=' +
    (graph.origin ? graph.origin.shortCommit : 'none');
  // An export carries no run statistics, and no focus text beyond what the graph
  // itself records, so both are supplied empty rather than invented.
  message = { type: 'graph', payload: toWebviewPayload(graph, '', { durationMs: 0, cacheHits: 0, cacheMisses: 0 }) };
} else {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ancestry-preview-'));
  console.log('[preview] demo repository: ' + dir);
  const built = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-demo-repo.mjs'), dir, '--force'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (built.status !== 0) {
    throw new Error('demo repository generation failed:\\n' + (built.stderr || built.stdout));
  }

  const absolute = path.join(dir, 'src', 'auth.ts');
  const text = fs.readFileSync(absolute, 'utf8');
  const { startLine, endLine } = rangeOf(text, 'validateToken');

  const engine = new AnalysisEngine({ config: DEFAULT_CONFIG });
  const result = await engine.analyze({ filePath: absolute, startLine, endLine });
  engine.dispose();

  summary =
    result.graph.nodes.length + ' nodes, ' + result.graph.edges.length + ' edges, origin=' +
    (result.graph.origin ? result.graph.origin.shortCommit : 'none');
  const focusSource = text.split('\\n').slice(startLine - 1, endLine).join('\\n');
  message = {
    type: 'graph',
    payload: toWebviewPayload(result.graph, focusSource, {
      durationMs: result.durationMs,
      cacheHits: result.cache.hits,
      cacheMisses: result.cache.misses,
    }),
  };
}

console.log('[preview] graph: ' + summary);

// FAIL LOUDLY HERE RATHER THAN HAND OVER A BLANK PAGE.
// A payload the webview's own validator rejects is discarded silently at runtime,
// which presents as "the graph did not load" with nothing in the console. Checking
// it at generation time turns that into a real error message here.
const checked = validateHostMessage(message);
if (checked === null) {
  throw new Error(
    'the webview validator REJECTED this payload. The host serialiser and the ' +
    'webview validator disagree, which would render an empty panel in VS Code too.',
  );
}
if (checked.type !== 'graph') {
  throw new Error('expected a graph message, got: ' + checked.type);
}
console.log(
  '[preview] payload accepted by the webview validator: ' +
    checked.payload.graph.nodes.length + ' nodes, ' + checked.payload.graph.edges.length + ' edges',
);

const payloadJson = JSON.stringify(message);
// The CSP source must be a real host-source, because the CSP builder strips
// quotes for safety, and a quoted 'self' would arrive as the bare word "self",
// which CSP reads as a hostname - so the stylesheet would be blocked. Passing the
// origin keeps it a valid host-source. A file:// page has no origin to name,
// which is why --serve is the faithful way to open this.
// (No backticks in this comment: it lives inside a template literal.)
const origin = process.env.ANCESTRY_PREVIEW_ORIGIN ?? ('http://127.0.0.1:' + PREVIEW_PORT);
const html = buildWebviewHtml({
  cspSource: origin,
  nonce: NONCE,
  scriptUri: 'media/webview.js',
  styleUri: 'media/webview.css',
  title: 'Ancestry preview',
});

// Injected BEFORE the real bootstrap so the bootstrap captures it exactly as it
// would capture VS Code's own API object.
const stub = '<script nonce="' + sanitizeNonce(NONCE) + '">\\n' +
  'window.__previewState = { ready: false, delivered: false, errors: [], log: [] };\\n' +
  'function __previewNote(kind, detail) {\\n' +
  '  var s = window.__previewState;\\n' +
  '  s.log.push(kind + ": " + detail);\\n' +
  '  if (kind === "ready") s.ready = true;\\n' +
  '  if (kind === "delivered") s.delivered = true;\\n' +
  '  if (kind === "error") { s.errors.push(detail); document.title = "ERROR: " + detail; }\\n' +
  '  __previewPaint();\\n' +
  '}\\n' +
  'function __previewPaint() {\\n' +
  '  var s = window.__previewState, el = document.getElementById("__preview_status");\\n' +
  '  if (!el) return;\\n' +
  '  var ok = s.ready && s.delivered && s.errors.length === 0;\\n' +
  '  el.textContent = ok\\n' +
  '    ? "host handshake OK - graph delivered (" + s.log.length + " message(s))"\\n' +
  '    : "waiting... ready=" + s.ready + " delivered=" + s.delivered +\\n' +
  '      " errors=" + s.errors.length + (s.errors.length ? " (" + s.errors.join("; ") + ")" : "");\\n' +
  '  el.style.color = ok ? "#7ec699" : "#e0a04a";\\n' +
  '}\\n' +
  'window.acquireVsCodeApi = function () { return { postMessage: function (m) {\\n' +
  '  __previewNote("out:" + (m && m.type), "webview -> host");\\n' +
  '  if (m && m.type === "ready") {\\n' +
  '    setTimeout(function () {\\n' +
  '      try { window.postMessage(' + payloadJson + ', "*"); __previewNote("delivered", "host -> webview"); }\\n' +
  '      catch (e) { __previewNote("error", "postMessage threw: " + e.message); }\\n' +
  '    }, 0);\\n' +
  '  }\\n' +
  '} }; };\\n' +
  'window.addEventListener("error", function (e) { __previewNote("error", e.message); });\\n' +
  'window.addEventListener("unhandledrejection", function (e) {\\n' +
  '  __previewNote("error", "unhandled rejection: " + (e.reason && e.reason.message ? e.reason.message : e.reason));\\n' +
  '});\\n' +
  '</script>\\n';

const out = html.replace('<script nonce=', stub + '<script nonce=');
if (out === html) throw new Error('could not inject the acquireVsCodeApi stub');

// A visible handshake line. Without it, "the graph did not load" and "the bundle
// threw" look identical from the outside, which is the whole reason the render
// could not be debugged from a screenshot alone.
const banner =
  '<div id="__preview_status" style="position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
  'font:12px/1.6 ui-monospace,monospace;padding:6px 10px;background:#1e1e1e;color:#e0a04a;' +
  'border-top:1px solid #333">starting...</div>';
const withBanner = out.includes('</body>') ? out.replace('</body>', banner + '</body>') : out + banner;

fs.writeFileSync(path.join(ROOT, 'preview.html'), withBanner, 'utf8');
if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
console.log('[preview] wrote ' + path.join(ROOT, 'preview.html'));
}

run().catch((error) => {
  console.error('[preview] failed: ' + (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
});
`;

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ancestry-preview-build-'));
  const entry = path.join(work, 'driver.ts');
  const bundle = path.join(work, 'driver.cjs');
  fs.writeFileSync(entry, DRIVER, 'utf8');

  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // The one module that only exists inside the extension host.
    alias: { vscode: path.join(root, 'tests', 'stubs', 'vscode.ts') },
    logLevel: 'error',
  });

  const run = spawnSync(process.execPath, [bundle], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  fs.rmSync(work, { recursive: true, force: true });
  if (run.status !== 0) {
    process.exitCode = run.status ?? 1;
    return;
  }

  const target = path.join(root, 'preview.html');
  if (!serve) {
    console.log('[preview] open it with:  code "' + target + '"');
    console.log('[preview] (a local server is more faithful: rerun with --serve)');
    return;
  }

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  };
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(root, rel === '/' ? '/preview.html' : rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end('not found: ' + rel);
        return;
      }
      res.writeHead(200, {
        'content-type': types[path.extname(file)] || 'application/octet-stream',
      });
      res.end(body);
    });
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('[preview] serving http://127.0.0.1:' + PORT + '/preview.html  (ctrl-c to stop)');
  });
}

await main();
