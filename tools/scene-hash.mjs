import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * What the baked bounce light (`bakeKey` in `src/client/remaster-settings.ts`) is a picture of: the scene's code and
 * models, the layout and sun it is built from, the bake's own settings, and three.js, which writes the shaders the
 * probes see the room through. Each is a path under the repository, a folder meaning every file in it.
 */
export const SCENE_INPUTS = ['src/client/world', 'src/client/public/props', 'src/client/remaster-settings.ts', 'src/shared/layout.ts', 'src/shared/sun.ts', 'src/shared/decor.ts', 'src/shared/floors.ts', 'node_modules/three/package.json'];

function files(entry) {
  if (!statSync(entry).isDirectory()) return [entry];
  return readdirSync(entry, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((child) => files(path.join(entry, child.name)));
}

/**
 * A short hash of `SCENE_INPUTS` under `root`. It changes only when one of them does, so a build that touches
 * the server, the windows or the phone apps keeps the bounce light it already baked.
 */
export function sceneHash(root, inputs = SCENE_INPUTS) {
  const hash = createHash('sha256');
  for (const input of inputs) {
    for (const file of files(path.join(root, input))) {
      hash.update(path.relative(root, file).split(path.sep).join('/'));
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex').slice(0, 12);
}
