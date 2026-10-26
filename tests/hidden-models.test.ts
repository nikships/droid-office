import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { HiddenModels } from '../src/server/hidden-models.js';
import { offeredModels, visibleModels } from '../src/shared/model-visibility.js';
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
  assert.equal(state.set('custom:droidproxy:gpt-6.1-sol', true), undefined);
  assert.equal(state.set('claude-opus-5-5', true), undefined);
  assert.equal(state.set('claude-opus-5-5', true), undefined);
  assert.deepEqual(new HiddenModels(dir).state(), ['custom:droidproxy:gpt-6.1-sol', 'claude-opus-5-5']);
  state.state().push('not-saved');
  assert.equal(state.state().length, 2);
  state.set('claude-opus-5-5', false);
  assert.deepEqual(new HiddenModels(dir).state(), ['custom:droidproxy:gpt-6.1-sol']);
  state.set(null, false);
  assert.deepEqual(new HiddenModels(dir).state(), []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'hidden-models.json'), 'utf8')), []);
});

test('bad saved data and invalid changes do not alter valid choices', (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'hidden-models.json');
  for (const raw of ['not json', '{}', 'null']) {
    writeFileSync(file, raw);
    assert.deepEqual(new HiddenModels(dir).state(), []);
  }
  writeFileSync(file, JSON.stringify(['gpt-6.1-sol', 'gpt-6.1-sol', null, 4, '', 'two words']));
  const state = new HiddenModels(dir);
  assert.deepEqual(state.state(), ['gpt-6.1-sol']);
  for (const id of ['', 'two words', 'a\nb', 'a\u200bb', 'a'.repeat(257), undefined, 7, {}]) assert.ok(state.set(id, true));
  assert.ok(state.set(null, true));
  assert.ok(state.set('gpt-6.1-sol', 'false'));
  assert.deepEqual(state.state(), ['gpt-6.1-sol']);
  mkdirSync(`${file}.tmp`);
  assert.match(state.set(null, false) ?? '', /Could not save/);
  assert.deepEqual(state.state(), ['gpt-6.1-sol']);
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

test('hidden models stay out of searches, groups and recents without changing the catalogue', () => {
  const models = [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', scope: 'OpenAI', group: 'OpenAI' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', scope: 'Anthropic', group: 'Anthropic' },
  ];
  const filtered = visibleModels(models, ['gpt-6.1-sol', 'unlisted']);
  assert.deepEqual(filtered, [models[1]]);
  assert.deepEqual(sectionsFor(filtered, { query: 'gpt', scope: '', recents: ['gpt-6.1-sol'] }), []);
  assert.deepEqual(visibleModels(models, []), models);
  assert.equal(models.length, 2);
});

test('offeredModels hides unpicked models while preserving already-picked hidden models', () => {
  const models = [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  ];
  assert.deepEqual(offeredModels(models, ['gpt-6.1-sol'], new Set()), [models[1], models[2]]);
  assert.deepEqual(offeredModels(models, ['gpt-6.1-sol'], new Set(['gpt-6.1-sol'])), models);
  assert.deepEqual(offeredModels(models, [], new Set()), models);
});

test('live hidden-model messages update the web store and notify open pickers', () => {
  const before = store.hiddenModels;
  let changes = 0;
  const off = store.on('hiddenModels', () => changes++);
  try {
    store.apply({ t: 'models.hidden', ids: ['gpt-6.1-sol'] });
    assert.deepEqual(store.hiddenModels, ['gpt-6.1-sol']);
    store.apply({ t: 'models.hidden', ids: [] });
    assert.deepEqual(store.hiddenModels, []);
    assert.equal(changes, 2);
  } finally {
    off();
    store.hiddenModels = before;
  }
});
