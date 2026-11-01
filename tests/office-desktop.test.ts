import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkDesktop, createDesktop, desktopCommand, desktopWindow } from '../.agents/skills/office-clone/scripts/office-desktop.mjs';

// Trimmed from the real-clone check on macOS. Metal keeps hidden utility and renderer windows.
const pid = 41957;
const visible = { accessible: true, app_name: 'Electron', id: 'w-14579', pid, title: 'droid-codex-computer-use · Droid Office', visible: true };
const hidden = { accessible: false, app_name: 'Electron', id: 'w-14578', pid, title: 'Droid Office', visible: false };
const ref = '@s1rxbzsedgpbhb:e1';
const found = {
  matches: [{ interactive: true, name: 'Switch to Office Companion', path: ['menu', 'menuitem:Office', 'menu:Office'], ref_id: ref, role: 'menuitem', states: [], value: null }],
  snapshot_id: 's1rxbzsedgpbhb',
  total_matches: 1,
  truncated: false,
};
const title = { property: 'title', ref, value: 'Switch to Office Companion' };
const enabled = { applicable: true, property: 'enabled', ref, result: true };
const session = 'run-1793510401217-51267-0';

function temp(t) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'office-desktop-test-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  return out;
}

async function setup(t, override?) {
  const out = temp(t);
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run = async (args, env) => {
    calls.push({ args, env });
    const cmd = args[0] === '--session' ? args.slice(2) : args;
    if (override) {
      const result = override(cmd);
      if (result !== undefined) return result;
    }
    if (cmd[0] === 'session' && cmd[1] === 'start') return { session_id: session };
    if (cmd[0] === 'list-windows') return [hidden, visible];
    if (cmd[0] === 'find') return found;
    if (cmd[0] === 'get') return title;
    if (cmd[0] === 'is') return enabled;
    // Snapshot fixture is a small subtree copied from the observed native menu.
    if (cmd[0] === 'snapshot') return { complete: true, tree: { role: 'menu', children: [{ role: 'menuitem', name: 'Switch to Office Companion', ref_id: ref }] } };
    return {};
  };
  return { desktop: await createDesktop({ pid, out, run }), calls, out };
}

test('desktop preflight accepts actual nested macOS permissions and refuses missing accessibility', async () => {
  const status = { platform: 'macos', permissions: { accessibility: { state: 'granted' }, screen_recording: { state: 'granted' }, automation: { state: 'unknown' } } };
  assert.equal(await checkDesktop(async () => status), status);
  await assert.rejects(
    checkDesktop(async () => ({ ...status, permissions: {} })),
    /permissions --guide/,
  );
  await assert.rejects(
    checkDesktop(async () => ({ ...status, platform: 'linux' })),
    /requires macOS/,
  );
});

test('window selection uses exact clone PID and visibility, never app title or foreground state', () => {
  const owner = { ...visible, pid: 100, id: 'w-owner' };
  assert.equal(desktopWindow([owner, hidden, visible], pid), visible);
  assert.throws(() => desktopWindow([owner, hidden], pid), /got 0/);
  assert.throws(() => desktopWindow([visible, { ...visible, id: 'w-second' }], pid), /got 2/);
  assert.equal(desktopWindow([visible, { ...visible, id: 'w-second' }], pid, visible.id), visible);
  assert.throws(() => desktopWindow([owner, visible], pid, owner.id), /got 0/);
  assert.throws(() => desktopWindow([hidden, visible], pid, hidden.id), /got 0/);
});

test('desktop commands get a private state root and pass the session to every later process', async (t) => {
  const { desktop, calls, out } = await setup(t);
  await desktop.windows();
  assert.equal(path.dirname(desktop.stateRoot), out);
  assert.deepEqual(calls[0].args, ['session', 'start', '--name', `office-clone-${pid}`]);
  assert.deepEqual(calls[1].args, ['--session', session, 'list-windows']);
  for (const call of calls) {
    assert.equal(call.env.AGENT_DESKTOP_HOME, desktop.stateRoot);
    assert.equal(call.env.AGENT_DESKTOP_SESSION, undefined);
    assert.equal(call.env.AGENT_DESKTOP_AGENT_ID, undefined);
    assert.equal(call.args.includes('--headed'), false);
  }
});

test('scoped observations preserve complete and match data and accept only their own refs', async (t) => {
  const { desktop, calls } = await setup(t);
  assert.throws(() => desktop.get('@foreign:e1'), /this desktop session/);
  assert.throws(() => desktop.click('@foreign:e1'), /this desktop session/);
  assert.equal(await desktop.find({ surface: 'menubar', role: 'menuitem', name: 'Switch to Office Companion', exact: true }), found);
  assert.deepEqual(calls.at(-1)?.args, ['--session', session, 'find', '--window-id', visible.id, '--surface', 'menubar', '--limit', '2', '--timeout-ms', '5000', '--role', 'menuitem', '--name', 'Switch to Office Companion', '--exact']);
  assert.equal(await desktop.get(ref, 'title'), title);
  assert.equal(await desktop.is(ref, 'enabled'), enabled);
  assert.equal((await desktop.snapshot({ root: ref })).complete, true);
  assert.deepEqual(calls.at(-1)?.args, ['--session', session, 'snapshot', '--root', ref, '-i', '--compact', '--timeout-ms', '3000']);
  await assert.rejects(desktop.snapshot({ root: ref, surface: 'menu' }), /cannot combine/);
  await assert.rejects(desktop.find({ root: ref, windowId: visible.id }), /cannot combine/);
});

test('skeleton applies only to windows and cold-renderer timeouts are explicit', async (t) => {
  const { desktop, calls } = await setup(t);
  await desktop.snapshot({ skeleton: true, timeoutMs: 25000 });
  assert.ok(calls.at(-1)?.args.includes('--skeleton'));
  assert.ok(calls.at(-1)?.args.includes('25000'));
  await desktop.snapshot({ skeleton: true, surface: 'menubar' });
  assert.equal(calls.at(-1)?.args.includes('--skeleton'), false);
  await assert.rejects(desktop.snapshot({ timeoutMs: -1 }), /positive milliseconds/);
  await assert.rejects(desktop.find({ timeoutMs: Infinity }), /positive milliseconds/);
});

test('semantic action arguments are literal and never imply physical input or retry', async (t) => {
  const { desktop, calls } = await setup(t);
  await desktop.find({ surface: 'menubar' });
  await desktop.click(ref);
  assert.deepEqual(calls.at(-1)?.args, ['--session', session, 'click', ref]);
  await desktop.setValue(ref, '--headed');
  assert.deepEqual(calls.at(-1)?.args, ['--session', session, 'set-value', ref, '--', '--headed']);
  await desktop.select(ref, 'Value with spaces');
  assert.deepEqual(calls.at(-1)?.args, ['--session', session, 'select', ref, '--', 'Value with spaces']);
});

test('an uncertain action is propagated exactly once, without replay or fallback', async (t) => {
  const failure = Object.assign(new Error('uncertain delivery'), { code: 'APP_UNRESPONSIVE', disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' } });
  const { desktop, calls } = await setup(t, (cmd) => {
    if (cmd[0] === 'click') throw failure;
  });
  await desktop.find({ surface: 'menubar' });
  await assert.rejects(
    async () => desktop.click(ref),
    (error) => error === failure,
  );
  assert.equal(calls.filter((c) => c.args[2] === 'click').length, 1);
});

test('native screenshots select a clone window and cannot escape the output directory', async (t) => {
  const { desktop, calls, out } = await setup(t);
  await desktop.shot('native.png', visible.id);
  assert.deepEqual(calls.at(-1)?.args, ['--session', session, 'screenshot', '--window-id', visible.id, path.join(out, 'native.png')]);
  await assert.rejects(desktop.shot('../escape'), /inside the output folder/);
  await assert.rejects(desktop.shot('/tmp/escape'), /inside the output folder/);
});

test('cleanup seals the session even if trace export fails and never closes an app by name', async (t) => {
  const { desktop, calls } = await setup(t, (cmd) => {
    if (cmd[0] === 'trace') throw new Error('export failed');
  });
  await assert.rejects(desktop.close(), /export failed/);
  assert.deepEqual(calls.at(-1)?.args, ['--session', session, 'session', 'end', session]);
  assert.equal(
    calls.some((c) => c.args.includes('close-app')),
    false,
  );
});

test('CLI structured failures retain delivery information despite nonzero exit status', async (t) => {
  const out = temp(t);
  const binary = path.join(out, 'agent-desktop');
  // Error observed from the real native screenshot attempt. Test only JSON/exit handling.
  const error = { code: 'INTERNAL', message: 'screencapture exited with error', disposition: { delivery: 'unknown', retry: 'unknown' } };
  writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ command: 'screenshot', ok: false, error }))}); process.exitCode = 1;\n`, { mode: 0o700 });
  await assert.rejects(desktopCommand(['screenshot'], { ...process.env, PATH: out }), (got: any) => {
    assert.equal(got.code, error.code);
    assert.deepEqual(got.disposition, error.disposition);
    return true;
  });
  writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, data: title }))});\n`, { mode: 0o700 });
  assert.deepEqual(await desktopCommand(['get', ref], { ...process.env, PATH: out }), title);
});

test('native skill routing keeps the API and rig as the scene default and states proof limits', () => {
  const guide = readFileSync(new URL('../.agents/skills/office-clone/references/native-desktop.md', import.meta.url), 'utf8');
  for (const invariant of ['window.office', '--source', '--desktop', 'disposition.retry', 'Metal presenter', 'off the current Space', 'does not record video']) assert.ok(guide.includes(invariant), invariant);
});
