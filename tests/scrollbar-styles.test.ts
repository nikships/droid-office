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

test('office and companion share slim scroll-only accent scrollbars on both axes', () => {
  for (const page of ['index', 'dashboard']) {
    const html = readFileSync(new URL(`../src/client/${page}.html`, import.meta.url), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\.\/style\.css"/);
  }
  assert.match(rule(':root'), /color-scheme:\s*dark;/);
  assert.match(rule('::-webkit-scrollbar'), /width:\s*2\.5px;\s*height:\s*2\.5px;/);
  assert.match(rule('::-webkit-scrollbar-track, ::-webkit-scrollbar-corner'), /background:\s*transparent;/);
  assert.match(rule('::-webkit-scrollbar-thumb'), /background:\s*transparent;/);
  assert.match(rule('::-webkit-scrollbar-thumb'), /border-radius:\s*999px;/);
  assert.match(rule('.user-scrolling::-webkit-scrollbar-thumb'), /background:\s*var\(--accent\);/);
  assert.match(rule('::-webkit-scrollbar-button'), /display:\s*none;/);
});

test('terminal scrollbar is hidden unless scrollable and uses a minimal neutral hairline pill', () => {
  assert.match(rule('.xterm .xterm-viewport'), /scrollbar-width:\s*none;/);
  assert.match(rule('.xterm .xterm-viewport::-webkit-scrollbar'), /display:\s*none;/);
  assert.match(css, /\.xterm \.xterm-scrollable-element > \.scrollbar,\n\.xterm \.xterm-scrollable-element > \.scrollbar\.vertical \{ opacity: 0; pointer-events: none; background: transparent; transition: none; \}/);
  const scrollableBar = rule('.xterm.term-scrollable .xterm-scrollable-element > .scrollbar.vertical');
  assert.match(scrollableBar, /pointer-events:\s*auto;/);
  assert.match(scrollableBar, /z-index:\s*11;/);
  assert.match(scrollableBar, /transition:\s*opacity 280ms var\(--ease\);/);
  assert.match(rule('.xterm.term-scrollable.term-scrollbar-quiet .xterm-scrollable-element > .scrollbar.vertical'), /transition:\s*none;/);
  assert.match(rule('.xterm .xterm-scrollable-element > .scrollbar > .slider'), /background:\s*transparent\s*!important;/);
  const pill = rule('.xterm .xterm-scrollable-element > .scrollbar.vertical > .slider::before');
  assert.match(pill, /width:\s*3px;/);
  assert.match(pill, /border-radius:\s*999px;/);
  assert.match(pill, /background:\s*rgba\(255,\s*255,\s*255,\s*\.22\);/);
  assert.doesNotMatch(pill, /var\(--accent\)/);
  const hoverPill = rule('.xterm.term-scrollable .xterm-scrollable-element > .scrollbar.vertical:hover > .slider::before');
  assert.match(hoverPill, /width:\s*5px;/);
  assert.match(hoverPill, /background:\s*rgba\(255,\s*255,\s*255,\s*\.42\);/);
  assert.match(css, /\.xterm\.term-scrollable\.term-scrolling\s+\.xterm-scrollable-element\s*>\s*\.scrollbar\.vertical/);
  assert.match(css, /\.xterm\.term-scrollable\.term-scrollbar-drag\s+\.xterm-scrollable-element\s*>\s*\.scrollbar\.vertical/);
  assert.match(css, /\.xterm\.term-scrollable\s+\.xterm-scrollable-element\s*>\s*\.scrollbar\.vertical:hover/);
  assert.doesNotMatch(css, /\.xterm(?::not\(\.user-scrolling\)|\.user-scrolling)/);
});

test('standard scrollbar styling cannot override WebKit styling outside the fallback', () => {
  const fallback = /@supports not selector\(::-webkit-scrollbar\)\s*\{\s*\*\s*\{([^}]+)\}\s*\.user-scrolling\s*\{([^}]+)\}\s*\}/;
  const match = css.match(fallback);
  assert.ok(match);
  assert.match(match[1], /scrollbar-width:\s*thin;/);
  assert.match(match[1], /scrollbar-color:\s*transparent\s+transparent;/);
  assert.match(match[2], /scrollbar-color:\s*var\(--accent\)\s+transparent;/);
  const themed = /@supports not selector\(::-webkit-scrollbar\)\s*\{\s*\.themed\[data-immersive~="scrollbar-thumb"\][^{}]+\.user-scrolling\s*\{\s*scrollbar-color:\s*var\(--th-scrollbar-thumb\) transparent;\s*\}\s*\}/;
  assert.match(css, themed);
  assert.match(css, /\.user-scrolling::-webkit-scrollbar-thumb\s*\{\s*background:\s*var\(--th-scrollbar-thumb\)/);
  const rest = css.replace(fallback, '').replace(themed, '');
  for (const declaration of rest.matchAll(/scrollbar-width:([^;]+);/g)) {
    assert.equal(declaration[1].trim(), 'none');
  }
  assert.doesNotMatch(rest, /scrollbar-color:/);
  assert.match(rule('.dash-workers'), /overflow:\s*auto;/);
});

test('compact navigation strips hide scrollbars without disabling scrolling', () => {
  for (const selector of ['.mp-chips', '.dash-team-nav-members']) {
    assert.match(rule(selector), /overflow-x:\s*auto;/);
    assert.match(rule(selector), /scrollbar-width:\s*none;/);
    assert.match(rule(`${selector}::-webkit-scrollbar`), /display:\s*none;/);
  }
});

test("the companion's floor strip never scrolls: tabs that don't fit fold into +N more", () => {
  assert.match(rule('.dash-floor-bays'), /overflow:\s*hidden;/);
  assert.doesNotMatch(rule('.dash-floor-bays'), /overflow-x:\s*auto/);
  assert.match(rule('.dash-floor-chip'), /flex:\s*none;/);
  assert.doesNotMatch(rule('.dash-floor-chip'), /max-width/);
});
