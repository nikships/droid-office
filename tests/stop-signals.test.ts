import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pty from '@lydell/node-pty';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('closing the terminal the office runs in shuts it down like a restart, to the end, even with the terminal gone', { skip: process.platform === 'win32' ? 'POSIX terminals' : false, timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'stop-signals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out.log');
  const mod = pathToFileURL(path.join(import.meta.dirname, '../src/server/stop-signals.ts')).href;
  // An office-like process: its shutdown takes a while and keeps logging to the terminal that is gone.
  const code = `
    import { appendFileSync } from 'node:fs';
    import { onStopSignals } from ${JSON.stringify(mod)};
    const note = (line) => appendFileSync(${JSON.stringify(out)}, line + '\\n');
    process.on('exit', (code) => note('exit ' + code));
    onStopSignals(async (keep) => {
      note('keep ' + keep);
      for (let i = 0; i < 20; i++) {
        console.log('still closing ' + i);
        console.error('still closing ' + i);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      note('done');
    });
    console.log('ready');
    setInterval(() => {}, 1000);
  `;
  const term = pty.spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), env: process.env as Record<string, string>, cols: 80, rows: 24 });
  let screen = '';
  term.onData((d) => {
    screen += d;
  });
  for (const end = Date.now() + 30_000; !screen.includes('ready'); await sleep(20)) {
    if (Date.now() > end) assert.fail(`the process never started: ${screen}`);
  }
  const pid = term.pid;
  // Closes the terminal, then hangs up its process, as closing a terminal window does.
  (term as pty.IPty & { destroy(): void }).destroy();
  // The shell that owned the terminal hangs up its jobs too: a second SIGHUP must not cut the shutdown short.
  await sleep(50);
  try {
    process.kill(pid, 'SIGHUP');
  } catch {
    // Already gone; the lines below say how it ended.
  }
  const lines = () => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n') : []);
  for (const end = Date.now() + 15_000; !lines().some((l) => l.startsWith('exit')) && Date.now() < end; ) await sleep(20);
  assert.deepEqual(lines(), ['keep true', 'done', 'exit 0'], 'workers kept, the shutdown finished, then a clean exit');
});
