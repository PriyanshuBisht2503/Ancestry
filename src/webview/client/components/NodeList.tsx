/**
 * The accessible fallback for the 3D view: a real, focusable list of every
 * visible version.
 *
 * WHY THIS IS NOT A NICETY
 * ------------------------
 * A `<canvas>` is a black rectangle to a screen reader, and an orbit camera is
 * not reachable by keyboard. If the graph can only be explored by dragging a
 * mouse then the visualisation is unusable for a large part of the audience, so
 * this list is a first-class view of the same data rather than a debug aid. It
 * shows the same *visible* set as the scene, so the two can never disagree.
 *
 * WHY `<button>` PER ITEM RATHER THAN A `LISTBOX`
 * ----------------------------------------------
 * A `listbox` with roving `tabindex` gives arrow-key navigation, but it takes
 * ownership of the arrow keys away from the page and it is fiddly to keep the
 * active option in sync with the selection. A plain list of buttons is
 * natively focusable, natively activatable with Enter *and* Space, keeps Tab
 * working, and needs no focus bookkeeping at all. `aria-current` is what tells a
 * screen reader which one is selected. Trade-off: more tab stops in a long list —
 * which is why the list is a scrolling region rather than the whole document.
 *
 * `aria-activedescendant` is deliberately absent: it requires the container to
 * keep focus, and here focus is on the items themselves.
 *
 * Accessibility of the swatch: the colour is redundant with the text, so the
 * swatch is `aria-hidden` — a screen reader user gets "2023-04-05 ·
 * src/app/service.ts", which is the information the colour was conveying.
 */

import type { AncestryNode } from '../../../types';
import { colorForNode } from '../core/colors';
import { formatAxisLabel } from '../core/timeline';
import { shortCommitOf } from './graphState';

/** Props for {@link NodeList}. */
export interface NodeListProps {
  /** The visible nodes, already in chronological order. */
  readonly nodes: readonly AncestryNode[];
  /** The selected node id, or `null`. */
  readonly selectedId: string | null;
  /** Selects a node, from the host's point of view as well as the local one. */
  readonly onSelect: (nodeId: string) => void;
}

/**
 * The version list.
 *
 * Hidden entirely when there is nothing to show, rather than rendered empty: an
 * empty bordered box labelled "Versions" reads as a failed load.
 */
export function NodeList(props: NodeListProps): JSX.Element | null {
  const { nodes, selectedId, onSelect } = props;
  if (nodes.length === 0) {
    return null;
  }
  return (
    <section className="node-list" aria-label="Versions">
      <h2 className="node-list-title">Versions</h2>
      <ul className="node-list-items">
        {nodes.map((node) => {
          const isSelected = node.id === selectedId;
          return (
            <li className="node-list-entry" key={node.id}>
              <button
                type="button"
                className={isSelected ? 'node-list-item is-selected' : 'node-list-item'}
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => onSelect(node.id)}
              >
                <span
                  className="legend-swatch"
                  style={{ background: colorForNode(node) }}
                  aria-hidden="true"
                />
                <span className="node-list-text">
                  {`${formatAxisLabel(node.timestamp)} · ${node.filePath} · ${shortCommitOf(node)}`}
                </span>
                <span className="node-list-meta">
                  {node.isFocus ? 'selected block' : node.classification}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
