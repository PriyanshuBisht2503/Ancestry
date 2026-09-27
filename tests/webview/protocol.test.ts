/**
 * The protocol validators are the XSS/DoS boundary in *both* directions, so
 * these tests are written adversarially: an extensive table of payloads that
 * must be rejected, plus explicit assertions that the rejections have no side
 * effects. A validator that "rejects" by throwing is not a validator — it is a
 * denial-of-service on the message channel, and `null` is the only acceptable
 * failure signal.
 */

import { describe, expect, it } from 'vitest';
import {
  isClientMessage,
  isHostMessage,
  validateClientMessage,
  validateFilter,
  validateGraph,
  validateGraphPayload,
  validateHostMessage,
  validateNode,
  validateEdge,
} from '../../src/webview/client/core/protocol';
import { SCHEMA_URI } from '../../src/types';
import { makeGraph, makeNode } from './fixtures';

function payload(): Record<string, unknown> {
  return {
    graph: makeGraph([makeNode('a')]),
    focusSource: 'function a() {}',
    engineVersion: '0.1.0',
    stats: { durationMs: 12, cacheHits: 1, cacheMisses: 2 },
  };
}

describe('validateHostMessage — valid variants', () => {
  const valid: Array<[string, unknown]> = [
    ['init', { type: 'init', payload: payload() }],
    ['graph', { type: 'graph', payload: payload() }],
    ['filter', { type: 'filter', payload: { branches: ['main'] } }],
    ['empty filter', { type: 'filter', payload: {} }],
    ['focus', { type: 'focus', payload: { nodeId: 'a' } }],
    ['highlight', { type: 'highlight', payload: { nodeIds: ['a', 'b'], reason: 'path' } }],
    ['clearHighlight', { type: 'clearHighlight' }],
    ['loading', { type: 'loading', payload: { message: 'Scanning', ratio: 0.4 } }],
    ['error', { type: 'error', payload: { message: 'boom', detail: 'stack' } }],
    ['error without detail', { type: 'error', payload: { message: 'boom' } }],
    ['status', { type: 'status', payload: { message: 'ready' } }],
  ];

  for (const [label, message] of valid) {
    it(`accepts ${label}`, () => {
      expect(validateHostMessage(message)).not.toBeNull();
      expect(isHostMessage(message)).toBe(true);
    });
  }

  it('rebuilds the graph so the caller cannot hold a live reference', () => {
    // `payload()` is already the payload, so the graph lives directly on it.
    const original = payload();
    const validated = validateHostMessage({ type: 'graph', payload: original }) as {
      payload: { graph: { nodes: Array<{ similarity: number }> } };
    };
    expect(validated.payload.graph.nodes).not.toBe(
      (original as { graph: { nodes: unknown } }).graph.nodes,
    );
    expect(validated.payload.graph.nodes[0]).not.toBe(
      (original as { graph: { nodes: unknown[] } }).graph.nodes[0],
    );
  });

  it('rejects a loading ratio outside [0, 1] rather than clamping it', () => {
    // The validators never return a *partially* trusted object, so a score
    // outside its documented range is a rejection, not a silently corrected
    // value. Clamping here would mean a buggy host's ratio of 7 became a
    // plausible-looking 100% with no signal that anything was wrong.
    expect(
      validateHostMessage({ type: 'loading', payload: { message: 'x', ratio: 5 } }),
    ).toBeNull();
    expect(
      validateHostMessage({ type: 'loading', payload: { message: 'x', ratio: -2 } }),
    ).toBeNull();
    expect(
      validateHostMessage({ type: 'loading', payload: { message: 'x', ratio: 1 } }),
    ).not.toBeNull();
  });
});

describe('validateClientMessage — valid variants', () => {
  const valid: Array<[string, unknown]> = [
    ['ready', { type: 'ready' }],
    ['selectNode', { type: 'selectNode', payload: { nodeId: 'a' } }],
    ['setFilter', { type: 'setFilter', payload: { minSimilarity: 0.5 } }],
    ['requestExport', { type: 'requestExport' }],
    ['requestDetails', { type: 'requestDetails', payload: { nodeId: 'a' } }],
    ['clientError', { type: 'clientError', payload: { message: 'kaboom' } }],
    ['viewport', { type: 'viewport', payload: { camera: [1, 2, 3] } }],
    ['viewport with floats', { type: 'viewport', payload: { camera: [-1.5, 0, 2.25] } }],
  ];

  for (const [label, message] of valid) {
    it(`accepts ${label}`, () => {
      expect(validateClientMessage(message)).not.toBeNull();
      expect(isClientMessage(message)).toBe(true);
    });
  }
});

describe('invalid payloads are rejected — host direction', () => {
  const invalid: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'init'],
    ['a number', 7],
    ['a boolean', true],
    ['an array', [{ type: 'init' }]],
    ['an empty object', {}],
    ['an unknown type', { type: 'exec', payload: {} }],
    ['a non-string type', { type: 42 }],
    ['init with no payload', { type: 'init' }],
    ['init with a null payload', { type: 'init', payload: null }],
    ['init with a payload that is not an object', { type: 'init', payload: 'graph' }],
    ['init with a payload whose graph is not an object', { type: 'init', payload: { graph: 5 } }],
    ['filter with a non-array branches', { type: 'filter', payload: { branches: 'main' } }],
    ['filter with a non-array edgeTypes', { type: 'filter', payload: { edgeTypes: 3 } }],
    ['focus with no nodeId', { type: 'focus', payload: {} }],
    ['focus with a numeric nodeId', { type: 'focus', payload: { nodeId: 7 } }],
    ['focus with a blank nodeId', { type: 'focus', payload: { nodeId: '' } }],
    ['highlight with a non-array nodeIds', { type: 'highlight', payload: { nodeIds: 'a' } }],
    ['loading with NaN ratio', { type: 'loading', payload: { message: 'x', ratio: Number.NaN } }],
    [
      'loading with an out-of-range ratio',
      { type: 'loading', payload: { message: 'x', ratio: 7 } },
    ],
    ['loading with a numeric message', { type: 'loading', payload: { message: 5, ratio: 0 } }],
    ['error with a non-string message', { type: 'error', payload: { message: {} } }],
    ['status with a missing message', { type: 'status', payload: {} }],
    [
      'a prototype-polluting payload',
      JSON.parse('{"type":"status","payload":{"message":"x"},"__proto__":{"polluted":true}}'),
    ],
    [
      'a payload with a constructor key',
      JSON.parse('{"type":"status","payload":{"message":"x","constructor":{"x":1}}}'),
    ],
    [
      'an object with a tampered prototype',
      Object.assign(Object.create({ inherited: 1 }), { type: 'status', payload: { message: 'x' } }),
    ],
  ];

  for (const [label, message] of invalid) {
    it(`rejects ${label}`, () => {
      expect(validateHostMessage(message)).toBeNull();
      expect(isHostMessage(message)).toBe(false);
    });
  }

  it('does not throw on any of them', () => {
    for (const [, message] of invalid) {
      expect(() => validateHostMessage(message)).not.toThrow();
    }
  });
});

/**
 * Oversized and unusable-but-recoverable values are **capped and coerced**,
 * not rejected.
 *
 * This is the counterpart to the table above, and it is the more interesting
 * half of the contract. `docs/specification.md` §8.4 requires the payload to be
 * "sanitised and capped", and a single 50 000-character warning must not be able
 * to take the panel down — so the validators truncate, substitute a safe
 * default, or drop a field, and return a message the caller can act on. What
 * they never do is return a value that still contains the hostile input.
 */
describe('oversized and unusable values are capped, not rejected — host direction', () => {
  it('caps a 100 000-element highlight set at the array cap', () => {
    const validated = validateHostMessage({
      type: 'highlight',
      payload: { nodeIds: new Array(100_000).fill('n'), reason: 'x' },
    }) as { payload: { nodeIds: string[] } };
    expect(validated).not.toBeNull();
    expect(validated.payload.nodeIds.length).toBeLessThanOrEqual(1_000);
  });

  it('caps an over-long status message at the string cap', () => {
    const validated = validateHostMessage({
      type: 'status',
      payload: { message: 'm'.repeat(50_000) },
    }) as { payload: { message: string } };
    expect(validated).not.toBeNull();
    expect(validated.payload.message.length).toBeLessThanOrEqual(8_192);
  });

  it('caps an over-long filter list at the array cap', () => {
    const validated = validateHostMessage({
      type: 'filter',
      payload: { branches: new Array(100_000).fill('main') },
    }) as { payload: { branches: string[] } };
    expect(validated).not.toBeNull();
    expect(validated.payload.branches.length).toBeLessThanOrEqual(1_000);
  });

  it('replaces a NaN run duration with 0 rather than letting it through', () => {
    const validated = validateGraphPayload({
      ...payload(),
      stats: { durationMs: Number.NaN, cacheHits: 1, cacheMisses: 2 },
    });
    expect(validated).not.toBeNull();
    expect(validated?.stats.durationMs).toBe(0);
    expect(Number.isFinite(validated?.stats.durationMs ?? Number.NaN)).toBe(true);
  });
});

describe('invalid payloads are rejected — client direction', () => {
  const invalid: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'ready'],
    ['an array', []],
    ['an unknown type', { type: 'navigate', payload: {} }],
    ['selectNode with no payload', { type: 'selectNode' }],
    ['selectNode with a missing nodeId', { type: 'selectNode', payload: {} }],
    ['setFilter with a scalar payload', { type: 'setFilter', payload: 1 }],
    ['clientError with a numeric message', { type: 'clientError', payload: { message: 9 } }],
    ['viewport with a two-element camera', { type: 'viewport', payload: { camera: [1, 2] } }],
    [
      'viewport with a four-element camera',
      { type: 'viewport', payload: { camera: [1, 2, 3, 4] } },
    ],
    ['viewport with a non-array camera', { type: 'viewport', payload: { camera: '1,2,3' } }],
    ['viewport with NaN components', { type: 'viewport', payload: { camera: [1, Number.NaN, 3] } }],
    ['a prototype-polluting payload', JSON.parse('{"type":"ready","__proto__":{"polluted":true}}')],
  ];

  for (const [label, message] of invalid) {
    it(`rejects ${label}`, () => {
      expect(validateClientMessage(message)).toBeNull();
      expect(isClientMessage(message)).toBe(false);
    });
  }
});

/**
 * Unknown fields are dropped, and oversized arrays are capped.
 *
 * `WebviewToHostMessage` is a closed union, so a key the type does not declare
 * is by definition not part of the message. The validators return a freshly
 * built object containing only the known fields, which means an unexpected
 * `payload` on `ready`, or an extra 100 000-element array bolted onto a
 * `selectNode`, is unreachable from the returned value — never copied, so it
 * cannot exhaust memory either. Rejecting the whole message instead would mean a
 * future field being *added* to a type silently broke every old sender.
 */
describe('unknown fields are dropped rather than rejected — client direction', () => {
  it('drops a payload a message type does not declare', () => {
    const validated = validateClientMessage({ type: 'ready', payload: { evil: true } });
    expect(validated).toEqual({ type: 'ready' });
    expect(Object.keys(validated as Record<string, unknown>)).toEqual(['type']);
  });

  it('never copies an oversized array attached as an unknown field', () => {
    const validated = validateClientMessage({
      type: 'selectNode',
      payload: { nodeId: 'a' },
      extra: new Array(100_000).fill('x'),
    });
    expect(validated).toEqual({ type: 'selectNode', payload: { nodeId: 'a' } });
  });

  it('caps a reachable oversized filter list at the array cap', () => {
    const validated = validateClientMessage({
      type: 'setFilter',
      payload: { branches: new Array(100_000).fill('main') },
    }) as { payload: { branches: string[] } };
    expect(validated).not.toBeNull();
    expect(validated.payload.branches.length).toBeLessThanOrEqual(1_000);
  });
});

describe('prototype pollution is impossible', () => {
  it('does not pollute Object.prototype from a JSON-parsed payload', () => {
    const hostile = JSON.parse(
      '{"type":"status","payload":{"message":"x"},"__proto__":{"polluted":"yes"}}',
    );
    expect(validateHostMessage(hostile)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not pollute from a nested __proto__', () => {
    const hostile = JSON.parse(
      '{"type":"graph","payload":{"graph":{"nodes":[{"id":"a","filePath":"a.ts","__proto__":{"polluted":true}}],"edges":[],"schema":"' +
        SCHEMA_URI +
        '"}}}',
    );
    validateHostMessage(hostile);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not pollute from a computed-key payload', () => {
    const hostile: Record<string, unknown> = { type: 'status', payload: { message: 'x' } };
    Object.defineProperty(hostile, '__proto__', {
      value: { polluted: true },
      enumerable: false,
    });
    expect(validateHostMessage(hostile)).toBeNull();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('adds no own properties to a global object as a side effect', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).length;
    validateHostMessage(JSON.parse('{"type":"status","payload":{"message":"x"},"__proto__":{}}'));
    validateClientMessage(JSON.parse('{"type":"ready","__proto__":{}}'));
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before);
  });
});

describe('getters are never invoked', () => {
  it('ignores an accessor property rather than calling it', () => {
    let called = false;
    const hostile: Record<string, unknown> = { type: 'status' };
    Object.defineProperty(hostile, 'payload', {
      get() {
        called = true;
        return { message: 'x' };
      },
      enumerable: true,
      configurable: true,
    });
    expect(validateHostMessage(hostile)).toBeNull();
    expect(called).toBe(false);
  });
});

describe('validateFilter', () => {
  it('accepts an empty filter and returns one', () => {
    expect(validateFilter({})).toEqual({});
  });

  it('coerces and de-duplicates array fields', () => {
    const filter = validateFilter({
      branches: ['main', 'main', 5, ''],
      files: ['src/a.ts'],
      authors: ['Ada'],
    })!;
    expect(filter.branches).toEqual(['main']);
    expect(filter.files).toEqual(['src/a.ts']);
    expect(filter.authors).toEqual(['Ada']);
  });

  it('drops out-of-range scores', () => {
    expect(validateFilter({ minSimilarity: 5 })?.minSimilarity).toBeUndefined();
    expect(validateFilter({ minSimilarity: Number.NaN })?.minSimilarity).toBeUndefined();
    expect(validateFilter({ minSimilarity: 0.5 })?.minSimilarity).toBe(0.5);
  });

  it('drops non-finite timestamps', () => {
    expect(validateFilter({ fromTimestamp: Number.NaN })?.fromTimestamp).toBeUndefined();
    expect(validateFilter({ toTimestamp: 10 })?.toTimestamp).toBe(10);
  });

  it('whitelists edge types', () => {
    expect(validateFilter({ edgeTypes: ['EVOLVED_FROM', 'NOPE'] })!.edgeTypes).toEqual([
      'EVOLVED_FROM',
    ]);
  });

  it('caps the search string', () => {
    expect(validateFilter({ search: 'x'.repeat(50_000) })!.search).toHaveLength(8192);
  });

  it('rejects non-objects and wrong-typed arrays', () => {
    expect(validateFilter(null)).toBeNull();
    expect(validateFilter('main')).toBeNull();
    expect(validateFilter({ branches: 'main' })).toBeNull();
  });
});

describe('validateNode / validateEdge / validateGraph', () => {
  it('accepts a valid node and fills in the defaults', () => {
    const node = validateNode({ id: 'a', filePath: 'a.ts' })!;
    expect(node.id).toBe('a');
    expect(node.classification).toBe('unrelated');
    expect(node.similarity).toBe(0);
    expect(node.branches).toEqual([]);
  });

  it('rejects a node with no id or no path', () => {
    expect(validateNode({ filePath: 'a.ts' })).toBeNull();
    expect(validateNode({ id: 'a' })).toBeNull();
    expect(validateNode({ id: '', filePath: 'a.ts' })).toBeNull();
  });

  it('rejects an edge with an unknown type or a missing endpoint', () => {
    const ids = new Set(['a', 'b']);
    expect(validateEdge({ from: 'a', to: 'b', type: 'NOPE' }, ids)).toBeNull();
    expect(validateEdge({ from: 'a', to: 'ghost', type: 'EVOLVED_FROM' }, ids)).toBeNull();
    expect(validateEdge({ from: 'a', to: 'b', type: 'EVOLVED_FROM' }, ids)).not.toBeNull();
  });

  it('reports truncation on an oversized graph', () => {
    const nodes = Array.from({ length: 25_000 }, (_, index) => makeNode(`n${index}`));
    const warnings: string[] = [];
    const result = validateGraph(makeGraph(nodes), { warnings });
    expect(result.graph.nodes).toHaveLength(20_000);
    expect(result.truncated).toBe(true);
    expect(result.droppedNodes).toBe(5_000);
    expect(warnings.join(' ')).toMatch(/truncated/i);
  });

  it('returns an empty graph for a non-object', () => {
    const result = validateGraph('nope');
    expect(result.graph.nodes).toEqual([]);
    expect(result.graph.schema).toBe(SCHEMA_URI);
  });

  it('validates a graph payload', () => {
    expect(validateGraphPayload(payload())).not.toBeNull();
    expect(validateGraphPayload({ graph: makeGraph() })).not.toBeNull();
    expect(validateGraphPayload({ graph: 5 })).toBeNull();
  });

  it('caps the focus source in a payload', () => {
    const validated = validateGraphPayload({ ...payload(), focusSource: 'z'.repeat(400_000) })!;
    expect(validated.focusSource.length).toBe(200_000);
  });
});
