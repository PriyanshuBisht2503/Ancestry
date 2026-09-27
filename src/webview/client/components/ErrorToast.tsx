/**
 * The non-fatal error surface.
 *
 * `role="alert"` (assertive) because an `error` message from the host means
 * something the user asked for did not work, and they should hear about it even
 * if focus is elsewhere. This replaced a hand-rolled toast that also set an
 * eight-second auto-dismiss timer — the timer is deliberately **gone**: a
 * message that vanishes before it can be read is not a report, and a
 * non-fatal-but-unexplained failure is exactly the kind of thing a user needs to
 * be able to quote into an issue. The dismiss control is the only way to close
 * it.
 *
 * The message and the optional detail are React children. Both come from the
 * host and both are attacker-influenced (a file that could not be parsed, a
 * warning about a shallow clone), so this is one of the places where the
 * migration's real security win lives: React escapes them, so a commit subject
 * containing `<script>` is text rather than markup.
 */

import type { ErrorState } from './graphState';

/** Props for {@link ErrorToast}. */
export interface ErrorToastProps {
  /** What went wrong, in words safe to show a user. */
  readonly message: string;
  /** Optional developer-facing detail; hidden entirely when absent. */
  readonly detail: string | null;
  /** Closes the toast. */
  readonly onDismiss: () => void;
}

/**
 * The error toast.
 *
 * `message` and `detail` are separate `p`s so a long detail wraps under the
 * headline instead of being concatenated into it — the host sends them
 * separately precisely because the second is not for the user.
 */
export function ErrorToast(props: ErrorToastProps): JSX.Element {
  return (
    <div className="toast" role="alert">
      <p className="toast-message">{props.message}</p>
      {props.detail === null || props.detail.length === 0 ? null : (
        <p className="toast-detail">{props.detail}</p>
      )}
      <button
        type="button"
        className="ancestry-button toast-dismiss"
        aria-label="Dismiss this error"
        onClick={props.onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

/** Narrowing helper so `App.tsx` can pass the reducer's state straight through. */
export function toastPropsFrom(
  error: ErrorState | null,
  onDismiss: () => void,
): ErrorToastProps | null {
  if (error === null) {
    return null;
  }
  return { message: error.message, detail: error.detail, onDismiss };
}
