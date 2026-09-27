/**
 * The webview's side of the `postMessage` channel.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE: `window.addEventListener('message')` is the
 * single untrusted input in the entire webview, and it is the one place where
 * the classic "trust the message because it came from the host" mistake would be
 * fatal. Everything that arrives is an `unknown`, is run through
 * `validateHostMessage` (the *same* validator the host uses on our outbound
 * traffic), and is discarded silently if it does not check out.
 *
 * The module is also the reason the `HostApi` seam exists: `main.tsx` and the
 * tests can hand it a stub, so the message plumbing is exercised without a
 * browser. There is no `any` anywhere in it — the API is a narrow interface and
 * every inbound value starts life as `unknown`.
 *
 * REACT
 * -----
 * {@link useAncestryHost} is the React-shaped door into this module. It is a thin
 * wrapper, not a second implementation: everything still goes through
 * `subscribeToHost` (hence `validateHostMessage`) and `postToHost` (hence the
 * outbound check), so a component can neither skip validation nor reach the
 * `window` object directly.
 */

import { useEffect, useRef } from 'react';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../types';
import { validateHostMessage } from './core/protocol';

/**
 * The `acquireVsCodeApi()` surface the webview may use. Deliberately minimal:
 * `postMessage` is the only capability, and there is no `setState` here because
 * a state round-trip would mean serialising the graph into the workbench's
 * webview state, which persists across reloads and would leak source text.
 */
export interface HostApi {
  postMessage(message: unknown): void;
}

/** The window-level surface the bridge touches, so it can be stubbed in tests. */
export interface HostBridgeWindow {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** Resolves the API captured by the inline bootstrap in `html.ts`. */
function resolveApi(): HostApi | null {
  const candidate = (globalThis as { __ancestryVsCodeApi?: unknown }).__ancestryVsCodeApi;
  if (candidate === null || typeof candidate !== 'object') {
    return null;
  }
  const post = (candidate as { postMessage?: unknown }).postMessage;
  if (typeof post !== 'function') {
    return null;
  }
  return {
    postMessage: (message: unknown) => (post as (m: unknown) => void).call(candidate, message),
  };
}

/**
 * Sends a message to the extension host.
 *
 * Validates outbound messages too, for the same reason the host does: a
 * malformed message would be dropped on arrival, and the resulting silence is
 * far harder to debug than a warning here. Returns `false` when the message was
 * rejected or no API is available, so the caller can surface a visible failure
 * rather than pretending it worked.
 */
export function postToHost(message: WebviewToHostMessage): boolean {
  // The outbound direction has the same closed set of shapes as the inbound one;
  // validating here keeps a typo in a keyboard shortcut from becoming silence.
  if (!isOutgoingMessage(message)) {
    return false;
  }
  const api = resolveApi();
  if (api === null) {
    return false;
  }
  try {
    api.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * Subscribes to validated host messages. Returns an unsubscribe function.
 *
 * The `event.data` is *not* trusted: `validateHostMessage` re-checks the type
 * discriminant, the payload shape and every nested field, and returns a freshly
 * built object. A message that fails is dropped without a `throw`, because a
 * `throw` inside a DOM event listener would surface as an opaque console error
 * and take the rest of the listener chain with it.
 */
export function subscribeToHost(
  handler: (message: HostToWebviewMessage) => void,
  target: HostBridgeWindow = globalThis as unknown as HostBridgeWindow,
): () => void {
  const listener = (event: MessageEvent): void => {
    const validated = validateHostMessage(event?.data);
    if (validated === null) {
      return;
    }
    try {
      handler(validated);
    } catch (error) {
      reportLocalError(error);
    }
  };
  target.addEventListener('message', listener);
  return () => {
    target.removeEventListener('message', listener);
  };
}

/**
 * The React hook: subscribes to validated host messages for the lifetime of the
 * component and announces readiness once.
 *
 * Two details are load-bearing:
 *
 *  1. The handler is kept in a ref and the subscription effect has `[]`
 *     dependencies, so a caller that passes an inline arrow function does not
 *     re-subscribe on every render. Re-subscribing is not merely wasteful: the
 *     `ready` handshake below would fire repeatedly, and the host treats the
 *     first `ready` as the point at which it starts flushing its buffered graph
 *     — so a re-subscribe storm would turn into a message storm.
 *
 *  2. `ready` is posted from the same effect, after the listener is attached.
 *     The reverse order is a real race: the host's buffered `graph` message can
 *     arrive before the listener exists and would be dropped, leaving the panel
 *     permanently blank.
 *
 * Nothing here bypasses `subscribeToHost`, so every inbound payload has been
 * through `validateHostMessage` before the callback sees it.
 */
export function useAncestryHost(
  onMessage: (message: HostToWebviewMessage) => void,
  target: HostBridgeWindow = globalThis as unknown as HostBridgeWindow,
): void {
  const handlerRef = useRef(onMessage);
  const targetRef = useRef(target);

  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    const off = subscribeToHost((message) => {
      handlerRef.current(message);
    }, targetRef.current);
    postToHost({ type: 'ready' });
    return off;
  }, []);
}

/** A minimal structural check for the outbound direction. */
function isOutgoingMessage(value: unknown): value is WebviewToHostMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === 'ready' ||
    type === 'selectNode' ||
    type === 'setFilter' ||
    type === 'requestExport' ||
    type === 'requestDetails' ||
    type === 'clientError' ||
    type === 'viewport'
  );
}

/** Surfaces a local failure to the host without letting it escape the listener. */
function reportLocalError(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  try {
    postToHost({ type: 'clientError', payload: { message } });
  } catch {
    // The channel itself is broken; the console is all that is left.
    console.error('[ancestry] unrecoverable webview error', error);
  }
}
