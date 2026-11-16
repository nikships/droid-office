import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { cachedLatestRelease, latestGitHubRelease, type GhRunner } from '../src/server/github-releases.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { tailnetProxy } from './tailnet-proxy.js';

/** `gh api repos/nikships/droid-office/releases/latest --jq '{tag_name, draft, prerelease, assets: [...]}'`, trimmed to two assets. */
const RELEASE = {
  assets: [
    {
      browser_download_url: 'https://github.com/nikships/droid-office/releases/download/v0.1.1161/Droid-Office-0.1.1160.apk',
      digest: 'sha256:6834751605ac972c339e22437bf7e8a248df4cffb0cf4dca81fca96f8b4157ef',
      name: 'Droid-Office-0.1.1160.apk',
      size: 25262837,
      state: 'uploaded',
    },
    {
      browser_download_url: 'https://github.com/nikships/droid-office/releases/download/v0.1.1161/latest-mac.yml',
      digest: 'sha256:0b17811c6a4da3169e1b487cb31ec38b96b5038e439d2882a2ffd969424c1ff1',
      name: 'latest-mac.yml',
      size: 553,
      state: 'uploaded',
    },
  ],
  draft: false,
  prerelease: false,
  tag_name: 'v0.1.1161',
};

test('the latest release is read through gh api, trimmed by jq', async () => {
  const asked: string[][] = [];
  const run: GhRunner = async (args) => {
    asked.push(args);
    return `${JSON.stringify(RELEASE)}\n`;
  };
  assert.deepEqual(await latestGitHubRelease('nikships/droid-office', run), RELEASE);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].slice(0, 3), ['api', 'repos/nikships/droid-office/releases/latest', '--jq']);
  assert.match(asked[0][3], /browser_download_url, size, digest, state/);
  await assert.rejects(
    latestGitHubRelease('nikships/droid-office', async () => 'not json'),
    /something other than nikships\/droid-office's latest release/,
  );
  for (const out of ['null', '[]', '"v0.1.1161"'])
    await assert.rejects(
      latestGitHubRelease('nikships/droid-office', async () => out),
      /something other than/,
    );
});

test('a cached latest release is shared and coalesced, and a failure is not kept', async () => {
  let calls = 0;
  let fail = true;
  let clock = 0;
  let release!: () => void;
  const run: GhRunner = async () => {
    calls++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (fail) throw new Error('HTTP 502 from GitHub');
    return JSON.stringify(RELEASE);
  };
  const latest = cachedLatestRelease('nikships/droid-office', run, () => clock, 60_000);
  const first = latest();
  const second = latest();
  release();
  await assert.rejects(first, /HTTP 502/);
  await assert.rejects(second, /HTTP 502/);
  assert.equal(calls, 1, 'concurrent asks share one gh call');
  fail = false;
  const third = latest();
  release();
  assert.deepEqual(await third, RELEASE);
  assert.equal(calls, 2, 'a failure is asked again');
  clock = 59_999;
  assert.deepEqual(await latest(), RELEASE);
  assert.equal(calls, 2, 'a success is kept for the ttl');
  clock = 60_000;
  const fourth = latest();
  release();
  await fourth;
  assert.equal(calls, 3);
});

async function office(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'app-release-'));
  const bin = path.join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = path.join(dir, 'gh.log');
  const failing = path.join(dir, 'gh-fails');
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify(RELEASE));
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/nikships/droid-office/releases/latest" ]; then
  echo "$*" >> '${log}'
  if [ -f '${failing}' ]; then echo "gh: API rate limit exceeded (HTTP 403)" >&2; exit 1; fi
  cat '${path.join(dir, 'release.json')}'
  exit 0
fi
echo "[]"
`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const cfg = loadConfig(['--home', dir, '--projects', dir, dir, '--weather', 'clear', '--host', '0.0.0.0']);
  cfg.port = 0;
  const server = await startServer(cfg);
  t.after(async () => {
    process.env.PATH = previous;
    const closing = once(server.server, 'close');
    server.shutdown(false);
    server.server.closeAllConnections();
    await closing;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0);
  return { server, base: `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`, failing, calls };
}

test("the phone's app release comes from the office's gh, behind the office's gate", async (t) => {
  const { server, base, failing, calls } = await office(t);
  const paired = server.devices.pair('Phone')!;
  const headers = { Authorization: `Bearer ${paired.token}` };

  writeFileSync(failing, '');
  const refused = await fetch(`${base}/api/mobile/app-release`, { headers });
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /couldn't read the newest release from GitHub: gh: API rate limit exceeded/);

  rmSync(failing);
  const ok = await fetch(`${base}/api/mobile/app-release`, { headers });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), RELEASE);
  assert.equal(calls(), 2, 'a failed read is not kept');
  assert.deepEqual(await (await fetch(`${base}/api/mobile/app-release`, { headers })).json(), RELEASE);
  assert.equal(calls(), 2, 'repeat checks reuse the last answer');

  assert.equal((await fetch(`${base}/api/mobile/app-release`, { method: 'POST', headers })).status, 404);
  server.devices.forget(paired.device.id);
  assert.equal((await fetch(`${base}/api/mobile/app-release`, { headers })).status, 401);
  const remote = await tailnetProxy(t, server.server);
  assert.equal((await remote.fetch(`${remote.base}/api/mobile/app-release`)).status, 401);
});
