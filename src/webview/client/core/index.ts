/**
 * Barrel for the webview's pure core.
 *
 * Everything re-exported here is free of Three.js and of DOM access, which is
 * what makes `tests/webview` able to exercise it in a plain Node process. The
 * host process (`src/webview/host.ts`, `serialize.ts`) also imports this barrel
 * so the *same* validators run on both sides of the message boundary.
 */

export * from './colors';
export * from './domain';
export * from './filter';
export * from './graph-stats';
export * from './layout';
export * from './protocol';
export * from './timeline';
