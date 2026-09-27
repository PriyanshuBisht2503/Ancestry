/**
 * Small display formatters shared by the command layer.
 *
 * These live here rather than in a module that already exists because they are
 * purely presentational: nothing in the analysis pipeline needs them, and pulling
 * a presentation concern into `src/cache` or `src/graph` would invert the
 * dependency direction described in docs/architecture.md.
 */

/** Binary-prefixed byte size, e.g. `1.4 MB`. Negative and non-finite input is 0. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  // Compute the unit from a log scale so 1023 B reads as "1023 B" and 1024 B as
  // "1.0 KB", which is what a reader expects.
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

/** Duration in the largest sensible unit, e.g. `840ms`, `2.4s`, `1m 12s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) {
    return `${minutes}m ${remainder}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `1,234` — thousands separators, locale-independent digits. */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0';
}

/** `2026-09-27 14:03:22Z` in UTC, or `n/a`. */
export function formatTimestamp(timestamp: number | null | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return 'n/a';
  }
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19);
}
