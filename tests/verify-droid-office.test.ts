import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildFreshness } from '../.agents/skills/verify-droid-office/scripts/build-freshness.mjs';
import { assertEvidenceOutsideRun } from '../.agents/skills/verify-droid-office/scripts/evidence-path.mjs';
import { assertMcpRefusal, resetProbe, shellQuote, waitForProbe } from '../.agents/skills/verify-droid-office/scripts/steps/shell-probe.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const scripts = path.join(repo, '.agents/skills/verify-droid-office/scripts');
// These subprocesses exercise dist/, whose original source is covered by the source-level suites.
function cliEnv(overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...overrides };
  env.NODE_V8_COVERAGE = '';
  return env;
}

test('evidence stays outside scratch paths, including symlink aliases', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = path.join(dir, 'run');
  const nested = path.join(run, 'nested');
  const sibling = path.join(dir, 'run-evidence');
  mkdirSync(nested, { recursive: true });
  mkdirSync(sibling);
  const alias = path.join(dir, 'alias');
  symlinkSync(run, alias, 'dir');
  for (const evidence of [run, nested, alias, path.join(alias, 'nested'), path.join(nested, '..')]) {
    assert.throws(() => assertEvidenceOutsideRun(run, evidence), /outside the scratch directory/);
  }
  assert.doesNotThrow(() => assertEvidenceOutsideRun(run, sibling));
});

test('launch rejects /tmp as evidence root before starting an office', () => {
  const launch = spawnSync('bash', [path.join(scripts, 'launch.sh'), '--fresh'], {
    cwd: repo,
    env: cliEnv({ VERIFY_EVIDENCE_ROOT: '/tmp' }),
    encoding: 'utf8',
  });
  assert.equal(launch.status, 1);
  assert.match(launch.stderr, /evidence must be outside the scratch directory/);
});

test('cleanup refuses a legacy run whose evidence is inside scratch', (t) => {
  const run = mkdtempSync('/tmp/verify-droid-office-test-');
  t.after(() => rmSync(run, { recursive: true, force: true }));
  const proof = path.join(run, 'proof.txt');
  writeFileSync(proof, 'retained');
  writeFileSync(path.join(run, 'verify.env'), `RUN=${shellQuote(run)}\nEVIDENCE=${shellQuote(run)}\nPID=2147483647\nPORT=4677\n`);
  const cleanup = spawnSync('bash', [path.join(scripts, 'cleanup.sh'), run], { encoding: 'utf8', env: cliEnv() });
  assert.equal(cleanup.status, 1);
  assert.match(cleanup.stderr, /refusing to delete a run containing its evidence/);
  assert.equal(readFileSync(proof, 'utf8'), 'retained');
});

test('shell proof paths preserve spaces, apostrophes and shell metacharacters', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "owner's proof $(false); result.txt");
  execFileSync('sh', ['-c', `printf 'current\\n' | tee ${shellQuote(file)}`]);
  assert.equal(readFileSync(file, 'utf8'), 'current\n');
});

test('repeated probes discard old results and wait for current nonempty output', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'probe.txt');
  for (const current of ['first', 'second']) {
    writeFileSync(file, 'old');
    resetProbe(file);
    assert.equal(existsSync(file), false);
    const result = waitForProbe(file, (value: string) => value === current);
    writeFileSync(file, '');
    setImmediate(() => writeFileSync(file, current));
    assert.equal(await result, current);
  }
  resetProbe(file);
  assert.equal(await waitForProbe(file, Boolean, 1), '');
});

test('Shell MCP proof requires the actual unauthorized response', () => {
  assert.doesNotThrow(() => assertMcpRefusal('401'));
  for (const code of ['', '000', '200', '404', '500']) assert.throws(() => assertMcpRefusal(code), /expected.*401/);
});

test('listener guard rejects a live HTTP listener outside the run process group', { skip: process.platform === 'win32' }, async (t) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import {createServer} from 'node:http'; const server=createServer((_,res)=>res.end('ok')); server.listen(0,'127.0.0.1',()=>console.log(server.address().port));"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  const [chunk] = await once(child.stdout, 'data');
  const port = chunk.toString().trim();
  const check = (pid: number) => spawnSync('bash', ['-c', 'source "$1"; owns_listener "$2" "$3"', '--', path.join(scripts, 'run-process.sh'), port, String(pid)], { encoding: 'utf8' });
  assert.equal(check(child.pid as number).status, 0);
  assert.equal(check(process.pid).status, 1);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  const launch = spawnSync('bash', [path.join(scripts, 'launch.sh'), '--fresh', '--port', port], { cwd: repo, env: cliEnv(), encoding: 'utf8', timeout: 30_000 });
  assert.equal(launch.status, 1, launch.stderr);
  assert.match(launch.stderr, /already belongs to another process/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
});

test('build freshness compares absolute file paths and timestamps on every platform', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['src', 'bin', 'dist/server/server']) mkdirSync(path.join(dir, folder), { recursive: true });
  const src = path.join(dir, 'src', 'source with spaces.ts');
  const built = path.join(dir, 'dist/server/server/cli.js');
  writeFileSync(src, '');
  writeFileSync(built, '');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', 'src']);
  utimesSync(src, 1000, 1000);
  utimesSync(built, 2000, 2000);
  assert.equal(buildFreshness(dir), 'current');
  utimesSync(src, 3000, 3000);
  assert.equal(buildFreshness(dir), 'stale');
});

test('website browser lookup honors a custom cache instead of falling back', () => {
  const cache = path.join(os.tmpdir(), 'verify-no-browser-here');
  const result = spawnSync(process.execPath, [path.join(scripts, 'website-sections.mjs'), 'http://127.0.0.1:1', os.tmpdir()], {
    cwd: repo,
    env: cliEnv({ DROID_OFFICE_BROWSERS_PATH: cache }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`no headless shell in ${cache}`), result.stderr);
});

test('fresh mode reuses the clone startup generator and preserves the browser cache', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-fresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = path.join(dir, 'browser cache');
  const clone = path.join(repo, '.agents/skills/office-clone/scripts/clone-office.sh');
  execFileSync('bash', [clone, '--fresh', '--dest', dir, '--port', '4678'], { cwd: repo, env: cliEnv({ DROID_OFFICE_BROWSERS_PATH: cache }) });
  const start = readFileSync(path.join(dir, 'start.sh'), 'utf8');
  assert.ok(start.includes('--port 4678'));
  const resolved = execFileSync('bash', ['-c', `${start.split('exec node')[0]}\nprintf '%s' "$DROID_OFFICE_BROWSERS_PATH"`], { encoding: 'utf8' });
  assert.equal(resolved, cache);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'local-storage.json'), 'utf8'))['droid-office.profile'].includes('Verifier'), true);
  const invalid = spawnSync('bash', [clone, '--fresh', '--office', dir], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /cannot be combined/);
  for (const port of ['nope', '0', '4600', '65536']) {
    const result = spawnSync('bash', [clone, '--fresh', '--port', port], { encoding: 'utf8' });
    assert.equal(result.status, 2, port);
  }
});
