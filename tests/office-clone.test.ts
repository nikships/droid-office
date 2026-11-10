import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('an office clone keeps Orchestrator settings but never copies its live session or credentials', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-clone-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const office = path.join(root, 'office');
  const state = path.join(office, '.droid-office');
  const session = path.join(state, 'orchestrator', '.droid-office');
  const dest = path.join(root, 'clone');
  mkdirSync(home);
  mkdirSync(session, { recursive: true });
  writeFileSync(path.join(state, 'floors.json'), JSON.stringify([{ id: 'home', name: 'Home', dir: home }]));
  const settings = { on: true, model: 'claude-haiku-5-5' };
  writeFileSync(path.join(state, 'orchestrator.json'), JSON.stringify(settings));
  for (const file of ['workers.json', 'droid-hooks.json', 'hook.cjs', 'pty.sock']) writeFileSync(path.join(session, file), 'session must not copy');
  writeFileSync(path.join(state, 'remote-workers.json'), 'remote credentials must not copy');
  const script = fileURLToPath(new URL('../.agents/skills/office-clone/scripts/clone-office.sh', import.meta.url));
  // The script runs the built CLI from dist/, whose original source is covered by the source-level suites.
  execFileSync('bash', [script, '--office', office, '--dest', dest, '--port', '4699'], { env: { ...process.env, HOME: home, NODE_V8_COVERAGE: '' }, timeout: 30_000, stdio: 'pipe' });
  const copied = path.join(dest, 'office', '.droid-office');
  assert.deepEqual(JSON.parse(readFileSync(path.join(copied, 'orchestrator.json'), 'utf8')), settings);
  assert.equal(existsSync(path.join(copied, 'orchestrator')), false);
  assert.equal(existsSync(path.join(copied, 'remote-workers.json')), false);
  assert.match(readFileSync(path.join(dest, 'start.sh'), 'utf8'), /export HOME=/);
});
