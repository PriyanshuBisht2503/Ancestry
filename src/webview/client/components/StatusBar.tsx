/**
 * The one-line status bar under the stage.
 *
 * It carries two things: whatever transient message is current (hover hints,
 * highlight notices, "fitted the view"), and the keyboard shortcut list. The
 * shortcut list is not decoration — an undiscoverable shortcut is a missing
 * feature, and this panel is entirely operable by keyboard.
 *
 * `aria-live="polite"` rather than `assertive`: the status line updates on every
 * hover, and an assertive live region would interrupt a screen reader mid-sentence
 * continuously. Polite queues the updates and drops stale ones.
 *
 * The shortcut hints are rendered as real `<kbd>` elements inside a `<span>`,
 * not as a `key` value inside a string, so the styling and the copy cannot drift
 * apart — the list is data.
 */

/** The keyboard shortcuts, as data. */
const SHORTCUTS: ReadonlyArray<{ readonly key: string; readonly label: string }> = Object.freeze([
  { key: 'f', label: 'fit' },
  { key: '/', label: 'search' },
  { key: 'Esc', label: 'clear' },
  { key: '1', label: 'labels' },
  { key: '2', label: 'edges' },
]);

/** Props for {@link StatusBar}. */
export interface StatusBarProps {
  /** The current message. Empty renders the neutral default. */
  readonly message: string;
}

/**
 * The status bar.
 *
 * A `role="status"` region: it is a status message by definition, and naming it
 * is what lets a screen reader find it without reading the whole panel.
 */
export function StatusBar(props: StatusBarProps): JSX.Element {
  return (
    <footer className="status-bar">
      <span className="status-message" role="status" aria-live="polite">
        {props.message}
      </span>
      <span className="status-shortcuts">
        {SHORTCUTS.map((shortcut) => (
          <span className="status-shortcut" key={shortcut.key}>
            <kbd>{shortcut.key}</kbd>
            {` ${shortcut.label}`}
          </span>
        ))}
      </span>
    </footer>
  );
}

/** The shortcut list, exported so a test can assert the full set is present. */
export function shortcutLabels(): string[] {
  return SHORTCUTS.map((shortcut) => `${shortcut.key} ${shortcut.label}`);
}
