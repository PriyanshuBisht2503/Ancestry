/**
 * Vite configuration for the Ancestry webview bundle.
 *
 * THE OUTPUT CONTRACT (do not change these filenames)
 * ---------------------------------------------------
 * `src/webview/host.ts` hardcodes two paths:
 *
 *   media/webview.js    — the <script> the CSP nonce authorises
 *   media/webview.css   — the <link rel="stylesheet">, so `style-src` needs no
 *                         'unsafe-inline'
 *
 * Both are absolute requirements of the host side, so `fileName`/`entryFileNames`
 * and `lib.cssFileName` below are contracts, not preferences. If either changes,
 * the panel loads unstyled and then fails to boot.
 *
 * WHY A SINGLE IIFE AND NOT AN ES-MODULE BUILD
 * --------------------------------------------
 * A webview document is a fixed, hand-written HTML string with exactly one
 * `<script type>`-less tag. There is no import graph for the browser to walk, and
 * `default-src 'none'` with a per-load nonce means we cannot add one. So:
 *
 *   - `formats: ['iife']`        — one self-contained script, no `import`.
 *   - `inlineDynamicImports: true` — an IIFE *cannot* code-split, and a stray
 *     dynamic import would emit a chunk the document never loads. This makes the
 *     constraint explicit and fails the build instead of producing a broken one.
 *   - `target: 'es2020'`        — the VS Code 1.85 webview is Electron with
 *     Chromium 120, and `es2020` is a safe floor for both it and the optional
 *     esbuild fallback in `scripts/build.mjs`.
 *
 * `emptyOutDir: false` is load-bearing: `scripts/build.mjs` writes the extension
 * bundle into `dist/` and this writes into `media/`, but a future `clean` step or
 * a second build must not let one tool delete the other's output. The extension
 * also *ships* `media/webview.css`, so deleting it during a build would produce a
 * package that only works because `host.ts` happens to re-materialise it at
 * runtime.
 *
 * SECURITY
 * --------
 * The webview runs under `default-src 'none'` with a per-load nonce and
 * `connect-src 'none'`. That forbids `eval` and `new Function` outright, so the
 * build must never produce either:
 *
 *   - `@vitejs/plugin-react` is used for the **automatic JSX runtime** only. In a
 *     production build its transform is esbuild's, which emits `_jsx(...)` calls
 *     against `react/jsx-runtime` — no `eval`, no Babel, no `React.createElement`
 *     helper import, and nothing that needs a helper injected at runtime.
 *   - `esbuild.legalComments: 'none'` keeps the only `/*!` comments (licence
 *     banners) out of the bundle, matching what `scripts/build.mjs` already did.
 *     They are harmless, but they are the sort of thing that gets appended to a
 *     file by a different tool on a different machine.
 *   - `base: './'` is cosmetic here — the host's `asWebviewUri` URL already ends
 *     in the filename — but it makes the build self-consistent if an asset ever
 *     needs a relative reference.
 *
 * `tests/webview/security.test.ts` greps `src/webview/client/**` for the
 * constructs above, and the bundle's own size and contents are checked by hand
 * after each build.
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // The webview is loaded from a `vscode-webview://` origin via an absolute
  // `asWebviewUri`, so nothing here needs rewriting — but a relative base means a
  // stray asset reference can never try to reach the workbench's own origin.
  base: './',
  // LOAD-BEARING. React's CommonJS entry branches on `process.env.NODE_ENV`, and
  // a webview has no `process`. Vite replaces this in *application* code, but not
  // inside a pre-bundled dependency, so the reference survived into the shipped
  // bundle and the first statement it reached threw
  // `ReferenceError: process is not defined` — the panel died on boot with a
  // blank canvas and no useful error.
  //
  // Nothing may read `process` in webview code, so the substitution is total
  // rather than a shim: a shim would be a real object in the bundle that only
  // exists to satisfy dead branches.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  plugins: [
    // Automatic runtime; no `jsxImportSource` override needed, React's own
    // `react/jsx-runtime` is the default and the import is a static module.
    react(),
  ],
  build: {
    outDir: 'media',
    // `scripts/build.mjs` owns `dist/`; neither build may empty the other.
    emptyOutDir: false,
    // One stylesheet, not one per dynamically imported chunk. The CSP allows a
    // single `<link>`, so a second CSS file would be dead weight.
    cssCodeSplit: false,
    target: 'es2020',
    minify: 'esbuild',
    sourcemap: true,
    esbuild: {
      legalComments: 'none',
    },
    lib: {
      entry: 'src/webview/client/main.tsx',
      // Required by the `iife` format; never referenced (the document loads the
      // bundle for its side effects, not for a global).
      name: 'AncestryWebview',
      formats: ['iife'],
      // Hard contract — see the header comment.
      fileName: () => 'webview.js',
      cssFileName: 'webview',
    },
    rollupOptions: {
      output: {
        // An IIFE has no module loader, so nothing may be split out. Stating it
        // turns a would-be broken build into a build error.
        inlineDynamicImports: true,
        assetFileNames: '[name][extname]',
      },
    },
  },
});
