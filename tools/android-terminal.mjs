// Copies xterm.js from the root node_modules into the Android app's terminal page, so the phone runs
// the same emulator as the office's own terminal window, and builds the office terminal's pixel
// scroller (src/client/term-pixel-scroll.ts) for it, so both scroll alike. `tests/android-terminal.test.ts`
// fails when the copy no longer matches the installed packages or the source.
//
//   node tools/android-terminal.mjs

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'android/app/src/main/assets');

/** Each vendored file: where it comes from under node_modules, and where it goes under assets. */
const VENDORED = [
  ['@xterm/xterm/lib/xterm.mjs', 'terminal/vendor/xterm.mjs'],
  ['@xterm/xterm/css/xterm.css', 'terminal/vendor/xterm.css'],
  ['@xterm/addon-unicode11/lib/addon-unicode11.mjs', 'terminal/vendor/addon-unicode11.mjs'],
  ['@xterm/xterm/LICENSE', 'licenses/xterm-LICENSE.txt'],
];

/** Each module built from the office's own source: where it comes from under the root, and where it goes under assets. */
const BUILT = [['src/client/term-pixel-scroll.ts', 'terminal/vendor/pixel-scroll.js']];

export const vendoredPaths = () => VENDORED.map(([from, to]) => [path.join(root, 'node_modules', from), path.join(assets, to)]);

/** Each built module's path under assets and the JavaScript it should hold. */
export const builtFiles = () =>
  BUILT.map(([from, to]) => {
    const [out] = buildSync({
      entryPoints: [path.join(root, from)],
      format: 'esm',
      target: 'es2020',
      write: false,
      banner: { js: `// Built from ${from} by tools/android-terminal.mjs. Do not edit.` },
    }).outputFiles;
    return [path.join(assets, to), out.text];
  });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [from, to] of vendoredPaths()) {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(path.relative(root, to));
  }
  for (const [to, text] of builtFiles()) {
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, text);
    console.log(path.relative(root, to));
  }
}
