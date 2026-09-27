/**
 * Escaping tests, kept in their own file because escaping is the one place where
 * a regression is silent: a missed `&` does not throw, it just produces a panel
 * that renders (or does not render) the wrong thing.
 *
 * Two contexts matter and they are not the same:
 *   1. the document, where `html.ts` interpolates a title and two URIs into
 *      static markup — covered here through `buildWebviewHtml`;
 *   2. the DOM, where every user-controlled string goes through `textContent`
 *      and therefore needs *no* escaping at all — asserted at the bottom, as a
 *      reminder that adding an escaper there would be a smell.
 */

import { describe, expect, it } from 'vitest';
import { buildWebviewHtml, escapeHtml } from '../../src/webview/html';

const BASE = {
  cspSource: 'vscode-webview://host',
  nonce: 'f'.repeat(32),
  scriptUri: 'vscode-webview://host/media/webview.js',
  styleUri: 'vscode-webview://host/media/webview.css',
  title: 'Ancestry',
};

/** Payloads a hostile commit subject or branch name could plausibly contain. */
const PAYLOADS = [
  '<script>window.x=1</script>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '</title></head><body><script>1</script>',
  '&lt;already escaped&gt;',
  '"><svg/onload=alert(1)>',
  'javascript:alert(1)',
  '`${process.env.SECRET}`',
  '${7*7}',
  ']]><!--',
] as const;

describe('escapeHtml — text and quoted-attribute contexts', () => {
  it('neutralises every payload', () => {
    for (const payload of PAYLOADS) {
      const escaped = escapeHtml(payload);
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
      expect(escaped).not.toContain('"');
      expect(escaped).not.toContain("'");
    }
  });

  it('leaves no raw ampersand behind', () => {
    // A lone `&` is the classic double-decoding bug: the browser sees `&amp`
    // and, for some entity names, decodes part of it a second time.
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('escapes the title so it cannot close the <title> element', () => {
    const html = buildWebviewHtml({ ...BASE, title: '</title><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;');
  });

  it('escapes a script URI so it cannot add an attribute', () => {
    const html = buildWebviewHtml({ ...BASE, scriptUri: 'x" onload="alert(1)' });
    const tag = /<script[^>]*src=[^>]*>/.exec(html)?.[0] ?? '';
    // Exactly one quoted pair for `nonce` and one for `src`: the injected quote
    // was escaped, so it did not open a third attribute.
    expect(tag.match(/"/g) ?? []).toHaveLength(4);
    expect(tag).toContain('&quot;');
  });

  it('escapes a style URI the same way', () => {
    const html = buildWebviewHtml({ ...BASE, styleUri: 'x"><script>1</script>' });
    expect(html).not.toContain('<script>1</script>');
  });

  it('does not let a hostile title break out into a script tag', () => {
    for (const payload of PAYLOADS) {
      const html = buildWebviewHtml({ ...BASE, title: payload });
      const scripts = html.match(/<script[^>]*>/g) ?? [];
      // Exactly the two we emit: the bootstrap and the bundle.
      expect(scripts).toHaveLength(2);
      for (const tag of scripts) {
        expect(tag).toContain(`nonce="${BASE.nonce}"`);
      }
    }
  });

  it('leaves a hostile nonce unable to inject a CSP directive', () => {
    const hostile = "'; script-src * 'x";
    const html = buildWebviewHtml({ ...BASE, nonce: hostile });
    const sanitized = hostile.replace(/[^A-Za-z0-9]/g, '');
    // The nonce is reduced to alphanumerics, so it cannot close the directive
    // and append a wildcard source of its own.
    expect(html).toContain(`script-src 'nonce-${sanitized}'`);
    expect(html).not.toContain('script-src *');
    // …and the two occurrences (CSP + both script tags) stay identical, so the
    // panel still loads rather than failing closed with a broken policy.
    expect(html).toContain(`<script nonce="${sanitized}">`);
    expect(html).toContain(`<script nonce="${sanitized}" src=`);
  });
});

describe('DOM context — textContent needs no escaper', () => {
  it('is a no-op that must not be reintroduced in the webview client', () => {
    // `panel.ts` sets `element.textContent` directly. This assertion documents
    // *why*: the DOM assigns text, it does not parse markup, so escaping there
    // would double-encode and show `&amp;` to the user.
    const value = '<b>not bold</b>';
    expect(escapeHtml(value)).not.toBe(value);
    expect(value).toBe(value);
  });
});
