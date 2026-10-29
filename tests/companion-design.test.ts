import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { colors, radius } from '../src/mobile/ui/tokens.js';

test('the native companion uses the same Factory product palette as the web', () => {
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
  for (const [native, web] of [
    ['bg', 'bg'],
    ['surface', 'surface'],
    ['raised', 'surface-raised'],
    ['text', 'text'],
    ['muted', 'text-secondary'],
    ['accent', 'accent'],
    ['accentHover', 'accent-hover'],
    ['danger', 'danger'],
  ] as const) {
    const value = new RegExp(`--${web}:\\s*(#[\\da-f]+);`, 'i').exec(css)?.[1];
    assert.equal(colors[native].toLowerCase(), value?.toLowerCase(), native);
  }
  assert.equal(colors.border, 'rgba(255,255,255,0.09)');
  assert.equal(colors.borderStrong, 'rgba(255,255,255,0.18)');
});

test('companion controls use near-square corners and inverted primary actions', () => {
  const css = readFileSync(new URL('../src/client/companion-workspace.css', import.meta.url), 'utf8');
  assert.match(css, new RegExp(`--radius: ${radius}px;`));
  assert.match(css, new RegExp(`--radius-lg: ${radius}px;`));
  assert.doesNotMatch(css, /(?:linear|radial)-gradient|drop-shadow|backdrop-filter/);
  const kit = readFileSync(new URL('../src/mobile/ui/kit.tsx', import.meta.url), 'utf8');
  assert.match(kit, /primary: \{ backgroundColor: colors\.text, borderColor: colors\.text \}/);
  assert.match(kit, /primaryText: \{ color: colors\.bg \}/);
  assert.match(kit, /minHeight: 44/);
  assert.match(kit, /fontFamily: mono/);
});

test('horizontal content inside native panes opts into nested Android scrolling', () => {
  for (const name of ['WorkerPane', 'Thread', 'Markdown']) {
    const source = readFileSync(new URL(`../src/mobile/ui/${name}.tsx`, import.meta.url), 'utf8');
    const scrollers = [...source.matchAll(/<ScrollView\b[^>]*\bhorizontal\b[^>]*>/g)];
    assert.ok(scrollers.length, `${name} has horizontal content`);
    for (const [tag] of scrollers) assert.match(tag, /\bnestedScrollEnabled\b/, name);
  }
});
