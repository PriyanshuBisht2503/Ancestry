/**
 * The top-level React component: it owns the graph, the filter, the selection,
 * the loading state and the error, and it is the only thing that talks to the
 * host bridge.
 *
 * STATE OWNERSHIP
 * ---------------
 * One `useReducer` over the pure reducer in `components/graphState.ts`. Not
 * three `useState` calls, and not a `useRef` full of mutable fields as the
 * pre-React `main.ts` had: the whole point of the reducer is that the mapping
 * from "a validated host message" to "what the panel shows" is a *pure
 * function*, which is what makes it testable without a browser and what stops a
 * component from ever reading a value that is one render stale.
 *
 * The bridge pushes messages in through `useAncestryHost(...)`, whose callback
 * is a stable `useCallback` that dispatches. No global event emitter, no
 * `document.dispatchEvent`, and nothing reaches down into a component: a
 * component only ever sees props.
 *
 * OUTBOUND TRAFFIC
 * ----------------
 * The reducer is pure, so it cannot post. The three outbound messages the UI
 * produces — `selectNode`, `setFilter`, `requestExport` — are posted from the
 * handlers below, each through `postToHost`, which runs `validateClientMessage`
 * on the way out. The UI therefore cannot construct a message the host would
 * reject, and the host still re-validates it.
 *
 * SECURITY POSTURE
 * ----------------
 * This file is where the migration's security story lives. React's inner-HTML
 * escape hatch is used nowhere in `src/webview/client/**` (a test asserts it
 * never will be), so every value that crosses the `postMessage` boundary —
 * commit metadata, author names, file paths, block signatures, warnings, the
 * origin disclaimer — is rendered as an escaped React child. There is no
 * dynamic code construction, no network call, and no remote origin anywhere in
 * the bundle.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { AncestryGraph, HostToWebviewMessage, WebviewFilter } from '../../types';
import { nodeById } from './core/graph-stats';
import { postToHost, useAncestryHost } from './host-bridge';
import { DetailPanel } from './components/DetailPanel';
import { ErrorToast, toastPropsFrom } from './components/ErrorToast';
import { FilterBar } from './components/FilterBar';
import { GraphCanvas } from './components/GraphCanvas';
import { Header } from './components/Header';
import { Legend } from './components/Legend';
import { LoadingOverlay } from './components/LoadingOverlay';
import { NodeList } from './components/NodeList';
import { StatusBar } from './components/StatusBar';
import { TimelineAxis } from './components/TimelineAxis';
import {
  ancestryReducer,
  createInitialUiState,
  defaultStatus,
  nodeHint,
  timestampRange,
  useAncestryPath,
  useAvailableFilterOptions,
  useGraphFilter,
  useLayout,
  useVisibleNodes,
} from './components/graphState';

/**
 * The whole panel.
 *
 * Rendered by `main.tsx` with `createRoot`. Contains no data fetching and no
 * Three.js: the 3D scene is entirely inside `GraphCanvas`, which is driven from
 * props, and everything else is a plain presentational component.
 */
export function App(): JSX.Element {
  const [state, dispatch] = useReducer(ancestryReducer, undefined, createInitialUiState);
  const { graph, filter, selectedId, highlightIds, view } = state;

  // --- derived data --------------------------------------------------------
  // All of it is `useMemo` over the `core/` functions, so a filter keystroke
  // re-runs `applyFilter` once and nothing else.
  const layout = useLayout(graph);
  const result = useGraphFilter(graph, filter);
  const options = useAvailableFilterOptions(graph);
  const visibleNodes = useVisibleNodes(graph, result?.visibleNodeIds ?? null);
  const path = useAncestryPath(graph, selectedId);
  const range = useMemo(() => timestampRange(graph), [graph]);
  const selectedNode = useMemo(
    () => (graph === null || selectedId === null ? null : nodeById(graph, selectedId)),
    [graph, selectedId],
  );

  // --- inbound host messages ----------------------------------------------
  // A stable callback: `useAncestryHost` subscribes exactly once, so a changing
  // identity here must not re-subscribe the message listener (which would drop
  // a `ready` handshake and leave the panel permanently blank).
  const onHostMessage = useCallback((message: HostToWebviewMessage): void => {
    dispatch({ type: 'host', message });
  }, []);
  useAncestryHost(onHostMessage);

  // --- outbound ------------------------------------------------------------
  const handleSelect = useCallback(
    (nodeId: string | null): void => {
      if (nodeId === null) {
        dispatch({ type: 'select', nodeId: null });
        return;
      }
      // Never report a selection the retained graph does not contain: the host
      // resolves ids against its own copy and logs a warning for a miss, so a
      // stale id from a previous graph would be a warning, not a selection.
      if (graph === null || nodeById(graph, nodeId) === null) {
        return;
      }
      postToHost({ type: 'selectNode', payload: { nodeId } });
      dispatch({ type: 'select', nodeId });
    },
    [graph],
  );

  const handleFilter = useCallback((next: WebviewFilter): void => {
    postToHost({ type: 'setFilter', payload: next });
    dispatch({ type: 'filter', filter: next });
  }, []);

  const handleExport = useCallback((): void => {
    postToHost({ type: 'requestExport' });
  }, []);

  const handleDismiss = useCallback((): void => {
    dispatch({ type: 'dismissError' });
  }, []);

  // --- hover hints ---------------------------------------------------------
  const onHover = useCallback(
    (nodeId: string | null): void => {
      dispatch({
        type: 'status',
        message: nodeHint(
          nodeId === null || graph === null ? null : nodeById(graph, nodeId),
          defaultStatus(graph),
        ),
      });
    },
    [graph],
  );

  // --- keyboard ------------------------------------------------------------
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A text field owns its own keys: `/` must type a slash into the search
      // box rather than stealing focus, and `f` must not reframe the view while
      // someone is typing a file name. Escape still blurs, which is the one
      // exception — it is how you get out of a field.
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        if (event.key === 'Escape' && target instanceof HTMLElement) {
          target.blur();
        }
        return;
      }
      switch (event.key) {
        case 'f':
          dispatch({ type: 'fit' });
          break;
        case '/':
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case 'Escape':
          dispatch({ type: 'select', nodeId: null });
          break;
        case '1':
          dispatch({ type: 'toggleLabels' });
          break;
        case '2':
          dispatch({ type: 'toggleEdges' });
          break;
        default:
          break;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // --- status line ---------------------------------------------------------
  const statusMessage = useMemo(() => {
    if (state.statusMessage.length > 0) {
      return state.statusMessage;
    }
    if (selectedId !== null && result !== null && !result.visibleNodeIds.has(selectedId)) {
      // The detail panel keeps showing the node — silently dropping the user's
      // context would be worse than saying so.
      return 'The selected version is hidden by the current filter';
    }
    return defaultStatus(graph);
  }, [state.statusMessage, selectedId, result, graph]);

  const toast = toastPropsFrom(state.error, handleDismiss);

  return (
    <>
      <Header graph={graph} focusSource={state.focusSource} runStats={state.runStats} />
      <Legend />
      <FilterBar
        options={options}
        filter={filter}
        result={result}
        searchRef={searchRef}
        onChange={handleFilter}
        onExport={handleExport}
      />
      <GraphCanvas
        graph={graph}
        nodes={layout?.nodes ?? []}
        axis={layout?.axis ?? null}
        visibleNodeIds={result?.visibleNodeIds ?? null}
        visibleEdgeIds={result?.visibleEdgeIds ?? null}
        selectedId={selectedId}
        highlightIds={highlightIds}
        labelsEnabled={view.labels}
        edgesEnabled={view.edges}
        fitToken={state.fitToken}
        focusRequest={state.focusRequest}
        ariaLabel={sceneLabel(graph)}
        onSelect={handleSelect}
        onHover={onHover}
      >
        <TimelineAxis axis={layout?.axis ?? null} nodes={layout?.nodes ?? []} range={range} />
        {state.loading === null ? null : (
          <LoadingOverlay message={state.loading.message} ratio={state.loading.ratio} />
        )}
      </GraphCanvas>
      <DetailPanel
        graph={graph}
        node={selectedNode}
        focusSource={state.focusSource}
        path={path}
        onSelect={handleSelect}
      />
      <NodeList nodes={visibleNodes} selectedId={selectedId} onSelect={handleSelect} />
      <StatusBar message={statusMessage} />
      {toast === null ? null : <ErrorToast {...toast} />}
    </>
  );
}

/**
 * The accessible name for the 3D canvas.
 *
 * Says what the picture *is* and how big it is, then points at the version list
 * — because a canvas is opaque to a screen reader and the only honest way to
 * describe it is to point at the thing that carries the same data in text.
 */
export function sceneLabel(graph: AncestryGraph | null): string {
  if (graph === null) {
    return 'Code ancestry graph, waiting for an analysis';
  }
  const parts: string[] = [
    'Code ancestry graph',
    `${graph.stats.nodeCount} version(s)`,
    `${graph.stats.fileCount} file(s)`,
  ];
  if (graph.stats.truncated) {
    parts.push('history is partial');
  }
  parts.push('use the version list for a keyboard-navigable view');
  return parts.join(', ');
}
