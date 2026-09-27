/**
 * The schematic X and Y axis overlays drawn on top of the 3D stage.
 *
 * These are the DOM twins of the axis furniture the renderer draws in the scene.
 * They exist for the same reason the DOM label layer does: text rendered by
 * Three.js would need a texture atlas or an addon, whereas absolutely-positioned
 * spans are crisp, themeable and selectable. The 3D lines stay as the visual
 * reference and the DOM ticks carry the readable numbers.
 *
 * SCHEMATIC, NOT PROJECTED — and stated here because it looks like a bug
 * ---------------------------------------------------------------------
 * The X ticks are placed by *timestamp fraction* along the width of the stage,
 * not by projecting the tick's world position through the camera matrix. A
 * pixel-accurate DOM axis would have to be recomputed on every camera frame,
 * which is exactly the per-frame React work `GraphCanvas.tsx` exists to avoid.
 * Because `core/layout.ts` maps a timestamp onto X linearly, the tick and the
 * node it labels always agree with each other; they agree with the *camera* only
 * when the camera is roughly side-on, which is the default framing. The labels
 * are `aria-hidden` because they duplicate what the detail panel states exactly.
 *
 * The Y rows are the branch rows, in the order `core/layout.ts` assigns them,
 * with the row's palette colour shown as a rule so the branch axis is colour-
 * coded the same way the scene is.
 */

import type { AxisSpec, LayoutNode } from '../core/layout';
import { xTickPercentages, yRowPlacements, type TimeRange } from './graphState';

/** Props for {@link TimelineAxis}. */
export interface TimelineAxisProps {
  /** The axis furniture, or `null` before a graph arrives. */
  readonly axis: AxisSpec | null;
  /** The laid-out nodes; kept for symmetry with the 3D furniture. */
  readonly nodes: readonly LayoutNode[];
  /** The graph's timestamp extent, for the X tick fractions. */
  readonly range: TimeRange;
}

/**
 * The X tick rail and the Y row labels.
 *
 * Two sibling absolutely-positioned layers rather than one, because the two have
 * different clip regions: the X rail occupies a 22px strip at the bottom of the
 * stage and the Y labels a narrow column down the left. Merging them would mean
 * one of them loses its overflow clipping.
 */
export function TimelineAxis(props: TimelineAxisProps): JSX.Element | null {
  const { axis } = props;
  if (axis === null) {
    return null;
  }
  const ticks = xTickPercentages(axis, props.range);
  const rows = yRowPlacements(axis);
  return (
    <>
      <div className="axis-overlay axis-overlay-x" aria-hidden="true">
        {ticks.map((tick, index) => (
          <span
            key={`${index}:${tick.label}`}
            className={tick.major ? 'axis-tick major' : 'axis-tick'}
            style={{ left: `${(tick.left * 100).toFixed(2)}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div className="axis-overlay axis-overlay-y" aria-hidden="true">
        {rows.map((row, index) => (
          <span
            key={`${index}:${row.label}`}
            className="axis-row-label"
            style={{ top: `${row.top.toFixed(2)}%`, borderColor: row.color }}
          >
            {row.label}
          </span>
        ))}
      </div>
    </>
  );
}
