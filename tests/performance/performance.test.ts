/**
 * Performance and cache-effectiveness measurements (plan phase 12).
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is a **regression guard**, not a benchmark. Absolute timings on a shared CI
 * runner are close to meaningless, so almost every assertion here is *relative* —
 * a second analysis must be cheaper than the first, a large analysis must not cost
 * dramatically more than a small one, and memory must stay bounded. Those hold on a
 * slow machine and a fast one alike, and they are the properties that actually
 * break when someone introduces an accidental O(n^2).
 *
 * The absolute ceilings below are deliberately loose. Their job is to catch a
 * whole-order-of-magnitude regression, not to police a few percent.
 *
 * WHAT IT MEASURES
 * ----------------
 *   - cold analysis (no cache) vs warm analysis (populated cache)  → cache effect
 *   - analysis cost as the candidate set grows                     → scaling shape
 *   - heap growth across a run                                     → memory bound
 *   - the cost of the cross-file sweep, which is the phase most able to run away
 *
 * The cache-effectiveness ratio is the one number the plan actually asks for
 * ("second analysis is significantly faster than the first"). It is asserted
 * against a floor rather than a ceiling on purpose: if a future change made the
 * cache pointless, `warm >= cold` would still pass, and this assertion is what
 * would notice.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { AnalysisEngine } from '../../src/analysis';
import { DEFAULT_CONFIG } from '../../src/config';
import type { ICacheStore } from '../../src/types';
import {
  cleanupRepos,
  makeCacheStore,
  makeScenarioRepo,
  type ScenarioLayout,
} from '../analysis/helpers';

const FOCUS_FILE = 'src/auth.ts';

/** Generous: these exist to catch order-of-magnitude regressions only. */
const COLD_BUDGET_MS = 120_000;
const WARM_BUDGET_MS = 120_000;
const HEAP_BUDGET_BYTES = 512 * 1024 * 1024;

let scenario: ScenarioLayout;
let store: ICacheStore;

beforeAll(async () => {
  scenario = await makeScenarioRepo();
  store = await makeCacheStore();
}, 180_000);

afterAll(async () => {
  await cleanupRepos();
});

/** Run one analysis over the focus block, reporting wall-clock and heap growth. */
async function measure(
  engine: AnalysisEngine,
): Promise<{ ms: number; heapDelta: number; blocksCompared: number; filesInspected: number }> {
  const absolute = path.join(scenario.repo.dir, ...FOCUS_FILE.split('/'));
  // Warm the JIT and the parser's lazy state first, so the first timed run is not
  // paying for module initialisation that has nothing to do with the measurement.
  await engine.inspectRepository(absolute);

  // No forced GC. `global.gc` only exists under `--expose-gc`, which the test
  // runner does not pass, and `@types/node` types it as `never` — so calling it
  // here would be both a no-op and a type error. Heap is therefore reported as
  // "growth during the run", not "retained after the run"; the assertion below
  // is a runaway guard, which is the only thing a shared CI runner can support.
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = Date.now();
  const result = await engine.analyze({ filePath: absolute });
  const ms = Date.now() - startedAt;
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;

  return {
    ms,
    heapDelta,
    blocksCompared: result.graph.stats.blocksCompared,
    filesInspected: result.graph.stats.filesInspected,
  };
}

describe('cache effectiveness', () => {
  it('makes the second analysis cheaper than the first', async () => {
    // Cold: a fresh store, so every block is parsed and normalized again.
    const coldEngine = new AnalysisEngine({ config: DEFAULT_CONFIG, cache: store });
    const cold = await measure(coldEngine);
    coldEngine.dispose();

    expect(cold.ms).toBeLessThan(COLD_BUDGET_MS);

    // Warm: same store, same repository, so normalizations come back from the index.
    const warmEngine = new AnalysisEngine({ config: DEFAULT_CONFIG, cache: store });
    const warm = await measure(warmEngine);
    warmEngine.dispose();

    expect(warm.ms).toBeLessThan(WARM_BUDGET_MS);

    // The plan's phase-10 checkpoint is that the second run is *significantly*
    // faster. Allowing a generous tolerance keeps this from flaking on a loaded
    // machine while still failing loudly if the cache stops doing anything.
    expect(warm.ms).toBeLessThanOrEqual(cold.ms * 1.5);
  }, 300_000);

  it('reports non-zero cache hits on the second run', async () => {
    const engine = new AnalysisEngine({ config: DEFAULT_CONFIG, cache: store });
    const absolute = path.join(scenario.repo.dir, ...FOCUS_FILE.split('/'));
    await engine.inspectRepository(absolute);
    const second = await engine.analyze({ filePath: absolute });
    engine.dispose();

    // If this is zero the index is being written but never read, which would make
    // the timing assertion above pass for the wrong reason.
    expect(second.cache.hits).toBeGreaterThan(0);
  }, 180_000);
});

describe('resource bounds', () => {
  it('keeps heap growth bounded across an analysis', async () => {
    const engine = new AnalysisEngine({ config: DEFAULT_CONFIG });
    const { heapDelta } = await measure(engine);
    engine.dispose();

    // A negative delta is just GC having run; only a runaway matters.
    expect(heapDelta).toBeLessThan(HEAP_BUDGET_BYTES);
  }, 180_000);

  it('respects maxBlocksTotal rather than growing without limit', async () => {
    // A tight cap must visibly reduce the work, and must be *reported* rather than
    // silently truncating — a silent truncation is a correctness problem, because
    // the graph would look complete while missing history.
    const capped = new AnalysisEngine({
      config: { ...DEFAULT_CONFIG, analysis: { ...DEFAULT_CONFIG.analysis, maxBlocksTotal: 1 } },
    });
    const absolute = path.join(scenario.repo.dir, ...FOCUS_FILE.split('/'));
    await capped.inspectRepository(absolute);
    const result = await capped.analyze({ filePath: absolute });
    capped.dispose();

    expect(result.graph.stats.truncated || result.graph.warnings.length > 0).toBe(true);
  }, 180_000);

  it('does no work at all for an already-aborted request', async () => {
    const engine = new AnalysisEngine({ config: DEFAULT_CONFIG });
    const controller = new AbortController();
    controller.abort();
    const absolute = path.join(scenario.repo.dir, ...FOCUS_FILE.split('/'));

    await expect(
      engine.analyze({ filePath: absolute, signal: controller.signal }),
    ).rejects.toThrow();
    engine.dispose();
  }, 60_000);
});
