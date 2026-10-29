import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SCENE_INPUTS, sceneHash } from '../tools/scene-hash.mjs';

const root = path.resolve(import.meta.dirname, '..');

/**
 * What `src/client/world` imports from outside itself that does not change the lit room the probes bake: live data
 * the boards and screens show, who sits where (hidden while baking), and settings that only apply to Classic.
 */
const NOT_SCENE: Record<string, string> = {
  'src/client/fonts': 'glyph shapes on labels',
  'src/client/graphics': 'the Classic upscaler',
  'src/client/player': 'movement',
  'src/client/state': 'live office state for the boards',
  'src/client/term-theme': 'laptop screen colours (laptops are hidden while baking)',
  'src/client/token': 'the device token',
  'src/shared/avatar': 'workers (hidden while baking)',
  'src/shared/emotes': 'workers (hidden while baking)',
  'src/shared/factory': 'Factory data on screens',
  'src/shared/factory-ci': 'Factory data on screens',
  'src/shared/factory-computers': 'Factory data on screens',
  'src/shared/factory-sessions': 'Factory data on screens',
  'src/shared/jira': 'board data',
  'src/shared/nav': 'floor navigation',
  'src/shared/pipelines': 'board data',
  'src/shared/protocol': 'message types',
  'src/shared/status': 'worker status',
  'src/shared/subscriptions': 'subscription data on a screen',
  'src/shared/visits': 'visitors (hidden while baking)',
  'src/shared/whiteboard': 'board data',
};

function worldFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? worldFiles(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []));
}

/** Every module outside `src/client/world` that the scene imports, as a repository path without its extension. */
function outsideImports(): Set<string> {
  const found = new Set<string>();
  const world = path.join(root, 'src/client/world');
  for (const file of worldFiles(world)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (target !== world && !target.startsWith(world + path.sep)) found.add(path.relative(root, target));
    }
  }
  return found;
}

test('every scene input exists in this checkout', () => {
  for (const input of SCENE_INPUTS) assert.ok(existsSync(path.join(root, input)), input);
});

test('every module the scene imports from outside world/ is either hashed or known not to change the lit room', () => {
  const covered = (module: string) => SCENE_INPUTS.some((input) => `${module}.ts` === input || `${module}.ts`.startsWith(`${input}/`));
  const imports = outsideImports();
  for (const module of imports) {
    assert.ok(covered(module) || module in NOT_SCENE, `${module} is imported by src/client/world: add it to SCENE_INPUTS (tools/scene-hash.mjs), or to NOT_SCENE here with the reason it cannot change the bake`);
  }
  for (const module of Object.keys(NOT_SCENE)) assert.ok(imports.has(module), `${module} is no longer imported by the scene: drop it from NOT_SCENE`);
  for (const module of imports) assert.ok(!(module in NOT_SCENE && covered(module)), `${module} is both hashed and listed as not a scene input`);
});

test('the scene hash follows the scene inputs and nothing else', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scene-hash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'scene/nested'), { recursive: true });
  mkdirSync(path.join(dir, 'server'));
  writeFileSync(path.join(dir, 'scene/a.ts'), 'a');
  writeFileSync(path.join(dir, 'scene/nested/b.glb'), 'b');
  writeFileSync(path.join(dir, 'lock.json'), '1');
  writeFileSync(path.join(dir, 'server/x.ts'), 'x');
  const inputs = ['scene', 'lock.json'];
  const first = sceneHash(dir, inputs);
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(sceneHash(dir, inputs), first);

  writeFileSync(path.join(dir, 'server/x.ts'), 'changed');
  assert.equal(sceneHash(dir, inputs), first, 'a file outside the inputs does not move the hash');

  writeFileSync(path.join(dir, 'scene/nested/b.glb'), 'b2');
  const model = sceneHash(dir, inputs);
  assert.notEqual(model, first, 'a model inside a folder moves it');

  writeFileSync(path.join(dir, 'lock.json'), '2');
  assert.notEqual(sceneHash(dir, inputs), model, 'a single-file input moves it');

  writeFileSync(path.join(dir, 'scene/c.ts'), 'a');
  writeFileSync(path.join(dir, 'scene/a.ts'), '');
  const swapped = sceneHash(dir, inputs);
  writeFileSync(path.join(dir, 'scene/a.ts'), 'a');
  writeFileSync(path.join(dir, 'scene/c.ts'), '');
  assert.notEqual(sceneHash(dir, inputs), swapped, 'the same bytes under another name are another scene');
});
