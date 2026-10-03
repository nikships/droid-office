import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(project, '../..');
const evidence = path.join(project, 'Evidence');

// Re-exec before loading server modules: no owner's credentials, provider homes,
// office state, workers or remote repository are involved in this fixture.
if (!process.argv.includes('--isolated')) {
  await mkdir(evidence, { recursive: true });
  const home = await mkdtemp(path.join(evidence, 'server-fixture-'));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--isolated', ...(process.argv.includes('--populated') ? ['--populated'] : [])], {
    cwd: root,
    env: {
      HOME: home,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      OFFICE_FIXTURE_HOME: home,
    },
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  const { startServer } = await import('../../../src/server/server.ts');
  const { loadConfig } = await import('../../../src/server/config.ts');
  const home = process.env.OFFICE_FIXTURE_HOME;
  const populated = process.argv.includes('--populated');
  const checkout = path.join(home, 'Synthetic office');
  await mkdir(checkout);
  execFileSync('git', ['init', '--quiet', checkout]);
  await writeFile(path.join(checkout, 'README.md'), '# Synthetic Unity integration office\n');
  const agent = path.join(home, 'office-test-agent');
  await writeFile(
    agent,
    `#!${process.execPath}
import http from 'node:http';
const events = ${populated ? "['SessionStart', 'UserPromptSubmit']" : "['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop']"};
let step = 0;
function next() {
  const event = events[step++ % events.length];
  const url = new URL(process.env.DROID_OFFICE_HOOK_URL + '/hooks/claude');
  url.searchParams.set('worker', process.env.DROID_OFFICE_WORKER_ID);
  url.searchParams.set('event', event);
  const body = JSON.stringify({ session_id: 'synthetic-session', prompt: 'Synthetic work', tool_name: 'Read', tool_input: { file_path: 'README.md' } });
  const request = http.request(url, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.DROID_OFFICE_HOOK_TOKEN, 'content-type': 'application/json' } }, response => response.resume());
  request.on('error', () => {});
  request.end(body);
  process.stdout.write('\\r\\nSynthetic terminal: ' + event + '\\r\\n');
}
setTimeout(next, 500);
setInterval(next, 1800);
process.stdin.resume();
`,
    { mode: 0o700 },
  );
  const cfg = loadConfig([checkout, '--host', '127.0.0.1', '--port', '14600', '--agent', agent, '--no-discovery', '--webhook', '', '--projects', home]);
  const office = await startServer(cfg);
  const floor = office.floors()[0];
  assert.ok(floor, 'Isolated fixture has a floor');
  const workers = Array.from({ length: populated ? 12 : 2 }, (_, i) => floor.workers.spawn(`desk-${i + 1}`, 'Unity fixture'));
  assert.ok(
    workers.every((worker) => typeof worker === 'object'),
    'Fake agents start without worktrees',
  );
  const seen = new Set();
  let welcomes = 0;
  let socket;
  function connect() {
    socket = new WebSocket('ws://127.0.0.1:14600/ws', { origin: 'http://127.0.0.1:14600' });
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.t === 'welcome') welcomes++;
      if (frame.t === 'worker.update') seen.add(frame.worker.status);
    });
    socket.on('error', () => {});
  }
  connect();
  const timer = setTimeout(() => {
    socket.close();
    connect();
  }, 9000);
  let shuttingDown = false;
  async function stop() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(timer);
    socket?.close();
    office.shutdown(false);
    await writeFile(
      path.join(evidence, 'server-fixture.json'),
      JSON.stringify(
        {
          source: `real server, isolated HOME and git checkout, ${workers.length} synthetic agent commands`,
          welcomes,
          statuses: [...seen].sort(),
          ownerOfficeTouched: false,
        },
        null,
        2,
      ),
    );
    await delay(300);
    process.exit(welcomes >= 2 && seen.has('working') && (populated || (seen.has('needs_input') && seen.has('done'))) ? 0 : 1);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setTimeout(stop, populated ? 600000 : 180000);
  console.log(`Synthetic office ready on loopback :14600, ${workers.length} agents. Automatic stop in ${populated ? 600 : 180} seconds.`);
}
