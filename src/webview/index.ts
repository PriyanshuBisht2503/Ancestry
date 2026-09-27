/**
 * Public surface of the Ancestry webview module (extension-host side).
 *
 * `extension.ts` should import from here and never reach into `client/`, whose
 * modules run in the browser sandbox and are bundled separately.
 *
 * The pure validators are re-exported from `client/core` on purpose: the host
 * runs the *same* runtime validators on inbound webview messages that the
 * webview runs on inbound host messages, and a single implementation is the only
 * way to guarantee the two directions cannot drift apart.
 */

export {
  AncestryWebviewManager,
  AncestryWebviewPanel,
  WEBVIEW_VIEW_TYPE,
  describe,
  getNonce,
  isAncestryWebviewPanel,
} from './host';
export type {
  AncestryWebviewHandle,
  AncestryWebviewManagerOptions,
  AncestryWebviewPanelOptions,
} from './host';

export {
  BASE_CSP_DIRECTIVES,
  buildBootstrapScript,
  buildContentSecurityPolicy,
  buildWebviewCss,
  buildWebviewHtml,
  escapeHtml,
} from './html';
export type { BuildWebviewHtmlOptions } from './html';

export { graphToJson, parseGraphJson, sanitizeGraph, toWebviewPayload } from './serialize';
export type { RunStats } from './serialize';

export {
  isClientMessage,
  isHostMessage,
  validateClientMessage,
  validateFilter,
  validateGraph,
  validateGraphPayload,
  validateHostMessage,
  validateNode,
  validateEdge,
} from './client/core/protocol';
export { MAX_EDGES, MAX_NODES } from './client/core/domain';

export {
  ancestryPath,
  clusterByFile,
  descendants,
  groupByAuthor,
  nodeById,
  relatedNodes,
  summarizeGraph,
} from './client/core/graph-stats';

export type { AncestryGraph, WebviewFilter, WebviewGraphPayload } from '../types';
