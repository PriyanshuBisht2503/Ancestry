import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  plugins: [
    {
      // `node:sqlite` is a Node builtin, but Vite's resolver strips the `node:`
      // prefix and then looks for a package called `sqlite`, which does not
      // exist. Marking the specifier external leaves it intact for Node to
      // resolve. A plugin is used rather than `server.deps.external` because the
      // prefix-stripping happens during resolution, before the dep list is read.
      name: 'ancestry:externalize-node-builtins',
      enforce: 'pre' as const,
      resolveId(source: string) {
        return source === 'node:sqlite' ? { id: source, external: true } : null;
      },
    },
  ],
  resolve: {
    alias: {
      // `vscode` is injected by the extension host and is not resolvable from a
      // plain Node process. Aliasing it to a hand-written stub makes the command
      // layer importable — and therefore testable — without a real VS Code.
      // See tests/stubs/vscode.ts for why that beats per-file `vi.mock`.
      vscode: path.resolve(__dirname, 'tests/stubs/vscode.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'media/**'],
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // Modules that need a real browser or a real WebGL context, and therefore
      // cannot be unit tested here. Their logic lives in
      // `src/webview/client/core`, which IS unit tested. The names must match the
      // files that actually exist: the client moved to React, so the entry point
      // is `main.tsx` and `panel.ts` is now `components/GraphCanvas.tsx`.
      exclude: [
        'src/webview/client/renderer.ts',
        'src/webview/client/camera.ts',
        'src/webview/client/host-bridge.ts',
        'src/webview/client/main.tsx',
        'src/webview/client/App.tsx',
      ],
      thresholds: {
        lines: 55,
        functions: 50,
        branches: 40,
        statements: 55,
      },
    },
  },
});
