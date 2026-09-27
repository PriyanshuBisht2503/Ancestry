/**
 * Time-axis tick generation and human-readable time formatting.
 *
 * WHY THIS IS PURE AND SEPARATE: the tick generator is the only part of the
 * visualisation that has to produce *the same labels twice* — once for the X
 * axis in the 3D scene and once for the summary line in the DOM panel — and a
 * mismatch there looks like a bug to the user. Keeping it pure, deterministic
 * and independently testable is the cheapest way to make that impossible.
 *
 * All calendar arithmetic is done in **UTC**. Git timestamps are absolute, and
 * using the viewer's local timezone here would make two users in different
 * timezones see different axis labels for the same graph.
 */

import { formatDateUtc } from '../../../types';

/** One labelled tick on the X (time) axis. */
export interface TimeTick {
  /** Epoch milliseconds of the tick. */
  timestamp: number;
  /** Display label, already formatted for the tick's granularity. */
  label: string;
  /**
   * True when this tick is on a "round" calendar boundary of a coarser unit
   * than the current one (e.g. the 1st of the month when the unit is one day,
   * midnight when the unit is one hour). The renderer draws major ticks with a
   * longer, brighter mark and a visible label.
   */
  major: boolean;
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Calendar granularity of a tick. Fine → coarse in {@link UNIT_LADDER}. */
type TickUnit = 'quarter-hour' | 'hour' | 'day' | 'week' | 'month' | 'year';

/** Approximate millisecond width of each unit, used for the span→unit choice. */
const UNIT_WIDTH: Readonly<Record<TickUnit, number>> = Object.freeze({
  'quarter-hour': 15 * MINUTE_MS,
  hour: HOUR_MS,
  day: DAY_MS,
  week: WEEK_MS,
  month: 30.44 * DAY_MS,
  year: 365.25 * DAY_MS,
});

/** Fine → coarse. The first entry whose width keeps the tick count in budget wins. */
const UNIT_LADDER: readonly TickUnit[] = ['quarter-hour', 'hour', 'day', 'week', 'month', 'year'];

/** Hard ceiling on rendered ticks — beyond this the axis is unreadable. */
export const MAX_TIME_TICKS = 24;

/** Default number of ticks the layout aims for on the X axis. */
export const DEFAULT_TIME_TICK_COUNT = 10;

/** Internal safety valve: aligned ticks generated before giving up on calendar alignment. */
const ALIGNED_TICK_BUDGET = 192;

/**
 * Generates ticks covering `[min, max]`.
 *
 * Deterministic: the same range always yields the same ticks, because the
 * ladder choice depends only on the span and every step is pure UTC calendar
 * arithmetic. Guarantees:
 *  - the first tick is `min` and the last is `max`, so the axis always shows
 *    its full extent even when the boundaries are not "round";
 *  - no more than `max(targetCount, 2)` and never more than
 *    {@link MAX_TIME_TICKS} ticks;
 *  - an empty array for a non-finite or inverted range;
 *  - a single tick when `min === max` (a repository whose entire reachable
 *    history is one commit must still get a labelled axis);
 *  - for absurdly long spans (centuries) the calendar ladder is abandoned in
 *    favour of an even linear sub-sample, so the axis still covers the whole
 *    range rather than only its first few years.
 */
export function generateTimeTicks(
  min: number,
  max: number,
  targetCount: number = DEFAULT_TIME_TICK_COUNT,
): TimeTick[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    return [];
  }
  if (min === max) {
    return [{ timestamp: min, label: formatAxisLabel(min), major: true }];
  }

  const wanted = clampInt(targetCount, 2, MAX_TIME_TICKS);
  const span = max - min;

  let unit: TickUnit = 'year';
  for (const candidate of UNIT_LADDER) {
    if (span / UNIT_WIDTH[candidate] <= wanted) {
      unit = candidate;
      break;
    }
  }

  let aligned = alignedTicks(min, max, unit);
  let guard = 0;
  while (!aligned.complete && aligned.stamps.length > wanted && guard < UNIT_LADDER.length) {
    const next = coarserUnit(unit);
    if (next === null) {
      break;
    }
    unit = next;
    aligned = alignedTicks(min, max, unit);
    guard += 1;
  }

  const interior = aligned.complete ? aligned.stamps : linearTicks(min, max, wanted);
  let stamps = [min, ...interior.filter((ts) => ts > min && ts < max), max];
  if (stamps.length > MAX_TIME_TICKS) {
    stamps = subSample(stamps, MAX_TIME_TICKS);
  }

  return stamps.map((timestamp, index) => ({
    timestamp,
    label: labelForUnit(timestamp, unit),
    // The two range bounds are always major: they are what the user is
    // actually reading the axis for.
    major: index === 0 || index === stamps.length - 1 || isMajorBoundary(timestamp, unit),
  }));
}

/**
 * Rounds a duration to a short human phrase: `450 ms`, `12 seconds`,
 * `3 days`, `2 months`, `4 years`.
 *
 * Uses 30-day months and 365.25-day years so the output is stable and does not
 * depend on the viewer's calendar. Non-finite input yields `unknown`; negative
 * input is treated as its magnitude, because a negative duration here is clock
 * skew rather than a different kind of span.
 */
export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return 'unknown';
  }
  const abs = Math.abs(ms);
  if (abs < SECOND_MS) {
    return `${Math.round(abs)} ms`;
  }
  if (abs < MINUTE_MS) {
    return plural(Math.round(abs / SECOND_MS), 'second');
  }
  if (abs < HOUR_MS) {
    return plural(Math.round(abs / MINUTE_MS), 'minute');
  }
  if (abs < DAY_MS) {
    return plural(Math.round(abs / HOUR_MS), 'hour');
  }
  if (abs < 30 * DAY_MS) {
    return plural(Math.round(abs / DAY_MS), 'day');
  }
  if (abs < 365.25 * DAY_MS) {
    return plural(Math.round(abs / (30 * DAY_MS)), 'month');
  }
  return plural(Math.round(abs / (365.25 * DAY_MS)), 'year');
}

/**
 * Renders an epoch timestamp relative to `now`: `2 years ago`, `in 3 days`,
 * `just now` for anything under a minute.
 *
 * `now` is injectable so tests and the "last run" header do not depend on the
 * wall clock. Anything within 60s in either direction reads as `just now`:
 * a 3-second `3 seconds ago` is noise, and an analysis is never that fresh to
 * be interesting.
 */
export function humanizeTimestamp(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) {
    return 'unknown';
  }
  const delta = now - ts;
  const abs = Math.abs(delta);
  if (abs < MINUTE_MS) {
    return 'just now';
  }
  const phrase = humanizeDuration(abs);
  return delta > 0 ? `${phrase} ago` : `in ${phrase}`;
}

/**
 * Formats an epoch timestamp as a UTC `YYYY-MM-DD` axis label.
 *
 * Delegates to the frozen `formatDateUtc` helper so the webview, the graph
 * export and any host-side output can never disagree about a date.
 */
export function formatAxisLabel(ts: number): string {
  if (!Number.isFinite(ts)) {
    return '—';
  }
  return formatDateUtc(ts);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Next coarser entry in {@link UNIT_LADDER}, or `null` at the top. */
function coarserUnit(unit: TickUnit): TickUnit | null {
  const index = UNIT_LADDER.indexOf(unit);
  if (index < 0) {
    return 'year';
  }
  return UNIT_LADDER[index + 1] ?? null;
}

/** Aligned tick timestamps strictly inside `(min, max)`, plus a completion flag. */
interface AlignedTicks {
  readonly stamps: number[];
  /** True when the walk reached `max` without exhausting the budget. */
  readonly complete: boolean;
}

function alignedTicks(min: number, max: number, unit: TickUnit): AlignedTicks {
  const stamps: number[] = [];
  let cursor = floorToUnit(min, unit);
  if (cursor < min) {
    cursor = nextUnit(cursor, unit);
  }
  while (cursor < max) {
    if (cursor > min) {
      stamps.push(cursor);
    }
    if (stamps.length >= ALIGNED_TICK_BUDGET) {
      return { stamps, complete: false };
    }
    const following = nextUnit(cursor, unit);
    if (following <= cursor) {
      // Defensive: a non-advancing step would spin forever.
      return { stamps, complete: false };
    }
    cursor = following;
  }
  return { stamps, complete: true };
}

/** Evenly spaced interior ticks; the fallback for spans no calendar unit can serve. */
function linearTicks(min: number, max: number, count: number): number[] {
  const out: number[] = [];
  const interior = Math.max(0, count - 2);
  for (let index = 1; index <= interior; index += 1) {
    out.push(min + ((max - min) * index) / (interior + 1));
  }
  return out;
}

/** Largest tick boundary at or before `ts`, in UTC. */
function floorToUnit(ts: number, unit: TickUnit): number {
  switch (unit) {
    case 'quarter-hour':
      return Math.floor(ts / UNIT_WIDTH['quarter-hour']) * UNIT_WIDTH['quarter-hour'];
    case 'hour':
      return Math.floor(ts / HOUR_MS) * HOUR_MS;
    case 'day':
      return Math.floor(ts / DAY_MS) * DAY_MS;
    case 'week': {
      const day = Math.floor(ts / DAY_MS);
      // 1970-01-01 was a Thursday, so `((day + 3) % 7)` gives a 0 = Sunday
      // convention, which is the ISO-adjacent convention Git users expect.
      const weekday = (((day + 3) % 7) + 7) % 7;
      return (day - weekday) * DAY_MS;
    }
    case 'month': {
      const date = new Date(ts);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    }
    case 'year': {
      const date = new Date(ts);
      return Date.UTC(date.getUTCFullYear(), 0, 1);
    }
    default:
      return ts;
  }
}

/** The first tick boundary strictly after `ts`. */
function nextUnit(ts: number, unit: TickUnit): number {
  switch (unit) {
    case 'quarter-hour':
      return ts + UNIT_WIDTH['quarter-hour'];
    case 'hour':
      return ts + HOUR_MS;
    case 'day':
      return ts + DAY_MS;
    case 'week':
      return ts + WEEK_MS;
    case 'month': {
      const date = new Date(ts);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
    case 'year': {
      const date = new Date(ts);
      return Date.UTC(date.getUTCFullYear() + 1, 0, 1);
    }
    default:
      return ts + DAY_MS;
  }
}

/** True when `ts` sits on a boundary one step coarser than `unit`. */
function isMajorBoundary(ts: number, unit: TickUnit): boolean {
  const coarser = coarserUnit(unit);
  if (coarser === null) {
    return true;
  }
  return floorToUnit(ts, coarser) === ts;
}

/** The label shown for a tick at the given granularity. */
function labelForUnit(ts: number, unit: TickUnit): string {
  if (unit === 'quarter-hour') {
    const date = new Date(ts);
    return `${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(
      date.getUTCMinutes(),
    )}`;
  }
  return formatAxisLabel(ts);
}

/**
 * Keeps at most `limit` entries, always retaining the first and last so the
 * axis still shows the full range.
 */
function subSample(items: number[], limit: number): number[] {
  if (items.length <= limit) {
    return items;
  }
  const out: number[] = [];
  const stride = (items.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) {
    out.push(items[Math.round(index * stride)]!);
  }
  return out;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
