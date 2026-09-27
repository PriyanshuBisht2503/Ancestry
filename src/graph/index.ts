/**
 * Public surface of the ancestry graph module.
 *
 * Everything the analysis orchestrator, the cache layer and the webview need is
 * re-exported here, so nothing outside `src/graph` has to know the file layout.
 * The graph schema identifier is exposed as {@link GRAPH_SCHEMA} because the
 * webview validates payloads against it.
 */

import { SCHEMA_URI } from '../types';

export * from './inputs';
export * from './edge-inference';
export * from './origin';
export * from './builder';

/** Schema identifier of a serialised graph: `ancestry://graph/v1` (specification §6). */
export const GRAPH_SCHEMA: string = SCHEMA_URI;
