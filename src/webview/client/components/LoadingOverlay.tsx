/**
 * The determinate progress overlay.
 *
 * A *determinate* bar, not a spinner: the host reports a real 0..1 ratio with
 * every `loading` message (`AnalysisProgress.ratio`), and an analysis of a large
 * repository can take a minute. A spinner would tell the user nothing; a bar
 * that actually moves tells them it is not stuck.
 *
 * Accessibility: the bar is a real `role="progressbar"` with `aria-valuenow` in
 * percent, and the surrounding block is a polite live region so the phase
 * message is announced without stealing focus from whatever the user is doing.
 *
 * The ratio is clamped here rather than in the reducer's caller, because a
 * `loading` message is host input and `AnalysisProgress` documents `ratio` as
 * 0..1 — a value outside that is a host bug the webview must survive rather
 * than render as a 4000%-wide bar.
 */

import { safeRatio } from './graphState';

/** Props for {@link LoadingOverlay}. */
export interface LoadingOverlayProps {
  /** The phase message, e.g. `Searching history…`. */
  readonly message: string;
  /** 0..1; clamped, and anything non-finite is treated as `0`. */
  readonly ratio: number;
}

/**
 * The loading overlay, rendered inside the stage so it covers the 3D view.
 *
 * `aria-valuetext` carries the phase message so a screen reader announces
 * something more useful than "42 percent".
 */
export function LoadingOverlay(props: LoadingOverlayProps): JSX.Element {
  const ratio = safeRatio(props.ratio);
  const percent = Math.round(ratio * 100);
  return (
    <div className="overlay overlay-loading" role="status" aria-live="polite">
      <div className="overlay-inner">
        <p className="overlay-message">{props.message}</p>
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={props.message}
        >
          <div className="progress-bar" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
        </div>
      </div>
    </div>
  );
}
