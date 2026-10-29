import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardQuestion, DashboardQuestionDrafts } from '../src/client/dashboard-question.js';
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

test('a new worker session invalidates an identical question receipt', () => {
  const state = new DashboardQuestion();
  state.sync(menu, 100, 'old-session');
  const revision = state.revision;
  state.answering = true;
  state.sync(menu, 100, 'new-session');
  assert.equal(state.answering, false);
  assert.notEqual(state.revision, revision);
});

test('answer text and checkbox drafts survive independent floor and pane remounts', () => {
  const drafts = new DashboardQuestionDrafts();
  const first = drafts.get('floor-a:worker', menu, 100, 'session');
  first.text = 'My answer';
  first.choices = [1, 2];
  const other = drafts.get('floor-b:worker', menu, 100, 'session');
  assert.deepEqual(other, { text: '' });
  other.text = 'Another floor';
  assert.equal(drafts.get('floor-a:worker', { ...menu, pointer: 2 }, 100, 'session'), first);
  assert.deepEqual(first, { text: 'My answer', choices: [1, 2] });
});

test('changed questions and sessions never inherit old answer selections', () => {
  const drafts = new DashboardQuestionDrafts();
  const first = drafts.get('worker', menu, 100, 'session');
  first.text = 'Old answer';
  first.choices = [1];
  const later = drafts.get('worker', menu, 200, 'session');
  assert.notEqual(later, first);
  assert.deepEqual(later, { text: '' });
  later.choices = [2];
  assert.deepEqual(drafts.get('worker', menu, 200, 'new-session'), { text: '' });
  drafts.get('worker', menu, 200, 'new-session').text = 'Typed';
  assert.deepEqual(drafts.get('worker', { ...menu, question: 'A different question?' }, 200, 'new-session'), { text: '' });
});

test('connection loss clears all floor answer drafts, while forgetting one leaves the rest', () => {
  const drafts = new DashboardQuestionDrafts();
  drafts.get('floor-a:worker', menu).text = 'First';
  drafts.get('floor-b:worker', menu).choices = [2];
  drafts.forget('floor-a:worker');
  assert.deepEqual(drafts.get('floor-a:worker', menu), { text: '' });
  assert.deepEqual(drafts.get('floor-b:worker', menu).choices, [2]);
  drafts.clear();
  assert.deepEqual(drafts.get('floor-a:worker', menu), { text: '' });
  assert.deepEqual(drafts.get('floor-b:worker', menu), { text: '' });
});
