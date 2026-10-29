import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SCENE_INPUTS, sceneHash } from '../tools/scene-hash.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('every scene input exists in this checkout, so the list cannot drift from the code', () => {
  for (const input of SCENE_INPUTS) assert.ok(existsSync(path.join(root, input)), input);
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
