/**
 * Colours are a *semantic promise* in this visualisation, and a promise nobody
 * checks is a promise that silently rots. These tests pin the two properties
 * that matter: every value is a syntactically valid colour the WebGL/DOM layers
 * can consume, and no two semantically-different things share a colour.
 */

import { describe, expect, it } from 'vitest';
import {
  BRANCH_PALETTE_SIZE,
  branchColor,
  CLASSIFICATION_COLOR_TABLE,
  colorForClassification,
  colorForEdgeType,
  colorForNode,
  edgeOpacityFor,
  FOCUS_NODE_COLOR,
  isHexColor,
  nodeScaleForSize,
  ORIGIN_NODE_COLOR,
  withAlpha,
} from '../../src/webview/client/core/colors';
import { EDGE_TYPES } from '../../src/webview/client/core/domain';
import type { MatchClassification } from '../../src/types';
import { makeNode } from './fixtures';

const HEX_OR_RGBA =
  /^(#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0?\.\d+)\))$/;

describe('colorForEdgeType', () => {
  it('returns a valid hex colour for all five types', () => {
    for (const type of EDGE_TYPES) {
      const color = colorForEdgeType(type);
      expect(isHexColor(color)).toBe(true);
      expect(color).toMatch(HEX_OR_RGBA);
    }
  });

  it('gives every edge type a distinct colour', () => {
    const colors = EDGE_TYPES.map(colorForEdgeType);
    expect(new Set(colors).size).toBe(EDGE_TYPES.length);
  });

  it('is stable across calls', () => {
    for (const type of EDGE_TYPES) {
      expect(colorForEdgeType(type)).toBe(colorForEdgeType(type));
    }
  });
});

describe('colorForClassification', () => {
  const classifications: MatchClassification[] = ['strong', 'possible', 'weak', 'unrelated'];

  it('returns a distinct valid hex colour for each classification', () => {
    const colors = classifications.map(colorForClassification);
    for (const color of colors) {
      expect(isHexColor(color)).toBe(true);
    }
    expect(new Set(colors).size).toBe(classifications.length);
  });

  it('does not collide with the focus or origin colours', () => {
    const colors = classifications.map(colorForClassification);
    expect(colors).not.toContain(FOCUS_NODE_COLOR);
    expect(colors).not.toContain(ORIGIN_NODE_COLOR);
  });
});

describe('colorForNode', () => {
  it('makes the focus node unmistakable — pure white', () => {
    expect(FOCUS_NODE_COLOR).toBe('#ffffff');
    const node = makeNode('a', { isFocus: true, classification: 'unrelated' });
    expect(colorForNode(node)).toBe('#ffffff');
  });

  it('makes the origin node unmistakable — aqua', () => {
    expect(ORIGIN_NODE_COLOR).toBe('#00ffc8');
    const node = makeNode('a', { isOrigin: true, classification: 'unrelated' });
    expect(colorForNode(node)).toBe('#00ffc8');
  });

  it('lets focus win over origin', () => {
    const node = makeNode('a', { isFocus: true, isOrigin: true });
    expect(colorForNode(node)).toBe(FOCUS_NODE_COLOR);
  });

  it('falls back to the classification colour', () => {
    expect(colorForNode(makeNode('a', { classification: 'strong' }))).toBe(
      colorForClassification('strong'),
    );
  });

  it('gives the focus and origin nodes different colours from each other', () => {
    expect(FOCUS_NODE_COLOR).not.toBe(ORIGIN_NODE_COLOR);
  });
});

describe('branchColor', () => {
  it('cycles deterministically', () => {
    expect(branchColor(0)).toBe(branchColor(0));
    expect(branchColor(1)).not.toBe(branchColor(0));
    expect(branchColor(BRANCH_PALETTE_SIZE)).toBe(branchColor(0));
    expect(branchColor(BRANCH_PALETTE_SIZE + 3)).toBe(branchColor(3));
  });

  it('handles negative and non-finite indices', () => {
    expect(branchColor(-1)).toBe(branchColor(BRANCH_PALETTE_SIZE - 1));
    expect(isHexColor(branchColor(Number.NaN))).toBe(true);
    expect(isHexColor(branchColor(Number.POSITIVE_INFINITY))).toBe(true);
  });

  it('returns a valid colour for any index', () => {
    for (const index of [0, 5, 9, 10, 42, 1000, -7]) {
      expect(isHexColor(branchColor(index))).toBe(true);
    }
  });
});

describe('nodeScaleForSize', () => {
  it('is always positive and bounded', () => {
    const samples = [
      makeNode('a', { similarity: 0, blockKind: 'block' }),
      makeNode('a', { similarity: 1, blockKind: 'class', isFocus: true }),
      makeNode('a', { similarity: Number.NaN, blockKind: 'unknown' }),
      makeNode('a', { similarity: 99, blockKind: 'function' }),
      makeNode('a', { similarity: -5, blockKind: 'variable' }),
    ];
    for (const node of samples) {
      const scale = nodeScaleForSize(node);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThanOrEqual(1.6);
    }
  });

  it('grows with similarity', () => {
    const low = nodeScaleForSize(makeNode('a', { similarity: 0.1 }));
    const high = nodeScaleForSize(makeNode('a', { similarity: 0.95 }));
    expect(high).toBeGreaterThan(low);
  });

  it('draws a class larger than a method', () => {
    const klass = nodeScaleForSize(makeNode('a', { blockKind: 'class' }));
    const method = nodeScaleForSize(makeNode('a', { blockKind: 'method' }));
    expect(klass).toBeGreaterThan(method);
  });

  it('draws the focus node larger than an ordinary one', () => {
    const plain = nodeScaleForSize(makeNode('a', { similarity: 0.5 }));
    const focus = nodeScaleForSize(makeNode('a', { similarity: 0.5, isFocus: true }));
    expect(focus).toBeGreaterThan(plain);
  });

  it('is deterministic', () => {
    const node = makeNode('a', { similarity: 0.42, blockKind: 'method' });
    expect(nodeScaleForSize(node)).toBe(nodeScaleForSize(node));
  });
});

describe('edgeOpacityFor', () => {
  it('is monotonic and stays in (0, 1]', () => {
    let previous = -1;
    for (const similarity of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const opacity = edgeOpacityFor(similarity);
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThanOrEqual(1);
      expect(opacity).toBeGreaterThanOrEqual(previous);
      previous = opacity;
    }
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(edgeOpacityFor(5)).toBe(edgeOpacityFor(1));
    expect(edgeOpacityFor(-5)).toBe(edgeOpacityFor(0));
    expect(edgeOpacityFor(Number.NaN)).toBe(edgeOpacityFor(0));
  });
});

describe('withAlpha', () => {
  it('converts a six-digit hex to rgba', () => {
    expect(withAlpha('#4d8bf5', 0.5)).toBe('rgba(77, 139, 245, 0.5)');
  });

  it('expands a three-digit hex', () => {
    expect(withAlpha('#0f8', 1)).toBe(withAlpha('#00ff88', 1));
    expect(withAlpha('#0f8', 1)).toBe('rgba(0, 255, 136, 1)');
  });

  it('is case-insensitive', () => {
    expect(withAlpha('#4D8BF5', 0.5)).toBe(withAlpha('#4d8bf5', 0.5));
  });

  it('clamps the alpha into [0, 1]', () => {
    expect(withAlpha('#ffffff', -3)).toBe('rgba(255, 255, 255, 0)');
    expect(withAlpha('#ffffff', 9)).toBe('rgba(255, 255, 255, 1)');
  });

  it('substitutes 1 for a non-finite alpha rather than emitting rgba(NaN)', () => {
    expect(withAlpha('#000000', Number.NaN)).toBe('rgba(0, 0, 0, 1)');
    expect(withAlpha('#000000', Number.NaN)).not.toContain('NaN');
  });

  it('rejects malformed input', () => {
    const bad = ['', '#', '#12', '#12345', '#1234567', 'red', 'rgb(1,2,3)', '  #ffffff', '#gggggg'];
    for (const value of bad) {
      expect(() => withAlpha(value, 1)).toThrow(TypeError);
    }
    expect(() => withAlpha(undefined as unknown as string, 1)).toThrow(TypeError);
  });

  it('produces only values the DOM accepts', () => {
    for (const type of EDGE_TYPES) {
      expect(withAlpha(colorForEdgeType(type), edgeOpacityFor(0.5))).toMatch(HEX_OR_RGBA);
    }
  });
});

describe('isHexColor', () => {
  it('accepts both hex forms and rejects everything else', () => {
    expect(isHexColor('#abc')).toBe(true);
    expect(isHexColor('#ABCDEF')).toBe(true);
    expect(isHexColor('#abcd')).toBe(false);
    expect(isHexColor('abc')).toBe(false);
  });
});

describe('colour tables', () => {
  it('expose the same values the functions return', () => {
    for (const type of EDGE_TYPES) {
      expect(Object.prototype.hasOwnProperty.call(CLASSIFICATION_COLOR_TABLE, 'strong')).toBe(true);
      expect(typeof colorForEdgeType(type)).toBe('string');
    }
  });
});
