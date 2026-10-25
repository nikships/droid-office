import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { needsWelcome, type SetupState } from '../src/shared/setup.js';
import type { Runner } from '../src/server/setup/droid-install.js';
import { parseDoctor } from '../src/server/setup/droid-signin.js';
import { agentFinder, mountSetup, readSetupFile, type SetupOptions } from '../src/server/setup/index.js';

/** `droid doctor --json --checks auth` from droid 0.249.0, signed in (trimmed, email replaced). */
const DOCTOR_IN = JSON.stringify({
  generatedAt: '2026-10-25T21:31:47.635Z',
  timeoutMs: 10000,
  ok: true,
  results: [
    { id: 'env.info', category: 'environment', label: 'Droid environment', status: 'pass', detail: 'v0.249.0 on darwin arm64 (bun 1.4.4)' },
    { id: 'auth.credentials', category: 'auth', label: 'Credential storage read', status: 'pass', detail: 'stored login session loaded from credential storage', durationMs: 18 },
    {
      id: 'auth.tokenExpiry',
      category: 'auth',
      label: 'Access token expiry',
      status: 'pass',
      detail: 'access token valid until 2026-10-26T01:28:06.000Z; this run does not exercise the api.workos.com token refresh',
    },
    {
      id: 'auth.workosRefresh',
      category: 'auth',
      label: 'WorkOS token refresh endpoint',
      status: 'pass',
      detail: 'POST api.workos.com/authenticate answered HTTP 400 (invalid-credential probe; any response proves the refresh request transits the network)',
      durationMs: 249,
    },
    { id: 'auth.verify', category: 'auth', label: 'Auth verification', status: 'pass', detail: 'authenticated as o***@example.com via stored login session', durationMs: 1 },
  ],
});

/** The same with an empty HOME: signed out, and doctor still exits 0 with ok: true. */
const DOCTOR_OUT = JSON.stringify({
  generatedAt: '2026-10-25T21:31:56.953Z',
  timeoutMs: 10000,
  ok: true,
  results: [
    { id: 'env.info', category: 'environment', label: 'Droid environment', status: 'pass', detail: 'v0.249.0 on darwin arm64 (bun 1.4.4)' },
    { id: 'auth.credentials', category: 'auth', label: 'Credential storage read', status: 'pass', detail: 'credential storage responded; no stored login found', durationMs: 1 },
    {
      id: 'auth.workosRefresh',
      category: 'auth',
      label: 'WorkOS token refresh endpoint',
      status: 'pass',
      detail: 'POST api.workos.com/authenticate answered HTTP 400 (invalid-credential probe; any response proves the refresh request transits the network)',
      durationMs: 180,
    },
    {
      id: 'auth.verify',
      category: 'auth',
      label: 'Auth verification',
      status: 'warn',
      detail: 'no usable credentials found (not logged in)',
      remediation: 'Run `droid` and complete the login flow.',
      durationMs: 0,
    },
  ],
});

test('doctor: signed in names the account; signed out is a warn on auth.verify', () => {
  assert.deepEqual(parseDoctor(DOCTOR_IN), { signedIn: true, account: 'o***@example.com' });
  assert.deepEqual(parseDoctor(DOCTOR_OUT), { signedIn: false, account: null });
  assert.deepEqual(parseDoctor('error: unknown command'), { signedIn: null, account: null });
  assert.deepEqual(parseDoctor(JSON.stringify({ results: [{ id: 'env.info', status: 'pass' }] })), { signedIn: null, account: null });
  const offline = JSON.parse(DOCTOR_IN);
  offline.results[3].status = 'fail';
  assert.equal(parseDoctor(JSON.stringify(offline)).signedIn, true);
  const expired = JSON.parse(DOCTOR_IN);
  expired.results[2].status = 'fail';
  assert.equal(parseDoctor(JSON.stringify(expired)).signedIn, false);
});

interface Office {
  setup: ReturnType<typeof mountSetup>;
  states: SetupState[];
  toasts: string[];
  changed: string[];
  dataDir: string;
  home: string;
  last(): SetupState;
}

function office(t: test.TestContext, o: { droid?: string | null; signedIn?: () => boolean; setupJson?: unknown; extra?: Partial<SetupOptions> } = {}): Office {
  const root = mkdtempSync(path.join(tmpdir(), 'setup-state-'));
  const dataDir = path.join(root, '.droid-office');
  const home = path.join(root, 'home');
  mkdirSync(home);
  if (o.setupJson !== undefined) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'setup.json'), JSON.stringify(o.setupJson));
  }
  const signedIn = o.signedIn ?? (() => true);
  const run: Runner = async (_cmd, args) => {
    if (args[0] === '--version') return { code: 0, stdout: '0.248.1\n', stderr: '' };
    if (args[0] === 'doctor') return { code: 0, stdout: signedIn() ? DOCTOR_IN : DOCTOR_OUT, stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const fetchImpl = (async (url: string) => (String(url).endsWith('/LATEST') ? new Response('0.249.0\n') : new Response('', { status: 404 }))) as unknown as typeof fetch;
  const droid = o.droid === undefined ? '/opt/fake/droid' : o.droid;
  const states: SetupState[] = [];
  const toasts: string[] = [];
  const changed: string[] = [];
  const setup = mountSetup({
    dataDir,
    agentCmd: 'droid',
    broadcast: (s) => states.push(s),
    toast: (text) => toasts.push(text),
    agentChanged: (file) => changed.push(file),
    home,
    platform: 'linux',
    arch: 'arm64',
    run,
    fetchImpl,
    findAgent: async (cmd) => (cmd.includes('/') ? cmd : droid),
    env: () => ({ PATH: process.env.PATH ?? '' }),
    ...o.extra,
  });
  t.after(() => {
    setup.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return { setup, states, toasts, changed, dataDir, home, last: () => setup.state() };
}

async function until(pred: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('an office with Droid ready and no setup.json is onboarded, and says so in setup.json', async (t) => {
  const o = office(t);
  assert.equal(o.last().droid.busy, 'checking');
  await until(() => o.last().droid.busy === null && o.last().droid.latest !== null);
  const s = o.last();
  assert.equal(s.droid.path, '/opt/fake/droid');
  assert.equal(s.droid.version, '0.248.1');
  assert.equal(s.droid.latest, '0.249.0');
  assert.equal(s.droid.signedIn, true);
  assert.equal(s.droid.account, 'o***@example.com');
  assert.equal(s.droid.canInstall, true);
  assert.equal(s.onboarded, true);
  assert.equal(readSetupFile(o.dataDir)?.onboarded, true);
  assert.deepEqual(o.changed, []);
});

test('signed out with no setup.json opens the welcome and writes it down, and signing in does not end it', async (t) => {
  let signedIn = false;
  const o = office(t, { signedIn: () => signedIn });
  await until(() => o.last().droid.signedIn === false && o.last().droid.busy === null);
  assert.equal(o.last().onboarded, false);
  assert.equal(needsWelcome(o.last()), true);
  await until(() => existsSync(path.join(o.dataDir, 'setup.json')));
  assert.equal(readSetupFile(o.dataDir)?.onboarded, false);

  // The owner still has the welcome's other steps.
  signedIn = true;
  o.setup.message('owner', { t: 'setup.check' });
  await until(() => o.last().droid.signedIn === true && o.last().droid.busy === null);
  assert.equal(o.last().onboarded, false);
  assert.equal(needsWelcome(o.last()), true);

  o.setup.message('owner', { t: 'setup.onboarded', done: true });
  await until(() => readSetupFile(o.dataDir)?.onboarded === true);
  assert.equal(o.states.at(-1)?.onboarded, true);
  o.setup.message('owner', { t: 'setup.onboarded', done: false });
  await until(() => readSetupFile(o.dataDir)?.onboarded === false);
  assert.equal(o.last().onboarded, false);
});

test('no Droid, no setup.json: onboarded false; an existing setup.json is kept', async (t) => {
  const missing = office(t, { droid: null });
  await until(() => missing.last().droid.busy === null);
  assert.equal(missing.last().droid.path, null);
  assert.equal(missing.last().onboarded, false);
  assert.equal(needsWelcome(missing.last()), true);
  await until(() => readSetupFile(missing.dataDir)?.onboarded === false);

  // A restart in the middle of the welcome, Droid ready by then, keeps it open.
  const midway = office(t, { setupJson: { onboarded: false, at: 1 } });
  await until(() => midway.last().droid.signedIn === true && midway.last().droid.busy === null);
  assert.equal(midway.last().onboarded, false);
  assert.equal(needsWelcome(midway.last()), true);
  assert.equal(readSetupFile(midway.dataDir)?.at, 1);

  const done = office(t, { droid: null, setupJson: { onboarded: true, at: 1 } });
  await until(() => done.last().droid.busy === null);
  assert.equal(done.last().onboarded, true);
  assert.equal(readSetupFile(done.dataDir)?.at, 1);
});

test('Droid found somewhere new later points every floor at it', async (t) => {
  let where: string | null = null;
  const o = office(t, { extra: { findAgent: async () => where } });
  await until(() => o.last().droid.busy === null);
  where = '/usr/local/bin/droid';
  o.setup.message('owner', { t: 'setup.check' });
  await until(() => o.last().droid.path === where && o.last().droid.busy === null);
  assert.deepEqual(o.changed, ['/usr/local/bin/droid']);
});

test('install downloads the newest release, points the office at it and checks the sign-in', async (t) => {
  const binary = Buffer.from('fake droid\n'.repeat(1000));
  const sha = createHash('sha256').update(binary).digest('hex');
  const base = 'https://downloads.factory.ai/factory-cli/releases/0.249.0/linux/arm64/droid';
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith('/LATEST')) return new Response('0.249.0\n');
    if (url === base) return new Response(binary, { headers: { 'content-length': String(binary.length) } });
    if (url === `${base}.sha256`) return new Response(sha);
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const o = office(t, { droid: null, signedIn: () => false, extra: { fetchImpl } });
  await until(() => o.last().droid.busy === null && o.last().droid.latest !== null);
  o.setup.message('owner', { t: 'setup.droid.install' });
  await until(() => o.last().droid.busy === null && o.last().droid.path !== null);
  const file = path.join(o.home, '.local', 'bin', 'droid');
  assert.deepEqual(readFileSync(file), binary);
  assert.equal(o.last().droid.path, file);
  assert.equal(o.last().droid.version, '0.248.1');
  assert.equal(o.last().droid.signedIn, false);
  assert.equal(o.last().droid.progress, undefined);
  assert.deepEqual(o.changed, [file]);
  assert.deepEqual(o.toasts, ['Droid 0.248.1 installed.']);
  assert.ok(o.states.some((s) => s.droid.busy === 'installing' && s.droid.progress === 1));
});

test('a failed install says why; where it cannot install it names the manual command', async (t) => {
  const o = office(t, { droid: null });
  await until(() => o.last().droid.busy === null && o.last().droid.latest !== null);
  o.setup.message('owner', { t: 'setup.droid.install' });
  await until(() => o.last().droid.busy === null && !!o.last().droid.error);
  assert.match(o.last().droid.error ?? '', /checksum \(HTTP 404\)/);
  assert.equal(o.toasts.length, 1);

  const win = office(t, { droid: null, extra: { platform: 'win32', arch: 'x64' } });
  await until(() => win.last().droid.busy === null);
  assert.equal(win.last().droid.canInstall, false);
  win.setup.message('owner', { t: 'setup.droid.install' });
  assert.match(win.last().droid.error ?? '', /curl -fsSL https:\/\/app\.factory\.ai\/cli \| sh/);
});

test('sign-in when doctor already says signed in starts no PTY; without Droid it says to install first', async (t) => {
  let signedIn = false;
  const o = office(t, { signedIn: () => signedIn });
  await until(() => o.last().droid.busy === null && o.last().droid.signedIn === false);
  signedIn = true;
  o.setup.message('owner', { t: 'setup.droid.signIn' });
  assert.equal(o.last().droid.busy, 'signing-in');
  await until(() => o.last().droid.busy === null);
  assert.equal(o.last().droid.signedIn, true);
  assert.equal(o.last().droid.signIn, undefined);

  const none = office(t, { droid: null });
  await until(() => none.last().droid.busy === null);
  none.setup.message('owner', { t: 'setup.droid.signIn' });
  assert.equal(none.last().droid.error, 'Install Droid first.');
});

test('sign-in runs Droid, shows its code, and finishes when doctor says signed in', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'setup-signin-droid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const droid = path.join(dir, 'droid');
  writeFileSync(
    droid,
    `#!/bin/sh\nstty raw -echo\nprintf 'Please login with your Factory account to continue.\\r\\n\\r\\n> Login\\r\\n  Exit\\r\\n'\nhead -c 1 >/dev/null\nprintf 'please visit https://auth.factory.ai/device and enter code\\r\\nABCD-EFGH to complete authentication.\\r\\n'\nsleep 60\n`,
  );
  chmodSync(droid, 0o755);
  let signedIn = false;
  const o = office(t, { droid, signedIn: () => signedIn, extra: { timing: { signInPollMs: 50 } } });
  await until(() => o.last().droid.busy === null && o.last().droid.signedIn === false);
  o.setup.message('owner', { t: 'setup.droid.signIn' });
  await until(() => !!o.last().droid.signIn?.code);
  assert.equal(o.last().droid.signIn?.code, 'ABCD-EFGH');
  assert.equal(o.last().droid.signIn?.url, 'https://auth.factory.ai/device?user_code=ABCD-EFGH');
  signedIn = true;
  await until(() => o.last().droid.busy === null);
  assert.equal(o.last().droid.signedIn, true);
  assert.deepEqual(o.toasts, ['Droid is signed in as o***@example.com.']);

  signedIn = false;
  o.setup.message('owner', { t: 'setup.check' });
  await until(() => o.last().droid.signedIn === false);
  o.setup.message('owner', { t: 'setup.droid.signIn' });
  await until(() => !!o.last().droid.signIn?.code);
  o.setup.message('owner', { t: 'setup.droid.signInCancel' });
  await until(() => o.last().droid.busy === null);
  assert.equal(o.last().droid.error, null);
  assert.equal(o.last().droid.signedIn, false);
});

test('agentFinder takes a path as it is and looks in ~/.local/bin for droid', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'setup-find-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'droid');
  writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  const find = agentFinder(home, 'win32');
  assert.equal(await find(file), file);
  assert.equal(await find(path.join(home, 'nope')), null);
  assert.equal(await find('definitely-not-a-command-droid-office'), null);
});
