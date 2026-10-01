// The headset app starts in the office, the way Half-Life: Alyx starts in its world: no workspace
// opens by itself on a launch or a reload, and the office page has no on-screen keyboard (a
// keyboard paired to the headset types there). Desktop and WebXR are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../src/client/', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|mjs)$/.test(path) ? [path] : [];
  });
}

const files = sources(ROOT).map((path) => ({ path: relative(ROOT, path), src: readFileSync(path, 'utf8') }));
const file = (path: string) => files.find((f) => f.path === path)?.src ?? assert.fail(`missing ${path}`);

test('every page load starts with the workspace closed', () => {
  const ui = file('native/ui.ts');
  assert.match(ui, /let homeOn = false;/, 'Home starts hidden');
  assert.match(ui, /\n {2}showHome\(false\);\n/, 'and initNativeUi shows it hidden, so the first packet says the panel is closed');
  assert.doesNotMatch(ui, /\bhome\?:/, 'no option brings Home up at start');
});

test('only the left controller’s Menu button opens the workspace', () => {
  const opens: string[] = [];
  for (const { path, src } of files) {
    if (path === 'native/ui.ts') continue;
    for (const m of src.matchAll(/\b(?:setPanelOpen\(\s*true|showHome\(\s*true|togglePanel\(\))/g)) opens.push(`${path}:${src.slice(0, m.index).split('\n').length}: ${m[0]}`);
  }
  // main.ts hands nativeUi.togglePanel to the controls; the controls call it from the left Menu press.
  assert.deepEqual(
    opens.map((o) => o.replace(/:\d+:/, ':')),
    ['main.ts: togglePanel()', 'native/controls.ts: togglePanel()'],
  );
  const controls = file('native/controls.ts');
  assert.match(controls, /if \(pad\.menu && !s\.wasMenu\) \{\n\s*this\.hooks\.togglePanel\(\);/);
});

test('the office page has no on-screen keyboard; only the sign-in page mounts one', () => {
  const importsPanelKeyboard = (path: string, src: string) => [...src.matchAll(/from '(\.{1,2}\/[^']*)'/g)].some((m) => relative(ROOT, join(ROOT, path, '..', m[1])) === 'native/keyboard');
  const mounts = files.filter(({ path, src }) => importsPanelKeyboard(path, src)).map((f) => f.path);
  assert.deepEqual(mounts, ['login.ts']);
  assert.doesNotMatch(file('native/ui.ts'), /keyboard\(|toggleKeyboard|\.native-kb/);
  assert.doesNotMatch(file('native/controls.ts'), /toggleKeyboard/);
});

test('no page brings back a keyboard it remembers from an earlier visit', () => {
  // The headset's stored droid-office.native-keyboard = '1' must not show a keyboard at the next launch.
  const remembering = files.filter(({ src }) => /native-keyboard|panel-keyboard/.test(src)).map((f) => f.path);
  assert.deepEqual(remembering, []);
  assert.doesNotMatch(file('native/keyboard.ts'), /localStorage|sessionStorage/);
});
