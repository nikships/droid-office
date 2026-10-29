import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { composerInputHeight } from '../src/mobile/conversation-layout.js';
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
  for (const name of ['Thread', 'Markdown']) {
    const source = readFileSync(new URL(`../src/mobile/ui/${name}.tsx`, import.meta.url), 'utf8');
    const scrollers = [...source.matchAll(/<ScrollView\b[^>]*\bhorizontal\b[^>]*>/g)];
    assert.ok(scrollers.length, `${name} has horizontal content`);
    for (const [tag] of scrollers) assert.match(tag, /\bnestedScrollEnabled\b/, name);
  }
});

test('Android conversations keep worker metadata and actions in the menu, not the transcript header', () => {
  const source = readFileSync(new URL('../src/mobile/ui/WorkerPane.tsx', import.meta.url), 'utf8');
  const [header, menu] = source.split('{details ? (');
  assert.doesNotMatch(header, /<Eyebrow|<ScrollView|actions\.map/);
  assert.match(header, /label="Worker actions and details"/);
  assert.match(header, /testID="pane-back"/);
  assert.match(header, /testID=\{props\.onSwitch \? 'pane-switch'/);
  assert.match(menu, /testID=\{`pane-view-\$\{a\.id\}`\}/);
  assert.match(menu, /disabled=\{!!a\.refusal \|\| busy\}/);
  assert.match(menu, /<Text style=\{s\.muted\}>\{a\.refusal\}<\/Text>/);
});

test('the Android composer grows with content and resets immediately when the draft clears', () => {
  assert.equal(composerInputHeight('', 128, false), 44);
  assert.equal(composerInputHeight('One line', 42, false), 44);
  assert.equal(composerInputHeight('Wrapped text', 66.4, false), 67);
  assert.equal(composerInputHeight('Long draft', 400, false), 128);
  assert.equal(composerInputHeight('Landscape draft', 400, true), 80);
  assert.equal(composerInputHeight('Invalid measurement', Number.NaN, false), 44);
  assert.equal(composerInputHeight('Invalid measurement', Number.POSITIVE_INFINITY, true), 44);
  assert.equal(composerInputHeight('Invalid measurement', -30, false), 44);
});
