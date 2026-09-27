/**
 * The detail panel: everything known about the selected version.
 *
 * WHY THE ORIGIN DISCLAIMER IS RENDERED VERBATIM
 * -----------------------------------------------
 * `docs/specification.md` §5 fixes the wording of the origin claim, and the
 * string itself is carried on `OriginInfo.disclaimer` so there is exactly one
 * copy of it in the system. This component therefore prints that string
 * **verbatim** — no trimming, no summarising, no "see docs" — and falls back to
 * a local constant only when a graph arrives with no `origin` record at all.
 * The whole product's honesty about "earliest *detected* match" rests on this
 * paragraph being on screen next to the claim it qualifies.
 *
 * SOURCE TEXT POLICY: source is rendered for the **focus node only**, and that
 * is enforced by the `node.isFocus` check rather than left to convention. The
 * host deliberately does not send historical source, so if a future change ever
 * adds text to another node, this degrades to metadata instead of quietly
 * displaying a file the user never asked about.
 *
 * XSS POSTURE: every value below — file paths, author names, signatures, commit
 * messages, the disclaimer — is a React child. React escapes text children and
 * attribute values, which is a genuine improvement over the `textContent`-and-
 * `createElement` discipline of the pre-React `panel.ts` and removes the
 * possibility of a mistake here becoming an injection.
 */

import type { ReactNode } from 'react';
import type { AncestryGraph, AncestryNode } from '../../../types';
import { DETACHED_BRANCH } from '../core/domain';
import { nodeById } from '../core/graph-stats';
import { formatAxisLabel, humanizeTimestamp } from '../core/timeline';
import { shortCommitOf, similarityLabel } from './graphState';

/**
 * Used only when a graph carries no `origin` record.
 *
 * Deliberately not the §5 wording: that wording belongs to the host, which
 * computes the basis the disclaimer qualifies. A graph with no origin did not
 * make a claim, so this says so without borrowing the claim's wording.
 */
export const FALLBACK_DISCLAIMER =
  'Ancestry shows the earliest semantic match it could detect in the history it scanned. ' +
  'Git cannot recover intent, and an earlier origin may exist outside the scanned range.';

/** Props for {@link DetailPanel}. */
export interface DetailPanelProps {
  /** The graph the node belongs to, or `null` before a payload arrives. */
  readonly graph: AncestryGraph | null;
  /** The selected node, or `null` for the empty state. */
  readonly node: AncestryNode | null;
  /** Source text of the focus block only. */
  readonly focusSource: string;
  /** The selected node's backwards ancestry chain, from `core/graph-stats.ts`. */
  readonly path: readonly string[];
  /** Selects another node, e.g. from the ancestry path. */
  readonly onSelect: (nodeId: string) => void;
}

/**
 * The right-hand panel.
 *
 * Renders an explicit empty state rather than nothing at all: a blank sidebar
 * reads as "the panel failed", whereas "Select a version" reads as "you have not
 * chosen one yet".
 */
export function DetailPanel(props: DetailPanelProps): JSX.Element {
  const { graph, node, focusSource, path, onSelect } = props;
  if (graph === null || node === null) {
    return (
      <aside className="details" aria-label="Version details">
        <p className="details-empty">Select a version in the 3D view, or in the list below.</p>
      </aside>
    );
  }

  return (
    <aside className="details" aria-label="Version details">
      <div className="details-body">
        <Section title="Summary">
          <Row label="Block" value={node.blockName ?? '(anonymous)'} />
          <Row label="Qualified" value={node.qualifiedName ?? '—'} />
          <Row label="File" value={node.filePath} />
          <Row label="Lines" value={`${node.lineStart}–${node.lineEnd}`} />
          <Row label="Commit" value={shortCommitOf(node)} mono />
          <Row label="Author" value={node.author.name || '(unknown)'} />
          <Row
            label="Authored"
            value={`${formatAxisLabel(node.timestamp)} · ${humanizeTimestamp(node.timestamp)}`}
          />
          <Row
            label="Branches"
            value={node.branches.length > 0 ? node.branches.join(', ') : DETACHED_BRANCH}
          />
          <Row label="Module" value={node.module || '—'} />
          <Row label="Similarity" value={similarityLabel(node.similarity)} />
          <Row label="Match" value={node.classification} badge={node.classification} />
          {node.isFocus ? <Row label="Role" value="your selection" /> : null}
          {node.isOrigin ? <Row label="Role" value="earliest detected match" /> : null}
          {node.isDeleted ? <Row label="State" value="no longer in the working tree" /> : null}
        </Section>

        {node.signature !== null && node.signature.length > 0 ? (
          <Section title="Signature">
            <pre className="details-signature">{node.signature}</pre>
          </Section>
        ) : null}

        <Section title={`Ancestry (${path.length} step${path.length === 1 ? '' : 's'})`}>
          <ul className="ancestry-path">
            {path.map((id) => {
              const step = nodeById(graph, id);
              const isCurrent = id === node.id;
              return (
                <li key={id} className={isCurrent ? 'is-current' : undefined}>
                  {step === null ? (
                    id
                  ) : (
                    <button
                      type="button"
                      className="link"
                      aria-current={isCurrent ? 'true' : undefined}
                      onClick={() => onSelect(id)}
                    >
                      {`${formatAxisLabel(step.timestamp)} · ${shortCommitOf(step)} · ${step.filePath}`}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>

        {node.isFocus && focusSource.length > 0 ? (
          <Section title="Selected block">
            <pre className="details-source">{focusSource}</pre>
          </Section>
        ) : null}

        {graph.origin === null ? null : (
          <Section title="Origin">
            <Row label="Earliest match" value={graph.origin.filePath} />
            <Row
              label="Commit"
              value={
                graph.origin.shortCommit.length > 0
                  ? graph.origin.shortCommit
                  : graph.origin.commit.slice(0, 7)
              }
              mono
            />
            <Row label="Author" value={graph.origin.author.name || '(unknown)'} />
            <Row label="Date" value={formatAxisLabel(graph.origin.timestamp)} />
            <Row label="Basis" value={graph.origin.basis} />
            <Row label="Similarity" value={similarityLabel(graph.origin.similarity)} />
          </Section>
        )}

        <p className="disclaimer">{graph.origin?.disclaimer ?? FALLBACK_DISCLAIMER}</p>
      </div>
    </aside>
  );
}

/** Props for the internal section wrapper. */
interface SectionProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** A titled group of detail rows. */
function Section(props: SectionProps): JSX.Element {
  return (
    <section className="details-section">
      <h3 className="details-section-title">{props.title}</h3>
      {props.children}
    </section>
  );
}

/** Props for the internal label/value row. */
interface RowProps {
  readonly label: string;
  readonly value: string;
  /** Renders the value in the monospace face — for shas and signatures. */
  readonly mono?: boolean;
  /** Renders the value as a classification pill. */
  readonly badge?: string;
}

/**
 * One label/value pair.
 *
 * A two-column grid rather than a real `<dl>`: the key and the value are not
 * term/definition pairs (they are associated positionally, not semantically),
 * and the grid keeps the columns aligned without more markup than the document
 * needs.
 */
function Row(props: RowProps): JSX.Element {
  const value =
    props.badge === undefined ? (
      props.value
    ) : (
      <span className={`badge ${props.badge}`}>{props.value}</span>
    );
  return (
    <div className="details-row">
      <span className="details-key">{props.label}</span>
      <span className={props.mono === true ? 'details-value mono' : 'details-value'}>
        {value}
      </span>
    </div>
  );
}
