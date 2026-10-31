import test from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_HISTORY_MAX, loadPromptHistory, recallPrompt, rememberPrompt, savePromptHistory } from '../src/client/prompt-recall.js';
import { officeTitle } from '../src/client/tab-title.js';

test('a sent prompt is kept newest-first, a repeat moves to the front, and the list stops at 50', () => {
  assert.deepEqual(rememberPrompt(['older'], '  '), ['older']);
  assert.deepEqual(rememberPrompt(['older'], '  newer \r\n'), ['newer', 'older']);
  assert.deepEqual(rememberPrompt(['newer', 'older'], 'older'), ['older', 'newer']);

  const many = Array.from({ length: PROMPT_HISTORY_MAX + 5 }, (_, i) => `p${i}`);
  const kept = many.reduce<string[]>((history, text) => rememberPrompt(history, text), []);
  assert.equal(kept.length, PROMPT_HISTORY_MAX);
  assert.equal(kept[0], `p${PROMPT_HISTORY_MAX + 4}`);
  assert.equal(kept.at(-1), 'p5');
  assert.deepEqual(many.slice(0, 3), ['p0', 'p1', 'p2']);
});

test('Up and Down walk saved prompts and return to the draft, without wrapping', () => {
  const history = ['newest', 'older', 'oldest'];
  const up = recallPrompt(history, -1, 'up', 'draft');
  assert.deepEqual(up, { index: 0, text: 'newest' });
  assert.deepEqual(recallPrompt(history, up.index, 'up', 'draft'), { index: 1, text: 'older' });
  const end = recallPrompt(history, 2, 'up', 'draft');
  assert.deepEqual(end, { index: 2, text: 'oldest' });
  assert.deepEqual(recallPrompt(history, end.index, 'down', 'draft'), { index: 1, text: 'older' });
  assert.deepEqual(recallPrompt(history, 0, 'down', 'draft'), { index: -1, text: 'draft' });
  assert.deepEqual(recallPrompt(history, -1, 'down', 'draft'), { index: -1, text: 'draft' });
  assert.deepEqual(recallPrompt([], -1, 'up', 'draft'), { index: -1, text: 'draft' });
});

test('prompt history survives a reload and ignores junk', () => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  assert.deepEqual(loadPromptHistory(), []);
  savePromptHistory(['  first  ', 'second']);
  assert.deepEqual(loadPromptHistory(), ['first', 'second']);
  mem.set('droid-office.prompt-history', JSON.stringify(['ok', 4, '', '  also  ']));
  assert.deepEqual(loadPromptHistory(), ['ok', 'also']);
  mem.set('droid-office.prompt-history', '{');
  assert.deepEqual(loadPromptHistory(), []);
});

test('the waiting count is only on the tab title while the tab is in the background', () => {
  assert.equal(officeTitle('my-project', 2, false), 'my-project · Droid Office');
  assert.equal(officeTitle('my-project', 2, true), '(2) my-project · Droid Office');
  assert.equal(officeTitle(undefined, 2, true), '(2) Droid Office');
  assert.equal(officeTitle(undefined, 0, true), 'Droid Office');
  assert.equal(officeTitle('my-project', 0, true), 'my-project · Droid Office');
});
