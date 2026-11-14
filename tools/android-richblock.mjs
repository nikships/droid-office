// Copies the libraries the Android app's rich block page draws with (assets/richblock/) from the root
// node_modules: Mermaid for ```mermaid diagrams in Thread messages. `tests/android-richblock.test.ts`
// fails when the copy no longer matches the installed packages.
//
//   node tools/android-richblock.mjs

import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'android/app/src/main/assets');

/** Each vendored file: where it comes from under node_modules, and where it goes under assets. */
export const VENDORED = [
  ['mermaid/dist/mermaid.min.js', 'richblock/vendor/mermaid.min.js'],
  ['mermaid/LICENSE', 'licenses/mermaid-LICENSE.txt'],
];

export const vendoredPaths = () => VENDORED.map(([from, to]) => [path.join(root, 'node_modules', from), path.join(assets, to)]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [from, to] of vendoredPaths()) {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(path.relative(root, to));
  }
}
