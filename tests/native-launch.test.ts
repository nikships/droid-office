// The headset app starts in the office. Its compositor workspace opens for shared office windows,
// terminals and navigation, while APK-owned graphics settings remain independent of the page.
// Desktop and WebXR are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../src/client/', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|mjs|css)$/.test(path) ? [path] : [];
  });
}

const files = sources(ROOT).map((path) => ({ path: relative(ROOT, path), src: readFileSync(path, 'utf8') }));
const file = (path: string) => files.find((f) => f.path === path)?.src ?? assert.fail(`missing ${path}`);

test('the headset page opens the workspace for office windows and does not refuse them', () => {
  const ui = file('native/ui.ts');
  assert.match(ui, /open: home \|\| modal \|\| floorMenu/);
  assert.match(ui, /setModalGate\(null\)/);
  assert.match(ui, /terminal: openTerminalFor\(\)/);
  assert.match(ui, /setPanelOpen\(open\) \{\n\s*home = open;/);
  assert.match(ui, /nativeSettings \|\| panelState\(\)\.open/, 'native settings also suppress world input');
});

test('the closed workspace paints nothing, while an open workspace shows its actual content', () => {
  const css = file('native/native.css');
  assert.match(css, /body\.native-xr:not\(\.native-workspace-open\)/);
  assert.match(css, /visibility: hidden/);
  assert.match(css, /body\.native-xr\.native-workspace-open \{ background:/);
});

test('legacy hosts can toggle the workspace, and right Menu stays reserved for Android XR', () => {
  assert.match(file('main.ts'), /togglePanel: \(\) => nativeUi\?\.setPanelOpen\(!nativeUi\.panelState\(\)\.open\),/);
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
  const remembering = files.filter(({ path, src }) => path.endsWith('.ts') && /native-keyboard|panel-keyboard/.test(src)).map((f) => f.path);
  assert.deepEqual(remembering, []);
  assert.doesNotMatch(file('native/keyboard.ts'), /localStorage|sessionStorage/);
});

test('a first launch with no saved look comes straight in, with no character window', () => {
  const main = file('main.ts');
  assert.match(main, /\} else if \(nativeMode\) \{[\s\S]{0,300}saveProfile\(store\.profile\);\n\s*showMyProfile\(store\.profile\);\n\s*boot\(\);/);
});
