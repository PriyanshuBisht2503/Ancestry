/**
 * The webview entry point. The only module with side effects at import time.
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *  1. installs two global error forwarders, so a throw inside a Three.js
 *     animation frame (or an unhandled promise rejection) reaches the extension's
 *     output channel instead of dying silently in the webview's devtools;
 *  2. finds the mount container that `html.ts` put in the document;
 *  3. `createRoot(...).render(<App />)`.
 *
 * The static DOM shell in `html.ts` is not the UI any more — React replaces it
 * on the first commit. The shell survives for two reasons: it is the mount point
 * (its grid layout is what `<App/>`'s children inherit, since the container
 * itself carries the `display: grid`), and its `<noscript>` block is the only
 * thing a user with JavaScript disabled ever sees. React clears the container's
 * children on mount, which is exactly right: the noscript content is inert once
 * the script has run.
 *
 * FAILURE POSTURE
 * ---------------
 * A webview that throws during bootstrap shows the user a blank panel and logs
 * nothing useful. So the whole bootstrap is wrapped and a failure renders a
 * visible message into the document instead — built with `createElement` +
 * `textContent`, never markup, because by definition this path has already
 * proved the module graph is broken and a React render is not available.
 *
 * SECURITY
 * --------
 * Nothing here builds DOM from strings or writes unescaped markup, and no
 * inbound message reaches a component without passing `validateHostMessage`
 * inside `host-bridge.ts`. No dynamic code construction, no network call, no
 * remote resources — the stylesheet is a single local file emitted by Vite.
 */

import { createRoot } from 'react-dom/client';
import type { WebviewToHostMessage } from '../../types';
import { App } from './App';
import { postToHost } from './host-bridge';
import '../webview.css';

/** The id of the container `html.ts` writes into the document. */
const MOUNT_ID = 'ancestry-root';

/**
 * Renders the panel into `container`.
 *
 * Exported so a test (or a future "remount the panel" path) can run the exact
 * entry the bundle runs, rather than a divergent copy of it.
 */
export function mount(container: Element): void {
  createRoot(container).render(<App />);
}

/**
 * Boots the webview.
 *
 * Returns the container it mounted into, or `null` when the bootstrap failed —
 * in which case a visible failure has already been rendered and a `clientError`
 * has been posted to the host.
 */
export function main(): Element | null {
  try {
    installErrorForwarders();
    const container = resolveContainer();
    mount(container);
    return container;
  } catch (error) {
    reportFatal(error);
    return null;
  }
}

/** The mount container, falling back to `<body>` if the id is missing. */
function resolveContainer(): Element {
  return document.getElementById(MOUNT_ID) ?? document.body;
}

/**
 * Forwards uncaught errors to the extension's output channel.
 *
 * A Three.js render loop lives in a `requestAnimationFrame` callback, so a throw
 * there never reaches a React error boundary — it would kill the frame loop and
 * leave a frozen picture with an empty console. These two listeners are the only
 * way that failure can reach the user.
 */
function installErrorForwarders(): void {
  globalThis.addEventListener('error', (event: ErrorEvent) => {
    postClientError(`window error: ${event.message}`);
  });
  globalThis.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    const detail = reason instanceof Error ? reason.message : String(reason);
    postClientError(`unhandled rejection: ${detail}`);
  });
}

/** Posts a `clientError` without letting the reporting path itself throw. */
function postClientError(message: string): void {
  try {
    postToHost({ type: 'clientError', payload: { message } } satisfies WebviewToHostMessage);
  } catch {
    // The channel itself is broken; the console is all that is left.
    console.error('[ancestry] unrecoverable webview error', message);
  }
}

/**
 * Renders a visible "Ancestry failed to start" banner.
 *
 * Uses DOM APIs and `textContent` on purpose: this path runs *because*
 * something in the module graph threw, and assuming React is usable here would
 * be assuming the thing that just failed.
 */
function reportFatal(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  try {
    const banner = document.createElement('div');
    banner.className = 'toast';
    banner.setAttribute('role', 'alert');
    const title = document.createElement('p');
    title.className = 'toast-message';
    title.textContent = 'Ancestry failed to start';
    const detail = document.createElement('p');
    detail.className = 'toast-detail';
    detail.textContent = message;
    banner.append(title, detail);
    (document.getElementById(MOUNT_ID) ?? document.body).append(banner);
  } catch {
    // Nothing left to do: the host notification below is the final channel.
  }
  postClientError(`bootstrap failed: ${message}`);
}

/**
 * Runs the bootstrap once the document can be queried.
 *
 * The bundle is loaded by a `<script>` at the end of `<body>`, so in practice
 * `readyState` is already `interactive` and this runs synchronously. The
 * `loading` branch exists for a document that is still parsing — rendering into
 * a half-parsed body would mount into the wrong node.
 */
function start(): void {
  if (typeof document === 'undefined') {
    return;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      main();
    }, { once: true });
    return;
  }
  main();
}

start();
