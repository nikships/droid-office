// Copies xterm.js from the root node_modules into the Android app's terminal page, so the phone runs
// the same emulator as the office's own terminal window. `tests/android-terminal.test.ts` fails when
// the copy no longer matches the installed packages.
//
//   node tools/android-terminal.mjs

import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'android/app/src/main/assets');

/** Each vendored file: where it comes from under node_modules, and where it goes under assets. */
export const VENDORED = [
  ['@xterm/xterm/lib/xterm.mjs', 'terminal/vendor/xterm.mjs'],
  ['@xterm/xterm/css/xterm.css', 'terminal/vendor/xterm.css'],
  ['@xterm/addon-unicode11/lib/addon-unicode11.mjs', 'terminal/vendor/addon-unicode11.mjs'],
  ['@xterm/xterm/LICENSE', 'licenses/xterm-LICENSE.txt'],
];

export const vendoredPaths = () => VENDORED.map(([from, to]) => [path.join(root, 'node_modules', from), path.join(assets, to)]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [from, to] of vendoredPaths()) {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(path.relative(root, to));
  }
}
