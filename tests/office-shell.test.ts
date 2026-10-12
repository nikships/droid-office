import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OfficeShell } from '../src/server/office-shell.js';
import { PtyHost } from '../src/server/ptys.js';

async function waitFor(pred: () => boolean, detail: () => string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out\n${detail().slice(-800)}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

test('the boss shell runs, restarts after exit, and is picked up after an office restart', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-shell-'));
  const data = path.join(root, '.droid-office');
  let output = '';
  let host = new PtyHost(data, () => {});
  let shell = new OfficeShell(root, data, host, {
    screen: () => {},
    data: (chunk) => {
      output += chunk;
    },
  });
  t.after(() => {
    shell.shutdown(false);
    host.stop();
    rmSync(root, { recursive: true, force: true });
  });

  await host.connect();
  await shell.start();
  const open = shell.attach('one');
  assert.ok(open);
  assert.equal(open.shared, false);
  assert.equal(shell.attach('two')?.shared, true);
  shell.detach('two');

  shell.write('echo OFFICE_SHELL_OK\r');
  await waitFor(
    () => output.includes('OFFICE_SHELL_OK'),
    () => output,
  );
  await waitFor(
    () => JSON.stringify(shell.fullScreen() ?? {}).includes('OFFICE_SHELL_OK'),
    () => output,
  );

  shell.resize(80, 24);
  assert.equal(shell.fullScreen()?.cols, 80);
  assert.equal(shell.fullScreen()?.rows, 24);

  const dropped = shell.drop('note.txt', 'text/plain', Buffer.from('hi'));
  assert.ok(dropped);
  assert.equal(readFileSync(dropped, 'utf8'), 'hi');

  output = '';
  shell.write('exit\r');
  await waitFor(
    () => output.includes('starting another'),
    () => output,
  );
  // The next shell is a fresh login, so give it a moment before typing.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  shell.write('echo AFTER_RESTART\r');
  await waitFor(
    () => output.includes('AFTER_RESTART'),
    () => output,
  );

  const statePath = path.join(data, 'shell.json');
  const before = JSON.parse(readFileSync(statePath, 'utf8')) as { ptyId?: string };
  shell.shutdown(true);
  host.detach();

  output = '';
  host = new PtyHost(data, () => {});
  shell = new OfficeShell(root, data, host, {
    screen: () => {},
    data: (chunk) => {
      output += chunk;
    },
  });
  await host.connect();
  await shell.start();
  const after = JSON.parse(readFileSync(statePath, 'utf8')) as { ptyId?: string };
  if (before.ptyId) assert.equal(after.ptyId, before.ptyId, 'the same terminal host session is still the shell');
  shell.attach('again');
  shell.write('echo STILL_THERE\r');
  await waitFor(
    () => output.includes('STILL_THERE'),
    () => output,
  );
});
