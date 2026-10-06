import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDroidModelCatalogue, listDroidModels, parseDroidModelList, readDroidModels } from '../src/server/droid-models.js';

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'droid-office-droid-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function settingsFile(t: { after(fn: () => void): void }, body: unknown): string {
  const file = path.join(scratch(t), 'settings.json');
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

const noLister = () => Promise.reject(new Error('no droid'));

test('Droid catalogue lists custom models with their display names and efforts', (t) => {
  const file = settingsFile(t, {
    customModels: [
      { id: 'custom:droidproxy:gpt-6-sol', displayName: 'DroidProxy: GPT 6 Sol', defaultReasoningEffort: 'xhigh', supportedReasoningEfforts: ['low', 'xhigh', 'bogus'] },
      { id: 'custom:droidproxy:gpt-6-sol', displayName: 'duplicate' },
      { id: 'has a space', displayName: 'bad' },
      { id: '', displayName: 'empty' },
      { nope: true },
    ],
    sessionDefaultSettings: { model: 'custom:droidproxy:muse-spark-1.3-contributor', reasoningEffort: 'max' },
    modelFavorites: ['glm-5.3-flash', 'custom:droidproxy:gpt-6-sol'],
  });
  const catalogue = readDroidModels(file);
  assert.deepEqual(catalogue.models, [
    { id: 'custom:droidproxy:gpt-6-sol', displayName: 'DroidProxy: GPT 6 Sol', custom: true, defaultReasoningEffort: 'xhigh', supportedReasoningEfforts: ['low', 'xhigh'] },
    { id: 'custom:droidproxy:muse-spark-1.3-contributor', displayName: 'custom:droidproxy:muse-spark-1.3-contributor' },
    { id: 'glm-5.3-flash', displayName: 'glm-5.3-flash' },
  ]);
  assert.equal(catalogue.defaultModel, 'custom:droidproxy:muse-spark-1.3-contributor');
  assert.equal(catalogue.defaultReasoningEffort, 'max');
});

test('Droid catalogue tolerates missing, corrupt, or model-less settings', (t) => {
  const dir = scratch(t);
  assert.deepEqual(readDroidModels(path.join(dir, 'nope.json')), { models: [] });
  assert.deepEqual(readDroidModels(settingsFile(t, 'not json{{')), { models: [] });
  assert.deepEqual(readDroidModels(settingsFile(t, { theme: 'factory-dark' })), { models: [] });
  const badDefault = readDroidModels(settingsFile(t, { customModels: [], sessionDefaultSettings: { model: 'has a space', reasoningEffort: 'overdrive' } }));
  assert.deepEqual(badDefault, { models: [] });
});

test('Droid model list puts custom models first and legacy ones last, without disabled models or unpinnable efforts', () => {
  const models = parseDroidModelList([
    { id: 'claude-fable-5', displayName: 'Fable 5', legacy: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: ['off', 'low', 'high'] },
    { id: 'glm-5.3', displayName: 'GLM-5.3', defaultReasoningEffort: 'max', supportedReasoningEfforts: ['low', 'high', 'max'] },
    { id: 'auto', displayName: 'Auto Model', defaultReasoningEffort: 'none', supportedReasoningEfforts: ['none'] },
    { id: 'minimax-m2.7', displayName: 'MiniMax M2.7 [Deprecated]', deprecated: true },
    { id: 'off-model', displayName: 'Off', disabled: true },
    { id: 'custom:zen:bunny', displayName: 'Bunny', isCustom: true, defaultReasoningEffort: 'high' },
    { id: 'glm-5.3', displayName: 'duplicate' },
    { id: 'bad id', displayName: 'Bad' },
    'nonsense',
    null,
  ]);
  assert.deepEqual(models, [
    { id: 'custom:zen:bunny', displayName: 'Bunny', custom: true, defaultReasoningEffort: 'high' },
    { id: 'glm-5.3', displayName: 'GLM-5.3', defaultReasoningEffort: 'max', supportedReasoningEfforts: ['low', 'high', 'max'] },
    { id: 'auto', displayName: 'Auto Model', supportedReasoningEfforts: [] },
    { id: 'claude-fable-5', displayName: 'Fable 5', legacy: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'high'] },
    { id: 'minimax-m2.7', displayName: 'MiniMax M2.7 [Deprecated]', legacy: true },
  ]);
});

test("Droid catalogue lists droid's own models and keeps settings-only ids and the settings default", async (t) => {
  const file = settingsFile(t, {
    customModels: [{ id: 'custom:a', displayName: 'A' }],
    sessionDefaultSettings: { model: 'glm-5.3', reasoningEffort: 'high' },
    modelFavorites: ['custom:gone'],
  });
  const asked: string[][] = [];
  const catalogue = createDroidModelCatalogue({
    command: '/opt/droid',
    cwd: '/work',
    settingsPath: file,
    lister: (command, cwd) => {
      asked.push([command, cwd]);
      return Promise.resolve([
        { id: 'glm-5.3', displayName: 'GLM-5.3' },
        { id: 'custom:a', displayName: 'A (droid)', isCustom: true },
      ]);
    },
  });
  const listed = await catalogue.get();
  assert.deepEqual(asked, [['/opt/droid', '/work']]);
  assert.deepEqual(
    listed.models.map((m) => [m.id, m.displayName]),
    [
      ['custom:a', 'A (droid)'],
      ['custom:gone', 'custom:gone'],
      ['glm-5.3', 'GLM-5.3'],
    ],
  );
  assert.equal(listed.defaultModel, 'glm-5.3');
  assert.equal(listed.defaultReasoningEffort, 'high');
});

test('Droid catalogue falls back to settings when droid cannot list models', async (t) => {
  const file = settingsFile(t, { customModels: [{ id: 'custom:a', displayName: 'A' }] });
  const failing = createDroidModelCatalogue({ settingsPath: file, lister: noLister });
  assert.deepEqual(
    (await failing.get()).models.map((m) => m.id),
    ['custom:a'],
  );
  const empty = createDroidModelCatalogue({ settingsPath: file, lister: () => Promise.resolve([]) });
  assert.deepEqual(
    (await empty.get()).models.map((m) => m.id),
    ['custom:a'],
  );
});

test('Droid catalogue caches briefly and shares one pending lookup', async (t) => {
  const file = settingsFile(t, { customModels: [{ id: 'custom:a', displayName: 'A' }] });
  let now = 1000;
  let asks = 0;
  const catalogue = createDroidModelCatalogue({
    settingsPath: file,
    now: () => now,
    lister: () => {
      asks++;
      return Promise.reject(new Error('no droid'));
    },
  });
  const [first, second] = await Promise.all([catalogue.get(), catalogue.get()]);
  assert.equal(first, second);
  assert.equal(asks, 1);
  assert.deepEqual(
    first.models.map((m) => m.id),
    ['custom:a'],
  );
  writeFileSync(file, JSON.stringify({ customModels: [{ id: 'custom:b', displayName: 'B' }] }));
  now += 59_999;
  assert.deepEqual(
    (await catalogue.get()).models.map((m) => m.id),
    ['custom:a'],
  );
  now += 2;
  assert.deepEqual(
    (await catalogue.get()).models.map((m) => m.id),
    ['custom:b'],
  );
  assert.equal(asks, 2);
});

test('listDroidModels asks droid over stream-jsonrpc and reads its response', { skip: process.platform === 'win32' }, async (t) => {
  const dir = scratch(t);
  const droid = path.join(dir, 'droid');
  writeFileSync(
    droid,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args !== 'exec --input-format stream-jsonrpc --output-format stream-jsonrpc') process.exit(2);
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (!input.includes('\\n')) return;
  const req = JSON.parse(input.split('\\n')[0]);
  if (req.method !== 'droid.list_models') process.exit(3);
  process.stdout.write('not json\\n');
  process.stdout.write(JSON.stringify({ type: 'notification', method: 'hello' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'response', id: req.id, result: { models: [{ id: 'glm-5.3', displayName: 'GLM-5.3' }] } }) + '\\n');
  setInterval(() => {}, 1000);
});
`,
    { mode: 0o700 },
  );
  assert.deepEqual(await listDroidModels(droid, dir), [{ id: 'glm-5.3', displayName: 'GLM-5.3' }]);

  const quitter = path.join(dir, 'quitter');
  writeFileSync(quitter, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await assert.rejects(listDroidModels(quitter, dir), /exited without listing/);
  await assert.rejects(listDroidModels(path.join(dir, 'missing'), dir));
});
