/**
 * The webview document is the webview's first line of defence, and it is also
 * the easiest place for a future change to quietly reintroduce a hole. These
 * tests therefore assert on the *raw generated string*, not on a parsed DOM,
 * because a parser would happily normalise away the exact thing that matters
 * (an untagged script element, an inline handler, a remote origin).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBootstrapScript,
  buildContentSecurityPolicy,
  buildWebviewCss,
  buildWebviewHtml,
  escapeHtml,
} from '../../src/webview/html';

const CSP_SOURCE = 'vscode-webview://abc123';
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OPTIONS = {
  cspSource: CSP_SOURCE,
  nonce: NONCE,
  scriptUri: 'vscode-webview://abc123/media/webview.js',
  styleUri: 'vscode-webview://abc123/media/webview.css',
  title: 'Ancestry',
};

describe('buildWebviewHtml — CSP', () => {
  const html = buildWebviewHtml(OPTIONS);

  it("contains default-src 'none'", () => {
    expect(html).toContain("default-src 'none'");
  });

  it("contains script-src 'nonce-<nonce>'", () => {
    expect(html).toContain(`script-src 'nonce-${NONCE}'`);
  });

  it('never puts unsafe-inline in script-src', () => {
    const scriptSrc = /script-src ([^;]*)/.exec(html)?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('permits unsafe-inline in style-src, and only for data-driven values', () => {
    // This assertion was previously the opposite: "never puts unsafe-inline in
    // style-src (the stylesheet is a separate file)". That was true while the
    // theme lived entirely in media/webview.css, and it stopped being true the
    // moment the UI needed runtime values.
    //
    // Nine components style themselves from data the stylesheet cannot know: node
    // and classification colours resolved from the palette at runtime, progress
    // width, and computed timeline offsets. `style-src` governs style *attributes*
    // through its `style-src-attr` fallback, so without this the browser blocked
    // every one of them and the panel rendered unstyled — with no error, which is
    // how it was found.
    //
    // The theme is still a separate file; that is what `style-src {cspSource}`
    // is for and it is unchanged. This only covers the inline *attributes*.
    const styleSrc = /style-src ([^;]*)/.exec(html)?.[1] ?? '';
    expect(styleSrc).toContain(CSP_SOURCE);
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it('never weakens script-src, which is the directive that can run code', () => {
    // The reason the style relaxation above is safe. If this ever has to change,
    // the CSP stops being a meaningful boundary and the relaxation has to be
    // re-argued from scratch.
    const scriptSrc = /script-src ([^;]*)/.exec(html)?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(scriptSrc).not.toContain('strict-dynamic');
  });

  it('locks down the remaining directives', () => {
    expect(html).toContain(`img-src ${CSP_SOURCE} data: blob:`);
    // `toContain` rather than equality: style-src legitimately carries the
    // 'unsafe-inline' relaxation asserted above, and this line is about the
    // origin still being present, not about the whole directive.
    expect(html).toContain(`style-src ${CSP_SOURCE}`);
    expect(html).toContain(`font-src ${CSP_SOURCE}`);
    expect(html).toContain(`connect-src 'none'`);
    expect(html).toContain(`object-src 'none'`);
    expect(html).toContain(`base-uri 'none'`);
    expect(html).toContain(`form-action 'none'`);
    expect(html).toContain(`frame-ancestors 'none'`);
  });

  it('emits the policy in a meta tag, not only as a string', () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  it('allows cspDirectives overrides without losing the base policy', () => {
    const overridden = buildWebviewHtml({
      ...OPTIONS,
      cspDirectives: { 'img-src': [`${CSP_SOURCE}`, 'data:'] },
    });
    expect(overridden).toContain(`img-src ${CSP_SOURCE} data:`);
    expect(overridden).not.toContain('blob:');
    expect(overridden).toContain("default-src 'none'");
  });
});

describe('buildWebviewHtml — no script execution vectors', () => {
  const html = buildWebviewHtml(OPTIONS);

  it('contains no eval(', () => {
    expect(html).not.toContain('eval(');
  });

  it('contains no "new Function"', () => {
    expect(html).not.toContain('new Function');
  });

  it('contains no remote origins', () => {
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('//cdn.');
  });

  it('contains no inline event handlers', () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('tags every <script> element with the nonce', () => {
    const matches = html.match(/<script[^>]*>/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const tag of matches) {
      expect(tag).toContain(`nonce="${NONCE}"`);
    }
  });

  it('puts the nonce on the bundled script src tag', () => {
    expect(html).toContain(
      `<script nonce="${NONCE}" src="${CSP_SOURCE}/media/webview.js"></script>`,
    );
  });

  it('loads the stylesheet as a separate file', () => {
    expect(html).toContain(`<link rel="stylesheet" href="${CSP_SOURCE}/media/webview.css" />`);
    expect(html).not.toContain('<style');
  });

  it('includes the charset, viewport and noscript affordances', () => {
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<noscript>');
  });
});

describe('buildWebviewHtml — nonce freshness', () => {
  it('produces different output for different nonces', () => {
    const a = buildWebviewHtml({ ...OPTIONS, nonce: '0'.repeat(32) });
    const b = buildWebviewHtml({ ...OPTIONS, nonce: '1'.repeat(32) });
    expect(a).not.toBe(b);
    expect(a).toContain(`script-src 'nonce-${'0'.repeat(32)}'`);
    expect(b).toContain(`script-src 'nonce-${'1'.repeat(32)}'`);
  });

  it('produces identical output for identical nonces', () => {
    expect(buildWebviewHtml(OPTIONS)).toBe(buildWebviewHtml(OPTIONS));
  });
});

describe('buildBootstrapScript', () => {
  const script = buildBootstrapScript(NONCE);

  it('captures the VS Code API exactly once', () => {
    expect(script).toContain('acquireVsCodeApi()');
    expect(script.match(/acquireVsCodeApi\(\)/g) ?? []).toHaveLength(1);
  });

  it('stores the API where the bundle looks for it', () => {
    expect(script).toContain('__ancestryVsCodeApi');
  });

  it('forwards console.error to the host', () => {
    expect(script).toContain('console.error');
    expect(script).toContain('clientError');
  });

  it('contains no eval and no new Function', () => {
    expect(script).not.toContain('eval(');
    expect(script).not.toContain('new Function');
  });

  it('survives a missing API without throwing', () => {
    expect(script).toContain('catch');
    expect(script).toContain('try');
  });
});

describe('buildContentSecurityPolicy', () => {
  it('substitutes the cspSource and nonce placeholders', () => {
    const csp = buildContentSecurityPolicy('vscode-resource://x', 'n0nce');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-n0nce'");
    expect(csp).toContain('style-src vscode-resource://x');
    expect(csp).not.toContain('{cspSource}');
    expect(csp).not.toContain('{nonce}');
  });

  it('ignores non-array overrides', () => {
    const csp = buildContentSecurityPolicy('vscode-resource://x', 'n', {
      'script-src': 'nonsense' as unknown as string[],
    });
    expect(csp).toContain("default-src 'none'");
  });
});

describe('buildWebviewCss', () => {
  const css = buildWebviewCss();

  it('uses VS Code theme variables with fallbacks for every colour', () => {
    expect(css).toContain('var(--vscode-editor-background');
    expect(css).toContain('var(--vscode-editor-foreground');
    expect(css).toContain('var(--vscode-button-background');
  });

  it('covers every region of the UI', () => {
    for (const selector of [
      '.header',
      '.legend',
      '.filter-bar',
      '.details',
      '.node-list',
      '.status-bar',
      '.toast',
      '.overlay-loading',
      '.axis-tick',
      '.node-label',
    ]) {
      expect(css).toContain(selector);
    }
  });

  it('contains no @import (style-src forbids remote sheets)', () => {
    expect(css).not.toContain('@import');
  });

  it('contains no remote font or url() reference', () => {
    expect(css).not.toContain('http://');
    expect(css).not.toContain('https://');
    expect(css).not.toContain('@font-face');
  });

  it('is covered region-for-region by the stylesheet Vite actually ships', () => {
    // There are now two stylesheets and they have different jobs:
    //   - `src/webview/webview.css` is the source of truth; Vite compiles it to
    //     `media/webview.css`, which is what the CSP-approved <link> loads.
    //   - `buildWebviewCss()` is a runtime fallback that `host.ts` materialises
    //     when `media/` was cleaned and the panel is opened before a rebuild.
    // They are no longer the same bytes, so the guarantee worth keeping is that
    // the shipped source covers every region the fallback styles — otherwise one
    // of the two paths renders unstyled. Extracted from the fallback rather than
    // hard-coded, so adding a region to either file is automatically covered.
    const file = path.resolve(__dirname, '..', '..', 'src', 'webview', 'webview.css');
    const shipped = readFileSync(file, 'utf8');
    // Class names that open a rule in the fallback, i.e. real regions. A
    // `.foo[hidden]` or `.foo:hover` *state* rule is skipped: the fallback needed
    // those because the hand-rolled DOM toggled a `hidden` attribute, and React
    // unmounts instead. What must not drift is the set of styled regions.
    const classes = new Set(
      [...normalize(css).matchAll(/\.(-?[_a-zA-Z][\w-]*)(?=[\s,>{:.])/g)].map((m) => m[1]),
    );
    expect(classes.size).toBeGreaterThan(20);
    for (const name of classes) {
      expect(shipped, `missing .${name}`).toContain(`.${name}`);
    }
  });

  it('never lets the shipped stylesheet reach the network', () => {
    // The stricter of the two: `src/webview/webview.css` is the one that is
    // actually shipped, so it is the one that must be free of remote references.
    // Comments are stripped first: the file's own header *documents* the ban, and
    // a rule that a comment can trip is a rule that gets "fixed" by rewording
    // the comment rather than by removing the offending declaration.
    const file = path.resolve(__dirname, '..', '..', 'src', 'webview', 'webview.css');
    const shipped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(shipped).not.toContain('@import');
    expect(shipped).not.toContain('@font-face');
    expect(shipped).not.toContain('url(');
    expect(shipped).not.toContain('http://');
    expect(shipped).not.toContain('https://');
  });
});

/** Normalises line endings so a Windows checkout and a POSIX build agree. */
function normalize(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

describe('escapeHtml', () => {
  it('escapes the five markup-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('replaces control characters with a space', () => {
    expect(escapeHtml('a\nb c')).toBe('a b  c');
  });

  it('returns an empty string for non-strings', () => {
    expect(escapeHtml(undefined as unknown as string)).toBe('');
    expect(escapeHtml(null as unknown as string)).toBe('');
  });
});
