import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { companionCommand, companionWindowMenu, sendCompanionCommand } from '../src/desktop/companion-commands.js';

test('native close chords distinguish Shift and leave unrelated shortcuts untouched', () => {
  const input = { type: 'keyDown' as const, key: 'w', meta: true, control: false, alt: false, shift: false };
  assert.equal(companionCommand(input), 'close-pane');
  assert.equal(companionCommand({ ...input, key: 'W', shift: true }), 'send-home');
  for (const override of [{ type: 'keyUp' as const }, { meta: false }, { control: true }, { alt: true }, { key: 'q' }]) assert.equal(companionCommand({ ...input, ...override }), undefined);
});

test('companion Window menu never closes the app via either W accelerator', () => {
  const actions: string[] = [];
  const menu = companionWindowMenu(
    (command) => actions.push(command),
    () => actions.push('window'),
  );
  assert.deepEqual(
    menu.map((item) => [item.label, item.accelerator]),
    [
      ['Close Pane', 'Cmd+W'],
      ['Send Home…', 'Shift+Cmd+W'],
      ['Close Window', undefined],
    ],
  );
  for (const item of menu) (item.click as () => void)();
  assert.deepEqual(actions, ['close-pane', 'send-home', 'window']);
});

test('command delivery reaches only the current office dashboard and tolerates teardown', async () => {
  const events: string[] = [];
  let url = 'http://localhost:4677/dashboard';
  let destroyed = false;
  const target = {
    getURL: () => url,
    isDestroyed: () => destroyed,
    executeJavaScript: async (source: string) => runInNewContext(source, { Event, window: { dispatchEvent: (e: Event) => events.push(e.type) } }),
  };
  sendCompanionCommand(target, 'http://localhost:4677', 'close-pane');
  sendCompanionCommand(target, 'http://localhost:4677', 'send-home');
  assert.deepEqual(events, ['droid-office:close-pane', 'droid-office:send-home']);
  for (url of ['http://localhost:4677/', 'https://example.com/dashboard', 'data:text/html,startup', 'invalid']) sendCompanionCommand(target, 'http://localhost:4677', 'close-pane');
  url = 'http://localhost:4677/dashboard';
  destroyed = true;
  sendCompanionCommand(target, url, 'close-pane');
  destroyed = false;
  sendCompanionCommand(undefined, url, 'close-pane');
  sendCompanionCommand(target, undefined, 'close-pane');
  sendCompanionCommand(
    {
      ...target,
      getURL: () => {
        throw Error('gone');
      },
    },
    url,
    'close-pane',
  );
  sendCompanionCommand(
    {
      ...target,
      executeJavaScript: async () => {
        throw Error('gone');
      },
    },
    url,
    'close-pane',
  );
  await Promise.resolve();
  assert.equal(events.length, 2);
});
