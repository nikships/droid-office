import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');

function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing rule: ${selector}`);
  return match[1];
}

test('office and companion share thin dark scrollbars on both axes', () => {
  for (const page of ['index', 'dashboard']) {
    const html = readFileSync(new URL(`../src/client/${page}.html`, import.meta.url), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\.\/style\.css"/);
  }
  assert.match(rule(':root'), /color-scheme:\s*dark;/);
  assert.match(rule('::-webkit-scrollbar'), /width:\s*8px;\s*height:\s*8px;/);
  assert.match(rule('::-webkit-scrollbar-track, ::-webkit-scrollbar-corner'), /background:\s*transparent;/);
  assert.match(rule('::-webkit-scrollbar-thumb'), /background:\s*var\(--border-strong\);/);
  assert.match(rule('::-webkit-scrollbar-thumb'), /border-radius:\s*3px;/);
  assert.match(rule('::-webkit-scrollbar-thumb:hover'), /background-color:\s*var\(--text-tertiary\);/);
  assert.match(rule('::-webkit-scrollbar-button'), /display:\s*none;/);
});

test('standard scrollbar styling cannot override WebKit styling outside the fallback', () => {
  const fallback = /@supports not selector\(::-webkit-scrollbar\)\s*\{\s*\*\s*\{([^}]+)\}\s*\}/;
  const match = css.match(fallback);
  assert.ok(match);
  assert.match(match[1], /scrollbar-width:\s*thin;/);
  assert.match(match[1], /scrollbar-color:\s*var\(--border-strong\)\s+transparent;/);
  const rest = css.replace(fallback, '');
  for (const declaration of rest.matchAll(/scrollbar-width:([^;]+);/g)) {
    assert.equal(declaration[1].trim(), 'none');
  }
  assert.doesNotMatch(rest, /scrollbar-color:/);
  assert.match(rule('.dash-workers'), /overflow:\s*auto;/);
});

test('compact navigation strips hide scrollbars without disabling scrolling', () => {
  for (const selector of ['.mp-chips', '.dash-floor-strip', '.dash-team-nav-members']) {
    assert.match(rule(selector), /overflow-x:\s*auto;/);
    assert.match(rule(selector), /scrollbar-width:\s*none;/);
    assert.match(rule(`${selector}::-webkit-scrollbar`), /display:\s*none;/);
  }
});
