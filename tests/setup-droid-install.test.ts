import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canInstall, cleanVersion, droidTarget, droidUrl, FACTORY_TEAM, httpsGet, installDroid, latestDroid, type Runner } from '../src/server/setup/droid-install.js';

const BINARY = Buffer.from('#!/bin/sh\necho 0.249.0\n'.repeat(4000));
const SHA = createHash('sha256').update(BINARY).digest('hex');
const BASE = 'https://downloads.factory.ai/factory-cli/releases/0.249.0';

/** `codesign -dv` on the real droid 0.249.0, trimmed. */
const CODESIGN_DV = `Executable=/Users/nik/.local/bin/droid
Identifier=droid
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=2245809 flags=0x10000(runtime) hashes=70171+7 location=embedded
Signature size=9017
TeamIdentifier=${FACTORY_TEAM}
Runtime Version=26.5.0
`;

function home(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'setup-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fetch that answers from `routes`, recording every URL it was asked for. */
function fakeFetch(routes: Record<string, () => Response>, asked: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const route = routes[url];
    return route ? route() : new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function release(target: string, body: Buffer = BINARY, sha = `${SHA}\n`) {
  return {
    [`${BASE}/${target}/droid`]: () => new Response(body, { headers: { 'content-length': String(body.length) } }),
    [`${BASE}/${target}/droid.sha256`]: () => new Response(sha),
  };
}

const noRun: Runner = async (cmd) => {
  throw new Error(`unexpected ${cmd}`);
};

function codesign(o: { verify?: number; team?: string } = {}): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'codesign') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === '--verify') return { code: o.verify ?? 0, stdout: '', stderr: o.verify ? `${args[2]}: code object is not signed at all` : '' };
    return { code: 0, stdout: '', stderr: CODESIGN_DV.replace(FACTORY_TEAM, o.team ?? FACTORY_TEAM) };
  };
  return { run, calls };
}

test('canInstall covers the builds Factory publishes', () => {
  assert.equal(canInstall('darwin', 'arm64'), true);
  assert.equal(canInstall('linux', 'x64'), true);
  assert.equal(canInstall('win32', 'x64'), false);
  assert.equal(canInstall('linux', 'ia32'), false);
});

test('x64 without AVX2 gets the baseline build, as Factory installer picks it', async () => {
  const sysctl =
    (out: string): Runner =>
    async () => ({ code: 0, stdout: out, stderr: '' });
  assert.deepEqual(await droidTarget({ platform: 'darwin', arch: 'arm64', run: noRun }), { os: 'darwin', arch: 'arm64' });
  assert.deepEqual(await droidTarget({ platform: 'darwin', arch: 'x64', run: sysctl('machdep.cpu.leaf7_features: RDWRFSGS BMI1 AVX2 SMEP') }), { os: 'darwin', arch: 'x64' });
  assert.deepEqual(await droidTarget({ platform: 'darwin', arch: 'x64', run: sysctl('machdep.cpu.features: FPU VME SSE4.2') }), { os: 'darwin', arch: 'x64-baseline' });
  assert.deepEqual(await droidTarget({ platform: 'linux', arch: 'x64', run: noRun, cpuinfo: async () => 'flags\t\t: fpu sse4_2 avx avx2 bmi2' }), { os: 'linux', arch: 'x64' });
  assert.deepEqual(await droidTarget({ platform: 'linux', arch: 'x64', run: noRun, cpuinfo: async () => 'flags\t\t: fpu sse4_2 avx' }), { os: 'linux', arch: 'x64-baseline' });
  await assert.rejects(droidTarget({ platform: 'win32', arch: 'x64', run: noRun }), /can't install Droid on win32/);
  assert.equal(droidUrl('0.249.0', { os: 'linux', arch: 'x64-baseline' }), `${BASE}/linux/x64-baseline/droid`);
});

test('the newest release comes from LATEST, and only a version counts', async () => {
  assert.equal(await latestDroid(fakeFetch({ 'https://downloads.factory.ai/factory-cli/LATEST': () => new Response('0.249.0\n') })), '0.249.0');
  assert.equal(await latestDroid(fakeFetch({ 'https://downloads.factory.ai/factory-cli/LATEST': () => new Response('<html>oops</html>') })), null);
  assert.equal(await latestDroid(fakeFetch({})), null);
  assert.equal(cleanVersion('0.249.0\n'), '0.249.0');
  assert.equal(cleanVersion('droid version 1.2.3-beta.1'), '1.2.3-beta.1');
});

test('a Linux install lands in ~/.local/bin/droid, executable, with progress and no leftovers', async (t) => {
  const dir = home(t);
  const progress: number[] = [];
  const file = await installDroid({
    version: '0.249.0',
    home: dir,
    platform: 'linux',
    arch: 'arm64',
    fetchImpl: fakeFetch(release('linux/arm64')),
    run: noRun,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(file, path.join(dir, '.local', 'bin', 'droid'));
  assert.deepEqual(readFileSync(file), BINARY);
  assert.equal(statSync(file).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(path.dirname(file)), ['droid']);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1])));
});

test('a SHA-256 mismatch deletes the download and says so', async (t) => {
  const dir = home(t);
  await assert.rejects(installDroid({ version: '0.249.0', home: dir, platform: 'linux', arch: 'arm64', fetchImpl: fakeFetch(release('linux/arm64', BINARY, `${'0'.repeat(64)}\n`)), run: noRun }), /SHA-256/);
  assert.deepEqual(readdirSync(path.join(dir, '.local', 'bin')), []);
});

test('a redirect off https is refused; one that stays on https is followed', async (t) => {
  const dir = home(t);
  const asked: string[] = [];
  const redirectTo = (location: string) => () => new Response(null, { status: 302, headers: { location } });
  const routes = { ...release('linux/arm64'), [`${BASE}/linux/arm64/droid`]: redirectTo('http://downloads.factory.ai/droid') };
  await assert.rejects(installDroid({ version: '0.249.0', home: dir, platform: 'linux', arch: 'arm64', fetchImpl: fakeFetch(routes, asked), run: noRun }), /refused a download over http/);
  assert.ok(!asked.includes('http://downloads.factory.ai/droid'));
  assert.deepEqual(readdirSync(path.join(dir, '.local', 'bin')), []);

  const cdn = 'https://cdn.example.com/droid';
  const ok = { ...release('linux/arm64'), [`${BASE}/linux/arm64/droid`]: redirectTo(cdn), [cdn]: () => new Response(BINARY) };
  const file = await installDroid({ version: '0.249.0', home: dir, platform: 'linux', arch: 'arm64', fetchImpl: fakeFetch(ok), run: noRun });
  assert.deepEqual(readFileSync(file), BINARY);
  await assert.rejects(httpsGet('http://downloads.factory.ai/factory-cli/LATEST', fakeFetch({})), /refused/);
});

test('on macOS the binary must pass codesign and be signed by Factory', async (t) => {
  const dir = home(t);
  const fetchImpl = fakeFetch(release('darwin/arm64'));
  const opts = { version: '0.249.0', home: dir, platform: 'darwin', arch: 'arm64', fetchImpl };

  const good = codesign();
  const file = await installDroid({ ...opts, run: good.run });
  assert.equal(statSync(file).mode & 0o777, 0o755);
  assert.deepEqual(
    good.calls.map((c) => c.slice(0, 3)),
    [
      ['codesign', '--verify', '--strict'],
      ['codesign', '-dv', good.calls[1][2]],
    ],
  );
  assert.match(good.calls[0][3], /\.droid-[0-9a-f]+\.download$/);
  rmSync(file);

  await assert.rejects(installDroid({ ...opts, run: codesign({ verify: 1 }).run }), /code signature check \(codesign --verify\)/);
  assert.deepEqual(readdirSync(path.join(dir, '.local', 'bin')), []);
  await assert.rejects(installDroid({ ...opts, run: codesign({ team: 'ABCDE12345' }).run }), /signed by team ABCDE12345, not Factory \(SW6TL4V6Q5\)/);
  assert.deepEqual(readdirSync(path.join(dir, '.local', 'bin')), []);
});

test('a download that stops short is not installed', async (t) => {
  const dir = home(t);
  const routes = { ...release('linux/arm64'), [`${BASE}/linux/arm64/droid`]: () => new Response(BINARY.subarray(0, 100), { headers: { 'content-length': String(BINARY.length) } }) };
  await assert.rejects(installDroid({ version: '0.249.0', home: dir, platform: 'linux', arch: 'arm64', fetchImpl: fakeFetch(routes), run: noRun }), /stopped short/);
  assert.deepEqual(readdirSync(path.join(dir, '.local', 'bin')), []);
});
