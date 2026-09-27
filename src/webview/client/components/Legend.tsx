/**
 * The static legend.
 *
 * Built entirely from `core/colors.ts`, which is the same table the Three.js
 * renderer draws from. That is the point: a legend that can advertise a colour
 * the scene does not actually use is worse than no legend, and the only way to
 * make that impossible is to have exactly one colour table.
 *
 * The axis note at the end restates the §6.1 mapping (X = time, Y = branch,
 * Z = module) so the picture is interpretable without leaving the panel.
 *
 * Every colour reaches the DOM as an inline `style.background` written by React
 * through the CSSOM — never as markup, and never as a value from a message: all
 * of them come from a frozen table in `core/colors.ts`.
 */

import {
  BRANCH_PALETTE_SIZE,
  colorForClassification,
  colorForEdgeType,
  FOCUS_NODE_COLOR,
  ORIGIN_NODE_COLOR,
} from '../core/colors';
import { EDGE_TYPES } from '../core/domain';
import { CLASSIFICATIONS, EDGE_LABELS } from './graphState';

/**
 * The legend row: one swatch per relationship type, per node role, and per
 * match classification, plus the axis mapping.
 *
 * The swatches are `aria-hidden` and the *text* carries the meaning, so a
 * screen reader reads "evolved" rather than "blue line".
 */
export function Legend(): JSX.Element {
  return (
    <div className="legend" role="group" aria-label="Legend">
      {EDGE_TYPES.map((type) => (
        <span className="legend-item" key={type}>
          <span
            className="legend-swatch edge"
            style={{ background: colorForEdgeType(type) }}
            aria-hidden="true"
          />
          <span>{EDGE_LABELS[type] ?? type}</span>
        </span>
      ))}

      <span className="legend-item">
        <span
          className="legend-swatch focus"
          style={{ background: FOCUS_NODE_COLOR }}
          aria-hidden="true"
        />
        <span>selected block</span>
      </span>

      <span className="legend-item">
        <span
          className="legend-swatch"
          style={{ background: ORIGIN_NODE_COLOR }}
          aria-hidden="true"
        />
        <span>earliest match</span>
      </span>

      {CLASSIFICATIONS.map((classification) => (
        <span className="legend-item" key={classification}>
          <span
            className="legend-swatch"
            style={{ background: colorForClassification(classification) }}
            aria-hidden="true"
          />
          <span>{classification} match</span>
        </span>
      ))}

      <span className="legend-note">
        {`X = time · Y = branch (colours repeat after ${BRANCH_PALETTE_SIZE}) · Z = module`}
      </span>
    </div>
  );
}
