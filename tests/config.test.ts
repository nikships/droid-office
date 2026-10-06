import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, suggestedFolder } from '../src/server/config.js';

/** loadConfig with a throwaway --home, turning process.exit into a throw so a bad flag can be tested. */
function load(t: { after(fn: () => void): void }, ...argv: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'droid-office-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const exit = process.exit;
  const error = console.error;
  const previousArgs = process.env.DROID_OFFICE_AGENT_ARGS;
  const errors: string[] = [];
  process.exit = ((code?: number) => {
    throw new Error(`exit ${code}: ${errors.join('\n')}`);
  }) as typeof process.exit;
  console.error = (...args: unknown[]) => void errors.push(args.join(' '));
  delete process.env.DROID_OFFICE_AGENT_ARGS;
  try {
    return loadConfig(['--home', home, ...argv]);
  } finally {
    process.exit = exit;
    console.error = error;
    if (previousArgs !== undefined) process.env.DROID_OFFICE_AGENT_ARGS = previousArgs;
  }
}

test('--agent-args takes flags as its value, as the help shows', (t) => {
  assert.deepEqual(load(t, '--agent-args', '--model opus').agentArgs, ['--model', 'opus']);
  // ...and the flag after it is parsed as a flag again.
  assert.equal(load(t, '--agent-args', '--model opus', '--port', '4999').port, 4999);
});

test('--agent-args with nothing after it still needs a value', (t) => {
  assert.throws(() => load(t, '--agent-args'), /exit 2: droid-office: --agent-args needs a value/);
});

test('other flags still treat a leading -- as a missing value', (t) => {
  assert.throws(() => load(t, '--agent', '--agent-args', 'x'), /exit 2: droid-office: --agent needs a value/);
});

test('voice is gone: --turn is no longer an option', (t) => {
  assert.throws(() => load(t, '--turn', 'turn:user:pass@turn.example.com:3478'), /exit 2: droid-office: unknown option --turn/);
  assert.ok(!('iceServers' in load(t)), 'no ICE servers on the config');
});

test('passwords are gone: no password flags and no secrets on the config', (t) => {
  for (const argv of [['--password', 'x'], ['--claim-token', 'x'], ['--reset-password']]) assert.throws(() => load(t, ...argv), /exit 2: droid-office: unknown option/, argv.join(' '));
  const cfg = load(t) as Record<string, unknown>;
  for (const key of ['password', 'passwordGenerated', 'verifier', 'salt', 'secret', 'claimToken', 'claimed', 'markClaimed']) assert.ok(!(key in cfg), `no ${key} on the config`);
  assert.deepEqual(JSON.parse(readFileSync(path.join(cfg.dataDir as string, 'config.json'), 'utf8')), {});
});

test('starting drops legacy password state left in config.json', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'droid-office-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.droid-office'), { recursive: true });
  writeFileSync(path.join(home, '.droid-office', 'config.json'), JSON.stringify({ password: 'old', verifier: '00', salt: '00', secret: '00', claimedAt: 1 }));
  const cfg = loadConfig(['--home', home]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(cfg.dataDir, 'config.json'), 'utf8')), {});
});

test('the office binds everywhere by default, with loopback one flag away', (t) => {
  assert.equal(load(t).host, '0.0.0.0');
  assert.equal(load(t, '--host', '127.0.0.1').host, '127.0.0.1');
});

test('the office looks for checkouts in a code folder in the home folder, else the home folder itself', (t) => {
  const cfg = load(t);
  assert.equal(cfg.projectsDir, suggestedFolder(homedir()));
});

test('the default agent is droid', (t) => {
  const previous = process.env.DROID_OFFICE_AGENT;
  delete process.env.DROID_OFFICE_AGENT;
  t.after(() => {
    if (previous !== undefined) process.env.DROID_OFFICE_AGENT = previous;
  });
  assert.equal(load(t).agentCmd, 'droid');
});
