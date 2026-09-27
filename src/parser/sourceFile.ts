/**
 * Single place where a string becomes a `ts.SourceFile`.
 *
 * Every Ancestry code path that needs an AST goes through {@link createSourceFile}
 * for two reasons:
 *
 *  1. **One dialect decision.** JSX is only recognised when the script kind says
 *     so. Deriving the dialect per call site is how a `.tsx` component silently
 *     ends up parsed as broken TypeScript, which then produces garbage blocks and
 *     false "no match found" answers months later.
 *  2. **`parent` links are always present.** {@link buildQualifiedName} and the
 *     block extractor walk `node.parent`; forgetting `setParentNodes` turns a
 *     whole-file parse into a silent runtime `TypeError`. Centralising the call
 *     makes that impossible.
 *
 * `src/normalization` re-parses standalone block text through this function so a
 * block extracted from `service.ts` and the same block pasted into a scratch
 * buffer are tokenised by exactly the same rules.
 */

import * as ts from 'typescript';
import type { SourceRange, SupportedLanguage } from '../types';

/**
 * Chooses the compiler's parser dialect for a language tag.
 *
 * `unknown` deliberately maps to TypeScript rather than to a "no parse" result:
 * a repository contains plenty of extension-less or exotic files whose content
 * is still valid TypeScript, and refusing to parse them would make Ancestry
 * blind to a chunk of a repository for no benefit. The `language` field on the
 * result is still reported as `unknown` so callers can filter.
 */
export function getScriptKind(language: SupportedLanguage): ts.ScriptKind {
  switch (language) {
    case 'typescript':
      return ts.ScriptKind.TS;
    case 'javascript':
      return ts.ScriptKind.JS;
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'jsx':
      return ts.ScriptKind.JSX;
    case 'unknown':
    default:
      // Permissive default: an unlabelled file is still worth parsing as TS.
      return ts.ScriptKind.TS;
  }
}

/**
 * Creates a `ts.SourceFile` with parent pointers populated.
 *
 * `filePath` is passed to the compiler (not just stored) so that JSX/TSX
 * detection and any future path-sensitive compiler behaviour stays correct when
 * this function is called with a synthetic path.
 */
export function createSourceFile(
  filePath: string,
  text: string,
  language: SupportedLanguage,
): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    getScriptKind(language),
  );
}

/**
 * Projects a node onto the domain {@link SourceRange}.
 *
 * Two subtleties are encoded here rather than at every call site:
 *
 *  - `node.getStart(sf, includeJsDoc)` skips *leading trivia*. With
 *    `includeJsDoc = false` a doc comment that precedes a declaration belongs to
 *    the declaration's `fullStart`, not to the declaration, so the block text is
 *    the code and nothing else. A decorator, by contrast, is a real child node
 *    that precedes the name, so it stays inside the range — dropping it would
 *    detach `@Injectable()` from the class it annotates.
 *  - `getEnd()` is exclusive. For a construct that ends in `}` the exclusive end
 *    lands on the *same* line as the closing brace, so `endLine` is already the
 *    last line of the block and needs no clamping.
 */
export function toSourceRange(node: ts.Node, sf: ts.SourceFile, includeJsDoc = false): SourceRange {
  const startOffset = node.getStart(sf, includeJsDoc);
  const endOffset = node.getEnd();
  const start = sf.getLineAndCharacterOfPosition(startOffset);
  const end = sf.getLineAndCharacterOfPosition(endOffset);
  return {
    startOffset,
    endOffset,
    startLine: start.line + 1,
    startColumn: start.character,
    endLine: end.line + 1,
    endColumn: end.character,
  };
}
