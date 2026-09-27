/**
 * Structural feature extraction.
 *
 * A bag of counts is the cheapest similarity signal Ancestry has: it is order
 * independent, it is tiny compared with the token stream, and it catches gross
 * differences (a loop became a recursion, four parameters became two) that a
 * token-level comparison would only discover after doing far more work. The
 * counts feed the `shape` component of `SimilarityBreakdown` in `src/similarity`.
 *
 * Cosine similarity itself is **not** computed here. It belongs to the scoring
 * module, which owns the weights and the classification thresholds; duplicating
 * the maths in two places is how the two copies drift apart.
 *
 * Namespaces in the returned vector:
 *  - `node:<SyntaxKind>` — one per token, so a construct that disappeared shows up
 *    as a dropped coordinate.
 *  - `op:<text>` — operators, `punc:<text>` — punctuation. Verbatim, because
 *    `+` → `-` is a real difference.
 *  - `kw:<word>` — keywords, already canonicalised (`const`/`let`/`var` are one).
 *  - `role:<role>` — identifier roles recovered from the token values. Only
 *    `param` and "everything else canonicalised" are distinguishable at the token
 *    level, so {@link featureVectorFor} recomputes the precise nine roles from
 *    the AST.
 *  - aggregates — `depth`, `maxDepth`, `branchCount`, `loopCount`, `callCount`,
 *    `paramCount`, `returnCount`, `literalCount`, `tokenCount`.
 *
 * All values are non-negative counts, which keeps the vector directly usable by
 * a cosine implementation.
 */

import * as ts from 'typescript';
import type { NormalizedToken } from '../types';
import { classifyIdentifier, collectDeclaredNames } from './identifiers';

/** Node kinds that introduce a branch. */
const BRANCH_KINDS: ReadonlySet<string> = new Set([
  'IfStatement',
  'ConditionalExpression',
  'SwitchStatement',
  'CaseClause',
  'DefaultClause',
  'CaseBlock',
  'CatchClause',
  'SwitchCase',
]);

/** Node kinds that introduce a loop. */
const LOOP_KINDS: ReadonlySet<string> = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForAwaitStatement',
  'WhileStatement',
  'DoStatement',
]);

/** Node kinds that count as "one call happened here". */
const CALL_KINDS: ReadonlySet<string> = new Set([
  'CallExpression',
  'NewExpression',
  'TaggedTemplateExpression',
]);

/** Value prefixes that identify a token's identifier role. */
const ROLE_PREFIXES: ReadonlyArray<[string, string]> = [
  ['ext:', 'external'],
  ['prop:', 'property'],
  ['type:', 'type'],
  ['mod:', 'import'],
  ['label:', 'label'],
];

/** Aggregate keys, in the order `summarizeAst` reports them. */
const SUMMARY_KEYS: ReadonlyArray<[string, string]> = [
  ['paramCount', 'params'],
  ['returnCount', 'returns'],
  ['loopCount', 'loops'],
  ['branchCount', 'branches'],
  ['callCount', 'calls'],
  ['maxDepth', 'maxDepth'],
];

function bump(features: Record<string, number>, key: string, by = 1): void {
  features[key] = (features[key] ?? 0) + by;
}

/**
 * Token-level feature vector.
 *
 * Derives the identifier role from the token value, which is enough for the five
 * preserved roles; `id:n` values are split by token kind, so parameters are
 * counted separately from other canonicalised names. Use {@link featureVectorFor}
 * when the AST is at hand and the exact nine roles matter.
 */
export function extractFeatures(tokens: readonly NormalizedToken[]): Record<string, number> {
  const features: Record<string, number> = {};
  let maxDepth = 0;
  let depthMarked = 0;
  let literalCount = 0;

  for (const token of tokens) {
    bump(features, `node:${token.nodeType}`);
    if (token.depth > maxDepth) {
      maxDepth = token.depth;
    }
    if (token.value.charCodeAt(0) === 0x64 /* d */ && isDigitCode(token.value.charCodeAt(1))) {
      depthMarked += 1;
    }
    switch (token.kind) {
      case 'keyword':
        bump(features, token.value.startsWith('kw:') ? token.value : `kw:${token.value}`);
        break;
      case 'operator':
        bump(features, `op:${token.value}`);
        break;
      case 'punct':
        if (!token.value.startsWith('s:') && !token.value.startsWith('d')) {
          bump(features, `punc:${token.value}`);
        }
        break;
      case 'literal':
        literalCount += 1;
        break;
      default:
        for (const [prefix, role] of ROLE_PREFIXES) {
          if (token.value.startsWith(prefix)) {
            bump(features, `role:${role}`);
            break;
          }
        }
        if (token.value.startsWith('id:')) {
          bump(features, `role:${token.kind === 'param' ? 'param' : 'local'}`);
        }
        break;
    }
    if (BRANCH_KINDS.has(token.nodeType)) {
      bump(features, 'branchCount');
    }
    if (LOOP_KINDS.has(token.nodeType)) {
      bump(features, 'loopCount');
    }
    if (CALL_KINDS.has(token.nodeType)) {
      bump(features, 'callCount');
    }
    if (token.nodeType === 'Parameter') {
      bump(features, 'paramCount');
    }
    if (token.nodeType === 'ReturnStatement') {
      bump(features, 'returnCount');
    }
  }

  features['depth'] = depthMarked;
  features['maxDepth'] = maxDepth;
  features['literalCount'] = literalCount;
  features['tokenCount'] = tokens.length;
  return features;
}

function isDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Feature vector enriched with AST-derived facts.
 *
 * Adds the exact nine identifier roles (the token stream cannot tell a `local`
 * from a `function` or a `member`, because all three are `id:n`) and the root
 * construct's kind, which lets the `shape` score separate a function from a
 * class of the same size.
 */
export function featureVectorFor(
  root: ts.Node,
  tokens: readonly NormalizedToken[],
): Record<string, number> {
  const features = extractFeatures(tokens);
  const declared = collectDeclaredNames(root);
  // One representative per role: a count of *distinct roles present* answers
  // "what kinds of name does this block use?", which is what the `shape` score
  // needs, and stays stable as a block grows.
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const key = `role:${classifyIdentifier(node, root, declared)}`;
      if (!seen.has(key)) {
        bump(features, key);
        seen.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  bump(features, `root:${ts.SyntaxKind[root.kind]}`);
  return features;
}

/**
 * One-line structural summary, e.g. `params:2 returns:1 loops:1 branches:2 calls:5 maxDepth:4`.
 *
 * Intended for tooltips and the graph's "why" line: it answers "how big and how
 * branchy is this block" without showing a token stream. Fields are always
 * present, in a fixed order, so the string is diffable and testable.
 */
export function summarizeAst(root: ts.Node, tokens: readonly NormalizedToken[]): string {
  const features = featureVectorFor(root, tokens);
  return SUMMARY_KEYS.map(([key, label]) => `${label}:${features[key] ?? 0}`).join(' ');
}
