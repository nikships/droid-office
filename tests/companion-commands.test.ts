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

test('companion Window menu routes close by focus and falls back to closing on non-dashboard pages', () => {
  const actions: string[] = [];
  let focused = true;
  let delivered = true;
  const menu = companionWindowMenu({
    isCompanionFocused: () => focused,
    run: (command) => {
      actions.push(command);
      return delivered;
    },
    closeCompanion: () => actions.push('companion-window'),
    closeSecondary: () => actions.push('secondary-window'),
  });
  assert.deepEqual(
    menu.map((item) => [item.label, item.accelerator]),
    [
      ['Close Pane', 'Cmd+W'],
      ['Send Home…', 'Shift+Cmd+W'],
      ['Close Window', undefined],
    ],
  );
  const [closePane, sendHome, closeWindow] = menu.map((item) => item.click as () => void);
  closePane!();
  sendHome!();
  assert.deepEqual(actions, ['close-pane', 'send-home']);

  delivered = false;
  closePane!();
  assert.deepEqual(actions, ['close-pane', 'send-home', 'close-pane', 'companion-window']);

  delivered = true;
  focused = false;
  closePane!();
  sendHome!();
  assert.deepEqual(actions, ['close-pane', 'send-home', 'close-pane', 'companion-window', 'secondary-window']);

  closeWindow!();
  assert.deepEqual(actions, ['close-pane', 'send-home', 'close-pane', 'companion-window', 'secondary-window', 'companion-window']);
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
  assert.equal(sendCompanionCommand(target, 'http://localhost:4677', 'close-pane'), true);
  assert.equal(sendCompanionCommand(target, 'http://localhost:4677', 'send-home'), true);
  assert.deepEqual(events, ['droid-office:close-pane', 'droid-office:send-home']);
  for (url of ['http://localhost:4677/', 'https://example.com/dashboard', 'data:text/html,startup', 'invalid']) assert.equal(sendCompanionCommand(target, 'http://localhost:4677', 'close-pane'), false);
  url = 'http://localhost:4677/dashboard';
  destroyed = true;
  assert.equal(sendCompanionCommand(target, url, 'close-pane'), false);
  destroyed = false;
  assert.equal(sendCompanionCommand(undefined, url, 'close-pane'), false);
  assert.equal(sendCompanionCommand(target, undefined, 'close-pane'), false);
  assert.equal(
    sendCompanionCommand(
      {
        ...target,
        getURL: () => {
          throw Error('gone');
        },
      },
      url,
      'close-pane',
    ),
    false,
  );
  assert.equal(
    sendCompanionCommand(
      {
        ...target,
        executeJavaScript: async () => {
          throw Error('gone');
        },
      },
      url,
      'close-pane',
    ),
    true,
  );
  await Promise.resolve();
  assert.equal(events.length, 2);
});
