import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_KEYS, canAnswer, menuKeys, menuOnTextRow, menuTakesText, menuTextKeys, menuTextRowEmpty, readMenu, readScreenMenu, replyKeys, sameMenu, workerMenu, type Menu } from '../src/shared/asks.js';
import { FLAG_BOLD, type Run } from '../src/shared/protocol.js';
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

// Question and labels transcribed from the owner's checkbox screenshot. Focus and hints match
// the installed CLI's AskUser renderer/reducer, not a generic checkbox picker.
const MULTI_QUESTION = 'What does managing agents simultaneously primarily mean to you?';
const MULTI_OPTIONS = [
  'Persistent roster with live status while working in one conversation',
  'Several conversations or terminals visible side by side on larger screens',
  'Select multiple agents to send instructions, stop, resume, or dismiss',
  'One attention inbox for questions, approvals, failures, and finished work',
];
function checkboxHost() {
  const state = { selected: new Set([2]), focus: 0, typed: '', submitted: 0, live: true, question: MULTI_QUESTION };
  const writes: string[] = [];
  const rows = (): Run[][] =>
    [
      ['  Ask User', false],
      [state.question, false],
      ['', false],
      ...MULTI_OPTIONS.map((option, i) => [`  ${i + 1}. [${state.selected.has(i + 1) ? 'x' : ' '}] ${option}`, state.focus === i]),
      [`  [${state.typed ? 'x' : ' '}] ${state.typed || 'Or type your own answer...'}`, state.focus === 4],
      ['', false],
      ['  Submit', state.focus === 5],
      ['', false],
      [state.focus === 4 ? '  Enter Add answer • ↑ back to options • ESC stop agent' : '  ↑/↓ Navigate • Space/Enter/1–9 Toggle • ESC stop agent', false],
    ].map(([text, bold]) => [[String(text), -1, -1, bold ? FLAG_BOLD : 0] as Run]);
  const api: AnswerHost = {
    worker: () => ({ kind: 'agent', status: 'needs_input' }),
    lines: () => rows().map((runs) => runs.map((run) => run[0]).join('')),
    menu: () => readScreenMenu(rows()),
    live: () => state.live,
    write(data) {
      writes.push(data);
      for (const key of data.match(/\x1b\[[AB]|\x01\x0b|\r|[^\x1b\r\x01\x0b]+/g) ?? []) {
        if (key === ASK_KEYS.DOWN) state.focus = (state.focus + 1) % 6;
        else if (key === ASK_KEYS.UP) state.focus = (state.focus + 5) % 6;
        else if (key === ASK_KEYS.ENTER) {
          if (state.focus === 5) state.submitted++;
          else if (state.focus === 4) state.focus = 5;
          else throw new Error('Enter toggles an option, not Submit');
        } else if (key === '\x01\x0b' && state.focus === 4) state.typed = '';
        else if (state.focus === 4) state.typed += key;
        else if (/^[1-4]$/.test(key)) {
          const number = Number(key);
          if (state.selected.has(number)) state.selected.delete(number);
          else state.selected.add(number);
        } else throw new Error(`Unexpected CLI input ${JSON.stringify(key)}`);
      }
    },
  };
  return { state, writes, api, rows };
}

test('checkbox menus preserve checks, recover wrapped questions and never use single-answer shortcuts', () => {
  const { api, rows } = checkboxHost();
  const menu = readMenu(api.lines()!)!;
  assert.equal(menu.multiSelect, true);
  assert.deepEqual(
    menu.choices.map((choice) => choice.selected),
    [false, true, false, false],
  );
  assert.equal(menu.choices[1].label, MULTI_OPTIONS[1]);
  assert.equal(menu.freeText, true);
  assert.equal(menuKeys(menu, menu.choices[0]), '');
  assert.equal(menuTextKeys(menu, 'Other'), undefined);
  assert.equal(replyKeys(menu, '1'), undefined);
  assert.equal(readScreenMenu(rows())?.pointer, 0);
  assert.equal(readScreenMenu([[['1. Earlier numbered tool output', -1, -1, FLAG_BOLD]], ...rows()])?.pointer, 0);
  assert.equal(sameMenu(menu, { ...menu, choices: menu.choices.map((choice) => ({ ...choice, selected: !choice.selected })), pointer: 3 }), true);
  assert.equal(sameMenu(menu, { ...menu, multiSelect: false }), false);
  const wrapped = readMenu([
    '  Ask User',
    '',
    '  What design direction should the web and Android',
    '  companions follow?',
    '',
    '  1. Dense operations console: compact rows,',
    '     dense hierarchy, strong keyboard support',
    '  2. Conversation-first: agent sidebar and clean chat workspace',
    '  Or type your own answer...',
    '',
    '  Space/Enter/1-9 Select',
  ]);
  assert.equal(wrapped?.question, 'What design direction should the web and Android companions follow?');
  assert.equal(wrapped?.choices[0].description, 'dense hierarchy, strong keyboard support');
});

test('checkbox answers change only the necessary checks and submit only on verified action focus', async () => {
  for (const focus of [0, 2, 4, 5]) {
    const { state, writes, api } = checkboxHost();
    state.focus = focus;
    const answers = new Answers();
    const shown = readMenu(api.lines()!)!;
    assert.equal(await answers.answer('a', shown, { choices: [1, 3] }, api), undefined);
    assert.deepEqual([...state.selected].sort(), [1, 3]);
    assert.equal(state.submitted, 1);
    assert.equal(state.typed, '');
    assert.deepEqual(
      writes.filter((write) => /^[1-4]$/.test(write)),
      ['1', '2', '3'],
    );
    assert.match((await answers.answer('a', shown, { choices: [1] }, api))!, /already/);
  }
});

test('checkbox answers support adding custom text without dropping the desired selection', async () => {
  const { state, api } = checkboxHost();
  assert.equal(await new Answers().answer('a', readMenu(api.lines()!)!, { choices: [1, 4], text: 'Also keep my keyboard workflow' }, api), undefined);
  assert.deepEqual([...state.selected].sort(), [1, 4]);
  assert.equal(state.typed, 'Also keep my keyboard workflow');
  assert.equal(state.submitted, 1);
});

test('checkbox submissions replace previous custom text, and omit it when only checkboxes are desired', async () => {
  for (const text of [undefined, 'A replacement answer']) {
    const { state, api } = checkboxHost();
    state.typed = 'An existing terminal draft';
    assert.equal(menuTextRowEmpty(api.lines()!), false);
    assert.equal(await new Answers().answer('a', readMenu(api.lines()!)!, { choices: [1], ...(text ? { text } : {}) }, api), undefined);
    assert.equal(state.typed, text ?? '');
    assert.deepEqual([...state.selected], [1]);
    assert.equal(state.submitted, 1);
  }
  assert.equal(menuTextRowEmpty([]), false);
});

test('long wrapped answers retain all description text and the custom-answer row', () => {
  const menu = readMenu([
    'Question?',
    '  1. First',
    ...Array.from({ length: 10 }, (_, i) => `     First description paragraph ${i + 1}`),
    '  2. Second',
    ...Array.from({ length: 10 }, (_, i) => `     Second description paragraph ${i + 1}`),
    '  Or type your own answer...',
    '  A footer hint',
    '     Not an answer description',
  ])!;
  assert.ok(menu.choices[0].description!.length > 160);
  assert.ok(menu.choices[1].description!.endsWith('paragraph 10'));
  assert.equal(menu.freeText, true);
});

test('checkbox changes must be confirmed before Submit, including concurrent terminal edits', async () => {
  const unchanged = checkboxHost();
  unchanged.api.write = () => {};
  assert.match((await new Answers().answer('a', readMenu(unchanged.api.lines()!)!, { choices: [1] }, unchanged.api))!, /selection.*verified/i);
  assert.equal(unchanged.state.submitted, 0);
  const edited = checkboxHost();
  const write = edited.api.write;
  edited.api.write = (data) => {
    write(data);
    if (edited.state.focus === 5) edited.state.selected.add(2);
  };
  assert.ok(await new Answers().answer('a', readMenu(edited.api.lines()!)!, { choices: [1] }, edited.api));
  assert.equal(edited.state.submitted, 0);
});

test('invalid or stale checkbox answers never submit and unverified focus never types', async () => {
  for (const reply of [{ choice: 1 }, { choices: [] }, { choices: [8] }, { choices: [1, 1] }, { choices: [1], text: '\x1b' }]) {
    const { state, writes, api } = checkboxHost();
    assert.ok(await new Answers().answer('a', readMenu(api.lines()!)!, reply, api));
    assert.equal(state.submitted, 0);
    assert.deepEqual(writes, []);
  }
  const { state, api, writes } = checkboxHost();
  const shown = readMenu(api.lines()!)!;
  api.menu = () => readMenu(api.lines()!);
  assert.match((await new Answers().answer('a', shown, { choices: [1] }, api))!, /focus/);
  assert.deepEqual(writes, []);
  const real = checkboxHost();
  const write = real.api.write;
  real.api.write = (data) => {
    write(data);
    real.state.question = 'A different question?';
  };
  assert.ok(await new Answers().answer('a', shown, { choices: [1] }, real.api));
  assert.equal(real.state.submitted, 0);
  state.live = false;
  assert.ok(await new Answers().answer('a', shown, { choices: [1] }, api));
});
