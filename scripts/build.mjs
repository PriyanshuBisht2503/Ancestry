#!/usr/bin/env node
/**
 * Extension bundle pipeline.
 *
 *  1. `dist/extension.js` — CommonJS, Node platform, `vscode` kept external.
 *
 * The webview is NOT built here. It is a React/JSX application, so it goes
 * through Vite (`vite.config.ts` → `media/webview.js` + `media/webview.css`),
 * which is what the `build` script chains: `build.mjs && vite build`.
 *
 * This used to carry a second esbuild target for the webview, pointing at
 * `src/webview/client/main.ts`. That entry point was replaced by `main.tsx` when
 * the client moved to React, so the old target did not just duplicate the work
 * — it failed to resolve its entry point and broke the whole build. Vite is now
 * the single owner of the webview bundle.
 *
 * Run with `--watch` for local development.
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify') || process.env.NODE_ENV === 'production';

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(root, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  minify,
  logLevel: 'info',
  external: ['vscode'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
};

if (watch) {
  const ctx = await context(extensionConfig);
  await ctx.watch();
  console.log('[ancestry] watching for changes…');
} else {
  await build(extensionConfig);
  console.log('[ancestry] extension build complete (run `npm run webview:build` for the webview)');
}
