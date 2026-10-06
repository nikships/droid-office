import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GUEST_REFUSED,
  GuestScanner,
  Guests,
  agentCandidates,
  assignSessions,
  attribute,
  floorFor,
  guestBanner,
  guestId,
  guestRefusal,
  officeLaunched,
  parseArgs,
  parseLsofCwd,
  parsePs,
  providerOf,
  resumedSession,
  transcriptState,
  type AgentProcess,
  type GuestEvents,
  type ProcRow,
} from '../src/server/guests.js';
import { COLORS, NAMES, WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { prune } from '../src/server/prune.js';
import { guestKeyNote, outsideNote, statusWord } from '../src/shared/guests.js';
import { DESKS } from '../src/shared/layout.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const row = (pid: number, ppid: number, comm: string, tty = 'ttys004'): ProcRow => ({ pid, ppid, tty, lstart: 'Mon Oct 5 21:30:05 2026', startedAt: 0, comm });

test('ps, ps args and lsof output parse into processes, arguments and working directories', () => {
  const ps = [
    '    1     0 ??       Thu Oct  1 08:00:00 2026     /sbin/launchd',
    '77381 60816 ttys000  Mon Oct  5 21:30:05 2026     /Users/me/.local/bin/droid',
    ' 2201  2200 pts/3    Tue Oct  6 10:01:02 2026     claude',
    '22000     1 ??       Tue Oct  6 09:00:00 2026     droid-office-pty',
    'not a ps line',
  ].join('\n');
  const rows = parsePs(ps);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => [r.pid, r.ppid, r.tty, r.comm]),
    [
      [1, 0, '??', '/sbin/launchd'],
      [77381, 60816, 'ttys000', '/Users/me/.local/bin/droid'],
      [2201, 2200, 'pts/3', 'claude'],
      [22000, 1, '??', 'droid-office-pty'],
    ],
  );
  assert.equal(rows[1].lstart, 'Mon Oct 5 21:30:05 2026');
  assert.ok(rows[1].startedAt > 0);

  const args = parseArgs('77381 /Users/me/.local/bin/droid --resume abc-123\n 2201 claude\n');
  assert.deepEqual(args.get(77381), ['/Users/me/.local/bin/droid', '--resume', 'abc-123']);
  assert.deepEqual(args.get(2201), ['claude']);

  const cwds = parseLsofCwd('p77381\nfcwd\nn/Users/me/code/app\np2201\nfcwd\nn/Users/me/code/app/src\n');
  assert.equal(cwds.get(77381), '/Users/me/code/app');
  assert.equal(cwds.get(2201), '/Users/me/code/app/src');
});

test('agent CLIs are recognised by their executable, wherever it is installed', () => {
  assert.equal(providerOf('/Users/me/.local/bin/droid'), 'droid');
  assert.equal(providerOf('/Applications/Factory.app/Contents/Resources/bin/droid'), 'droid');
  assert.equal(providerOf('claude'), 'claude');
  assert.equal(providerOf('codex'), 'codex');
  assert.equal(providerOf('opencode'), 'opencode');
  assert.equal(providerOf('grok'), 'grok');
  assert.equal(providerOf('muse'), 'muse');
  assert.equal(providerOf('C:\\bin\\droid.exe'.replace(/\\/g, '/')), 'droid');
  assert.equal(providerOf('-zsh'), undefined);
  assert.equal(providerOf('node'), undefined);
  assert.equal(providerOf('droid-office-pty'), undefined);
});

test('only agents someone runs in a terminal of their own are candidates: never the office’s, helpers, daemons or headless runs', () => {
  const rows = [
    row(1, 0, '/sbin/launchd', '??'),
    row(10, 1, '-zsh'),
    row(11, 10, '/usr/local/bin/droid'), // started by hand in a terminal: a guest
    row(12, 11, '/usr/local/bin/droid'), // that droid's own helper: not a second guest
    row(20, 1, 'droid-office-pty', '??'),
    row(21, 20, '/usr/local/bin/droid', 'ttys009'), // an office worker, in the terminal host
    row(22, 20, '/bin/zsh', 'ttys010'),
    row(23, 22, '/usr/local/bin/claude', 'ttys010'), // started in an office shell: the office's
    row(30, 1, '/usr/local/bin/droid', '??'), // a daemon, no terminal
    row(40, 10, '/usr/local/bin/droid'), // droid exec
    row(50, 10, '/usr/local/bin/droid'), // started by another office with its hooks
    row(60, 1, 'node', '??'),
    row(61, 60, '/usr/local/bin/codex', 'ttys011'), // under the office server itself
  ];
  const args = new Map<number, string[]>([
    [40, ['droid', 'exec', '--output-format', 'json']],
    [50, ['droid', '--settings', '/Users/me/code/app/.droid-office/droid-0cdfae351f97.json', '--resume', 'x']],
  ]);
  const picked = agentCandidates(rows, args, new Set([60]));
  assert.deepEqual(
    picked.map((r) => r.pid),
    [11],
  );
});

test('the office’s own launches are told apart by their hook settings overlay', () => {
  assert.equal(officeLaunched(['droid', '--settings', '/p/.droid-office/droid-hooks.json']), true);
  assert.equal(officeLaunched(['droid', '--settings', '/p/.droid-office/droid-1a2b.json', '--', 'fix it']), true);
  assert.equal(officeLaunched(['droid', '--settings', '/p/my-settings.json']), false);
  assert.equal(officeLaunched(['droid']), false);
  assert.equal(officeLaunched(undefined), false);
});

test('a droid started to resume a session names it', () => {
  assert.equal(resumedSession(['droid', '--resume', 'af551f4e-0d57-47a9-8d0a-62c589957298']), 'af551f4e-0d57-47a9-8d0a-62c589957298');
  assert.equal(resumedSession(['droid', '-r', 'abc']), 'abc');
  assert.equal(resumedSession(['droid', '--resume']), undefined);
  assert.equal(resumedSession(['droid', '--resume', '../../etc']), undefined);
  assert.equal(resumedSession(undefined), undefined);
});

test('a guest’s id stays the same for its process and differs from a later process given the same pid', () => {
  const a = guestId(77381, 'Mon Oct 5 21:30:05 2026');
  assert.equal(a, guestId(77381, 'Mon Oct 5 21:30:05 2026'));
  assert.notEqual(a, guestId(77381, 'Tue Oct 6 09:00:00 2026'));
  assert.notEqual(a, guestId(77382, 'Mon Oct 5 21:30:05 2026'));
  assert.ok(a.length <= 32, 'fits the 32 characters the server takes for a worker id');
});

test('a working directory belongs to the innermost floor whose checkout it is in; the home floor only to itself', () => {
  const floors = [
    { id: 'home', dir: '/Users/me', home: true },
    { id: 'app', dir: '/Users/me/code/app' },
    { id: 'lib', dir: '/Users/me/code/app/vendor/lib' },
    { id: 'api', dir: '/Users/me/code/api' },
  ];
  assert.equal(floorFor('/Users/me/code/app', floors), 'app');
  assert.equal(floorFor('/Users/me/code/app/src/server', floors), 'app');
  assert.equal(floorFor('/Users/me/code/app/.droid-office/worktrees/pixel-1a2b', floors), 'app');
  assert.equal(floorFor('/Users/me/code/app/vendor/lib/src', floors), 'lib');
  assert.equal(floorFor('/Users/me', floors), 'home');
  assert.equal(floorFor('/Users/me/Downloads', floors), undefined);
  assert.equal(floorFor('/Users/me/code/application', floors), undefined, 'a sibling with the same prefix is not inside');
  assert.equal(floorFor('/tmp/elsewhere', floors), undefined);
  assert.equal(floorFor('/Users/me/code/api', []), undefined, 'a floor taken off the building matches nothing');
});

const proc = (pid: number, cwd: string, extra: Partial<AgentProcess> = {}): AgentProcess => ({ id: `guest-${pid}-x`, pid, tty: `/dev/ttys00${pid % 10}`, provider: 'droid', cwd, startedAt: 1_000_000, ...extra });

test('a process started by hand in a worker’s own worktree is that worker’s, not a second guest', () => {
  const procs = [proc(1, '/p'), proc(2, '/p/.droid-office/worktrees/pixel-1a2b'), proc(3, '/p/.droid-office/worktrees/pixel-1a2b/src'), proc(4, '/p/.droid-office/worktrees/byte-9f9f')];
  const { guests, outside } = attribute(procs, [
    { id: 'pixel', folder: '/p/.droid-office/worktrees/pixel-1a2b' },
    { id: 'main', folder: undefined },
  ]);
  // The main checkout and a kept worktree nobody sits in any more are the guests'.
  assert.deepEqual(
    guests.map((g) => g.pid),
    [1, 4],
  );
  assert.deepEqual(outside.get('pixel'), [
    { pid: 2, tty: '/dev/ttys002', provider: 'droid' },
    { pid: 3, tty: '/dev/ttys003', provider: 'droid' },
  ]);
  assert.equal(outside.has('main'), false);
});

const line = (o: unknown) => JSON.stringify(o);
const start = line({ type: 'session_start', id: 's1', title: 'Fix the login redirect', cwd: '/p' });
const hook = line({ type: 'message', id: 'h1', message: { role: 'user', content: [], hookEventName: 'SessionStart' } });
const context = line({ type: 'message', id: 'context-u1', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>env</system-reminder>' }] } });
const ask = line({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Fix the login redirect on /settings' }] } });
const toolUse = line({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'thinking' }, { type: 'tool_use', name: 'Read' }] } });
const toolResult = line({ type: 'message', id: 'u2', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const reply = line({ type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: fixed.' }] } });
const outcome = line({ type: 'agent_turn_outcome', turnId: 't1', reason: 'completed', resultKind: 'text' });

test('a droid transcript says whether the session is waiting for a first prompt, mid-turn or done', () => {
  assert.deepEqual(transcriptState(start, start), { status: 'idle', title: 'Fix the login redirect', prompt: undefined });
  assert.equal(transcriptState(start, [start, hook, context].join('\n')).status, 'idle');
  const asked = transcriptState(start, [start, hook, context, ask].join('\n'));
  assert.equal(asked.status, 'working');
  assert.equal(asked.prompt, 'Fix the login redirect on /settings');
  assert.equal(transcriptState(start, [start, ask, toolUse, toolResult].join('\n')).status, 'working');
  const done = transcriptState(start, [start, ask, toolUse, toolResult, reply, hook, outcome, ''].join('\n'));
  assert.equal(done.status, 'done');
  assert.equal(done.prompt, 'Fix the login redirect on /settings');
  // A new prompt after a finished turn starts the next one.
  assert.equal(transcriptState(start, [ask, reply, outcome, ask].join('\n')).status, 'working');
});

test('a transcript read from the middle skips the cut-off line, and garbage is no state at all', () => {
  const tail = `${outcome.slice(10)}\n${ask}\n${toolUse}`;
  assert.equal(transcriptState('', tail, true).status, 'working');
  assert.deepEqual(transcriptState('{not json', 'nonsense\n{also not'), { status: 'idle', title: undefined, prompt: undefined });
});

test('sessions are tied to guests only when they can’t be anyone else’s', () => {
  const files = new Map([
    [
      '/a',
      [
        { id: 'old', mtime: 500 },
        { id: 'new', mtime: 2_000 },
        { id: 'office', mtime: 3_000 },
      ],
    ],
    [
      '/b',
      [
        { id: 'b1', mtime: 2_000 },
        { id: 'b2', mtime: 2_500 },
      ],
    ],
    ['/c', [{ id: 'resumed', mtime: 100 }]],
  ]);
  const guests = [
    { id: 'g1', cwd: '/a', startedAt: 1_000 },
    { id: 'g2', cwd: '/b', startedAt: 1_000 },
    { id: 'g3', cwd: '/b', startedAt: 1_000 },
    { id: 'g4', cwd: '/c', startedAt: 1_000, resume: 'resumed' },
  ];
  const got = assignSessions(guests, files, new Set(['office']));
  // The one guest in /a gets the newest session there since it started, not the office worker's.
  assert.equal(got.get('g1'), 'new');
  // Two guests in /b: no telling whose transcript is whose.
  assert.equal(got.has('g2'), false);
  assert.equal(got.has('g3'), false);
  // A resumed session is its own, however old.
  assert.equal(got.get('g4'), 'resumed');
  // Nothing written since it started: no session.
  assert.equal(assignSessions([{ id: 'g', cwd: '/a', startedAt: 10_000 }], files, new Set()).has('g'), false);
});

function recorder() {
  const updates: WorkerInfo[] = [];
  const removed: string[] = [];
  const drawn: { id: string; data: string; ids: string[] }[] = [];
  const events: GuestEvents = {
    update: (info) => updates.push(info),
    remove: (id) => removed.push(id),
    data: (id, data, ids) => drawn.push({ id, data, ids }),
  };
  return { ...events, updates, removed, drawn };
}

function guestFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-guests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const sessions = path.join(root, 'sessions');
  const project = path.join(root, 'project');
  mkdirSync(data, { recursive: true });
  mkdirSync(project, { recursive: true });
  const sessionDir = path.join(sessions, project.replace(/[\\/:]/g, '-'));
  mkdirSync(sessionDir, { recursive: true });
  const transcript = (id: string, lines: string[], mtime = Date.now()) => {
    const file = path.join(sessionDir, `${id}.jsonl`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  };
  return { root, data, sessions, project, sessionDir, transcript };
}

const office = (taken: string[] = [], names: string[] = []) => ({ deskTaken: (id: string) => taken.includes(id), names: () => names, pool: { names: NAMES, colors: COLORS } });

test('guests sit at free desks of their own, with names the office’s workers don’t have, and go home when their process does', async (t) => {
  const f = guestFixture(t);
  const ev = recorder();
  const guests = new Guests(f.data, office([DESKS[0].id], [NAMES[0]]), ev, f.sessions);
  t.after(() => guests.stop());
  const started = Date.now() - 60_000;
  const a = proc(101, f.project, { id: 'guest-101-a', startedAt: started });
  const b = proc(102, f.project, { id: 'guest-102-b', startedAt: started, provider: 'claude' });
  await guests.sync([a, b], new Set());
  const list = guests.list();
  assert.equal(list.length, 2);
  const [ga, gb] = list;
  assert.notEqual(ga.deskId, gb.deskId, 'two processes in one checkout get two desks');
  assert.notEqual(ga.id, gb.id);
  assert.notEqual(ga.deskId, DESKS[0].id, 'never a desk an office worker sits at');
  assert.ok(!list.some((g) => g.name === NAMES[0]), 'never the name of an office worker');
  assert.notEqual(ga.name, gb.name);
  assert.equal(guests.deskTaken(ga.deskId), true);
  // Neither can be tied to a transcript: the office says only that they run.
  for (const g of list) {
    assert.equal(g.guest?.seen, 'process');
    assert.equal(g.status, 'idle');
    assert.equal(g.acked, true, 'an unknown state is never shown as waiting on someone');
  }
  assert.equal(gb.guest?.provider, 'claude');
  assert.equal(ev.updates.length, 2);

  // Nothing changed: nothing is sent.
  await guests.sync([a, b], new Set());
  assert.equal(ev.updates.length, 2);

  // One scan that misses a process isn't it leaving; the second is.
  await guests.sync([a], new Set());
  assert.deepEqual(ev.removed, []);
  await guests.sync([a], new Set());
  assert.deepEqual(ev.removed, [gb.id]);
  assert.equal(guests.list().length, 1);
});

test('a droid guest’s status, task and waiting flag come from its transcript', async (t) => {
  const f = guestFixture(t);
  const ev = recorder();
  const guests = new Guests(f.data, office(), ev, f.sessions);
  t.after(() => guests.stop());
  const started = Date.now() - 60_000;
  const p = proc(201, f.project, { id: 'guest-201-a', startedAt: started });
  // Finished before the office saw it: nobody is waiting on that.
  f.transcript('s-1', [start, ask, reply, outcome], started + 5_000);
  await guests.sync([p], new Set());
  let g = guests.list()[0];
  assert.equal(g.guest?.seen, 'transcript');
  assert.equal(g.status, 'done');
  assert.equal(g.acked, true);
  assert.equal(g.task?.name, 'Fix the login redirect');
  assert.equal(g.prompt, 'Fix the login redirect on /settings');

  // The owner asks for more in their own terminal: it's working.
  f.transcript('s-1', [start, ask, reply, outcome, ask, toolUse], started + 10_000);
  await guests.sync([p], new Set());
  g = guests.list()[0];
  assert.equal(g.status, 'working');
  assert.equal(g.waitingSince, undefined);

  // It finishes while the office watches: it's waiting on someone, until its window is opened.
  f.transcript('s-1', [start, ask, reply, outcome, ask, toolUse, reply, outcome], started + 20_000);
  await guests.sync([p], new Set());
  g = guests.list()[0];
  assert.equal(g.status, 'done');
  assert.equal(g.acked, false);
  assert.equal(g.waitingSince, started + 20_000);

  const snap = guests.attach(g.id, 'conn-1');
  assert.ok(snap?.data.includes('running outside the office'));
  assert.ok(snap?.data.includes(`pid ${p.pid}`));
  assert.ok(snap?.data.includes(p.tty));
  assert.equal(guests.get(g.id)?.acked, true);
  assert.equal(guests.get(g.id)?.open, true);

  // A change redraws the banner for whoever has the window open.
  f.transcript('s-1', [start, ask, reply, outcome, ask], started + 30_000);
  await guests.sync([p], new Set());
  assert.equal(ev.drawn.at(-1)?.id, g.id);
  assert.deepEqual(ev.drawn.at(-1)?.ids, ['conn-1']);
  guests.detachAll('conn-1');
  assert.equal(guests.get(g.id)?.open, false);
});

test('an office worker’s session is never a guest’s', async (t) => {
  const f = guestFixture(t);
  const guests = new Guests(f.data, office(), recorder(), f.sessions);
  t.after(() => guests.stop());
  const started = Date.now() - 60_000;
  f.transcript('worker-session', [start, ask, toolUse], started + 5_000);
  await guests.sync([proc(301, f.project, { id: 'guest-301-a', startedAt: started })], new Set(['worker-session']));
  assert.equal(guests.list()[0].guest?.seen, 'process');
});

test('a guest is back at the same desk with the same name after the office restarts, while its process runs', async (t) => {
  const f = guestFixture(t);
  const p = proc(401, f.project, { id: 'guest-401-a', startedAt: Date.now() - 60_000 });
  const first = new Guests(f.data, office([DESKS[0].id, DESKS[1].id]), recorder(), f.sessions);
  await first.sync([p], new Set());
  const before = first.list()[0];
  first.stop();
  assert.ok(existsSync(path.join(f.data, 'guests.json')));
  const saved = JSON.parse(readFileSync(path.join(f.data, 'guests.json'), 'utf8'));
  assert.equal(saved[0].id, p.id);

  // The next office has the desks before it free, and the guest still takes the one it had.
  const second = new Guests(f.data, office(), recorder(), f.sessions);
  t.after(() => second.stop());
  await second.sync([p], new Set());
  const after = second.list()[0];
  assert.equal(after.deskId, before.deskId);
  assert.equal(after.name, before.name);
  assert.equal(after.color, before.color);
});

test('with every seat taken, a guest waits outside rather than share one', async (t) => {
  const f = guestFixture(t);
  const guests = new Guests(f.data, { deskTaken: () => true, names: () => [], pool: { names: NAMES, colors: COLORS } }, recorder(), f.sessions);
  t.after(() => guests.stop());
  await guests.sync([proc(501, f.project)], new Set());
  assert.deepEqual(guests.list(), []);
});

test('the guest’s window and every refusal say it runs outside the office, and the office never acts on it', () => {
  const info: WorkerInfo = {
    id: 'guest-1-x',
    kind: 'agent',
    deskId: 'desk-3',
    name: 'Pixel',
    color: '#fff',
    status: 'working',
    acked: true,
    createdBy: 'outside the office',
    createdAt: 0,
    cols: 100,
    rows: 30,
    open: false,
    activeModel: 'claude-opus-5',
    guest: { pid: 77381, tty: '/dev/ttys000', provider: 'droid', cwd: '/Users/me/code/app', startedAt: Date.now() - 60_000, seen: 'transcript', writtenAt: Date.now() },
  };
  const banner = guestBanner(info);
  assert.ok(banner.includes('Droid session running outside the office'));
  assert.ok(banner.includes('pid 77381 on /dev/ttys000'));
  assert.ok(banner.includes('/Users/me/code/app'));
  assert.ok(banner.includes('claude-opus-5'));
  assert.ok(banner.includes('nothing'));
  assert.ok(guestBanner({ ...info, guest: { ...info.guest!, seen: 'process' } }).includes("doesn't know whether it's working or waiting"));

  for (const t of ['worker.kill', 'worker.prompt', 'worker.shoot', 'worker.resume', 'worker.pr', 'worker.rebuild', 'changes.commit', 'changes.discard'] as const) assert.ok(GUEST_REFUSED.has(t), t);
  assert.ok(!GUEST_REFUSED.has('worker.attach'), 'its window still opens');
  assert.match(guestRefusal(info, 'worker.kill'), /never stops a process it didn't start/);
  assert.match(guestRefusal(info, 'worker.prompt'), /own terminal/);
  assert.match(guestRefusal(info, 'worker.shoot'), /leaves it alone/);

  assert.equal(statusWord(info, { working: 'working' }), 'working');
  assert.equal(statusWord({ ...info, guest: { ...info.guest!, seen: 'process' } }, { working: 'working' }), 'running');
  assert.match(guestKeyNote(info, 'X'), /never stops it/);
  assert.match(guestKeyNote(info, 'P'), /own terminal/);
  assert.equal(outsideNote(info), undefined);
  assert.match(outsideNote({ ...info, outside: [{ pid: 9, tty: '/dev/ttys009', provider: 'droid' }] }) ?? '', /pid 9 on \/dev\/ttys009/);
});

test('one scan hands each floor the processes in its checkout', async () => {
  const got = new Map<string, number[]>();
  const floor = (id: string, dir: string, home = false) => ({
    id,
    dir,
    home,
    syncGuests: async (procs: AgentProcess[]) =>
      void got.set(
        id,
        procs.map((p) => p.pid),
      ),
  });
  const scanner = new GuestScanner(
    () => [floor('home', '/nowhere/home', true), floor('app', '/nowhere/home/app')],
    () => [],
    async () => [proc(1, '/nowhere/home'), proc(2, '/nowhere/home/app/src'), proc(3, '/nowhere/home/Downloads')],
  );
  await scanner.tick();
  assert.deepEqual(got.get('home'), [1]);
  assert.deepEqual(got.get('app'), [2]);
});

const workerEvents: WorkerEvents = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };

test('the office’s hires and the queue treat a guest’s desk and name as taken, and know who works by hand in a worktree', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-guest-desks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, '.droid-office');
  mkdirSync(data, { recursive: true });
  const workers = new WorkerManager(root, data, path.join(root, 'no-droid'), [], { url: 'http://127.0.0.1:1', token: '' }, workerEvents);
  t.after(() => workers.shutdown());
  assert.equal(workers.deskOccupied(DESKS[2].id), false);
  workers.holds = { desk: (id) => id === DESKS[2].id, names: () => [] };
  assert.equal(workers.deskOccupied(DESKS[2].id), true);
  assert.equal(workers.ownDesk(DESKS[2].id), false);
  assert.match(String(workers.spawn(DESKS[2].id, 'test')), /taken/);
  assert.deepEqual(workers.folders(), []);
  assert.deepEqual([...workers.sessionIds()], []);
});

test('prune keeps a worktree an agent runs in, even with --force', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-guest-prune-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-qm', 'a');
  const wt = path.join(root, '.droid-office', 'worktrees', 'pixel-1a2b');
  git('worktree', 'add', '-q', '-b', 'office/pixel-1a2b', wt);
  const log = t.mock.method(console, 'log', () => {});
  const realWt = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: wt, encoding: 'utf8' }).trim();
  assert.equal(await prune([root, '--force'], async () => [proc(7, path.join(realWt, 'src'))]), 0);
  assert.ok(existsSync(wt), 'the worktree someone works in is kept');
  assert.ok(log.mock.calls.some((c) => String(c.arguments[0]).includes('droid (pid 7) is running in it')));
  assert.equal(await prune([root, '--force'], async () => []), 0);
  assert.equal(existsSync(wt), false, 'and pruned once nobody does');
});
