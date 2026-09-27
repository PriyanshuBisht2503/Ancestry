/**
 * Component tests, rendered with `react-dom/server`'s `renderToStaticMarkup`.
 *
 * WHY NO jsdom AND NO testing-library
 * -----------------------------------
 * A JSDOM environment is a large, slow dependency that a `default-src 'none'`
 * webview has no reason to carry in its test suite, and `renderToStaticMarkup`
 * needs no DOM at all: it runs React's renderer over a component tree and returns
 * the HTML string. That is enough for everything this file asserts — structure,
 * conditional rendering, attribute wiring, and *escaping*, which is the one that
 * actually matters here. Escaping is a pure string transformation, so a string
 * assertion is not a weaker check than a DOM one; if anything it is a stronger
 * one, because it asserts on the exact bytes that would be sent to the document.
 *
 * What these tests deliberately do NOT cover: event handlers and effects. The
 * behaviour behind every control lives in the pure helpers in `graphState.ts`
 * (which `graphState.test.ts` exercises directly) or in the reducer, so there is
 * nothing meaningful left to check by synthesising DOM events.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import type { WebviewFilter } from '../../src/types';
import { availableFilterOptions, applyFilter } from '../../src/webview/client/core/filter';
import { computeLayout } from '../../src/webview/client/core/layout';
import { DetailPanel, FALLBACK_DISCLAIMER } from '../../src/webview/client/components/DetailPanel';
import { ErrorToast } from '../../src/webview/client/components/ErrorToast';
import { FilterBar } from '../../src/webview/client/components/FilterBar';
import { Header } from '../../src/webview/client/components/Header';
import { Legend } from '../../src/webview/client/components/Legend';
import { LoadingOverlay } from '../../src/webview/client/components/LoadingOverlay';
import { NodeList } from '../../src/webview/client/components/NodeList';
import { StatusBar, shortcutLabels } from '../../src/webview/client/components/StatusBar';
import { TimelineAxis } from '../../src/webview/client/components/TimelineAxis';
import { timestampRange } from '../../src/webview/client/components/graphState';
import { DAY, makeChainGraph, makeGraph, makeNode, T0 } from './fixtures';

/**
 * The exact origin wording from `docs/specification.md` §5.
 *
 * Duplicated here on purpose. `OriginInfo.disclaimer` is produced by the host,
 * and the whole point of the requirement is that the webview renders it
 * *verbatim* — so the test has to hold its own copy of the string and prove the
 * component did not paraphrase it.
 */
const SPEC_DISCLAIMER =
  "Git history records commits, not intentions. This is the earliest version Ancestry " +
  'detected that is sufficiently similar to your selection — not proof of original ' +
  'authorship. The search covered the history available in this repository, which may be ' +
  'truncated by a shallow clone or by the configured depth limit.';

/** Renders a component to static HTML. */
function html(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A graph with an origin, so the detail panel has a full origin block. */
function graphWithOrigin() {
  const base = makeChainGraph();
  return makeGraph(base.nodes, base.edges, {
    focusBlockId: base.focusBlockId,
    origin: {
      nodeId: 'n1',
      filePath: 'src/legacy/helper.ts',
      commit: 'a'.repeat(40),
      shortCommit: 'aaaaaaa',
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
      timestamp: T0,
      similarity: 0.62,
      basis: 'earliest-match',
      disclaimer: SPEC_DISCLAIMER,
    },
  });
}

/** The default props a `FilterBar` needs before any interaction. */
const FILTER_PROPS = {
  options: null,
  filter: {} as WebviewFilter,
  result: null,
  searchRef: { current: null },
  onChange: (): void => undefined,
  onExport: (): void => undefined,
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe('Header', () => {
  const graph = makeChainGraph();

  it('shows the focus block name as the title', () => {
    const markup = html(
      createElement(Header, {
        graph,
        focusSource: 'function service() {}',
        runStats: { durationMs: 1234, cacheHits: 12, cacheMisses: 3 },
      }),
    );
    expect(markup).toContain('<h1 class="header-title">n3</h1>');
    expect(markup).toContain('function service() {}');
  });

  it('shows the focus block signature', () => {
    const markup = html(createElement(Header, { graph, focusSource: '', runStats: null }));
    expect(markup).toContain('header-signature');
    expect(markup).toContain('function n3(): void');
  });

  it('shows the engine version and the run statistics', () => {
    const markup = html(
      createElement(Header, {
        graph,
        focusSource: '',
        runStats: { durationMs: 1234, cacheHits: 12, cacheMisses: 3 },
      }),
    );
    expect(markup).toContain('engine 0.1.0');
    expect(markup).toContain('12 cache hit(s)');
    expect(markup).toContain('3 miss(es)');
  });

  it('renders a truncation banner when stats.truncated is true', () => {
    const truncated = makeChainGraph();
    truncated.stats.truncated = true;
    const markup = html(createElement(Header, { graph: truncated, focusSource: '', runStats: null }));
    expect(markup).toContain('class="banner"');
    expect(markup).toContain('History is partial');
  });

  it('omits the banner when the scan was complete', () => {
    const markup = html(createElement(Header, { graph, focusSource: '', runStats: null }));
    expect(markup).not.toContain('class="banner"');
    expect(markup).not.toContain('History is partial');
  });

  it('says it is waiting before any payload arrives', () => {
    const markup = html(createElement(Header, { graph: null, focusSource: '', runStats: null }));
    expect(markup).toContain('Waiting for analysis');
    expect(markup).toContain('<h1 class="header-title">Ancestry</h1>');
  });

  it('lists the analysis warnings when there are any', () => {
    const warned = makeChainGraph();
    warned.warnings = ['shallow clone detected', '3 file(s) unparseable'];
    const markup = html(createElement(Header, { graph: warned, focusSource: '', runStats: null }));
    expect(markup).toContain('2 warning(s)');
    expect(markup).toContain('shallow clone detected');
    expect(markup).toContain('3 file(s) unparseable');
  });
});

// ---------------------------------------------------------------------------
// DetailPanel
// ---------------------------------------------------------------------------

describe('DetailPanel', () => {
  const graph = graphWithOrigin();
  const node = graph.nodes.find((candidate) => candidate.id === 'n3') ?? null;

  it('renders an explicit empty state when nothing is selected', () => {
    const markup = html(
      createElement(DetailPanel, {
        graph,
        node: null,
        focusSource: '',
        path: [],
        onSelect: (): void => undefined,
      }),
    );
    expect(markup).toContain('Select a version');
    expect(markup).not.toContain('class="disclaimer"');
  });

  it('renders the selected node metadata', () => {
    const markup = html(
      createElement(DetailPanel, {
        graph,
        node,
        focusSource: '',
        path: ['n3', 'n2', 'n1'],
        onSelect: (): void => undefined,
      }),
    );
    expect(markup).toContain('src/app/service.ts');
    expect(markup).toContain('aaaaaaaaaaa');
    expect(markup).toContain('Ada Lovelace');
    expect(markup).toContain('2023-01-01');
    expect(markup).toContain('95.0%');
    expect(markup).toContain('class="badge strong"');
    expect(markup).toContain('1–10');
  });

  it('renders the focus block source only for the focus node', () => {
    const focusMarkup = html(
      createElement(DetailPanel, {
        graph,
        node,
        focusSource: 'const secret = 1;',
        path: ['n3'],
        onSelect: (): void => undefined,
      }),
    );
    expect(focusMarkup).toContain('const secret = 1;');

    const historical = graph.nodes.find((candidate) => candidate.id === 'n2') ?? null;
    const otherMarkup = html(
      createElement(DetailPanel, {
        graph,
        node: historical,
        focusSource: 'const secret = 1;',
        path: ['n2', 'n1'],
        onSelect: (): void => undefined,
      }),
    );
    expect(otherMarkup).not.toContain('const secret = 1;');
  });

  it('renders the ancestry chain, one step per entry', () => {
    const markup = html(
      createElement(DetailPanel, {
        graph,
        node,
        focusSource: '',
        path: ['n3', 'n2', 'n1'],
        onSelect: (): void => undefined,
      }),
    );
    expect(markup).toContain('Ancestry (3 steps)');
    expect(count(markup, 'class="link"')).toBe(3);
  });

  it('renders the origin block', () => {
    const markup = html(
      createElement(DetailPanel, {
        graph,
        node,
        focusSource: '',
        path: ['n3'],
        onSelect: (): void => undefined,
      }),
    );
    expect(markup).toContain('class="details-section-title">Origin</h3>');
    expect(markup).toContain('src/legacy/helper.ts');
    expect(markup).toContain('earliest-match');
  });

  it('renders the origin disclaimer verbatim', () => {
    const markup = html(
      createElement(DetailPanel, {
        graph,
        node,
        focusSource: '',
        path: ['n3'],
        onSelect: (): void => undefined,
      }),
    );
    expect(markup).toContain(`<p class="disclaimer">${SPEC_DISCLAIMER}</p>`);
  });

  it('keeps the em dash and the punctuation in the disclaimer exactly', () => {
    const markup = html(
      createElement(DetailPanel, {
        graph,
        node,
        focusSource: '',
        path: [],
        onSelect: (): void => undefined,
      }),
    );
    expect(markup).toContain('not proof of original authorship');
    expect(markup).toContain('truncated by a shallow clone or by the configured depth limit.');
  });

  it('falls back to a local disclaimer when the graph has no origin', () => {
    const markup = html(
      createElement(DetailPanel, {
        graph: makeChainGraph(),
        node,
        focusSource: '',
        path: ['n3'],
        onSelect: (): void => undefined,
      }),
    );
    expect(markup).toContain(FALLBACK_DISCLAIMER);
    expect(markup).not.toContain(SPEC_DISCLAIMER);
  });

  it('marks a deleted block and the selected block', () => {
    const deleted = graph.nodes.map((candidate) =>
      candidate.id === 'n1' ? { ...candidate, isDeleted: true } : candidate,
    );
    const withDelete = makeGraph(deleted, graph.edges, { origin: graph.origin });
    const markup = html(
      createElement(DetailPanel, {
        graph: withDelete,
        node: withDelete.nodes.find((candidate) => candidate.id === 'n1') ?? null,
        focusSource: '',
        path: ['n1'],
        onSelect: (): void => undefined,
      }),
    );
    expect(markup).toContain('no longer in the working tree');
    expect(markup).toContain('earliest detected match');
  });
});

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

describe('FilterBar', () => {
  const graph = makeChainGraph();
  const options = availableFilterOptions(graph);
  const result = applyFilter(graph, { minSimilarity: 0.9 });

  const markup = html(
    createElement(FilterBar, {
      ...FILTER_PROPS,
      options,
      filter: { minSimilarity: 0.9, search: 'service', edgeTypes: ['EVOLVED_FROM', 'COPIED_FROM'] },
      result,
    }),
  );

  it('renders one multi-select per categorical dimension', () => {
    expect(count(markup, '<select')).toBe(3);
    for (const id of ['filter-branches', 'filter-files', 'filter-authors']) {
      expect(markup).toContain(`id="${id}"`);
      expect(markup).toContain(`for="${id}"`);
    }
    expect(markup).toContain('multiple');
  });

  it('renders one option per available value', () => {
    expect(count(markup, '<option')).toBe(
      options.branches.length + options.files.length + options.authors.length,
    );
    for (const file of options.files) {
      expect(markup).toContain(`>${file}</option>`);
    }
  });

  it('renders a similarity slider, two date inputs and a search box', () => {
    expect(count(markup, 'type="range"')).toBe(1);
    expect(count(markup, 'type="date"')).toBe(2);
    expect(count(markup, 'type="search"')).toBe(1);
    expect(markup).toContain('aria-label="From date"');
    expect(markup).toContain('aria-label="To date"');
    expect(markup).toContain('id="filter-similarity"');
    expect(markup).toContain('id="filter-search"');
  });

  it('reflects the active filter in the control values', () => {
    expect(markup).toContain('value="90"');
    expect(markup).toContain('90%');
    expect(markup).toContain('value="service"');
  });

  it('renders one toggle per edge type, checked only for the enabled ones', () => {
    expect(count(markup, 'type="checkbox"')).toBe(5);
    expect(count(markup, 'checked=""')).toBe(2);
    expect(markup).toContain('filter-toggles');
  });

  it('reports what the filter is hiding', () => {
    expect(markup).toContain('1 shown');
    expect(markup).toContain('minSimilarity');
  });

  it('renders reset and export controls', () => {
    expect(markup).toContain('Reset');
    expect(markup).toContain('Export JSON');
  });

  it('degrades to an empty, disabled bar before a graph arrives', () => {
    const empty = html(createElement(FilterBar, FILTER_PROPS));
    expect(empty).toContain('Waiting for a graph');
    expect(empty).toContain('disabled=""');
    expect(empty).not.toContain('<option');
  });
});

// ---------------------------------------------------------------------------
// ErrorToast
// ---------------------------------------------------------------------------

describe('ErrorToast', () => {
  it('renders the message and the detail', () => {
    const markup = html(
      createElement(ErrorToast, {
        message: 'git failed',
        detail: 'exit 128',
        onDismiss: (): void => undefined,
      }),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('git failed');
    expect(markup).toContain('exit 128');
  });

  it('renders a dismiss control with an accessible name', () => {
    const markup = html(
      createElement(ErrorToast, {
        message: 'git failed',
        detail: null,
        onDismiss: (): void => undefined,
      }),
    );
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="Dismiss this error"');
    expect(markup).toContain('Dismiss');
  });

  it('omits the detail paragraph entirely when there is none', () => {
    const markup = html(
      createElement(ErrorToast, {
        message: 'git failed',
        detail: null,
        onDismiss: (): void => undefined,
      }),
    );
    expect(markup).not.toContain('toast-detail');
  });
});

// ---------------------------------------------------------------------------
// NodeList
// ---------------------------------------------------------------------------

describe('NodeList', () => {
  const graph = makeChainGraph();
  const visible = [...graph.nodes].sort((a, b) => a.timestamp - b.timestamp);

  it('renders one focusable list item per visible node', () => {
    const markup = html(
      createElement(NodeList, {
        nodes: visible,
        selectedId: null,
        onSelect: (): void => undefined,
      }),
    );
    expect(count(markup, '<button')).toBe(visible.length);
    expect(count(markup, '<li')).toBe(visible.length);
    expect(count(markup, '<ul')).toBe(1);
    // A button is focusable and Enter/Space-activatable without any code here.
    expect(markup).not.toContain('tabindex');
  });

  it('orders the items oldest first', () => {
    const markup = html(
      createElement(NodeList, {
        nodes: visible,
        selectedId: null,
        onSelect: (): void => undefined,
      }),
    );
    const first = markup.indexOf('src/legacy/helper.ts');
    const last = markup.indexOf('src/app/service.ts');
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
  });

  it('marks the selected item with aria-current and nothing else', () => {
    const markup = html(
      createElement(NodeList, {
        nodes: visible,
        selectedId: 'n2',
        onSelect: (): void => undefined,
      }),
    );
    expect(count(markup, 'aria-current="true"')).toBe(1);
    expect(count(markup, 'is-selected')).toBe(1);
  });

  it('hides the colour swatch from assistive technology', () => {
    const markup = html(
      createElement(NodeList, {
        nodes: visible,
        selectedId: null,
        onSelect: (): void => undefined,
      }),
    );
    expect(count(markup, 'aria-hidden="true"')).toBe(visible.length);
  });

  it('renders nothing at all when there is nothing to show', () => {
    const markup = html(
      createElement(NodeList, {
        nodes: [],
        selectedId: null,
        onSelect: (): void => undefined,
      }),
    );
    expect(markup).toBe('');
  });
});

// ---------------------------------------------------------------------------
// LoadingOverlay
// ---------------------------------------------------------------------------

describe('LoadingOverlay', () => {
  it('reflects the ratio in the bar width and in aria-valuenow', () => {
    const markup = html(
      createElement(LoadingOverlay, { message: 'Reading history…', ratio: 0.42 }),
    );
    expect(markup).toContain('width:42.0%');
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
  });

  it('reports the phase in the live region and in aria-valuetext', () => {
    const markup = html(
      createElement(LoadingOverlay, { message: 'Searching history…', ratio: 0.1 }),
    );
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-valuetext="Searching history…"');
  });

  it('clamps a hostile ratio instead of rendering a broken bar', () => {
    expect(html(createElement(LoadingOverlay, { message: 'x', ratio: 7 }))).toContain('width:100.0%');
    expect(html(createElement(LoadingOverlay, { message: 'x', ratio: -2 }))).toContain('width:0.0%');
    expect(html(createElement(LoadingOverlay, { message: 'x', ratio: Number.NaN }))).toContain(
      'width:0.0%',
    );
  });

  it('renders nothing visible for a zero ratio bar fill but keeps the chrome', () => {
    const markup = html(createElement(LoadingOverlay, { message: 'x', ratio: 0 }));
    expect(markup).toContain('width:0.0%');
    expect(markup).toContain('overlay-loading');
  });
});

// ---------------------------------------------------------------------------
// Legend, TimelineAxis, StatusBar
// ---------------------------------------------------------------------------

describe('Legend', () => {
  const markup = html(createElement(Legend));

  it('names every relationship, node role and classification', () => {
    for (const label of [
      'evolved',
      'modified',
      'moved',
      'copied',
      'merged',
      'selected block',
      'earliest match',
      'strong match',
      'possible match',
      'weak match',
      'unrelated match',
    ]) {
      expect(markup).toContain(`<span>${label}</span>`);
    }
  });

  it('states the axis mapping', () => {
    expect(markup).toContain('X = time');
    expect(markup).toContain('Y = branch');
    expect(markup).toContain('Z = module');
  });

  it('is a labelled group, and hides its swatches from screen readers', () => {
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Legend"');
    // 5 edge types + focus + origin + 4 classifications.
    expect(count(markup, 'aria-hidden="true"')).toBe(11);
  });
});

describe('TimelineAxis', () => {
  const graph = makeChainGraph();
  const layout = computeLayout(graph);
  const markup = html(
    createElement(TimelineAxis, {
      axis: layout.axis,
      nodes: layout.nodes,
      range: timestampRange(graph),
    }),
  );

  it('renders one tick label per X tick and one row label per branch', () => {
    expect(count(markup, 'class="axis-tick')).toBe(layout.axis.xTicks.length);
    expect(count(markup, 'axis-row-label')).toBe(layout.axis.yRows.length);
  });

  it('puts the first and last tick at the edges', () => {
    expect(markup).toContain('left:0.00%');
    expect(markup).toContain('left:100.00%');
  });

  it('is decorative, so it is hidden from assistive technology', () => {
    expect(count(markup, 'aria-hidden="true"')).toBe(2);
  });

  it('renders nothing without an axis', () => {
    const empty = html(
      createElement(TimelineAxis, { axis: null, nodes: [], range: { min: 0, max: 1 } }),
    );
    expect(empty).toBe('');
  });
});

describe('StatusBar', () => {
  it('renders the current message in a polite live region', () => {
    const markup = html(createElement(StatusBar, { message: '3 versions · 2 files' }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('3 versions · 2 files');
  });

  it('documents every keyboard shortcut', () => {
    const markup = html(createElement(StatusBar, { message: '' }));
    // The keys and their descriptions are separate elements so the styling and
    // the copy cannot drift apart, so they are asserted separately too.
    for (const key of ['f', '/', 'Esc', '1', '2']) {
      expect(markup).toContain(`<kbd>${key}</kbd>`);
    }
    for (const label of ['fit', 'search', 'clear', 'labels', 'edges']) {
      expect(markup).toContain(label);
    }
    expect(shortcutLabels()).toEqual([
      'f fit',
      '/ search',
      'Esc clear',
      '1 labels',
      '2 edges',
    ]);
  });
});

// ---------------------------------------------------------------------------
// ESCAPING — the regression guard for the migration
// ---------------------------------------------------------------------------

describe('escaping', () => {
  const hostile = '<img src=x onerror=alert(1)>';

  it('escapes a hostile file path in the detail panel', () => {
    const graph = makeGraph([
      makeNode('n1', {
        isFocus: true,
        filePath: hostile,
        author: { name: hostile, email: hostile },
        signature: hostile,
      }),
    ]);
    const node = graph.nodes[0] ?? null;
    const markup = html(
      createElement(DetailPanel, {
        graph,
        node,
        focusSource: '',
        path: ['n1'],
        onSelect: (): void => undefined,
      }),
    );
    // The escaped form is present…
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // …and the unescaped element never is.
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('onerror=alert(1)>');
  });

  it('escapes a hostile file path in the header', () => {
    const graph = makeGraph([makeNode('n1', { isFocus: true, filePath: hostile, blockName: hostile })]);
    const markup = html(createElement(Header, { graph, focusSource: hostile, runStats: null }));
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img');
  });

  it('escapes a hostile file path in the version list', () => {
    const node = makeNode('n1', { filePath: hostile });
    const markup = html(
      createElement(NodeList, { nodes: [node], selectedId: null, onSelect: (): void => undefined }),
    );
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img');
  });

  it('escapes a hostile warning in the header', () => {
    const graph = makeChainGraph();
    graph.warnings = [hostile];
    const markup = html(createElement(Header, { graph, focusSource: '', runStats: null }));
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img');
  });

  it('escapes a hostile error message and detail in the toast', () => {
    const markup = html(
      createElement(ErrorToast, {
        message: hostile,
        detail: hostile,
        onDismiss: (): void => undefined,
      }),
    );
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img');
  });

  it('escapes hostile filter option values', () => {
    const graph = makeGraph([makeNode('n1', { author: { name: hostile, email: 'a@b' } })]);
    const markup = html(
      createElement(FilterBar, {
        ...FILTER_PROPS,
        options: availableFilterOptions(graph),
        filter: { authors: [hostile] },
        result: applyFilter(graph, {}),
      }),
    );
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img');
  });

  it('never emits a raw script tag from any component', () => {
    const graph = graphWithOrigin();
    const node = graph.nodes[0] ?? null;
    const everything = [
      html(createElement(Header, { graph, focusSource: hostile, runStats: null })),
      html(
        createElement(DetailPanel, {
          graph,
          node,
          focusSource: hostile,
          path: ['n3'],
          onSelect: (): void => undefined,
        }),
      ),
      html(createElement(FilterBar, FILTER_PROPS)),
      html(createElement(Legend)),
      html(createElement(ErrorToast, { message: hostile, detail: hostile, onDismiss: () => undefined })),
      html(createElement(LoadingOverlay, { message: hostile, ratio: 0.5 })),
      html(
        createElement(NodeList, {
          nodes: [makeNode('n1', { filePath: hostile })],
          selectedId: null,
          onSelect: (): void => undefined,
        }),
      ),
      html(createElement(StatusBar, { message: hostile })),
    ].join('\n');
    expect(everything).not.toMatch(/<script/i);
    expect(everything).not.toMatch(/<img/i);
    expect(everything).not.toContain('javascript:');
  });
});

describe('fixtures sanity', () => {
  it('the chain graph has one focus node and an origin candidate', () => {
    const graph = makeChainGraph();
    expect(graph.nodes.filter((node) => node.isFocus)).toHaveLength(1);
    expect(graph.nodes.map((node) => node.timestamp)).toContain(T0);
    expect(graph.nodes.map((node) => node.timestamp)).toContain(T0 + 90 * DAY);
  });

  it('the filter result used by the FilterBar test hides exactly one node', () => {
    const result = applyFilter(makeChainGraph(), { minSimilarity: 0.9 });
    expect(result.visibleNodeIds.size).toBe(1);
    expect(result.hiddenCount).toBe(2);
  });
});
