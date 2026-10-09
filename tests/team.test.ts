import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Team, settled, type TeamOptions, type TeamWorkers } from '../src/server/team.js';
import { teamOf, teamSummary, workersByTeam } from '../src/shared/team.js';
import { SUBAGENT_DEFAULTS, type AgentChoice, type SubagentSettings, type WorkerInfo, type WorkerStatus, type WorkerTask } from '../src/shared/protocol.js';

function worker(over: Partial<WorkerInfo> & { id: string; deskId: string }): WorkerInfo {
  return { kind: 'agent', name: over.id, color: '#fff', status: 'done', acked: true, createdBy: 'test', createdAt: Date.now(), cols: 100, rows: 30, open: false, ...over };
}

class Fake implements TeamWorkers {
  ws = new Map<string, WorkerInfo>();
  officeDefault: AgentChoice | undefined = undefined;
  hired: { deskId: string; by: string; prompt: string; worktree: boolean; choice: Partial<AgentChoice>; lead: string }[] = [];
  prompts: [string, string][] = [];
  resumed: [string, string | undefined][] = [];
  killed: string[] = [];
  tails = new Map<string, string>();
  fetched = 0;
  refuse?: string;
  private n = 0;
  add(w: WorkerInfo) {
    this.ws.set(w.id, w);
    return w;
  }
  list() {
    return [...this.ws.values()];
  }
  get(id: string) {
    return this.ws.get(id);
  }
  deskOccupied(deskId: string) {
    return this.list().some((w) => w.deskId === deskId);
  }
  hire(deskId: string, by: string, prompt: string, worktree: boolean, choice: Partial<AgentChoice>, lead: string) {
    if (this.refuse) return this.refuse;
    this.hired.push({ deskId, by, prompt, worktree, choice, lead });
    const id = `sub${++this.n}`;
    return this.add(
      worker({
        id,
        deskId,
        name: ['Pixel', 'Byte', 'Dot', 'Echo', 'Fizz'][this.n - 1] ?? id,
        status: 'starting',
        lead,
        ...(choice.model ? { model: choice.model } : {}),
        ...(worktree ? { worktree: { path: `.droid-office/worktrees/${id}`, branch: `office/${id}`, base: 'abc' } } : {}),
      }),
    );
  }
  prompt(id: string, text: string) {
    this.prompts.push([id, text]);
    return undefined;
  }
  resume(id: string, text?: string) {
    this.resumed.push([id, text]);
    return undefined;
  }
  async kill(id: string) {
    this.ws.delete(id);
    this.killed.push(id);
    return { note: 'Kept its worktree' };
  }
  tail(id: string) {
    return this.tails.get(id);
  }
  setTask(id: string, task: WorkerTask) {
    const w = this.ws.get(id);
    if (w) w.task = task;
  }
  fetchBase() {
    this.fetched++;
    return Promise.resolve();
  }
}

interface Rig {
  fake: Fake;
  team: Team;
  toasts: string[];
  settings: SubagentSettings;
  dir: string;
  /** Moves a droid to a new status, as the floor reports it. */
  set(id: string, status: WorkerStatus, extra?: Partial<WorkerInfo>): void;
  call(caller: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }>;
}

function rig(t: { after(fn: () => void): void }, over: Partial<TeamOptions> = {}, settings: Partial<SubagentSettings> = {}): Rig {
  const dir = mkdtempSync(path.join(tmpdir(), 'droid-office-team-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = new Fake();
  fake.add(worker({ id: 'lead', deskId: 'desk-1', name: 'Nibble' }));
  const toasts: string[] = [];
  const s: SubagentSettings = { ...SUBAGENT_DEFAULTS, ...settings };
  const team = new Team(fake, { dataDir: dir, dir: '/proj', git: true, settings: () => s, toast: (text) => toasts.push(text), nudgeDelayMs: 5, ...over });
  t.after(() => team.stop());
  return {
    fake,
    team,
    toasts,
    settings: s,
    dir,
    set(id, status, extra = {}) {
      const w = fake.get(id);
      if (!w) throw new Error(`no ${id}`);
      Object.assign(w, extra, { status });
      team.onWorker({ ...w });
    },
    async call(caller, body) {
      const w = fake.get(caller);
      if (!w) throw new Error(`no ${caller}`);
      return (await team.handle(w, body)) as { status: number; body: Record<string, any> };
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a lead hires a subagent at the free desk nearest it, in its own worktree, on the Subagents setting', async (t) => {
  const r = rig(t, {}, { agent: { model: 'custom:droidproxy:gpt-6-sol', effort: 'high' } });
  const res = await r.call('lead', { action: 'hire', task: '  Fix the login redirect\r\nand test it  ', title: 'Fix login' });
  assert.equal(res.status, 200);
  assert.deepEqual(r.fake.hired, [{ deskId: 'desk-3', by: 'Nibble', prompt: 'Fix the login redirect\nand test it', worktree: true, choice: { model: 'custom:droidproxy:gpt-6-sol', effort: 'high' }, lead: 'lead' }]);
  assert.equal(r.fake.fetched, 1, 'its worktree starts from what the forge has now');
  assert.deepEqual(r.fake.get('sub1')?.task, { name: 'Fix login', summary: 'Fix the login redirect and test it' });
  assert.equal(res.body.worker.name, 'Pixel');
  assert.equal(res.body.worker.desk, 'Desk 3');
  assert.deepEqual(res.body.worker.worktree, { path: path.join('/proj', '.droid-office/worktrees/sub1'), branch: 'office/sub1' });
  assert.deepEqual(r.toasts, ['🧭 Nibble hired Pixel at Desk 3: Fix login']);

  // The lead's own picks win; what it leaves out comes from the setting.
  await r.call('lead', { action: 'hire', task: 'b', model: 'glm-5.3' });
  await r.call('lead', { action: 'hire', task: 'c', effort: 'low' });
  await r.call('lead', { action: 'hire', task: 'd', worktree: false });
  assert.deepEqual(
    r.fake.hired.slice(1).map((h) => [h.choice, h.worktree]),
    [
      [{ model: 'glm-5.3', effort: 'high' }, true],
      [{ model: 'custom:droidproxy:gpt-6-sol', effort: 'low' }, true],
      [{ model: 'custom:droidproxy:gpt-6-sol', effort: 'high' }, false],
    ],
  );
  // Nearest first: across the pod, beside it, diagonally, then the next pod over.
  assert.deepEqual(
    r.fake.hired.map((h) => h.deskId),
    ['desk-3', 'desk-2', 'desk-4', 'desk-9'],
  );
});

test('with no Subagents setting, what the lead leaves out comes from the office default', async (t) => {
  const r = rig(t);
  r.fake.officeDefault = { model: 'glm-5.3', effort: 'max' };
  await r.call('lead', { action: 'hire', task: 'a' });
  await r.call('lead', { action: 'hire', task: 'b', effort: 'low' });
  await r.call('lead', { action: 'hire', task: 'c', model: 'custom:droidproxy:gpt-6-sol' });
  assert.deepEqual(
    r.fake.hired.map((h) => h.choice),
    [{}, { model: 'glm-5.3', effort: 'low' }, { model: 'custom:droidproxy:gpt-6-sol', effort: 'max' }],
  );
});

test("hiring is refused when it shouldn't happen, with a reason the agent can act on", async (t) => {
  const r = rig(t, { git: false }, { maxPerLead: 1 });
  r.fake.add(worker({ id: 'issues', deskId: 'station-issues', name: 'Issues agent' }));
  r.fake.add(worker({ id: 'shell', deskId: 'desk-8', kind: 'shell', name: 'Shell 🐚' }));
  r.fake.add(worker({ id: 'meet', deskId: 'meeting-1', meeting: 'm1' }));
  const no = async (caller: string, body: Record<string, unknown>, status: number, why: RegExp) => {
    const res = await r.call(caller, body);
    assert.equal(res.status, status, `${caller} ${JSON.stringify(body)}`);
    assert.match(res.body.error, why);
  };
  await no('lead', { action: 'hire' }, 400, /needs a task/);
  await no('lead', { action: 'hire', task: 'x', effort: 'ludicrous' }, 400, /Effort is one of low, medium, high, xhigh, max/);
  await no('lead', { action: 'hire', task: 'x', worktree: true }, 400, /isn't a git checkout/);
  await no('issues', { action: 'hire', task: 'x' }, 403, /Issues agent doesn't hire subagents: put the work on the task queue/);
  await no('shell', { action: 'hire', task: 'x' }, 403, /Only agents/);
  await no('meet', { action: 'hire', task: 'x' }, 403, /meeting table/);
  await no('lead', { action: 'nope' }, 400, /Unknown action/);

  // No git: no worktree, without being asked.
  assert.equal((await r.call('lead', { action: 'hire', task: 'x' })).status, 200);
  assert.equal(r.fake.hired[0].worktree, false);
  assert.equal(r.fake.fetched, 0);
  await no('lead', { action: 'hire', task: 'y' }, 409, /You have 1 subagents, the most one lead has at once/);
  await no('sub1', { action: 'hire', task: 'y' }, 403, /You're a subagent of Nibble, and subagents can't hire their own/);

  r.settings.deskWorkers = false;
  r.settings.maxPerLead = 4;
  await no('lead', { action: 'hire', task: 'y' }, 403, /Only the Team lead hires subagents/);
  r.fake.add(worker({ id: 'tl', deskId: 'station-lead', name: 'Team lead' }));
  assert.equal((await r.call('tl', { action: 'hire', task: 'y' })).status, 200);
  r.settings.on = false;
  await no('tl', { action: 'hire', task: 'z' }, 403, /turned off/);

  r.fake.refuse = 'Every desk is taken';
  r.settings.on = true;
  await no('tl', { action: 'hire', task: 'z' }, 409, /Every desk is taken/);
});

test('whoami and list say who you are, what you may do, and how your team is doing', async (t) => {
  const r = rig(t);
  let who = (await r.call('lead', { action: 'whoami' })).body;
  assert.deepEqual(who.you, { id: 'lead', name: 'Nibble', desk: 'Desk 1', role: 'worker' });
  assert.equal(who.canHire, true);
  assert.equal(who.max, 4);
  assert.equal(who.worktree, true);
  await r.call('lead', { action: 'hire', task: 'Fix it', title: 'Fix' });
  who = (await r.call('lead', { action: 'whoami' })).body;
  assert.equal(who.you.role, 'lead');
  assert.equal(who.subagents, 1);
  const sub = (await r.call('sub1', { action: 'whoami' })).body;
  assert.equal(sub.you.role, 'subagent');
  assert.deepEqual(sub.lead, { id: 'lead', name: 'Nibble' });
  assert.equal(sub.canHire, false);

  r.set('sub1', 'working', { activity: 'Editing login.ts' });
  await r.call('sub1', { action: 'report', text: 'Fixed it in #12' });
  const list = (await r.call('lead', { action: 'list' })).body;
  assert.equal(list.team.length, 1);
  assert.equal(list.team[0].activity, 'Editing login.ts');
  assert.equal(list.team[0].settled, false);
  assert.equal(list.team[0].report.text, 'Fixed it in #12');
  assert.equal(list.team[0].report.question, false);
});

test("a subagent's reports, questions and turns reach its lead once, and finishing after a report is no news", async (t) => {
  const r = rig(t, { nudgeDelayMs: 60_000 });
  await r.call('lead', { action: 'hire', task: 'a' });
  await r.call('lead', { action: 'hire', task: 'b' });
  const events = async (body: Record<string, unknown> = {}) => (await r.call('lead', { action: 'events', ...body })).body;

  r.set('sub1', 'working');
  r.set('sub2', 'working');
  assert.deepEqual((await events()).events, []);
  assert.equal((await r.call('sub1', { action: 'report', text: '  Done: PR #12  ' })).body.lead, 'Nibble');
  r.set('sub1', 'done');
  r.set('sub2', 'needs_input', { activity: 'Bash: rm -rf build' });
  let got = await events();
  assert.deepEqual(
    got.events.map((e: any) => [e.kind, e.name, e.text]),
    [
      ['report', 'Pixel', 'Done: PR #12'],
      ['needs_input', 'Byte', 'Bash: rm -rf build'],
    ],
  );
  assert.deepEqual(
    got.team.map((m: any) => [m.name, m.settled]),
    [
      ['Pixel', true],
      ['Byte', true],
    ],
  );
  // Heard once.
  assert.deepEqual((await events()).events, []);

  // A turn that ends without a report is news; so is a question, stopping and leaving.
  r.set('sub2', 'working');
  r.set('sub2', 'done', { task: { name: 'B', summary: 'Tidying the tests' } });
  await r.call('sub1', { action: 'report', text: 'Which branch?', question: true });
  r.set('sub1', 'working');
  r.set('sub1', 'exited', { exitCode: 1 });
  got = await events({ workers: ['pixel'] });
  assert.deepEqual(
    got.events.map((e: any) => [e.kind, e.text]),
    [
      ['question', 'Which branch?'],
      ['stopped', 'exit code 1'],
    ],
  );
  r.fake.ws.delete('sub2');
  r.team.onWorkerGone('sub2');
  got = await events();
  assert.deepEqual(
    got.events.map((e: any) => [e.kind, e.name, e.text]),
    [
      ['done', 'Byte', 'Tidying the tests'],
      ['left', 'Byte', undefined],
    ],
  );
  assert.match((await r.call('lead', { action: 'events', workers: ['Nova'] })).body.error, /No subagent called Nova: yours are Pixel/);

  // Restored asleep after a restart and woken: no news in that.
  r.set('sub1', 'offline');
  r.set('sub1', 'done');
  assert.deepEqual((await events()).events, []);
});

test("a lead's news outlives a restart, and goes with the lead", async (t) => {
  const r = rig(t, { nudgeDelayMs: 60_000 });
  await r.call('lead', { action: 'hire', task: 'a' });
  r.set('sub1', 'working');
  await r.call('sub1', { action: 'report', text: 'All done' });
  r.team.stop();
  const again = new Team(r.fake, { dataDir: r.dir, dir: '/proj', git: true, settings: () => r.settings, toast() {}, nudgeDelayMs: 60_000 });
  t.after(() => again.stop());
  const lead = r.fake.get('lead')!;
  assert.deepEqual(
    ((await again.handle(lead, { action: 'events' })).body.events as any[]).map((e) => e.text),
    ['All done'],
  );
  await again.handle(r.fake.get('sub1')!, { action: 'report', text: 'One more thing' });
  r.fake.ws.delete('lead');
  again.onWorkerGone('lead');
  const third = new Team(r.fake, { dataDir: r.dir, dir: '/proj', git: true, settings: () => r.settings, toast() {} });
  t.after(() => third.stop());
  r.fake.add(lead);
  assert.deepEqual((await third.handle(lead, { action: 'events' })).body.events, []);
});

test('a lead at rest is woken once per batch of news, and a busy one when it comes to rest', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'a' });
  await r.call('lead', { action: 'hire', task: 'b' });
  r.set('sub1', 'working');
  r.set('sub2', 'working');
  r.set('lead', 'done');
  await r.call('sub1', { action: 'report', text: 'Done' });
  r.set('sub1', 'done');
  r.set('sub2', 'done');
  await sleep(40);
  assert.equal(r.fake.prompts.length, 1);
  const [to, text] = r.fake.prompts[0];
  assert.equal(to, 'lead');
  assert.match(text, /📨 Pixel reported back\. Byte finished its turn without reporting\. Run `office-workers wait`/);
  await sleep(20);
  assert.equal(r.fake.prompts.length, 1, 'once for the same news');

  // Busy, it isn't interrupted; once it comes to rest with news unheard, it is.
  r.set('lead', 'working');
  r.set('sub1', 'working');
  await r.call('sub1', { action: 'report', text: 'Also fixed the docs' });
  await sleep(30);
  assert.equal(r.fake.prompts.length, 1);
  r.set('lead', 'done');
  await sleep(30);
  assert.equal(r.fake.prompts.length, 2);
  assert.match(r.fake.prompts[1][1], /Pixel reported back\./);

  // News it has already heard with wait wakes nobody, and neither does someone typing to it.
  r.set('lead', 'working');
  await r.call('sub1', { action: 'report', text: 'And the tests' });
  await r.call('lead', { action: 'events' });
  r.set('lead', 'done');
  await sleep(30);
  assert.equal(r.fake.prompts.length, 2);
  r.fake.get('lead')!.lastInputAt = Date.now();
  await r.call('sub1', { action: 'report', text: 'Last one' });
  await sleep(30);
  assert.equal(r.fake.prompts.length, 2);
  r.fake.get('lead')!.lastInputAt = Date.now() - 10_000;
  await sleep(30);
  assert.equal(r.fake.prompts.length, 3);

  r.settings.wakeLead = false;
  await r.call('sub1', { action: 'report', text: 'Quiet now' });
  await sleep(30);
  assert.equal(r.fake.prompts.length, 3);
});

test("a lead reads, messages and dismisses only its own subagents, and a subagent with no lead can't report", async (t) => {
  const r = rig(t, { nudgeDelayMs: 60_000 });
  r.fake.add(worker({ id: 'other', deskId: 'desk-9', name: 'Gizmo' }));
  await r.call('lead', { action: 'hire', task: 'a' });
  r.fake.tails.set('sub1', 'line 1\nline 2');
  assert.deepEqual((await r.call('lead', { action: 'read', worker: 'PIXEL', lines: 2 })).body.text, 'line 1\nline 2');
  assert.match((await r.call('lead', { action: 'read', worker: 'Gizmo' })).body.error, /Gizmo isn't one of your subagents: yours are Pixel/);
  assert.match((await r.call('lead', { action: 'read', worker: '' })).body.error, /Name the subagent/);
  r.set('sub1', 'working');
  assert.match((await r.call('lead', { action: 'read', worker: 'sub2' })).body.error, /No subagent called sub2/);

  assert.match((await r.call('lead', { action: 'send', worker: 'Pixel' })).body.error, /on stdin/);
  assert.equal((await r.call('lead', { action: 'send', worker: 'Pixel', text: 'Use main' })).status, 200);
  assert.deepEqual(r.fake.prompts.at(-1), ['sub1', 'Use main']);
  r.set('sub1', 'needs_input', { activity: 'Bash: npm publish' });
  assert.match((await r.call('lead', { action: 'send', worker: 'Pixel', text: 'yes' })).body.error, /waiting on an answer in its own terminal \(Bash: npm publish\)/);
  r.set('sub1', 'exited');
  assert.equal((await r.call('lead', { action: 'send', worker: 'Pixel', text: 'Carry on' })).status, 200);
  assert.deepEqual(r.fake.resumed, [['sub1', 'Carry on']]);
  r.set('sub1', 'starting');
  assert.match((await r.call('lead', { action: 'send', worker: 'Pixel', text: 'hi' })).body.error, /still starting up/);

  const gone = await r.call('lead', { action: 'dismiss', worker: 'pixel' });
  assert.deepEqual(gone.body, { name: 'Pixel', note: 'Kept its worktree' });
  assert.deepEqual(r.fake.killed, ['sub1']);
  assert.match(r.toasts.at(-1)!, /👋 Nibble sent Pixel home\. Kept its worktree/);
  assert.match((await r.call('other', { action: 'report', text: 'hi' })).body.error, /no lead to report to/);
});

test('settled: given its task and not mid-turn', () => {
  const at = (status: WorkerStatus) => settled(worker({ id: 'x', deskId: 'desk-1', status }));
  assert.deepEqual((['starting', 'idle', 'working', 'needs_input', 'done', 'exited', 'offline'] as WorkerStatus[]).map(at), [false, false, false, true, true, true, true]);
});

test('a team reads as one block: each lead with its subagents under it, and a summary of how they are doing', () => {
  const at = (n: number) => 1_000 + n;
  const ws = [
    worker({ id: 'sub-b', deskId: 'desk-4', lead: 'lead', status: 'needs_input', createdAt: at(4) }),
    worker({ id: 'lone', deskId: 'desk-2', createdAt: at(2) }),
    worker({ id: 'lead', deskId: 'desk-1', status: 'working', createdAt: at(1) }),
    worker({ id: 'orphan', deskId: 'desk-5', lead: 'gone', createdAt: at(5) }),
    worker({ id: 'sub-a', deskId: 'desk-3', lead: 'lead', status: 'working', createdAt: at(3) }),
  ];
  assert.deepEqual(
    workersByTeam(ws).map((w) => w.id),
    ['lead', 'sub-a', 'sub-b', 'lone', 'orphan'],
  );
  const team = teamOf(ws, 'lead');
  assert.deepEqual(
    team.map((w) => w.id),
    ['sub-a', 'sub-b'],
  );
  assert.equal(teamSummary(team), '🧭 2 subagents · 1 working · 1 needs input');
  assert.equal(teamSummary([team[0]]), '🧭 1 subagent · 1 working');
  assert.equal(teamSummary(teamOf(ws, 'lone')), undefined);
});
