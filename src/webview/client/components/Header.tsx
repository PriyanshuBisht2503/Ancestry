/**
 * The panel header: what is being analysed, what it cost, and — when the search
 * was incomplete — a banner that says so.
 *
 * The truncation banner is the single most important thing in this component.
 * `docs/specification.md` §3.5.5 is explicit: a shallow clone or a hit against
 * `maxHistoryDepth` means the "earliest detected match" is the earliest one
 * *inside the scanned window*, and `GraphStats.truncated` is the flag that says
 * so. Showing a "found the origin" panel without it would overstate what the
 * analysis actually did, so the banner is rendered from `stats.truncated` alone
 * and cannot be suppressed by a caller.
 *
 * Everything is rendered as React children. Commit metadata, file paths, author
 * names and block signatures are all attacker-influenced in any repository the
 * user has not personally audited, and React's default escaping is the reason
 * this migration is safe to do at all — see the module header in `App.tsx`.
 */

import type { AncestryGraph, AncestryNode } from '../../../types';
import { humanizeDuration } from '../core/timeline';
import type { RunStats } from './graphState';

/** Props for {@link Header}. */
export interface HeaderProps {
  /** The graph to describe, or `null` before the first payload arrives. */
  readonly graph: AncestryGraph | null;
  /** Source text of the focus block only; empty renders no preview. */
  readonly focusSource: string;
  /** Duration and cache accounting for the run that produced `graph`. */
  readonly runStats: RunStats | null;
}

/**
 * The header bar.
 *
 * A heading (`h1`) rather than a styled `div`: the panel is a document, and this
 * is its title. The summary line is a `p` because it is prose, not a label for a
 * form control.
 */
export function Header(props: HeaderProps): JSX.Element {
  const { graph, focusSource, runStats } = props;
  const focus = findFocusNode(graph);
  const title = focusTitle(graph, focus);
  const signature = focus !== null && focus.signature !== null ? focus.signature : null;
  const summary = summarize(graph, runStats);

  return (
    <header className="header">
      <div className="header-main">
        <h1 className="header-title">{title}</h1>
        <p className="header-summary">{summary}</p>
        {signature === null ? null : (
          <p className="header-signature" title={signature}>
            {signature}
          </p>
        )}
        {graph === null || !graph.stats.truncated ? null : (
          <TruncationBanner graph={graph} />
        )}
        {graph === null || graph.warnings.length === 0 ? null : (
          <details className="header-warnings">
            <summary>{graph.warnings.length} warning(s) from the analysis</summary>
            <ul className="warning-list">
              {graph.warnings.map((warning, index) => (
                <li key={`${index}:${warning.slice(0, 24)}`}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <pre className="header-preview" aria-label="Selected block source">
        {focusSource}
      </pre>
    </header>
  );
}

/**
 * The "this history is partial" banner.
 *
 * Split out so the wording lives in one place and so the condition
 * (`stats.truncated`) is evaluated exactly once per render.
 */
function TruncationBanner(props: { readonly graph: AncestryGraph }): JSX.Element {
  const { graph } = props;
  const { stats } = graph;
  return (
    <div className="banner" role="status">
      <p className="banner-title">History is partial — this is not the whole story</p>
      <p className="banner-body">
        The search stopped at a configured limit, so the earliest match shown may have an
        earlier ancestor outside the scanned range. {stats.filesInspected} file(s) inspected,
        {` ${stats.blocksCompared} block(s) compared.`}
      </p>
    </div>
  );
}

/** The focus node, i.e. the one the user invoked the command on. */
function findFocusNode(graph: AncestryGraph | null): AncestryNode | null {
  if (graph === null) {
    return null;
  }
  return graph.nodes.find((node) => node.isFocus) ?? null;
}

/** The heading text: the focus block's name, else its id, else the product name. */
function focusTitle(graph: AncestryGraph | null, focus: AncestryNode | null): string {
  if (focus !== null) {
    const name = focus.blockName !== null && focus.blockName.length > 0 ? focus.blockName : null;
    if (name !== null) {
      return name;
    }
    if (focus.qualifiedName !== null && focus.qualifiedName.length > 0) {
      return focus.qualifiedName;
    }
  }
  if (graph !== null && graph.focusBlockId.length > 0) {
    return graph.focusBlockId;
  }
  return 'Ancestry';
}

/** One line: graph size, engine version, and how long the run took. */
function summarize(graph: AncestryGraph | null, runStats: RunStats | null): string {
  if (graph === null) {
    return 'Waiting for analysis…';
  }
  const parts: string[] = [
    `${graph.stats.nodeCount} version(s)`,
    `engine ${graph.engineVersion.length > 0 ? graph.engineVersion : 'unknown'}`,
  ];
  if (runStats !== null) {
    parts.push(`analysed in ${humanizeDuration(runStats.durationMs)}`);
    parts.push(`${runStats.cacheHits} cache hit(s)`);
    parts.push(`${runStats.cacheMisses} miss(es)`);
  }
  return parts.join(' · ');
}
