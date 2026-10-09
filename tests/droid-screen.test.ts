import test from 'node:test';
import assert from 'node:assert/strict';
import { readDroidScreen, screenStatus } from '../src/server/droid-screen.js';

// The bottom of droid 0.234's screen in each state, as its terminal showed them.
const box = (text: string) => ['╭──────────────────────────────────────────────────────────────╮', `│ > ${text.padEnd(59)}│`, '╰──────────────────────────────────────────────────────────────╯'];
const footer = ['[⏱ 6s, context: 4%] ? for help                     MCP ✓ | IDE ◌', '/private/tmp/proj | master'];
const history = ['   Run the shell command: sleep 5 && echo done.', '', '   Execute sleep 5', '           && echo done', ''];

const BUSY = [...history, ' ⠋ Executing...  (Press ESC to stop)', '', ' Auto (Off) · all actions require approval        Sonnet 5.5 (High)', ...box('Enter to steer · Ctrl+Enter to queue'), ...footer];
const IDLE = [...history, '    ↳ done', '', '⛬  Done.', '', ' Auto (Off) · all actions require approval        Sonnet 5.5 (High)', ...box(''), ...footer];
const PERMISSION = [
  ...history,
  '  Command to approve · low risk',
  '  ↳ sleep 5 && echo done',
  '╭──────────────────────────────────────────────────────────────╮',
  '│  Yes, allow                                                  │',
  '│  Yes, and always allow low impact commands                   │',
  '│  No, cancel                                                  │',
  '╰──────────────────────────────────────────────────────────────╯',
  '  ↑↓ navigate   Enter select   Esc cancel   Alt/Option+E to inspect approval details',
];
const QUESTION = [...history, '   Ask User', '   Which do you pick: red or blue?', '', '   1. Red', '   2. Blue', '   Or type your own answer...', '', '   ↑/↓ Navigate • Space/Enter/1–9 Select • ESC stop agent'];

test("Droid's screen says whether it's busy, asking or at rest", () => {
  assert.equal(readDroidScreen(BUSY), 'busy');
  assert.equal(readDroidScreen(IDLE), 'idle');
  assert.equal(readDroidScreen(PERMISSION), 'asking');
  assert.equal(readDroidScreen(QUESTION), 'asking');
  // Trailing blank rows under the cursor don't push its live area out of view.
  assert.equal(readDroidScreen([...BUSY, '', '', '', '', '', '', '', '', '', '']), 'busy');
});

test('only the bottom of the screen counts, not what scrolled by above it', () => {
  const quoted = ['  cat src/server/droid-screen.ts', '  /Press ESC to stop/  /inspect approval details/', ...Array.from({ length: 6 }, (_, i) => `  line ${i}`)];
  assert.equal(readDroidScreen([...quoted, ...IDLE]), 'idle');
  // Something else (a login, a menu, another program): no say.
  assert.equal(readDroidScreen(['Sign in to Factory', 'Open https://app.factory.ai/device', '']), undefined);
  assert.equal(readDroidScreen([]), undefined);
});

test('a settled screen corrects only the status it contradicts', () => {
  // Busy on screen while it shows done (a queued message started a turn), idle, or still asking (the prompt was answered).
  assert.equal(screenStatus('done', 'busy', false), 'working');
  assert.equal(screenStatus('idle', 'busy', false), 'working');
  assert.equal(screenStatus('needs_input', 'busy', false), 'working');
  assert.equal(screenStatus('working', 'busy', false), undefined);
  // A spinner that stopped printing isn't a turn going on.
  assert.equal(screenStatus('done', 'busy', true), undefined);

  // At rest while it shows working or asking (a Stop that never came): done.
  assert.equal(screenStatus('working', 'idle', true), 'done');
  assert.equal(screenStatus('needs_input', 'idle', true), 'done');
  assert.equal(screenStatus('working', 'idle', false), undefined, 'still printing');
  assert.equal(screenStatus('done', 'idle', true), undefined);
  assert.equal(screenStatus('idle', 'idle', true), undefined);

  // A dialog waiting on someone, whatever the status said.
  for (const status of ['working', 'done', 'idle'] as const) assert.equal(screenStatus(status, 'asking', true), 'needs_input');
  assert.equal(screenStatus('needs_input', 'asking', true), undefined);

  // Nothing to correct about a droid that isn't running a session.
  for (const status of ['starting', 'exited', 'offline'] as const) {
    for (const screen of ['busy', 'asking', 'idle'] as const) {
      assert.equal(screenStatus(status, screen, true), undefined);
      assert.equal(screenStatus(status, screen, false), undefined);
    }
  }
});
