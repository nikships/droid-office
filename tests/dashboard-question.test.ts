import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardQuestion } from '../src/client/dashboard-question.js';
import { readMenu } from '../src/shared/asks.js';

// The Droid folder-trust screen also used in asks.test.ts.
const menu = readMenu(['Do you trust the files in this folder?', '/tmp/do-qa-test', '', '> 1. Yes, proceed', '  2. Yes, and remember this folder', '  3. No, exit', '', 'Enter to confirm · Esc to exit'])!;

test('an answered question stays answered through pointer and screen updates', () => {
  const state = new DashboardQuestion();
  state.sync(menu, 100);
  const revision = state.revision;
  state.answered = true;
  state.sync({ ...menu, pointer: 1 }, 100);
  assert.equal(state.answered, true);
  assert.equal(state.revision, revision);
});

test('a later identical question resets both receipt flags and invalidates the old reply', () => {
  const state = new DashboardQuestion();
  state.sync(menu, 100);
  const oldReply = state.revision;
  state.answered = true;
  state.answering = true;
  state.sync(menu, 200);
  assert.equal(state.answered, false);
  assert.equal(state.answering, false);
  assert.notEqual(state.revision, oldReply);
});

test('a changed menu or leaving a question invalidates its receipt without a timestamp', () => {
  const state = new DashboardQuestion();
  state.sync(menu, undefined);
  state.answered = true;
  state.sync({ ...menu, question: 'Changed question?' }, undefined);
  assert.equal(state.answered, false);
  state.answering = true;
  state.sync(undefined, undefined);
  const revision = state.revision;
  assert.equal(state.answering, false);
  state.sync(undefined, undefined);
  assert.equal(state.revision, revision);
  state.sync(menu, undefined);
  assert.notEqual(state.revision, revision);
});
