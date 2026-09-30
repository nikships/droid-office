import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS_SHORTCUT, KEYBOARD_ROWS, nativeCommandsKey, pressOf, type Modifier } from '../src/client/native/keys.js';
import { NATIVE_SETTINGS, workerReposLine } from '../src/client/native/panel-text.js';
import { isPaletteKey } from '../src/shared/palette.js';
import { SETTINGS_CARDS } from '../src/shared/settings-nav.js';

const ctrl = new Set<Modifier>(['ctrl']);
const code = (k: { key: string }) => ({ ...k, code: `Key${k.key.toUpperCase()}` });

// ---- Command palette on the panel ----

test('the panel keyboard can type the palette shortcut it shows', () => {
  assert.equal(COMMANDS_SHORTCUT, 'Ctrl+K');
  const ids = KEYBOARD_ROWS.flat().map((k) => k.id);
  assert.ok(ids.includes('mod:ctrl') && ids.includes('k'));
  assert.ok(!ids.includes('mod:meta'), 'the panel keyboard has no ⌘, so it must never advertise ⌘K');
  const press = code(pressOf('k', ctrl));
  assert.ok(isPaletteKey(press, false), "on the headset's platform the page's own Ctrl+K listener opens it");
});

test('panel Ctrl+K opens the palette once, whatever platform the page reports', () => {
  const press = code(pressOf('k', ctrl));
  for (const mac of [false, true]) {
    const page = isPaletteKey(press, mac);
    const panel = nativeCommandsKey(press, mac);
    assert.equal(Number(page) + Number(panel), 1, `mac=${mac}: exactly one listener toggles it`);
  }
});

test('only Ctrl+K is the panel shortcut', () => {
  const mods = (m: Modifier[]) => code(pressOf('k', new Set(m)));
  assert.ok(!nativeCommandsKey(mods([]), true));
  assert.ok(!nativeCommandsKey(mods(['ctrl', 'shift']), true));
  assert.ok(!nativeCommandsKey(mods(['ctrl', 'alt']), true));
  assert.ok(!nativeCommandsKey(code(pressOf('j', ctrl)), true));
  // ⌘K on a Mac is the page's own, never the panel's too.
  assert.ok(!nativeCommandsKey({ key: 'k', code: 'KeyK', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true }, true));
});

// ---- Workers across repositories ----

test('a worker across repositories names each one, its own floor first', () => {
  assert.equal(workerReposLine({}, 'office'), '');
  assert.equal(workerReposLine({ repos: [] }, 'office'), '');
  const repo = (name: string) => ({ floor: `f-${name}`, name, dir: `/x/${name}`, path: `wt/${name}`, branch: 'office/a', base: 'abc' });
  assert.equal(workerReposLine({ repos: [repo('api'), repo('web')] }, 'office'), '📚 3 repositories: office, api, web');
  assert.equal(workerReposLine({ repos: [repo('api')] }, undefined), '📚 2 repositories: this floor, api');
});

// ---- Settings on the panel ----

test('headset settings describe the head-tracked first-person view and controllers only', () => {
  assert.match(NATIVE_SETTINGS.viewMode, /first person/i);
  assert.match(NATIVE_SETTINGS.viewMode, /head-tracked/i);
  assert.match(NATIVE_SETTINGS.view, /no third-person/i);
  assert.doesNotMatch(NATIVE_SETTINGS.view + NATIVE_SETTINGS.movementControls, /\b(hand tracking|pinch|gesture)/i);
  assert.match(NATIVE_SETTINGS.movementControls, /Menu button/);
  assert.match(NATIVE_SETTINGS.movementControls, /grip/i);
  // The native cards reuse the desktop category layout: every desktop title still exists for the desktop page.
  assert.ok(SETTINGS_CARDS.some((c) => c.title === 'Camera view'));
});

test('the native settings replace the desktop camera choice instead of offering it', () => {
  const src = readFileSync(new URL('../src/client/ui/settings.ts', import.meta.url), 'utf8');
  assert.match(src, /native\s*\?\s*setting\(\s*NATIVE_SETTINGS\.viewTitle/);
  assert.match(src, /:\s*card\('Camera view', seg, note\)/);
});

// ---- Panel CSS guards ----

const css = readFileSync(new URL('../src/client/native/native.css', import.meta.url), 'utf8');

/** A selector list's selectors, split at commas outside :is(…) and other parentheses. */
function topLevelParts(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of sel) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

test('long board and list rows keep their content height in a scrolling column', () => {
  const rule = css.split('\n').find((l) => l.includes(':is(.card, .svc-list li') && l.includes('min-height: 48px'));
  assert.ok(rule, 'the row min-height rule exists');
  assert.match(rule!, /flex-shrink: 0/);
});

test('every native.css rule is scoped to the panel', () => {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...body.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter((s) => s && !s.startsWith('from') && !s.startsWith('to'));
  for (const sel of selectors) {
    for (const part of topLevelParts(sel)) {
      if (part === ':root') continue;
      assert.ok(/body\.native-xr|^\.native-|^\.nh-|^body\.native-home-on/.test(part), `unscoped selector: ${part}`);
    }
  }
});
