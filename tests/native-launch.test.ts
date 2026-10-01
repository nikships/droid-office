// The headset app starts in the office, the way Half-Life: Alyx starts in its world, and it never
// shows the workspace (the owner's decision): no window, Home, menu or field ever opens on its panel,
// whatever happens. The left Menu button opens the settings menu that floats where you stand, and the
// office page has no on-screen keyboard (a keyboard paired to the headset types into the world).
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

test('the headset page reports the workspace panel closed, always, and refuses every window', () => {
  const ui = file('native/ui.ts');
  assert.match(ui, /open: false, home: false, modal: false, floorMenu: false, typing: false, terminal: null, carrying/, 'panelState is closed whatever the page holds');
  assert.match(ui, /setModalGate\(\(\) => false\)/, 'initNativeUi refuses every window');
  assert.doesNotMatch(ui, /showHome|buildHome|openNativeGraphicsSettings|togglePanel|openCommands/, 'no Home, graphics window or palette is left to open');
  assert.match(ui, /setPanelOpen\(open\) \{\n\s*if \(open\) return;/, 'asking to open the panel does nothing');
});

test('the headset page paints nothing: every element hidden and every animation paused', () => {
  const css = file('native/native.css');
  assert.match(css, /body\.native-xr,\nbody\.native-xr \* \{\n {2}visibility: hidden;\n {2}animation-play-state: paused;\n\}/);
});

test('only the left controller’s Menu button opens a menu on its own, and it is the floating settings menu', () => {
  const opens: string[] = [];
  for (const { path, src } of files) {
    // Where the settings menu itself is defined.
    if (path === 'native/menus.ts') continue;
    for (const m of src.matchAll(/\b(?:setPanelOpen\(\s*true|showHome\(\s*true|togglePanel\(\)|toggleSettings\(\)|openSettings\(\))/g)) opens.push(`${path}: ${m[0]}`);
  }
  // main.ts hands the settings toggle to the controls as togglePanel; the controls call it from the
  // left Menu press; the debug hook can open it for captures.
  assert.deepEqual(opens.sort(), ['main.ts: openSettings()', 'main.ts: toggleSettings()', 'native/controls.ts: togglePanel()'].sort());
  assert.match(file('main.ts'), /togglePanel: \(\) => menus\.toggleSettings\(\),/);
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
