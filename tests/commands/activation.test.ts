/**
 * `activate` / `deactivate` against a mocked extension host.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * "Extension could not be loaded" is the least informative failure an extension
 * has, and nothing else in the suite would catch it. Every other test imports a
 * module directly; this one calls the real entry point the way VS Code does, with
 * a real `ExtensionContext`-shaped object, and asserts the contract that makes the
 * extension loadable at all:
 *
 *   - the module exports `activate` and `deactivate` as functions;
 *   - `activate` returns an API object and registers commands;
 *   - a failure *inside* activation is contained — `activate` still returns a
 *     usable API instead of throwing, because a throw here is what produces
 *     "the extension failed to activate" and disables every command;
 *   - `deactivate` disposes everything and is safe to call twice, and safe to
 *     call when activation never happened.
 *
 * That containment is the part worth pinning. The alternative — letting an
 * activation failure propagate — turns one bad file into a dead command palette
 * entry for the whole session, and it is exactly the kind of regression that
 * passes a test suite that only ever imports submodules.
 *
 * `vscode` is aliased to `tests/stubs/vscode.ts` by `vitest.config.ts`, the same
 * stub the command layer already uses, so this exercises the real wiring rather
 * than a parallel mock.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as vscode from 'vscode';

import { activate, deactivate, type AncestryExtensionApi } from '../../src/extension';
import { COMMAND_IDS, findUndeclaredCommands, findUnimplementedCommands } from '../../src/commands';

let storageRoot: string;
let context: vscode.ExtensionContext;

beforeEach(() => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ancestry-activate-'));
  context = {
    subscriptions: [],
    extensionPath: path.resolve(__dirname, '..', '..'),
    extensionUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
    globalStoragePath: path.join(storageRoot, 'global'),
    storagePath: path.join(storageRoot, 'workspace'),
    logPath: path.join(storageRoot, 'logs'),
    extensionMode: 2,
    environmentVariableCollection: undefined,
    secrets: undefined,
    globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] },
  } as unknown as vscode.ExtensionContext;
});

afterEach(() => {
  try {
    deactivate();
  } catch {
    // deactivate is asserted separately; a throw here must not mask that.
  }
  fs.rmSync(storageRoot, { recursive: true, force: true });
  // Registrations outlive a single test otherwise, and `registerCommand` now
  // (correctly) throws on a duplicate id. Cast because `vscode` is typed by
  // `@types/vscode` here, while the value is the stub — `__reset` is a stub-only
  // affordance with no counterpart in the real API.
  (vscode.commands as unknown as { __reset(): void }).__reset();
  vi.restoreAllMocks();
});

describe('the extension entry point', () => {
  it('exports activate and deactivate as functions', () => {
    // The literal contract VS Code checks before it calls anything. If the build
    // ever changes the export shape, this fails here rather than as a toast.
    expect(typeof activate).toBe('function');
    expect(typeof deactivate).toBe('function');
  });

  it('activates and returns a usable API', () => {
    const api = activate(context) as AncestryExtensionApi;

    expect(api).toBeTruthy();
    expect(typeof api.version).toBe('string');
    expect(api.version.length).toBeGreaterThan(0);
    expect(typeof api.getLastGraphJson).toBe('function');
    // No analysis has run, so there is nothing to export yet. Returning null here
    // is correct; returning a string would mean it invented a graph.
    expect(api.getLastGraphJson()).toBeNull();
  });

  it('registers every command it contributes', () => {
    activate(context);

    const registered = vscode.commands
      .getCommands(true)
      .then((ids) => ids.filter((id) => id.startsWith('ancestry.')));

    // The registry is the source of truth; the manifest is cross-checked below.
    return registered.then((ids) => {
      for (const id of Object.values(COMMAND_IDS)) {
        expect(ids).toContain(id);
      }
    });
  });

  it('contributes a command id for every command it implements', () => {
    // The mismatch that produces a silently missing palette entry. `registry.ts`
    // exists to make this checkable without booting the extension.
    const manifestPath = path.resolve(__dirname, '..', '..', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      contributes?: { commands?: ReadonlyArray<{ command?: unknown }> };
    };

    expect(findUndeclaredCommands(manifest)).toEqual([]);
    expect(findUnimplementedCommands(manifest)).toEqual([]);
  });

  it('pushes its disposables onto the subscription list', () => {
    // VS Code disposes these on deactivate. A command registered but not
    // subscribed leaks a command registration for the rest of the session.
    activate(context);
    expect(context.subscriptions.length).toBeGreaterThan(0);
  });

  it('deactivates cleanly and is safe to call twice', () => {
    activate(context);
    expect(() => deactivate()).not.toThrow();
    // Idempotent: a second call must not throw on already-disposed state.
    expect(() => deactivate()).not.toThrow();
  });

  it('deactivates cleanly when activation never happened', () => {
    // Shutdown ordering is not guaranteed to match activation ordering.
    expect(() => deactivate()).not.toThrow();
  });

  it('survives an extension context with no extensionUri', () => {
    // Activation must not assume a fully-populated context; a degraded context
    // should cost a feature, not the whole command palette.
    const bare = { ...context, extensionUri: undefined } as unknown as vscode.ExtensionContext;
    expect(() => activate(bare)).not.toThrow();
  });
});
