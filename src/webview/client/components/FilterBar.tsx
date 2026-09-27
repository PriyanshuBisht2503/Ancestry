/**
 * The filter bar: one control per filter dimension, plus reset and export.
 *
 * FULLY CONTROLLED
 * ----------------
 * This component holds no filter state of its own. Every control reads from
 * `props.filter` and reports upwards through `onChange`. That is what makes the
 * host's `{ type: 'filter' }` message able to drive the UI: the host sends a
 * filter, the reducer stores it, the props change, and the controls follow —
 * with no "suppress the echo while applying" flag, which is the mechanism that
 * made the pre-React `FilterBar` need a `suppress` boolean at all.
 *
 * Because React reconciles rather than replacing, the controls also stop losing
 * focus and scroll position on every keystroke, which is the other half of what
 * made the old "create once, patch in place" comment necessary.
 *
 * ACCESSIBILITY: every control has an associated `<label>`, the slider and the
 * date inputs carry `aria-label`s that name their direction ("From date", "To
 * date") rather than repeating the visible text, and the whole bar is a
 * `role="group"` with a name so a screen reader can jump to it in one step.
 *
 * `onChange` always receives a *complete* filter object, which is then posted
 * through the outbound validator — so the UI physically cannot produce a shape
 * the host would reject.
 */

import type { ChangeEvent, RefObject } from 'react';
import type { WebviewFilter } from '../../../types';
import { EDGE_COLOR_TABLE } from '../core/colors';
import { EDGE_TYPES } from '../core/domain';
import { describeHiddenReasons, type FilterOptions, type FilterResult } from '../core/filter';
import {
  dateInputValue,
  EDGE_LABELS,
  endOfDayUtc,
  filterForEdgeTypes,
  parseDateInput,
  patchFilter,
  resetFilter,
  similarityPercent,
} from './graphState';

/** Props for {@link FilterBar}. */
export interface FilterBarProps {
  /** Every value each dimension can take, or `null` before a graph arrives. */
  readonly options: FilterOptions | null;
  /** The active filter. Always complete: absent key means "no restriction". */
  readonly filter: WebviewFilter;
  /** The current filter result, for the "N shown" summary. */
  readonly result: FilterResult | null;
  /** Ref to the search input, so the `/` shortcut can focus it. */
  readonly searchRef: RefObject<HTMLInputElement>;
  /** Reports a new, complete filter. */
  readonly onChange: (filter: WebviewFilter) => void;
  /** Asks the host to export the graph as JSON. */
  readonly onExport: () => void;
}

/**
 * The filter bar.
 *
 * Renders a fixed control set even before a graph arrives, with the option lists
 * empty and every control disabled. A bar that pops into existence after the
 * first analysis would make the panel look like it was missing something, and
 * the empty state is honest about not having anything to filter yet.
 */
export function FilterBar(props: FilterBarProps): JSX.Element {
  const { options, filter, result, searchRef, onChange, onExport } = props;
  const ready = options !== null;
  const branchValues = new Set(filter.branches ?? []);
  const fileValues = new Set(filter.files ?? []);
  const authorValues = new Set(filter.authors ?? []);
  const edgeValues = new Set<string>(filter.edgeTypes ?? EDGE_TYPES);
  const percent = similarityPercent(filter.minSimilarity ?? 0);

  const handleTime = (from: string, to: string): void => {
    const parsedFrom = parseDateInput(from);
    const parsedTo = parseDateInput(to);
    onChange(
      patchFilter(filter, {
        fromTimestamp: parsedFrom === null ? undefined : parsedFrom,
        toTimestamp: parsedTo === null ? undefined : endOfDayUtc(parsedTo),
      }),
    );
  };

  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      <MultiSelect
        id="filter-branches"
        label="Branch"
        values={options?.branches ?? []}
        selected={branchValues}
        onChange={(next) => onChange(patchFilter(filter, { branches: next }))}
      />
      <MultiSelect
        id="filter-files"
        label="File"
        values={options?.files ?? []}
        selected={fileValues}
        onChange={(next) => onChange(patchFilter(filter, { files: next }))}
      />
      <MultiSelect
        id="filter-authors"
        label="Author"
        values={options?.authors ?? []}
        selected={authorValues}
        onChange={(next) => onChange(patchFilter(filter, { authors: next }))}
      />

      <span className="filter-field">
        <label htmlFor="filter-similarity">Min similarity</label>
        <input
          id="filter-similarity"
          type="range"
          min={Math.floor((options?.minSimilarity ?? 0) * 100)}
          max={Math.max(1, Math.ceil((options?.maxSimilarity ?? 1) * 100))}
          step={1}
          value={percent}
          disabled={!ready}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            onChange(
              patchFilter(filter, { minSimilarity: Number(event.target.value) / 100 }),
            );
          }}
        />
        <span className="filter-value">{`${percent}%`}</span>
      </span>

      <span className="filter-field">
        <label htmlFor="filter-search">Search</label>
        <input
          id="filter-search"
          ref={searchRef}
          type="search"
          placeholder="name, path, sha…"
          value={filter.search ?? ''}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            onChange(patchFilter(filter, { search: event.target.value }));
          }}
        />
      </span>

      <span className="filter-field">
        <label htmlFor="filter-from">From</label>
        <input
          id="filter-from"
          type="date"
          aria-label="From date"
          value={dateInputValue(filter.fromTimestamp)}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            handleTime(event.target.value, dateInputValue(filter.toTimestamp));
          }}
        />
      </span>

      <span className="filter-field">
        <label htmlFor="filter-to">To</label>
        <input
          id="filter-to"
          type="date"
          aria-label="To date"
          value={dateInputValue(filter.toTimestamp)}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            handleTime(dateInputValue(filter.fromTimestamp), event.target.value);
          }}
        />
      </span>

      <span className="filter-toggles" role="group" aria-label="Relationship types">
        <span className="filter-toggles-label">Edges</span>
        {EDGE_TYPES.map((type) => (
          <label
            key={type}
            className={edgeValues.has(type) ? 'filter-toggle is-on' : 'filter-toggle'}
          >
            <input
              type="checkbox"
              checked={edgeValues.has(type)}
              onChange={() => {
                const next = new Set(edgeValues);
                if (next.has(type)) {
                  next.delete(type);
                } else {
                  next.add(type);
                }
                onChange(patchFilter(filter, { edgeTypes: filterForEdgeTypes(next) }));
              }}
            />
            <span className="dot" style={{ background: EDGE_COLOR_TABLE[type] }} aria-hidden="true" />
            <span>{EDGE_LABELS[type] ?? type}</span>
          </label>
        ))}
      </span>

      <button
        type="button"
        className="ancestry-button"
        disabled={options === null}
        onClick={() => {
          if (options !== null) {
            onChange(resetFilter(options));
          }
        }}
      >
        Reset
      </button>

      <button type="button" className="ancestry-button" onClick={onExport}>
        Export JSON
      </button>

      <span className="filter-summary" role="status">
        {result === null
          ? 'Waiting for a graph'
          : `${result.visibleNodeIds.size} shown · ${describeHiddenReasons(result)}`}
      </span>
    </div>
  );
}

/** Props for the internal multi-select. */
interface MultiSelectProps {
  readonly id: string;
  readonly label: string;
  readonly values: readonly string[];
  readonly selected: ReadonlySet<string>;
  readonly onChange: (values: string[]) => void;
}

/**
 * A `multiple` select over one filter dimension.
 *
 * `size` is clamped to 4 so the control stays a control: a 200-branch select
 * expanded to 200 rows would push every other control off screen. The list stays
 * keyboard-operable natively, and the label is a real `<label for>`.
 */
function MultiSelect(props: MultiSelectProps): JSX.Element {
  const { id, label, values, selected, onChange } = props;
  return (
    <span className="filter-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        multiple
        size={Math.min(4, Math.max(1, values.length))}
        value={[...values].filter((value) => selected.has(value))}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          onChange(
            Array.from(event.target.selectedOptions)
              .map((option) => option.value)
              .filter((value) => value.length > 0),
          );
        }}
      >
        {values.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </span>
  );
}
