import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { HiddenModels } from '../src/server/hidden-models.js';
import { countHiddenModels, isModelHidden, offeredModels, visibleModels } from '../src/shared/model-visibility.js';
import { sectionsFor } from '../src/client/ui/model-search.js';
import { store } from '../src/client/state.js';

function directory(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hidden-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('visibility persists independently, supports individual changes and restores all models', (t) => {
  const dir = directory(t);
  const state = new HiddenModels(dir);
  assert.deepEqual(state.state(), []);
  assert.equal(state.hideNative(), false);
  assert.equal(state.set('custom:droidproxy:gpt-6.1-sol', true), undefined);
  assert.equal(state.set('claude-opus-5-5', true), undefined);
  assert.equal(state.set('claude-opus-5-5', true), undefined);
  assert.deepEqual(new HiddenModels(dir).state(), ['custom:droidproxy:gpt-6.1-sol', 'claude-opus-5-5']);
  state.state().push('not-saved');
  assert.equal(state.state().length, 2);
  state.set('claude-opus-5-5', false);
  assert.deepEqual(new HiddenModels(dir).state(), ['custom:droidproxy:gpt-6.1-sol']);
  assert.equal(state.setHideNative(true), undefined);
  assert.equal(state.hideNative(), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'hidden-models.json'), 'utf8')), {
    hideNative: true,
    ids: ['custom:droidproxy:gpt-6.1-sol'],
  });
  const reloaded = new HiddenModels(dir);
  assert.equal(reloaded.hideNative(), true);
  assert.deepEqual(reloaded.state(), ['custom:droidproxy:gpt-6.1-sol']);
  assert.equal(reloaded.setHideNative(false), undefined);
  assert.equal(reloaded.hideNative(), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'hidden-models.json'), 'utf8')), ['custom:droidproxy:gpt-6.1-sol']);
  assert.equal(reloaded.setHideNative(true), undefined);
  reloaded.set(null, false);
  assert.deepEqual(new HiddenModels(dir).state(), []);
  assert.equal(new HiddenModels(dir).hideNative(), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'hidden-models.json'), 'utf8')), []);
});

test('bad saved data and invalid changes do not alter valid choices', (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'hidden-models.json');
  for (const raw of ['not json', '{}', 'null']) {
    writeFileSync(file, raw);
    const loaded = new HiddenModels(dir);
    assert.deepEqual(loaded.state(), []);
    assert.equal(loaded.hideNative(), false);
  }
  writeFileSync(file, JSON.stringify({ hideNative: 'yes', ids: ['gpt-6.1-sol', 'gpt-6.1-sol', null, 4, '', 'two words'] }));
  const state = new HiddenModels(dir);
  assert.deepEqual(state.state(), ['gpt-6.1-sol']);
  assert.equal(state.hideNative(), false);
  for (const id of ['', 'two words', 'a\nb', 'a\u200bb', 'a'.repeat(257), undefined, 7, {}]) assert.ok(state.set(id, true));
  for (const bad of ['true', null, undefined, 1, {}]) assert.ok(state.setHideNative(bad));
  assert.ok(state.set(null, true));
  assert.ok(state.set('gpt-6.1-sol', 'false'));
  assert.deepEqual(state.state(), ['gpt-6.1-sol']);
  assert.equal(state.hideNative(), false);
  mkdirSync(`${file}.tmp`);
  assert.match(state.set(null, false) ?? '', /Could not save/);
  assert.match(state.setHideNative(true) ?? '', /Could not save/);
  assert.deepEqual(state.state(), ['gpt-6.1-sol']);
  assert.equal(state.hideNative(), false);
});

test('hidden lists are bounded on disk and when a new id is added', (t) => {
  const dir = directory(t);
  writeFileSync(path.join(dir, 'hidden-models.json'), JSON.stringify(Array.from({ length: 2001 }, (_, i) => `model-${i}`)));
  const state = new HiddenModels(dir);
  assert.equal(state.state().length, 2000);
  assert.match(state.set('another', true) ?? '', /At most/);
  assert.equal(state.set('model-0', false), undefined);
  assert.equal(state.set('another', true), undefined);
});

test('hidden models and native Factory hiding stay out of searches, groups and recents without changing the catalogue', () => {
  const models = [
    { id: 'custom:droidproxy:gpt-6.1-sol', name: 'GPT 6.1 Sol', custom: true, scope: 'Yours', group: 'DroidProxy' },
    { id: 'custom:openrouter:kimi-k3.1', name: 'Kimi K3.1', custom: true, scope: 'Yours', group: 'OpenRouter' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', scope: 'OpenAI', group: 'OpenAI' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', scope: 'Anthropic', group: 'Anthropic' },
  ];
  const filtered = visibleModels(models, ['gpt-6.1-sol', 'unlisted']);
  assert.deepEqual(filtered, [models[0], models[1], models[3]]);
  assert.deepEqual(visibleModels(models, [], true), [models[0], models[1]]);
  assert.deepEqual(visibleModels(models, ['custom:openrouter:kimi-k3.1'], true), [models[0]]);
  assert.equal(isModelHidden(models[0], [], true), false);
  assert.equal(isModelHidden(models[2], [], true), true);
  assert.equal(isModelHidden(models[0], ['custom:droidproxy:gpt-6.1-sol'], true), true);
  assert.deepEqual(sectionsFor(visibleModels(models, [], true), { query: 'opus', scope: '', recents: ['claude-opus-5-5'] }), []);
  assert.deepEqual(visibleModels(models, []), models);
  assert.equal(models.length, 4);
});

test('offeredModels hides unpicked models and native Factory models while preserving already-picked hidden models', () => {
  const models = [
    { id: 'custom:droidproxy:opus-5-5', name: 'DroidProxy: Opus 5.5', custom: true },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  ];
  assert.deepEqual(offeredModels(models, ['gpt-6.1-sol'], new Set()), [models[0], models[2]]);
  assert.deepEqual(offeredModels(models, ['gpt-6.1-sol'], new Set(['gpt-6.1-sol'])), models);
  assert.deepEqual(offeredModels(models, [], new Set(), true), [models[0]]);
  assert.deepEqual(offeredModels(models, [], new Set(['claude-opus-5-5']), true), [models[0], models[2]]);
  assert.deepEqual(offeredModels(models, [], new Set()), models);
});

test('countHiddenModels counts only models present in the current catalogue without double-counting native models', () => {
  const models = [{ id: 'gpt-6.1-sol' }, { id: 'claude-opus-5-5' }, { id: 'custom:droidproxy:gemini-3.8-flash-high', custom: true }];
  assert.equal(countHiddenModels(models, ['gpt-6.1-sol', 'custom:droidproxy:fable-5', 'custom:droidproxy:gpt-6.1-sol']), 1);
  assert.equal(countHiddenModels(models, ['custom:droidproxy:fable-5', 'custom:meta:muse-spark-1.3']), 0);
  assert.equal(countHiddenModels(models, ['gpt-6.1-sol', 'gpt-6.1-sol', 'claude-opus-5-5']), 2);
  assert.equal(countHiddenModels(models, ['gpt-6.1-sol'], true), 2);
  assert.equal(countHiddenModels(models, ['gpt-6.1-sol', 'custom:droidproxy:gemini-3.8-flash-high'], true), 3);
});

test('live hidden-model messages update the web store and notify open pickers', () => {
  const before = store.hiddenModels;
  const beforeNative = store.hideNativeModels;
  let changes = 0;
  const off = store.on('hiddenModels', () => changes++);
  try {
    store.apply({ t: 'models.hidden', ids: ['gpt-6.1-sol'], hideNative: true });
    assert.deepEqual(store.hiddenModels, ['gpt-6.1-sol']);
    assert.equal(store.hideNativeModels, true);
    store.apply({ t: 'models.hidden', ids: [] });
    assert.deepEqual(store.hiddenModels, []);
    assert.equal(store.hideNativeModels, false);
    assert.equal(changes, 2);
  } finally {
    off();
    store.hiddenModels = before;
    store.hideNativeModels = beforeNative;
  }
});
