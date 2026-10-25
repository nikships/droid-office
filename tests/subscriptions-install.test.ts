import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { installProxy, latestRelease, parseSha, type Runner } from '../src/server/subscriptions/proxy-install.js';
import { CODESIGN_DV, SPCTL, fakeApp, json, ok, tempDir } from './subscriptions-fixtures.js';

const ZIP_URL = 'https://github.com/nikships/droidproxy/releases/download/v1.8.179/DroidProxy-arm64.zip';
const SHA_URL = `${ZIP_URL}.sha256`;
/** GET /repos/nikships/droidproxy/releases/latest, trimmed. */
const RELEASE = {
  tag_name: 'v1.8.179',
  assets: [
    { name: 'DroidProxy-arm64.zip', size: 25974239, browser_download_url: ZIP_URL },
    { name: 'DroidProxy-arm64.zip.sha256', size: 87, browser_download_url: SHA_URL },
  ],
};
const ZIP = Buffer.from('not really a zip, but the bytes the SHA-256 is of');
const SHA = createHash('sha256').update(ZIP).digest('hex');

interface Rig {
  run: Runner;
  calls: string[][];
  fetchImpl: typeof fetch;
  fetched: string[];
}

function rig(over: { sha?: string; team?: string; notarized?: boolean; verify?: number; bundle?: string; redirect?: string } = {}): Rig {
  const calls: string[][] = [];
  const fetched: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ditto' && args[0] === '-x') {
      assert.equal(readFileSync(args[2]).toString(), ZIP.toString());
      mkdirSync(args[3], { recursive: true });
      fakeApp(args[3], '1.8.179', over.bundle);
      return ok();
    }
    if (cmd === 'ditto') {
      cpSync(args[0], args[1], { recursive: true });
      return ok();
    }
    if (cmd === 'plutil') return ok(readFileSync(args.at(-1) as string, 'utf8'));
    if (cmd === 'codesign' && args[0] === '--verify') return { code: over.verify ?? 0, stdout: '', stderr: over.verify ? 'a sealed resource is missing or invalid' : '' };
    if (cmd === 'codesign') return ok('', over.team ? CODESIGN_DV.replace('NW6B3R27LQ', over.team) : CODESIGN_DV);
    if (cmd === 'spctl') return over.notarized === false ? { code: 3, stdout: '', stderr: `${args[4]}: rejected\nsource=Unnotarized Developer ID\n` } : ok('', SPCTL);
    if (cmd === 'osascript') return ok();
    throw new Error(`unexpected ${cmd}`);
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url === 'https://api.github.com/repos/nikships/droidproxy/releases/latest') return json(RELEASE);
    if (url === SHA_URL) return new Response(`${over.sha ?? SHA}  DroidProxy-arm64.zip\n`);
    if (url === ZIP_URL) return new Response(null, { status: 302, headers: { location: over.redirect ?? 'https://release-assets.githubusercontent.com/github-production-release-asset/1/zip?sp=r' } });
    if (url.startsWith('https://release-assets.githubusercontent.com/')) return new Response(ZIP, { headers: { 'content-length': String(ZIP.length) } });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { run, calls, fetchImpl, fetched };
}

function dirs(t: { after(fn: () => void): void }) {
  const root = tempDir(t, 'proxy-install');
  const system = path.join(root, 'Applications');
  mkdirSync(system);
  return { root, system, user: path.join(root, 'home', 'Applications'), tmp: path.join(root, 'tmp') };
}

test("the newest release is GitHub's latest, with both assets", async () => {
  const r = rig();
  assert.deepEqual(await latestRelease(r.fetchImpl), { version: '1.8.179', zip: ZIP_URL, sha256: SHA_URL });
  const elsewhere = (async () => json({ ...RELEASE, assets: [{ name: 'DroidProxy-arm64.zip', browser_download_url: 'https://evil.example/DroidProxy-arm64.zip' }] })) as unknown as typeof fetch;
  await assert.rejects(latestRelease(elsewhere), /has no DroidProxy-arm64.zip on GitHub/);
  assert.equal(parseSha(`${SHA}  DroidProxy-arm64.zip\n`), SHA);
  assert.equal(parseSha('nope'), undefined);
});

test('a checked download replaces the installed DroidProxy where it is, after quitting it', async (t) => {
  const d = dirs(t);
  mkdirSync(d.tmp);
  const old = fakeApp(d.system, '1.8.177');
  const r = rig();
  const progress: number[] = [];
  const done = await installProxy({ fetchImpl: r.fetchImpl, run: r.run, dirs: d, current: old, tmp: d.tmp, progress: (p) => progress.push(p) });
  assert.deepEqual(done, { path: path.join(d.system, 'DroidProxy.app'), version: '1.8.179' });
  assert.equal(JSON.parse(readFileSync(path.join(done.path, 'Contents', 'Info.plist'), 'utf8')).CFBundleShortVersionString, '1.8.179');
  assert.equal(progress.at(-1), 1);
  const names = r.calls.map((c) => c.slice(0, 2).join(' '));
  assert.deepEqual(names, ['ditto -x', 'plutil -convert', 'codesign --verify', 'codesign -dv', 'spctl -a', `ditto ${r.calls[5][1]}`, 'osascript -e']);
  assert.deepEqual(r.calls[2].slice(1, 4), ['--verify', '--deep', '--strict']);
  assert.equal(r.calls[6][2], 'quit app id "com.droidproxy.app"');
  assert.deepEqual(readdirSync(d.system), ['DroidProxy.app']);
  assert.deepEqual(readdirSync(d.tmp), []);
});

test("into ~/Applications when /Applications can't be written", async (t) => {
  const d = dirs(t);
  chmodSync(d.system, 0o555);
  try {
    const r = rig();
    const done = await installProxy({ fetchImpl: r.fetchImpl, run: r.run, dirs: d, current: null, tmp: d.root });
    assert.equal(done.path, path.join(d.user, 'DroidProxy.app'));
    assert.deepEqual(readdirSync(d.system), []);
  } finally {
    chmodSync(d.system, 0o755);
  }
});

for (const [what, over, said] of [
  ['a SHA-256 that does not match', { sha: 'f'.repeat(64) }, /doesn't match its published SHA-256: the office deleted it/],
  ['a signature that does not verify', { verify: 1 }, /code signature doesn't verify/],
  ['another team', { team: 'ABCDE12345' }, /signed by team ABCDE12345, not DroidProxy's \(NW6B3R27LQ\)/],
  ['no notarization', { notarized: false }, /isn't notarized by Apple/],
  ['another app', { bundle: 'com.example.other' }, /isn't DroidProxy \(its bundle id is com.example.other\)/],
  ['a redirect off GitHub', { redirect: 'https://evil.example/zip' }, /Refused to download DroidProxy from https:\/\/evil.example/],
  ['a redirect to plain http', { redirect: 'http://release-assets.githubusercontent.com/zip' }, /Refused to download DroidProxy from http:/],
] as const) {
  test(`${what} is refused, the download deleted and the installed app left alone`, async (t) => {
    const d = dirs(t);
    mkdirSync(d.tmp);
    const old = fakeApp(d.system, '1.8.177');
    const r = rig(over);
    await assert.rejects(installProxy({ fetchImpl: r.fetchImpl, run: r.run, dirs: d, current: old, tmp: d.tmp }), said);
    assert.deepEqual(readdirSync(d.tmp), []);
    assert.deepEqual(readdirSync(d.system), ['DroidProxy.app']);
    assert.equal(JSON.parse(readFileSync(path.join(old, 'Contents', 'Info.plist'), 'utf8')).CFBundleShortVersionString, '1.8.177');
    assert.ok(!r.calls.some((c) => c[0] === 'osascript'), 'never quits the running one');
    assert.ok(!existsSync(d.user));
  });
}
