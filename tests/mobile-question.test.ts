import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readMenu } from '../src/shared/asks.js';
import { questionFeedback, questionReply, type QuestionDraft, selectQuestionChoice, writeQuestionText } from '../src/mobile/model.js';

// Same owner-captured checkbox labels and CLI hints as ask-question.test.ts.
const menu = readMenu(['  What does managing agents simultaneously mean to you?', '  1. [ ] Persistent roster', '  2. [x] Several conversations', '  [ ] Or type your own answer...', '  Submit', '  Space/Enter/1–9 Toggle'])!;
const draft = (multi = true): QuestionDraft => ({ workerId: 'w', token: { office: 'o', epoch: 1, floor: 'a', arrival: 1 }, waitingSince: 10, sessionId: 's', menu: { ...menu, multiSelect: multi }, text: '', choices: [], state: 'idle' });

test('checkbox drafts toggle independently, preserve custom text, and submit a complete sorted selection', () => {
  let d = writeQuestionText(draft(), '  And my own answer  ');
  d = selectQuestionChoice(selectQuestionChoice(d, 2), 1);
  assert.deepEqual(questionReply(d), { choices: [1, 2], text: 'And my own answer' });
  d = selectQuestionChoice(d, 2);
  assert.deepEqual(questionReply(d), { choices: [1], text: 'And my own answer' });
  d = selectQuestionChoice(d, 1);
  assert.deepEqual(questionReply(d), { choices: [], text: 'And my own answer' });
  assert.equal(selectQuestionChoice(d, 9), d);
  assert.equal(questionReply({ ...d, choices: [9] }), undefined);
  assert.equal(questionReply({ ...d, menu: { ...d.menu, freeText: false } }), undefined);
  assert.equal(questionReply(draft()), undefined);
  assert.equal(writeQuestionText(d, 'x'.repeat(20001)).text.length, 20000);
});

test('radio drafts and custom answers exclude each other and reject invalid multiple selections', () => {
  let d = selectQuestionChoice(draft(false), 1);
  assert.deepEqual(questionReply(d), { choice: 1 });
  d = selectQuestionChoice(d, 2);
  assert.deepEqual(d.choices, [2]);
  d = writeQuestionText(d, 'Other direction');
  assert.deepEqual(d.choices, []);
  assert.deepEqual(questionReply(d), { text: 'Other direction' });
  d = selectQuestionChoice(d, 1);
  assert.equal(d.text, '');
  assert.equal(questionReply({ ...d, choices: [1, 2] }), undefined);
});

test('a confirmed native answer stays confirmed after the worker advances, without disguising uncertain replies', () => {
  const d = draft();
  assert.match(questionFeedback({ ...d, state: 'sending' }, false, true), /^Sending/);
  assert.match(questionFeedback({ ...d, state: 'sent' }, false, true), /^Answer sent\./);
  assert.match(questionFeedback({ ...d, state: 'sent' }, true, true), /^Answer sent\./);
  assert.match(questionFeedback(d, false, true), /changed or was answered elsewhere/);
  assert.match(questionFeedback(d, true, false), /cannot safely submit/);
  assert.match(questionFeedback(d, true, true), /Nothing is sent until you submit/);
  assert.equal(questionFeedback({ ...d, state: 'uncertain', error: 'Not confirmed' }, true, true), 'Not confirmed');
});

test('native question controls use the shared presentation, full text, a pinned Submit, and no bypassing modal', () => {
  const ui = readFileSync(new URL('../src/mobile/ui/QuestionWorkspace.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/mobile/ui/App.tsx', import.meta.url), 'utf8');
  const thread = readFileSync(new URL('../src/mobile/ui/Thread.tsx', import.meta.url), 'utf8');
  assert.match(ui, /questionPresentation\(draft\.menu,/);
  assert.doesNotMatch(ui, /<Modal|numberOfLines|onSubmitEditing/);
  assert.match(ui, /accessibilityRole=\{draft\.menu\.multiSelect \? 'checkbox' : 'radio'\}/);
  assert.match(ui, /accessibilityState=\{\{ checked, disabled: !enabled \}\}/);
  assert.match(ui, /onPress=\{\(\) => session\.selectAnswer\(draft, choice\.number\)\}/);
  assert.ok(ui.indexOf('</ScrollView>') < ui.indexOf('testID="question-footer"'));
  assert.equal((ui.match(/session\.answer\(/g) ?? []).length, 1, 'only Submit sends');
  for (const id of ['question-workspace', 'question-scroll', 'question-text', 'question-close', 'answer-text', 'question-footer', 'question-review', 'question-raw', 'question-submit', 'question-feedback'])
    assert.ok(ui.includes(`testID="${id}"`), id);
  assert.match(app, /<SafeAreaView[^>]*testID="app">\s*<QuestionWorkspace/);
  assert.match(app, /if \(snap\.question\) return session\.closeQuestion\(\), true/);
  assert.match(thread, /label="Answer questions"[^\n]+testID="question-open"/);
  assert.doesNotMatch(thread, /session\.answer\(/);
});
