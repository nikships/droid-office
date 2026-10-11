import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudScreen, wrap } from '../src/shared/cloud-screen.js';
import type { FactoryMessage } from '../src/shared/factory-sessions.js';
import { FLAG_BOLD } from '../src/shared/protocol.js';

const text = (f: NonNullable<ReturnType<typeof cloudScreen>>) => Array.from({ length: f.rows }, (_, y) => (f.lines[y] ?? []).map((r) => r[0]).join(''));

test('wrap breaks at spaces, hard-cuts long words and drops ANSI and control characters', () => {
  assert.deepEqual(wrap('one two three', 8), ['one two', 'three']);
  assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrap('\x1b[31mred\x1b[0m\r\nnext\tx\x07', 20), ['red', 'next  x']);
});

test('a transcript reads like the Droid CLI: prompt, thinking, reply, tool calls with their results', () => {
  const messages: FactoryMessage[] = [
    { id: 'u', role: 'user', createdAt: 1, seq: 1, blocks: [{ type: 'text', text: 'Fix the tests' }] },
    {
      id: 'a',
      role: 'assistant',
      createdAt: 2,
      seq: 2,
      blocks: [
        { type: 'thinking', text: 'Let me look\nat things' },
        { type: 'text', text: 'Running **them** now.' },
        { type: 'tool_use', id: 't1', name: 'Execute', input: { command: 'npm test' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/a.ts' } },
      ],
    },
    { id: 'r', role: 'tool', createdAt: 3, seq: 3, blocks: [{ type: 'tool_result', toolUseId: 't1', text: '1\n2\n3\n4\n5', isError: false }] },
  ];
  const f = cloudScreen(messages, 40, 30)!;
  const lines = text(f).filter((l) => l);
  assert.deepEqual(lines, ['> Fix the tests', '✻ Let me look', '⛬ Running them now.', '● Execute npm test', '  ⎿  1', '     2', '     3', '     … +2 lines', '● Read src/a.ts']);
  const read = text(f).indexOf('● Read src/a.ts');
  assert.equal(f.lines[read][0][1], 8, 'a call with no result and newer messages after it is not running');
  const running = text(cloudScreen(messages.slice(0, 2), 40, 30)!).filter((l) => l);
  assert.deepEqual(running.slice(-2), ['● Read src/a.ts', '  ⎿  Running…']);
  assert.equal(f.lines[0][1][3] & FLAG_BOLD, FLAG_BOLD, 'the prompt is bold');
  assert.equal(
    text(f).every((l) => [...l].length <= 40),
    true,
  );
});

test('only the newest rows show, and an empty transcript has no screen', () => {
  const messages: FactoryMessage[] = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: 'assistant', createdAt: i, seq: i, blocks: [{ type: 'text', text: `reply ${i}` }] }));
  const f = cloudScreen(messages, 40, 10)!;
  const lines = text(f);
  assert.equal(lines.length, 10);
  assert.equal(lines.at(-1), '⛬ reply 29');
  assert.equal(cloudScreen([]), undefined);
});
