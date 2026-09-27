/**
 * Time formatting is the one place where a locale or a timezone leak would be
 * visible to *every* user rather than to one of them, so the assertions here are
 * deliberately UTC-pinned and `now`-pinned. No test in this file reads the wall
 * clock.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_TICK_COUNT,
  formatAxisLabel,
  generateTimeTicks,
  humanizeDuration,
  humanizeTimestamp,
  MAX_TIME_TICKS,
} from '../../src/webview/client/core/timeline';
import { DAY, T0 } from './fixtures';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('humanizeDuration', () => {
  it('covers the whole range from milliseconds to years', () => {
    expect(humanizeDuration(0)).toBe('0 ms');
    expect(humanizeDuration(450)).toBe('450 ms');
    expect(humanizeDuration(5 * SECOND)).toBe('5 seconds');
    expect(humanizeDuration(1 * SECOND)).toBe('1 second');
    expect(humanizeDuration(90 * SECOND)).toBe('2 minutes');
    expect(humanizeDuration(2 * HOUR)).toBe('2 hours');
    expect(humanizeDuration(1 * HOUR)).toBe('1 hour');
    expect(humanizeDuration(3 * DAY)).toBe('3 days');
    expect(humanizeDuration(1 * DAY)).toBe('1 day');
    expect(humanizeDuration(60 * DAY)).toBe('2 months');
    expect(humanizeDuration(365.25 * DAY * 4)).toBe('4 years');
  });

  it('singularises correctly at every boundary', () => {
    expect(humanizeDuration(DAY)).toBe('1 day');
    expect(humanizeDuration(30 * DAY)).toBe('1 month');
    expect(humanizeDuration(365.25 * DAY)).toBe('1 year');
  });

  it('switches granularity exactly at the documented boundaries', () => {
    expect(humanizeDuration(SECOND - 1)).toMatch(/ms$/);
    expect(humanizeDuration(SECOND)).toMatch(/seconds?$/);
    expect(humanizeDuration(MINUTE - 1)).toMatch(/seconds?$/);
    expect(humanizeDuration(MINUTE)).toMatch(/minutes?$/);
    expect(humanizeDuration(HOUR - 1)).toMatch(/minutes?$/);
    expect(humanizeDuration(HOUR)).toMatch(/hours?$/);
    expect(humanizeDuration(DAY - 1)).toMatch(/hours?$/);
    expect(humanizeDuration(DAY)).toMatch(/days?$/);
  });

  it('treats a negative duration as its magnitude (clock skew)', () => {
    expect(humanizeDuration(-3 * DAY)).toBe(humanizeDuration(3 * DAY));
  });

  it('returns "unknown" for non-finite input', () => {
    expect(humanizeDuration(Number.NaN)).toBe('unknown');
    expect(humanizeDuration(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});

describe('humanizeTimestamp', () => {
  const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

  it('renders the past as "X ago"', () => {
    expect(humanizeTimestamp(NOW - 2 * 365.25 * DAY, NOW)).toBe('2 years ago');
    expect(humanizeTimestamp(NOW - 3 * DAY, NOW)).toBe('3 days ago');
    expect(humanizeTimestamp(NOW - 5 * HOUR, NOW)).toBe('5 hours ago');
    expect(humanizeTimestamp(NOW - 30 * MINUTE, NOW)).toBe('30 minutes ago');
    expect(humanizeTimestamp(NOW - 2 * MINUTE, NOW)).toBe('2 minutes ago');
  });

  it('renders the future as "in X"', () => {
    expect(humanizeTimestamp(NOW + 3 * DAY, NOW)).toBe('in 3 days');
    expect(humanizeTimestamp(NOW + 2 * HOUR, NOW)).toBe('in 2 hours');
  });

  it('collapses anything under a minute to "just now", in both directions', () => {
    expect(humanizeTimestamp(NOW - 5 * SECOND, NOW)).toBe('just now');
    expect(humanizeTimestamp(NOW + 5 * SECOND, NOW)).toBe('just now');
    expect(humanizeTimestamp(NOW, NOW)).toBe('just now');
  });

  it('is a pure function of its `now` argument', () => {
    const ts = NOW - 4 * HOUR;
    expect(humanizeTimestamp(ts, NOW)).toBe('4 hours ago');
    expect(humanizeTimestamp(ts, NOW - HOUR)).toBe('3 hours ago');
    expect(humanizeTimestamp(ts, NOW)).toBe(humanizeTimestamp(ts, NOW));
  });

  it('returns "unknown" for non-finite input', () => {
    expect(humanizeTimestamp(Number.NaN, NOW)).toBe('unknown');
    expect(humanizeTimestamp(NOW, Number.NaN)).toBe('unknown');
  });
});

describe('formatAxisLabel', () => {
  it('formats as a UTC YYYY-MM-DD string', () => {
    expect(formatAxisLabel(T0)).toBe('2023-01-01');
    expect(formatAxisLabel(Date.UTC(2024, 1, 29, 23, 59, 59))).toBe('2024-02-29');
    expect(formatAxisLabel(Date.UTC(1999, 11, 31, 0, 0, 0))).toBe('1999-12-31');
  });

  it('is UTC-stable: the time of day never shifts the date', () => {
    expect(formatAxisLabel(Date.UTC(2023, 5, 1, 0, 0, 0))).toBe('2023-06-01');
    expect(formatAxisLabel(Date.UTC(2023, 5, 1, 23, 59, 59))).toBe('2023-06-01');
  });

  it('degrades gracefully for non-finite input', () => {
    expect(formatAxisLabel(Number.NaN)).toBe('—');
    expect(formatAxisLabel(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('generateTimeTicks — granularity', () => {
  it('uses minute labels for a short span', () => {
    const ticks = generateTimeTicks(T0, T0 + 90 * MINUTE, 8);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every((tick) => /\d{2}-\d{2} \d{2}:\d{2}/.test(tick.label))).toBe(true);
  });

  it('uses hour granularity for a multi-hour span', () => {
    const ticks = generateTimeTicks(T0, T0 + 6 * HOUR, 8);
    expect(ticks.every((tick) => /^\d{4}-\d{2}-\d{2}$/.test(tick.label))).toBe(true);
  });

  it('uses date labels for a multi-day span', () => {
    const ticks = generateTimeTicks(T0, T0 + 30 * DAY, 8);
    expect(ticks.every((tick) => /^\d{4}-\d{2}-\d{2}$/.test(tick.label))).toBe(true);
  });

  it('marks the range bounds as major', () => {
    const ticks = generateTimeTicks(T0, T0 + 30 * DAY, 6);
    expect(ticks[0]!.major).toBe(true);
    expect(ticks[ticks.length - 1]!.major).toBe(true);
  });

  it('honours the default target', () => {
    const ticks = generateTimeTicks(T0, T0 + 365 * DAY);
    expect(ticks.length).toBeLessThanOrEqual(Math.max(2, DEFAULT_TIME_TICK_COUNT));
    expect(ticks.length).toBeLessThanOrEqual(MAX_TIME_TICKS);
  });

  it('clamps a nonsense target instead of exploding', () => {
    expect(generateTimeTicks(T0, T0 + DAY, 0).length).toBeGreaterThan(1);
    expect(generateTimeTicks(T0, T0 + DAY, -5).length).toBeGreaterThan(1);
    expect(generateTimeTicks(T0, T0 + DAY, Number.NaN).length).toBeGreaterThan(1);
    expect(generateTimeTicks(T0, T0 + 900 * DAY, 1000).length).toBeLessThanOrEqual(MAX_TIME_TICKS);
  });

  it('is stable for a month boundary', () => {
    const ticks = generateTimeTicks(Date.UTC(2023, 0, 15), Date.UTC(2023, 2, 20), 4);
    expect(ticks[0]!.timestamp).toBe(Date.UTC(2023, 0, 15));
    expect(ticks[ticks.length - 1]!.timestamp).toBe(Date.UTC(2023, 2, 20));
  });
});
