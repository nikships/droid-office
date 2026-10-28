// Builds the native Metal presenter (native/presenter) into native/presenter/build/Release/presenter.node.
// `npm run build` runs it. It is a no-op anywhere but macOS: the presenter is Objective-C++ for the Mac app,
// and the Linux CI job, a developer checkout on Linux and the Cursor image only need the office itself.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addon = path.join(root, 'native', 'presenter');
const output = path.join(addon, 'build', 'Release', 'presenter.node');

if (process.platform !== 'darwin') {
  console.log(`native: skipped the Metal presenter (macOS only; this is ${process.platform})`);
  process.exit(0);
}

// node-gyp builds Node-API modules against the headers of the Node that runs it. Node-API is ABI-stable,
// so the .node loads in Electron's Node unchanged: no Electron headers, no @electron/rebuild.
const gyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
if (!existsSync(gyp)) {
  console.error('native: node-gyp is missing; run npm ci');
  process.exit(1);
}
const run = spawnSync(process.execPath, [gyp, 'rebuild', '--arch=arm64', '--directory', addon], { cwd: root, stdio: 'inherit' });
if (run.status !== 0 || !existsSync(output)) {
  console.error(`native: building the Metal presenter failed${run.status === null ? ` (${run.signal})` : ''}`);
  process.exit(run.status || 1);
}
console.log(`native: built ${path.relative(root, output)}`);
const finder = spawnSync(process.execPath, [path.join(root, 'native', 'mac', 'build.mjs')], { cwd: root, stdio: 'inherit' });
if (finder.status !== 0) process.exit(finder.status || 1);
