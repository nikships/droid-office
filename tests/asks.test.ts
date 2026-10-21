import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_KEYS, canAnswer, menuKeys, menuOnTextRow, menuTakesText, menuTextKeys, readMenu, replyKeys, sameMenu, workerMenu, type Menu } from '../src/shared/asks.js';
import { Answers, type AnswerHost } from '../src/server/answers.js';

// These screens are the same Droid fixtures used by Android's ChoicesTest/AsksTest.
const BOX = [
  '  Ask User',
  '  Which greeting should I write into HELLO.md?',
  '  1. hi',
  '     Short and friendly',
  '     for a README',
  '  2. hello',
  '  3. hey',
  '     Casual',
  '  Or type your own answer...',
  '',
  '  ↑/↓ Navigate · Space/Enter/1-9 Select · ESC stop agent',
];
const POINTER = ['Do you trust the files in this folder?', '/tmp/do-qa-test', '', '> 1. Yes, proceed', '  2. Yes, and remember this folder', '  3. No, exit', '', 'Enter to confirm · Esc to exit'];
const DIGITS = ['│ Which file should I create? │', '│ 1. hello.txt │', '│    A greeting │', '│ 2. bye.txt │', '│ 3. Other (type your answer) │', '│ Press a number to answer, Esc to skip │'];

test('question parsing and keys agree with Android’s real menu fixtures', () => {
  const box = readMenu(BOX)!;
  assert.equal(box.question, 'Which greeting should I write into HELLO.md?');
  assert.deepEqual(
    box.choices.map((c) => c.description),
    ['Short and friendly for a README', undefined, 'Casual'],
  );
  assert.equal(box.freeText, true);
  assert.equal(menuTextKeys(box, 'salut\n'), `${ASK_KEYS.DOWN.repeat(3)}salut\r`);
  assert.equal(menuTextKeys(box, '  '), undefined);
  const pointer = readMenu(POINTER)!;
  assert.equal(pointer.pointer, 0);
  assert.equal(readMenu(['Question?', '> 1. One', '> 2. Two'])?.pointer, undefined);
  assert.equal(menuKeys(pointer, pointer.choices[2]!), `${ASK_KEYS.DOWN.repeat(2)}\r`);
  const moved = { ...pointer, pointer: 2 };
  assert.equal(menuKeys(moved, moved.choices[1]!), `${ASK_KEYS.UP}\r`);
  assert.equal(menuKeys(moved, { number: 9, label: 'missing' }), '9');
  const digits = readMenu(DIGITS)!;
  assert.equal(digits.question, 'Which file should I create?');
  assert.equal(digits.choices[0]!.description, 'A greeting');
  assert.equal(menuTakesText(digits), true);
  assert.equal(menuTextKeys(digits, 'bonjour.txt'), '3bonjour.txt\r');
  assert.equal(replyKeys(digits, ' 2 '), '2');
  assert.equal(replyKeys(digits, 'hi'), '3hi\r');
  assert.equal(replyKeys(undefined, '2'), undefined);
  assert.equal(menuOnTextRow(['  Enter Submit answer • ← back to options • ESC stop agent', '']), true);
  assert.equal(menuOnTextRow(BOX), false);
});

test('incomplete, stale lists and unsupported workers are not synthetic questions', () => {
  for (const lines of [[], [''], ['1. only one'], ['2. two', '3. three'], ['1. one', '2. two', ...Array.from({ length: 7 }, () => 'work continues')], ['1. one', 'a', 'b', 'c', '2. two']]) assert.equal(readMenu(lines), undefined);
  const menu = readMenu(['1. stale', 'Pick one?', '1. red', '2. green'])!;
  assert.equal(menu.question, 'Pick one?');
  assert.equal(menuTakesText(menu), false);
  assert.equal(menuTextKeys(menu, 'blue'), undefined);
  assert.equal(sameMenu(menu, { ...menu, pointer: 1 }), true);
  assert.equal(sameMenu(menu, { ...menu, question: 'New?' }), false);
  assert.equal(sameMenu(menu, readMenu(['Pick one?', '1. red', '2. blue'])), false);
  assert.equal(sameMenu(menu, undefined), false);
  assert.equal(sameMenu({ choices: null } as unknown as Menu, menu), false);
  assert.equal(sameMenu({ choices: [null] } as unknown as Menu, menu), false);
  const w = { kind: 'agent', status: 'needs_input' };
  assert.equal(canAnswer(w, BOX), true);
  for (const patch of [{ kind: 'shell' }, { kind: 'cloud' }, { guest: {} }, { cloud: {} }, { status: 'working' }, { status: 'offline' }]) assert.equal(canAnswer({ ...w, ...patch }, BOX), false);
  assert.equal(workerMenu(w, undefined), undefined);
});

function host() {
  const writes: string[] = [];
  const state = { worker: { kind: 'agent', status: 'needs_input' }, lines: [...POINTER], live: true };
  const api: AnswerHost = { worker: () => state.worker, lines: () => state.lines, live: () => state.live, write: (s) => writes.push(s) };
  return { state, writes, api };
}

test('answers revalidate the latest status, menu and pointer and reject duplicate submissions', async () => {
  const { state, writes, api } = host();
  const answers = new Answers();
  const shown = readMenu(state.lines)!;
  state.lines = state.lines.map((s) => s.replace('> 1.', '  1.').replace('  3.', '> 3.'));
  assert.equal(await answers.answer('a', shown, { choice: 2 }, api), undefined);
  assert.deepEqual(writes, [`${ASK_KEYS.UP}\r`]);
  assert.match((await answers.answer('a', shown, { choice: 2 }, api))!, /already/);
  answers.changed('a', 'working');
  state.worker.status = 'working';
  assert.match((await answers.answer('a', shown, { choice: 1 }, api))!, /changed/);
  state.worker.status = 'needs_input';
  state.lines[0] = 'A different question?';
  assert.match((await answers.answer('a', shown, { choice: 1 }, api))!, /changed/);
  state.lines = [...POINTER];
  state.live = false;
  assert.match((await answers.answer('a', shown, { choice: 1 }, api))!, /changed/);
  assert.equal(writes.length, 1);
  state.live = true;
  assert.match((await answers.answer('a', shown, { choice: 8 }, api))!, /no longer/);
  assert.match((await answers.answer('a', shown, { text: 'abc' }, api))!, /cannot safely/);
  for (const text of ['', '\x1b[31m', '\u200b']) assert.match((await answers.answer('a', shown, { text }, api))!, /ordinary text/);
  state.lines = [...DIGITS];
  assert.equal(await answers.answer('a', readMenu(DIGITS)!, { text: 'hi\nthere' }, api), undefined);
  assert.equal(writes.at(-1), '3hi there\r');
  answers.changed('a');
});

test('typed answers wait for the real text row and refuse a changed question or disconnected host', async () => {
  const { state, writes, api } = host();
  state.lines = [...BOX];
  const answers = new Answers();
  const shown = readMenu(BOX)!;
  const pending = answers.answer('a', shown, { text: 'salut' }, api);
  assert.match((await answers.answer('a', shown, { text: 'duplicate' }, api))!, /already/);
  assert.deepEqual(writes, [ASK_KEYS.DOWN.repeat(3)]);
  state.lines = [...BOX.slice(0, -3), '', '  > salut', '  Enter Submit answer • ← back to options • ESC stop agent'];
  assert.equal(await pending, undefined);
  assert.equal(writes.at(-1), 'salut\r');
  answers.changed('a', 'done');
  state.lines = [...BOX];
  const changed = answers.answer('a', shown, { text: 'never type me' }, api);
  state.lines[1] = 'A different question?';
  assert.match((await changed)!, /changed/);
  assert.ok(!writes.some((s) => s.includes('never type me')));
  state.lines = [...BOX];
  const disconnected = answers.answer('a', shown, { text: 'offline text' }, api);
  state.live = false;
  assert.match((await disconnected)!, /changed/);
  assert.ok(!writes.some((s) => s.includes('offline text')));
});
