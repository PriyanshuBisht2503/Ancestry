/**
 * Typed access to the `ancestry.*` settings.
 *
 * Every value has a hard default so the engine is fully functional even if the
 * user's settings file is missing, malformed, or out of range. Nothing here
 * throws — bad configuration degrades to the default and is reported through the
 * logger, because a malformed setting must never break the extension host.
 */
import * as vscode from 'vscode';
import type { SimilarityThresholds } from './types';

export const CONFIG_SECTION = 'ancestry';

export interface AncestryConfig extends SimilarityThresholds {
  git: {
    maxHistoryDepth: number;
    maxFileSizeBytes: number;
    maxRepositorySizeBytes: number;
  };
  similarity: {
    candidateWindow: number;
    shingleSize: number;
  };
  analysis: {
    followRenames: boolean;
    includeAllBranches: boolean;
    maxBlocksPerFile: number;
    maxBlocksTotal: number;
    includeTests: boolean;
  };
  cache: {
    enabled: boolean;
    maxAgeDays: number;
    backend: 'auto' | 'sqlite' | 'file';
  };
  privacy: {
    logSourceCode: boolean;
  };
  experimental: {
    workers: boolean;
  };
  telemetry: {
    enabled: boolean;
  };
}

export const DEFAULT_CONFIG: AncestryConfig = Object.freeze({
  strong: 0.9,
  possible: 0.75,
  ignore: 0.6,
  git: Object.freeze({
    maxHistoryDepth: 2000,
    maxFileSizeBytes: 2 * 1024 * 1024,
    maxRepositorySizeBytes: 5 * 1024 * 1024 * 1024,
  }),
  similarity: Object.freeze({
    candidateWindow: 6,
    shingleSize: 4,
  }),
  analysis: Object.freeze({
    followRenames: true,
    includeAllBranches: true,
    maxBlocksPerFile: 500,
    maxBlocksTotal: 200_000,
    includeTests: true,
  }),
  cache: Object.freeze({
    enabled: true,
    maxAgeDays: 30,
    backend: 'auto' as const,
  }),
  privacy: Object.freeze({ logSourceCode: false }),
  experimental: Object.freeze({ workers: false }),
  telemetry: Object.freeze({ enabled: false }),
}) as AncestryConfig;

type NumericBounds = { min: number; max: number };

function readNumber(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  bounds: NumericBounds,
  onBadValue?: (detail: string) => void,
): number {
  const raw = config.get<unknown>(key);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    if (raw !== undefined) {
      onBadValue?.(`${key} is not a finite number (${String(raw)}); using ${fallback}`);
    }
    return fallback;
  }
  if (raw < bounds.min || raw > bounds.max) {
    onBadValue?.(
      `${key}=${raw} is outside [${bounds.min}, ${bounds.max}]; clamping to ${fallback}`,
    );
    return fallback;
  }
  return raw;
}

function readBoolean(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: boolean,
  onBadValue?: (detail: string) => void,
): boolean {
  const raw = config.get<unknown>(key);
  if (typeof raw !== 'boolean') {
    if (raw !== undefined) {
      onBadValue?.(`${key} is not a boolean (${String(raw)}); using ${fallback}`);
    }
    return fallback;
  }
  return raw;
}

function readEnum<T extends string>(
  config: vscode.WorkspaceConfiguration,
  key: string,
  allowed: readonly T[],
  fallback: T,
  onBadValue?: (detail: string) => void,
): T {
  const raw = config.get<unknown>(key);
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    if (raw !== undefined) {
      onBadValue?.(`${key}=${String(raw)} is not one of ${allowed.join('|')}; using ${fallback}`);
    }
    return fallback;
  }
  return raw as T;
}

export function readConfig(
  scope?: vscode.ConfigurationScope,
  onBadValue?: (detail: string) => void,
): AncestryConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, scope);
  const d = DEFAULT_CONFIG;

  return {
    strong: clamp01(
      readNumber(cfg, 'similarity.strongThreshold', d.strong, { min: 0, max: 1 }, onBadValue),
    ),
    possible: clamp01(
      readNumber(cfg, 'similarity.possibleThreshold', d.possible, { min: 0, max: 1 }, onBadValue),
    ),
    // `ignore` is derived so the three thresholds stay monotonic: a user who
    // raises `possible` above `strong` must not create an unreachable band.
    ignore: d.ignore,
    git: {
      maxHistoryDepth: Math.floor(
        readNumber(
          cfg,
          'git.maxHistoryDepth',
          d.git.maxHistoryDepth,
          { min: 1, max: 100_000 },
          onBadValue,
        ),
      ),
      maxFileSizeBytes: Math.floor(
        readNumber(
          cfg,
          'git.maxFileSizeBytes',
          d.git.maxFileSizeBytes,
          { min: 1024, max: 1 << 30 },
          onBadValue,
        ),
      ),
      maxRepositorySizeBytes: Math.floor(
        readNumber(
          cfg,
          'git.maxRepositorySizeBytes',
          d.git.maxRepositorySizeBytes,
          { min: 1 << 20, max: 1 << 42 },
          onBadValue,
        ),
      ),
    },
    similarity: {
      candidateWindow: Math.floor(
        readNumber(
          cfg,
          'similarity.candidateWindow',
          d.similarity.candidateWindow,
          { min: 1, max: 32 },
          onBadValue,
        ),
      ),
      shingleSize: Math.floor(
        readNumber(
          cfg,
          'similarity.shingleSize',
          d.similarity.shingleSize,
          { min: 2, max: 16 },
          onBadValue,
        ),
      ),
    },
    analysis: {
      followRenames: readBoolean(
        cfg,
        'analysis.followRenames',
        d.analysis.followRenames,
        onBadValue,
      ),
      includeAllBranches: readBoolean(
        cfg,
        'analysis.includeAllBranches',
        d.analysis.includeAllBranches,
        onBadValue,
      ),
      maxBlocksPerFile: Math.floor(
        readNumber(
          cfg,
          'analysis.maxBlocksPerFile',
          d.analysis.maxBlocksPerFile,
          { min: 1, max: 100_000 },
          onBadValue,
        ),
      ),
      maxBlocksTotal: Math.floor(
        readNumber(
          cfg,
          'analysis.maxBlocksTotal',
          d.analysis.maxBlocksTotal,
          { min: 1, max: 10_000_000 },
          onBadValue,
        ),
      ),
      includeTests: readBoolean(cfg, 'analysis.includeTests', d.analysis.includeTests, onBadValue),
    },
    cache: {
      enabled: readBoolean(cfg, 'cache.enabled', d.cache.enabled, onBadValue),
      maxAgeDays: Math.floor(
        readNumber(cfg, 'cache.maxAgeDays', d.cache.maxAgeDays, { min: 1, max: 3650 }, onBadValue),
      ),
      backend: readEnum(
        cfg,
        'cache.backend',
        ['auto', 'sqlite', 'file'] as const,
        d.cache.backend,
        onBadValue,
      ),
    },
    privacy: {
      logSourceCode: readBoolean(cfg, 'privacy.logSourceCode', d.privacy.logSourceCode, onBadValue),
    },
    experimental: {
      workers: readBoolean(cfg, 'experimental.workers', d.experimental.workers, onBadValue),
    },
    telemetry: {
      enabled: readBoolean(cfg, 'telemetry.enabled', d.telemetry.enabled, onBadValue),
    },
  };
}

/**
 * Enforce `ignore < possible <= strong`. Invalid configurations would otherwise
 * make whole similarity bands unreachable and silently hide real matches.
 */
export function normalizeThresholds(config: AncestryConfig): SimilarityThresholds {
  const possible = clamp01(config.possible);
  let strong = clamp01(config.strong);
  if (strong < possible) {
    strong = possible;
  }
  let ignore = config.ignore;
  if (ignore >= possible) {
    ignore = possible * 0.8;
  }
  if (ignore < 0) {
    ignore = 0;
  }
  return { strong, possible, ignore };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
