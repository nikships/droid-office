import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DroidModelCatalogue } from '../src/server/droid-models.js';
import { emptySubscriptionsState, modelUsage, type ModelAvailability } from '../src/shared/subscriptions.js';
import { modelList, outsideModelList, outsideModelListMessage } from '../src/server/model-policy.js';
import { Team, settled, type TeamOptions, type TeamWorkers } from '../src/server/team.js';
import { pickUniqueSeat } from '../src/server/floor-watch.js';
import type { DeskDef } from '../src/shared/layout.js';
import { teamOf, teamSummary, workersByTeam } from '../src/shared/team.js';
import { SUBAGENT_DEFAULTS, type AgentChoice, type SubagentSettings, type WorkerInfo, type WorkerStatus, type WorkerTask } from '../src/shared/protocol.js';

function worker(over: Partial<WorkerInfo> & { id: string; deskId: string }): WorkerInfo {
  return { kind: 'agent', name: over.id, color: '#fff', status: 'done', acked: true, createdBy: 'test', createdAt: Date.now(), cols: 100, rows: 30, open: false, ...over };
}

class Fake implements TeamWorkers {
  ws = new Map<string, WorkerInfo>();
  officeDefault: AgentChoice | undefined = undefined;
  hired: { deskId: string; by: string; prompt: string; worktree: boolean; choice: Partial<AgentChoice>; lead: string; from?: string }[] = [];
  prompts: [string, string][] = [];
  queued: string[] = [];
  notices: [string, string][] = [];
  hookDelivery = false;
  resumed: [string, string | undefined][] = [];
  killed: string[] = [];
  gone?: (id: string) => void;
  tails = new Map<string, string>();
  fetched = 0;
  starts: [string, string | undefined][] = [];
  refuse?: string;
  pickSeat?: (choose: (taken: (id: string) => boolean) => DeskDef | undefined) => DeskDef | undefined;
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
  hire(deskId: string, by: string, prompt: string, worktree: boolean, choice: Partial<AgentChoice>, lead: string, from?: string) {
    if (this.refuse) return this.refuse;
    this.hired.push({ deskId, by, prompt, worktree, choice, lead, ...(from ? { from } : {}) });
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
  prompt(id: string, text: string, queue = false) {
    this.prompts.push([id, text]);
    if (queue) this.queued.push(id);
    return undefined;
  }
  notice(id: string, text: string) {
    if (!this.hookDelivery) return false;
    this.notices.push([id, text]);
    return true;
  }
  resume(id: string, text?: string) {
    this.resumed.push([id, text]);
    return undefined;
  }
  async kill(id: string) {
    this.ws.delete(id);
    this.killed.push(id);
    this.gone?.(id);
    return { note: 'Kept its worktree' };
  }
  tail(id: string) {
    return this.tails.get(id);
  }
  setTask(id: string, task: WorkerTask) {
    const w = this.ws.get(id);
    if (w) w.task = task;
  }
  fetchStart(lead: string, from?: string) {
    this.fetched++;
    this.starts.push([lead, from]);
    return Promise.resolve();
  }
}

interface Rig {
  fake: Fake;
  team: Team;
  toasts: string[];
  settings: SubagentSettings;
  dir: string;
  /** Moves a worker to a new status, as the floor reports it. */
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

test('airgapped team catalogues do not reintroduce hosted defaults or remembered allowlists', async (t) => {
  const id = 'custom:droidproxy:gpt-6-sol';
  const r = rig(t, { models: async () => ({ customOnly: true, models: [{ id, displayName: 'GPT 6 Sol', custom: true }], defaultModel: id }) }, { models: [{ id: 'auto' }, { id }] });
  r.fake.officeDefault = { model: 'auto' };
  for (const action of ['models', 'models_list']) {
    const result = await r.call('lead', { action });
    assert.deepEqual(
      result.body.models.map((m: { id: string }) => m.id),
      [id],
    );
    assert.equal(result.body.defaultModel, undefined, 'a hosted office override is not falsely described as running a custom model');
  }
});

test('sibling board, notes and hire snapshots share concise live context without consuming lead news', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', title: 'Shared API', task: 'Change src/shared/api.ts' });
  r.set('sub1', 'working', { activity: 'Updating shared API' });
  await r.call('sub1', { action: 'report', text: 'Use the new API.', result: { status: 'ok', summary: `Use the new API. ${'detail '.repeat(200)}` } });
  await r.call('sub1', { action: 'note', text: 'API now takes an options object.', areas: ['src/shared/api.ts'] });
  await r.call('lead', { action: 'hire', title: 'Client', task: 'Update callers' });
  assert.equal(r.fake.hired[1].prompt, 'Update callers');
  const snapshot = r.team.siblingSnapshot('lead', 'sub2')!;
  assert.match(snapshot, /Siblings at hire time/);
  assert.match(snapshot, /Shared API/);
  assert.match(snapshot, /office\/sub1/);
  assert.match(snapshot, /src\/shared\/api.ts/);
  assert.match(snapshot, /API now takes an options object/);
  r.fake.add(worker({ id: 'outsider', deskId: 'desk-12', lead: 'another' }));
  r.set('sub2', 'working');
  r.fake.hookDelivery = true;
  await r.call('sub1', { action: 'note', text: 'Migration is ready.' });
  assert.deepEqual(
    r.fake.notices.map(([id]) => id),
    ['sub2'],
  );
  const board = (await r.call('sub2', { action: 'board' })).body.members;
  assert.deepEqual(
    board.map((w: { id: string }) => w.id),
    ['sub1', 'sub2'],
  );
  assert.equal(board[0].task, 'Shared API');
  assert.equal(board[0].status, 'working');
  assert.deepEqual(board[0].areas, ['src/shared/api.ts']);
  assert.equal(board[0].note.text, 'Migration is ready.');
  assert.equal(board[0].report.summary.length, 300);
  assert.equal(r.team.news('lead', { unread: true }).length, 1);
  const restored = new Team(r.fake, { dataDir: r.dir, dir: '/proj', git: true, settings: () => r.settings, toast() {} });
  t.after(() => restored.stop());
  assert.deepEqual(restored.board('lead')[0].areas, ['src/shared/api.ts']);
  assert.equal(restored.board('lead')[0].note?.text, 'Migration is ready.');
  await r.call('sub1', { action: 'note', text: 'Finished API edits.', areas: [] });
  assert.deepEqual(r.team.board('lead')[0].areas, []);
  assert.equal((await r.call('lead', { action: 'note', text: 'No' })).status, 403);
});

test('sibling board uses the existing structured result status and summary, with legacy report fallback', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'Shared API' });
  await r.call('lead', { action: 'hire', task: 'Client' });
  for (const status of ['ok', 'blocked', 'failed', 'partial'] as const) {
    const summary = `Canonical ${status} summary.`;
    await r.call('sub1', { action: 'report', text: 'Different legacy prose.', result: { status, summary } });
    const board = (await r.call('sub2', { action: 'board' })).body.members;
    assert.deepEqual(board[0].result, { status, summary });
    assert.equal(board[0].report.summary, summary);
    assert.match(r.team.siblingSnapshot('lead', 'sub2')!, new RegExp(`Latest report \\(${status}\\): Canonical ${status} summary`));
    assert.doesNotMatch(r.team.siblingSnapshot('lead', 'sub2')!, /Different legacy prose/);
  }
  await r.call('sub1', { action: 'report', text: 'Legacy report only.' });
  const latest = r.team.board('lead')[0];
  assert.deepEqual(latest.result, { status: 'ok', summary: 'Legacy report only.' }, 'new prose reports use the upstream normalization');
  assert.equal(latest.report?.summary, 'Legacy report only.');
  const statePath = path.join(r.dir, 'team.json');
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const event of saved.events) delete event.result;
  writeFileSync(statePath, JSON.stringify(saved));
  const restored = new Team(r.fake, { dataDir: r.dir, dir: '/proj', git: true, settings: () => r.settings, toast() {} });
  t.after(() => restored.stop());
  assert.equal(restored.board('lead')[0].result, undefined, 'historical reports need no invented result');
  assert.equal(restored.board('lead')[0].report?.summary, 'Legacy report only.');
});

test('sibling notes never type, queue behind a turn, revive resting sessions or prolong reported work', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'Author' });
  await r.call('lead', { action: 'hire', task: 'Receiver' });
  const text = 'Shared API\n```text\nnot an assignment\n```';
  for (const state of ['starting', 'working', 'needs_input', 'done', 'idle', 'exited'] as const) {
    for (const currentHooks of [true, false]) {
      r.set('sub2', state);
      r.fake.hookDelivery = currentHooks;
      r.fake.notices = [];
      const reply = await r.call('sub1', { action: 'note', text, areas: ['src/shared/api.ts'] });
      assert.equal(reply.status, 200);
      assert.equal(r.fake.notices.length, state === 'working' && currentHooks ? 1 : 0, `${state}, hooks=${currentHooks}`);
      assert.deepEqual(reply.body.notified, state === 'working' && currentHooks ? ['sub2'] : []);
      assert.equal(r.fake.prompts.length, 0);
      assert.equal(r.fake.resumed.length, 0);
    }
  }
  r.set('sub2', 'working');
  r.fake.hookDelivery = true;
  r.fake.notices = [];
  await r.call('sub1', { action: 'note', text });
  assert.match(r.fake.notices[0][1], /a worker, not the lead or owner/);
  assert.match(r.fake.notices[0][1], /````text\nShared API/);
  r.fake.notices = [];
  await r.call('sub2', { action: 'report', text: 'Finished.' });
  await r.call('sub1', { action: 'note', text: 'Do not wake the finished worker.' });
  assert.equal(r.fake.notices.length, 0);
  assert.equal(r.team.beforeStop(r.fake.get('sub2')!), undefined);
});

test('steering covers startup, current and legacy working hooks, reported work, menus, rest and exit', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'Worker' });
  for (const [state, hooks, expected] of [
    ['starting', true, 'error'],
    ['working', true, 'next_step'],
    ['working', false, 'sent'],
    ['needs_input', true, 'error'],
    ['done', true, 'sent'],
    ['idle', true, 'sent'],
    ['exited', true, 'resumed'],
  ] as const) {
    r.set('sub1', state);
    r.fake.hookDelivery = hooks;
    const result = await r.call('lead', { action: 'send', worker: 'Pixel', text: 'Course correction.' });
    assert.equal(result.body.delivery ?? 'error', expected, state);
    assert.equal(result.status, expected === 'error' ? 409 : 200);
  }
  r.set('sub1', 'working');
  r.fake.hookDelivery = false;
  assert.equal((await r.call('lead', { action: 'send', worker: 'Pixel', text: 'After turn.', queue: true })).body.delivery, 'queued_turn');
  await r.call('sub1', { action: 'report', text: 'Ready for follow-up.' });
  r.fake.hookDelivery = true;
  assert.equal((await r.call('lead', { action: 'send', worker: 'sub1', text: 'Revise this.' })).body.delivery, 'next_step');
});

test('broadcast deduplicates canonical ids and reports empty and entirely failed deliveries as errors', async (t) => {
  const r = rig(t);
  assert.match((await r.call('lead', { action: 'send', all: true, text: ' ' })).body.error, /Provide text/);
  assert.match((await r.call('lead', { action: 'send', all: true, text: 'Hello' })).body.error, /No subagents/);
  await r.call('lead', { action: 'hire', task: 'One' });
  r.set('sub1', 'working');
  r.fake.hookDelivery = true;
  const duplicate = await r.call('lead', { action: 'send', workers: ['Pixel', 'pixel', 'sub1', 'SUB1'], text: 'Once.' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.results.length, 1);
  assert.equal(duplicate.body.results[0].id, 'sub1');
  assert.equal(duplicate.body.results[0].name, 'Pixel');
  assert.equal(r.fake.notices.length, 1);
  r.set('sub1', 'starting');
  for (const targets of [{ all: true }, { workers: ['Pixel', 'missing'] }]) {
    const failed = await r.call('lead', { action: 'send', ...targets, text: 'Cannot deliver.' });
    assert.equal(failed.status, 409);
    assert.match(failed.body.error, /every recipient failed/);
    assert.ok(failed.body.results.every((r: { error?: string }) => r.error));
  }
});

test('note cleanup is persisted on lead dismissal and malformed notes never erase restored team news', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'One' });
  await r.call('sub1', { action: 'note', text: 'Original.', areas: ['src/shared/api.ts'] });
  r.fake.gone = (id) => r.team.onWorkerGone(id);
  await r.call('lead', { action: 'dismiss', worker: 'sub1' });
  const saved = JSON.parse(readFileSync(path.join(r.dir, 'team.json'), 'utf8'));
  assert.deepEqual(saved.notes, {});
  r.fake.add(worker({ id: 'sub1', deskId: 'desk-3', lead: 'lead' }));
  for (const notes of [null, [], 'invalid', { bad: null, worse: 1, sub1: null }, { bad: null, sub1: { text: '  Preserved.  ', at: 10, areas: [null, '', '  ', 3, ' src/api.ts ', ...Array.from({ length: 30 }, (_, i) => ` file${i} `)] } }]) {
    writeFileSync(
      path.join(r.dir, 'team.json'),
      JSON.stringify({
        seq: 77,
        statusCursors: { lead: 70 },
        notes,
        events: [
          { seq: 20, lead: 'lead', worker: 'sub1', name: 'Pixel', kind: 'report', at: 10, text: 'Kept news.' },
          { seq: 72, lead: 'lead', worker: 'sub1', name: 'Pixel', kind: 'report', at: 11, text: 'Newer news.' },
        ],
      }),
    );
    const restored = new Team(r.fake, { dataDir: r.dir, dir: '/proj', git: true, settings: () => r.settings, toast() {} });
    t.after(() => restored.stop());
    assert.equal(restored.latest(), 77);
    assert.equal(restored.news('lead')[0].text, 'Kept news.');
    const status = await restored.handle({ ...r.fake.get('lead')!, remote: true }, { action: 'status' });
    assert.deepEqual(
      (status.body.events as { seq: number }[]).map((event) => event.seq),
      [72],
      'the saved remote cursor survives malformed notes too',
    );
    const note = restored.board('lead')[0].note;
    if (note) {
      assert.equal(note.text, 'Preserved.');
      const areas = restored.board('lead')[0].areas;
      assert.equal(areas.length, 20);
      assert.equal(areas[0], 'src/api.ts');
      assert.equal(areas[1], 'file0');
    }
  }
});

test('hire snapshots cap multiline notes and the full context without changing literal tasks', async (t) => {
  const r = rig(t);
  r.settings.maxPerLead = 8;
  for (let i = 0; i < 7; i++) {
    const task = `Literal task ${i}\nwith newlines`;
    await r.call('lead', { action: 'hire', title: `Task ${i}`, task });
    assert.equal(r.fake.hired[i].prompt, task);
    await r.call(`sub${i + 1}`, { action: 'note', text: 'details\n'.repeat(120), areas: Array.from({ length: 20 }, (_, n) => `src/area-${n}`) });
  }
  const snapshot = r.team.siblingSnapshot('lead', 'not-hired-yet')!;
  assert.ok(snapshot.length < 2600);
  assert.match(snapshot, /Current context: team_board/);
  assert.doesNotMatch(snapshot, /team_note/);
  assert.doesNotMatch(snapshot, /details\ndetails/);
});

test('mid-turn steering uses existing hook notices and queued-turn fallback; broadcasts report each outcome', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'one' });
  await r.call('lead', { action: 'hire', task: 'two' });
  r.set('sub1', 'working');
  r.set('sub2', 'working');
  r.fake.hookDelivery = true;
  const message = await r.call('lead', { action: 'send', worker: 'sub1', text: 'Use the new API.' });
  assert.equal(message.body.delivery, 'next_step');
  assert.equal(r.fake.prompts.length, 0);
  assert.match(r.fake.notices[0][1], /Use the new API/);
  r.fake.hookDelivery = false;
  assert.equal((await r.call('lead', { action: 'send', worker: 'sub1', text: 'Steer immediately.' })).body.delivery, 'sent');
  assert.deepEqual(r.fake.queued, []);
  assert.equal((await r.call('lead', { action: 'send', worker: 'sub1', text: 'Keep going.', queue: true })).body.delivery, 'queued_turn');
  assert.deepEqual(r.fake.queued, ['sub1']);
  assert.equal((await r.call('lead', { action: 'send', worker: 'sub1', text: 'Normal submission.', queue: false })).body.delivery, 'sent');
  assert.deepEqual(r.fake.queued, ['sub1']);
  r.set('sub2', 'needs_input');
  const all = await r.call('lead', { action: 'send', all: true, text: 'Shared constraint.' });
  assert.equal(all.body.results[0].delivery, 'sent');
  assert.match(all.body.results[1].error, /waiting on an answer/);
  assert.equal((await r.call('lead', { action: 'send', workers: ['Pixel'], text: 'One only.' })).body.results.length, 1);
  const mixed = await r.call('lead', { action: 'send', workers: ['sub1', 'outsider'], text: 'Partial delivery.', queue: true });
  assert.equal(mixed.body.results[0].delivery, 'queued_turn');
  assert.match(mixed.body.results[1].error, /No subagent called outsider/);
  r.set('sub2', 'exited');
  assert.equal((await r.call('lead', { action: 'send', worker: 'sub2', text: 'Continue.' })).body.delivery, 'resumed');
  r.set('sub1', 'done');
  assert.equal((await r.call('lead', { action: 'send', worker: 'sub1', text: 'Next.' })).body.delivery, 'sent');
});

test('a subagent’s automatic seat prefers desks no other floor’s live worker holds, else the nearest free one', async (t) => {
  const r = rig(t);
  let everySeatElsewhere = false;
  r.fake.pickSeat = (choose) =>
    pickUniqueSeat(
      choose,
      (id) => r.fake.deskOccupied(id),
      (id) => everySeatElsewhere || id === 'desk-3',
    );
  assert.equal((await r.call('lead', { action: 'hire', task: 'a' })).status, 200);
  const first = r.fake.hired[0].deskId;
  assert.ok(first !== 'desk-3' && first !== 'desk-1', first);
  everySeatElsewhere = true;
  assert.equal((await r.call('lead', { action: 'hire', task: 'b' })).status, 200, 'every free desk held elsewhere still seats it here');
  assert.equal(r.fake.hired[1].deskId, 'desk-3');
});

test('a lead hires a subagent at the free desk nearest it, in its own worktree, on the Subagents setting', async (t) => {
  const r = rig(t, {}, { agent: { model: 'custom:droidproxy:gpt-6-sol', effort: 'high' } });
  const res = await r.call('lead', { action: 'hire', task: '  Fix the login redirect\r\nand test it  ', title: 'Fix login' });
  assert.equal(res.status, 200);
  assert.deepEqual(r.fake.hired, [{ deskId: 'desk-3', by: 'Nibble', prompt: 'Fix the login redirect\nand test it', worktree: true, choice: { model: 'custom:droidproxy:gpt-6-sol', effort: 'high' }, lead: 'lead' }]);
  assert.equal(r.fake.fetched, 1, "the branch the lead's HEAD is on is refreshed, so it isn't handed an old main");
  assert.deepEqual(r.fake.starts, [['lead', undefined]]);
  assert.deepEqual(r.fake.get('sub1')?.task, { name: 'Fix login', summary: 'Fix the login redirect and test it' });
  assert.equal(res.body.worker.name, 'Pixel');
  assert.equal(res.body.worker.desk, 'Desk 3');
  // Without a branch to name, where it started is the commit.
  assert.deepEqual(res.body.worker.worktree, { path: path.join('/proj', '.droid-office/worktrees/sub1'), branch: 'office/sub1', from: 'abc' });
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

test('a lead picks the branch its subagent starts from, and only for a worktree', async (t) => {
  const r = rig(t);
  const res = await r.call('lead', { action: 'hire', task: 'a', from: ' origin/main ' });
  assert.equal(res.status, 200);
  assert.equal(r.fake.hired[0].from, 'origin/main');
  assert.equal(r.fake.fetched, 1, 'fetched first, so origin/main is what the forge has now');
  assert.deepEqual(r.fake.starts, [['lead', 'origin/main']]);
  // Left out, it starts where the lead is: nothing is passed on, and the lead's own branch is refreshed.
  await r.call('lead', { action: 'hire', task: 'b' });
  assert.equal(r.fake.hired[1].from, undefined);
  assert.equal(r.fake.fetched, 2);
  assert.deepEqual(r.fake.starts[1], ['lead', undefined]);
  const no = async (body: Record<string, unknown>, why: RegExp) => {
    const out = await r.call('lead', { action: 'hire', task: 'x', ...body });
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.match(out.body.error, why);
  };
  await no({ from: 'main', worktree: false }, /from is where a subagent’s own worktree starts/);
  await no({ from: '--upload-pack=evil' }, /from takes a branch, tag or commit/);
  await no({ from: 'two words' }, /from takes a branch, tag or commit/);
  assert.equal(r.fake.hired.length, 2);
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

const CATALOGUE: DroidModelCatalogue = {
  models: [
    { id: 'custom:mine', displayName: 'Mine', custom: true, provider: 'generic-chat-completion-api' },
    { id: 'claude-opus-5-5', displayName: 'Opus 5.5', provider: 'anthropic', tokenMultiplier: 1.6, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'] },
    { id: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', provider: 'factory', tokenMultiplier: 0.06, noImages: true, promo: 'Half off' },
    { id: 'old', displayName: 'Old', legacy: true, tokenMultiplier: 2 },
  ],
  defaultModel: 'claude-opus-5-5',
};

test('models_list includes Droid-disabled, disabled subscription and disallowed models without changing team_models', async (t) => {
  const r = rig(t, { models: async () => ({ ...CATALOGUE, disabledModels: [{ id: 'off-model', displayName: 'Off', disabled: true }] }), availability: (id) => (id === 'custom:mine' ? { state: 'disabled', provider: 'grok' } : undefined) });
  const allowed = (await r.call('lead', { action: 'models' })).body.models;
  assert.equal(
    allowed.find((m: { id: string }) => m.id === 'old'),
    undefined,
  );
  assert.equal('enabled' in allowed[0], false);
  assert.equal(
    allowed.some((m: { id: string }) => m.id === 'off-model'),
    false,
  );
  r.settings.models = [{ id: 'custom:mine' }];
  const all = (await r.call('lead', { action: 'models_list' })).body.models;
  assert.equal(all.find((m: { id: string }) => m.id === 'custom:mine').enabled, false);
  assert.match(all.find((m: { id: string }) => m.id === 'custom:mine').cannotRun, /off/i);
  assert.equal(all.find((m: { id: string }) => m.id === 'glm-5.3-flash').enabled, false);
  assert.equal(all.find((m: { id: string }) => m.id === 'claude-opus-5-5').enabled, false, 'a default model outside the allowlist is also disallowed');
  assert.equal(all.find((m: { id: string }) => m.id === 'off-model').enabled, false);
  assert.match(all.find((m: { id: string }) => m.id === 'off-model').cannotRun, /Switched off in Droid/);
  r.settings.models = [{ id: 'custom:mine' }, { id: 'claude-opus-5-5' }];
  const withAllowedDefault = (await r.call('lead', { action: 'models_list' })).body.models;
  assert.equal(withAllowedDefault.find((m: { id: string }) => m.id === 'claude-opus-5-5').enabled, true);
});

test('team status measures idle time from state transitions and preserves it across restore', async (t) => {
  let now = 1000;
  const r = rig(t, { now: () => now });
  const hired = (await r.call('lead', { action: 'hire', task: 'ticket' })).body.worker.id;
  r.set(hired, 'done');
  now += 3_600_000;
  const status = (await r.call('lead', { action: 'status' })).body.team[0];
  assert.equal(status.idleSince, 1000);
  assert.equal(status.idleForMs, 3_600_000);
  r.fake.get(hired)!.status = 'offline';
  const restored = new Team(r.fake, { dataDir: r.dir, dir: '/proj', git: true, settings: () => r.settings, now: () => now, toast() {} });
  t.after(() => restored.stop());
  const offline = await restored.handle(r.fake.get('lead')!, { action: 'status' });
  assert.equal((offline.body.team as { idleForMs?: number }[])[0].idleForMs, undefined);
  r.fake.get(hired)!.status = 'done';
  restored.onWorker(r.fake.get(hired)!);
  const next = await restored.handle(r.fake.get('lead')!, { action: 'status' });
  assert.equal((next.body.team as { idleForMs: number }[])[0].idleForMs, 3_600_000);
  r.set(hired, 'working');
  assert.equal((await r.call('lead', { action: 'status' })).body.team[0].idleForMs, undefined);
});

test('worker logs are bounded and safe dismissal is attributed to its lead across async checks', async (t) => {
  const r = rig(t);
  const hired = (await r.call('lead', { action: 'hire', task: 'ticket' })).body.worker.id;
  r.fake.tails.set(hired, 'x'.repeat(60_000));
  const log = await r.call('lead', { action: 'log', worker: hired, tail: 400 });
  assert.equal(log.body.terminal.length, 48_000);
  assert.equal(log.body.truncated, true);
  assert.equal((await r.call('lead', { action: 'dismiss', worker: hired, pruneWorktree: true })).status, 409);
  assert.equal((await r.call('lead', { action: 'dismiss', worker: hired, pruneWorktree: false })).status, 409);
  assert.equal((await r.call('lead', { action: 'dismiss', worker: hired, keepBranch: true })).status, 409);
  assert.deepEqual(r.fake.killed, [], 'explicit retention must not fall back to a legacy kill that could prune');
  assert.ok(r.fake.get(hired), 'unavailable safe cleanup cannot fall through to legacy cleanup');
  (r.fake as TeamWorkers).dismiss = async (id, prune, keep) => {
    assert.equal(prune, true);
    assert.equal(keep, true);
    await Promise.resolve();
    return r.fake.kill(id);
  };
  assert.equal((await r.call('lead', { action: 'dismiss', worker: hired, pruneWorktree: true })).status, 200);
  assert.deepEqual((await r.call('lead', { action: 'status' })).body.events, []);
  assert.equal((await r.call('lead', { action: 'log', worker: 'missing' })).status, 404);
});

test('direct dismissal validates new cleanup flags without changing legacy dismissal', async (t) => {
  const r = rig(t);
  const hired = (await r.call('lead', { action: 'hire', task: 'ticket' })).body.worker.id;
  const calls: unknown[] = [];
  (r.fake as TeamWorkers).dismiss = async (...args) => {
    calls.push(args);
    return {};
  };
  for (const flags of [{ pruneWorktree: 'false' }, { pruneWorktree: 0 }, { keepBranch: 'true' }, { keepBranch: false }, { pruneWorktree: false, keepBranch: false }]) {
    assert.equal((await r.call('lead', { action: 'dismiss', worker: hired, ...flags })).status, 400, JSON.stringify(flags));
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(r.fake.killed, []);
  assert.equal((await r.call('lead', { action: 'dismiss', worker: hired, pruneWorktree: false })).status, 200);
  assert.equal((await r.call('lead', { action: 'dismiss', worker: hired, keepBranch: true })).status, 200);
  assert.equal((await r.call('lead', { action: 'dismiss', worker: hired, pruneWorktree: true, keepBranch: false })).status, 200);
  assert.deepEqual(calls, [
    [hired, false, true],
    [hired, false, true],
    [hired, true, false],
  ]);
  assert.equal((await r.call('lead', { action: 'dismiss', worker: hired })).status, 200);
  assert.deepEqual(r.fake.killed, [hired], 'omitting cleanup flags preserves legacy behavior');
});

test('direct diff inspection validates commit bounds and mutually exclusive revision selectors', async (t) => {
  const r = rig(t);
  const hired = (await r.call('lead', { action: 'hire', task: 'ticket' })).body.worker.id;
  for (const commits of [0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
    const result = await r.call('lead', { action: 'diff', worker: hired, commits });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /1–1000/);
  }
  assert.match((await r.call('lead', { action: 'diff', worker: hired, base: 1 })).body.error, /base takes/);
  assert.match((await r.call('lead', { action: 'diff', worker: hired, base: 'HEAD', commits: 1 })).body.error, /not both/);
});

test('direct reports validate provenance before persisting news or acknowledging a report', async (t) => {
  const r = rig(t);
  const hired = (await r.call('lead', { action: 'hire', task: 'ticket' })).body.worker.id;
  for (const fields of [{ pushedSha: 'bad' }, { pushedSha: 42 }, { pushedSha: 'a'.repeat(65) }, { prUrl: 'not a URL' }, { prUrl: 42 }, { prUrl: `https://example.com/${'x'.repeat(2000)}` }]) {
    assert.equal((await r.call(hired, { action: 'report', text: 'Done', ...fields })).status, 400);
  }
  assert.deepEqual((await r.call('lead', { action: 'status' })).body.events, []);
  const fields = { pushedSha: 'a'.repeat(40), prUrl: 'https://github.com/nikships/droid-office/pull/375' };
  const report = await r.call(hired, { action: 'report', text: 'Done', ...fields });
  assert.equal(report.status, 200);
  assert.equal(report.body.pushedSha, fields.pushedSha);
  const status = (await r.call('lead', { action: 'status' })).body;
  assert.equal(status.events[0].prUrl, fields.prUrl);
  assert.equal(status.team[0].report.pushedSha, fields.pushedSha);
});

test('models lists what a lead may pick, with credit multipliers and notes, and hire keeps to it', async (t) => {
  const r = rig(t, { models: () => Promise.resolve(CATALOGUE) });
  // Nothing picked in Settings: every current model, the legacy ones left out.
  let res = (await r.call('lead', { action: 'models' })).body;
  assert.equal(res.restricted, false);
  assert.equal(res.defaultModel, 'claude-opus-5-5');
  assert.deepEqual(res.models, [
    { id: 'custom:mine', name: 'Mine', provider: 'generic-chat-completion-api', custom: true },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', provider: 'anthropic', multiplier: 1.6, defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], default: true },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', provider: 'factory', multiplier: 0.06, noImages: true, promo: 'Half off' },
  ]);
  assert.equal((await r.call('lead', { action: 'hire', task: 'a', model: 'old' })).status, 200, 'any model goes when Settings picks none');

  // A list in Settings: only those picks, with the owner's notes; a default outside the list is not added.
  r.settings.models = [{ id: 'glm-5.3-flash', note: 'tests and docs' }, { id: 'gone' }];
  res = (await r.call('lead', { action: 'models' })).body;
  assert.equal(res.restricted, true);
  assert.equal(res.defaultModel, undefined);
  assert.deepEqual(
    res.models.map((m: Record<string, unknown>) => [m.id, m.note, m.default, m.unlisted]),
    [
      ['glm-5.3-flash', 'tests and docs', undefined, undefined],
      ['gone', undefined, undefined, true],
    ],
  );
  assert.equal((await r.call('lead', { action: 'whoami' })).body.models, 2);
  assert.equal((await r.call('lead', { action: 'hire', task: 'b', model: 'glm-5.3-flash' })).status, 200);
  const unallowedDefault = await r.call('lead', { action: 'hire', task: 'c', model: 'claude-opus-5-5' });
  assert.equal(unallowedDefault.status, 400, "droid's default is rejected when not on the allowlist");
  assert.match(unallowedDefault.body.error, /claude-opus-5-5 isn't one of the models[\s\S]*\(glm-5\.3-flash, gone\)/);
  const refused = await r.call('lead', { action: 'hire', task: 'd', model: 'old' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /old isn't one of the models this office lets subagents use[\s\S]*team_models \(glm-5\.3-flash, gone\)/);
  const omittedOutside = await r.call('lead', { action: 'hire', task: 'e', effort: 'low' });
  assert.equal(omittedOutside.status, 400, 'leaving --model out is refused when the resolved default is outside the allowlist');
  assert.match(omittedOutside.body.error, /default model \(claude-opus-5-5\) isn't on this office's allowed list[\s\S]*allowed models \(glm-5\.3-flash, gone\)/);
  r.settings.agent = { model: 'glm-5.3-flash' };
  assert.equal((await r.call('lead', { action: 'hire', task: 'e2', effort: 'low' })).status, 200, 'leaving --model out succeeds when the configured default is on the allowlist');
  assert.deepEqual(
    r.fake.hired.map((h) => h.choice.model),
    ['old', 'glm-5.3-flash', 'glm-5.3-flash'],
  );
  // Existing workers on models outside the allowlist can still be messaged.
  r.fake.get('sub1')!.model = 'old';
  r.set('sub1', 'idle');
  assert.equal((await r.call('lead', { action: 'send', worker: 'sub1', text: 'carry on' })).status, 200);
  // Only someone who may hire sees the list.
  const sub = await r.call('sub1', { action: 'models' });
  assert.equal(sub.status, 403);
  assert.match(sub.body.error, /subagents can't hire their own/);
});

test('the Orchestrator, external bots and floor leads all keep to the models leads can pick', async (t) => {
  const r = rig(t, { models: () => Promise.resolve(CATALOGUE) });
  r.fake.add(worker({ id: 'orchestrator', deskId: '', name: 'Orchestrator' }));
  r.fake.add(worker({ id: 'remote-bot', deskId: '', name: 'Bot', remote: true }));
  const models = async (caller: string) => (await r.call(caller, { action: 'models' })).body;
  // Nothing picked: all callers may hire any model, with no list to name.
  for (const caller of ['orchestrator', 'remote-bot', 'lead']) {
    assert.equal((await models(caller)).restricted, false, caller);
  }
  assert.equal((await r.call('orchestrator', { action: 'hire', task: 'a', model: 'old' })).status, 200, 'an empty list lets it hire any model');
  assert.equal((await r.call('remote-bot', { action: 'hire', task: 'a2', model: 'old' })).status, 200, 'an empty list lets an external bot hire any model');

  r.settings.models = [{ id: 'glm-5.3-flash', note: 'tests and docs' }];
  for (const caller of ['orchestrator', 'remote-bot', 'lead']) {
    const res = await models(caller);
    assert.equal(res.restricted, true, caller);
    assert.equal(res.defaultModel, undefined, caller);
    assert.deepEqual(
      res.models.map((m: Record<string, unknown>) => [m.id, m.note]),
      [['glm-5.3-flash', 'tests and docs']],
      `${caller} sees only the allowed picks with their notes`,
    );
    assert.equal((await r.call(caller, { action: 'whoami' })).body.models, 1, caller);
  }
  for (const caller of ['orchestrator', 'remote-bot']) {
    assert.equal((await r.call(caller, { action: 'hire', task: `b-${caller}`, model: 'glm-5.3-flash' })).status, 200, caller);
    const refusedDefault = await r.call(caller, { action: 'hire', task: `c-${caller}`, model: 'claude-opus-5-5' });
    assert.equal(refusedDefault.status, 400, caller);
    assert.match(refusedDefault.body.error, /claude-opus-5-5 isn't one of the models[\s\S]*\(glm-5\.3-flash\)/);
    const refused = await r.call(caller, { action: 'hire', task: `d-${caller}`, model: 'claude-sonnet-4-6' });
    assert.equal(refused.status, 400, caller);
    assert.match(refused.body.error, /claude-sonnet-4-6 isn't one of the models this office lets subagents use[\s\S]*team_models \(glm-5\.3-flash\)/);
    const omitted = await r.call(caller, { action: 'hire', task: `e-${caller}`, effort: 'low' });
    assert.equal(omitted.status, 400, caller);
    assert.match(omitted.body.error, /default model \(claude-opus-5-5\) isn't on this office's allowed list[\s\S]*\(glm-5\.3-flash\)/);
  }
  r.settings.agent = { model: 'glm-5.3-flash' };
  assert.equal((await r.call('remote-bot', { action: 'hire', task: 'f', effort: 'low' })).status, 200, 'omitting model works once the configured default is on the allowlist');

  // Neither the Orchestrator nor an external bot has a team size limit.
  r.settings.maxPerLead = 1;
  assert.equal((await r.call('orchestrator', { action: 'hire', task: 'h', model: 'glm-5.3-flash' })).status, 200);
  assert.equal((await r.call('remote-bot', { action: 'hire', task: 'i', model: 'glm-5.3-flash' })).status, 200);
});

test('a spawn through office_worker_spawn is held to the same list for leads, the Orchestrator and external bots', async (t) => {
  const OPUS = 'custom:droidproxy:opus-5-5';
  const availability: Record<string, ModelAvailability> = { [OPUS]: { state: 'signed-out', provider: 'claude' } };
  const r = rig(t, { models: () => Promise.resolve(CATALOGUE), availability: (m) => availability[m] });
  const orchestrator = r.fake.add(worker({ id: 'orchestrator', deskId: '', name: 'Orchestrator' }));
  const bot = r.fake.add(worker({ id: 'remote-bot', deskId: '', name: 'Bot', remote: true }));
  const spawn = (caller: WorkerInfo, model?: string, cloud = false) => r.team.refuseSpawnModel(caller, model, cloud);

  assert.equal(await spawn(orchestrator, 'old'), undefined, 'an empty list allows any model');
  assert.equal(await spawn(bot, 'old'), undefined, 'an empty list allows any model for an external bot');
  assert.equal(await spawn(bot), undefined, 'an empty list allows omitting model');
  r.settings.models = [{ id: 'glm-5.3-flash' }, { id: OPUS }];
  for (const caller of [orchestrator, bot]) {
    assert.equal(await spawn(caller, 'glm-5.3-flash'), undefined, `a listed model (${caller.id})`);
    assert.match((await spawn(caller, 'claude-opus-5-5'))!, /claude-opus-5-5 isn't one of the models[\s\S]*\(glm-5\.3-flash, custom:droidproxy:opus-5-5\)/);
    assert.match((await spawn(caller, 'old'))!, /old isn't one of the models this office lets subagents use[\s\S]*team_models \(glm-5\.3-flash, custom:droidproxy:opus-5-5\)/);
    assert.match((await spawn(caller))!, /default model \(claude-opus-5-5\) isn't on this office's allowed list[\s\S]*\(glm-5\.3-flash, custom:droidproxy:opus-5-5\)/);
    assert.match((await spawn(caller, '   '))!, /default model \(claude-opus-5-5\) isn't on this office's allowed list/, 'blank model is treated as omitted');
    assert.match((await spawn(caller, undefined, true))!, /No default model is on this office's allowed list[\s\S]*\(glm-5\.3-flash, custom:droidproxy:opus-5-5\)/);
    assert.match((await spawn(caller, OPUS))!, /Can't hire on .*no Claude account is connected\. Pick one that can: glm-5\.3-flash\./, 'availability is checked, and it is pointed to the list');
  }
  r.fake.officeDefault = { model: 'glm-5.3-flash' };
  assert.equal(await spawn(bot), undefined, 'omitting model succeeds when officeDefault is on the allowlist');
  assert.equal(await spawn(bot, undefined, true), undefined, 'cloud spawn omitting model succeeds when non-custom officeDefault is on the allowlist');
  r.fake.officeDefault = { model: OPUS };
  assert.match((await spawn(bot, undefined, true))!, /No default model is on this office's allowed list/, 'cloud spawn ignores custom: officeDefault');
  assert.match((await spawn(bot))!, /no Claude account is connected/, 'local spawn checks availability of the resolved default');
});

test("hire checks droid's own default against a fresh model list when model is omitted", async (t) => {
  let asks = 0;
  const r = rig(
    t,
    {
      models: () => {
        asks++;
        return Promise.resolve(CATALOGUE);
      },
    },
    { models: [{ id: 'glm-5.3-flash' }] },
  );
  assert.equal((await r.call('lead', { action: 'hire', task: 'a', model: 'glm-5.3-flash' })).status, 200);
  assert.equal(asks, 0, 'an explicit model needs no catalogue lookup');
  assert.equal((await r.call('lead', { action: 'hire', task: 'a2', model: 'claude-opus-5-5' })).status, 400, 'an explicit unallowed model needs no catalogue lookup');
  assert.equal(asks, 0);
  const omittedRejected = await r.call('lead', { action: 'hire', task: 'b' });
  assert.equal(omittedRejected.status, 400, "droid's default is checked and rejected when outside the allowlist");
  assert.equal(asks, 1);
  r.settings.models = [{ id: 'glm-5.3-flash' }, { id: 'claude-opus-5-5' }];
  assert.equal((await r.call('lead', { action: 'hire', task: 'b2' })).status, 200, "droid's default is accepted when on the allowlist");
  assert.equal(asks, 2);
  r.fake.officeDefault = { model: 'glm-5.3' };
  assert.equal((await r.call('lead', { action: 'hire', task: 'c' })).status, 400, 'with an office default, that default is checked without asking droid');
  assert.equal(asks, 2, 'and droid is not asked');
});

test("models says which subscription models can't run and why, and hire refuses them before a desk is taken", async (t) => {
  const SOL = 'custom:droidproxy:gpt-6.1-sol';
  const GROK = 'custom:droidproxy:grok-4.7';
  const OPUS = 'custom:droidproxy:opus-5-5';
  const now = Date.parse('2026-10-25T21:31:54Z');
  const catalogue: DroidModelCatalogue = {
    models: [
      { id: SOL, displayName: 'DroidProxy: GPT 6.1 Sol', custom: true },
      { id: GROK, displayName: 'DroidProxy: Grok 4.7', custom: true },
      { id: OPUS, displayName: 'DroidProxy: Opus 5.5', custom: true },
      { id: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', tokenMultiplier: 0.06 },
    ],
    defaultModel: 'glm-5.3-flash',
  };
  const availability: Record<string, ModelAvailability> = {
    [SOL]: { state: 'exhausted', until: now + 41 * 60_000, window: '5-hour' },
    [GROK]: { state: 'ok' },
    [OPUS]: { state: 'signed-out', provider: 'claude' },
  };
  const r = rig(t, { models: () => Promise.resolve(catalogue), availability: (m) => availability[m], now: () => now });
  r.fake.officeDefault = { model: SOL };
  const res = (await r.call('lead', { action: 'models' })).body;
  assert.deepEqual(
    res.models.map((m: Record<string, unknown>) => [m.id, m.default, m.cannotRun]),
    [
      [SOL, true, 'Out of quota, back in 41 min (5-hour)'],
      [GROK, undefined, undefined],
      [OPUS, undefined, 'No Claude account is connected'],
      ['glm-5.3-flash', undefined, undefined],
    ],
  );

  const named = await r.call('lead', { action: 'hire', task: 'a', model: OPUS });
  assert.equal(named.status, 409);
  assert.equal(named.body.error, `Can't hire on Opus 5.5: no Claude account is connected. Pick one that can: ${GROK}, glm-5.3-flash.`);
  const byDefault = await r.call('lead', { action: 'hire', task: 'b' });
  assert.equal(byDefault.status, 409);
  assert.match(byDefault.body.error, /^Can't hire on GPT 6.1 Sol: out of quota, back in 41 min \(5-hour\)\. It is the default subagent model, so set model in team_hire\. Pick one that can:/);
  assert.equal(r.fake.hired.length, 0, 'no desk was taken');
  assert.equal(r.fake.fetched, 0);
  assert.equal((await r.call('lead', { action: 'hire', task: 'c', model: GROK })).status, 200);

  // The Orchestrator keeps the availability check, and with a model list it is offered only the picks that can run.
  r.fake.add(worker({ id: 'orchestrator', deskId: '', name: 'Orchestrator' }));
  assert.equal((await r.call('orchestrator', { action: 'hire', task: 'o', model: OPUS })).status, 409, 'a model that cannot run is refused with no list');
  r.settings.models = [{ id: OPUS }, { id: GROK }];
  const listed = await r.call('orchestrator', { action: 'hire', task: 'p', model: OPUS });
  assert.equal(listed.status, 409);
  assert.equal(listed.body.error, `Can't hire on Opus 5.5: no Claude account is connected. Pick one that can: ${GROK}.`, 'it is pointed to the picks, not every model');
  delete r.settings.models;
  r.fake.hired.length = 0;

  // Droid's own default is judged too, and with nothing else that can run the lead is told to ask.
  r.fake.officeDefault = undefined;
  availability['glm-5.3-flash'] = { state: 'proxy-down', installed: false };
  availability[GROK] = { state: 'disabled', provider: 'grok' };
  const none = await r.call('lead', { action: 'hire', task: 'd' });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /^Can't hire on GLM-5.3-Flash: DroidProxy isn't installed\. It is the default subagent model, so set model in team_hire\. No other model a subagent may run can run now either/);
  // A stopped DroidProxy doesn't refuse: the office starts it.
  availability[GROK] = { state: 'proxy-down', installed: true };
  assert.equal((await r.call('lead', { action: 'hire', task: 'e', model: GROK })).status, 200);
});
test('team models carries the usage of a subscription model next to its refusal, and none for other models', async (t) => {
  const SOL = 'custom:droidproxy:gpt-6.1-sol';
  const GROK = 'custom:droidproxy:grok-4.7';
  const now = Date.parse('2026-11-10T12:09:00Z');
  const subs = emptySubscriptionsState();
  subs.modelProviders = { [SOL]: 'codex', [GROK]: 'grok' };
  subs.providers = [
    {
      key: 'codex',
      name: 'Codex',
      enabled: true,
      connect: 'browser',
      accounts: [
        {
          id: 'a',
          label: 'a@example.com',
          expired: false,
          disabled: false,
          usageUpdatedAt: now - 60_000,
          windows: [
            { name: '5-hour', usedPercent: 0, resetsAt: now + 296 * 60_000 },
            { name: 'Weekly', usedPercent: 39, resetsAt: now + 57 * 3_600_000 },
          ],
        },
      ],
    },
    { key: 'grok', name: 'Grok', enabled: true, connect: 'app', accounts: [{ id: 'g', label: 'g', expired: false, disabled: false, windows: [{ name: 'Weekly', usedPercent: 100, resetsAt: now + 3_600_000 }] }] },
  ];
  const availability: Record<string, ModelAvailability> = { [SOL]: { state: 'ok' }, [GROK]: { state: 'exhausted', until: now + 3_600_000, window: 'Weekly' } };
  const catalogue: DroidModelCatalogue = {
    models: [
      { id: SOL, displayName: 'DroidProxy: GPT 6.1 Sol', custom: true },
      { id: GROK, displayName: 'DroidProxy: Grok 4.7', custom: true },
      { id: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', tokenMultiplier: 0.06 },
    ],
    defaultModel: 'glm-5.3-flash',
  };
  const r = rig(t, { models: () => Promise.resolve(catalogue), availability: (m) => availability[m], usage: (m, at) => modelUsage(subs, m, at), now: () => now });
  const res = (await r.call('lead', { action: 'models' })).body;
  const by = Object.fromEntries(res.models.map((m: { id: string }) => [m.id, m]));
  assert.deepEqual(by[SOL].usage, {
    provider: 'codex',
    accounts: 1,
    windows: [
      { name: '5-hour', leftPercent: 100, resetsAt: now + 296 * 60_000 },
      { name: 'Weekly', leftPercent: 61, resetsAt: now + 57 * 3_600_000 },
    ],
    updatedAt: now - 60_000,
    at: now,
  });
  assert.equal(by[SOL].cannotRun, undefined);
  assert.equal(by[GROK].cannotRun, 'Out of quota, back in 1 h (Weekly)', 'the refusal text is unchanged');
  assert.equal(by[GROK].usage.windows[0].leftPercent, 0, 'and the plan shows how empty it is');
  assert.equal('usage' in by['glm-5.3-flash'], false, 'a model that is not a subscription has no usage');

  const all = (await r.call('lead', { action: 'models_list' })).body;
  assert.deepEqual(all.models.find((m: { id: string }) => m.id === SOL).usage, by[SOL].usage, 'models_list shares it');
});

test('models without a catalogue still names allowed picks and only marks an allowed default', async (t) => {
  const unallowedDefault = rig(t, { models: () => Promise.reject(new Error('no droid')) }, { agent: { model: 'glm-5.3' }, models: [{ id: 'glm-5.3-flash' }] });
  const res = (await unallowedDefault.call('lead', { action: 'models' })).body;
  assert.equal(res.unavailable, true);
  assert.equal(res.defaultModel, undefined);
  assert.deepEqual(res.models, [{ id: 'glm-5.3-flash', name: 'glm-5.3-flash' }]);
  const allowedDefault = rig(t, { models: () => Promise.reject(new Error('no droid')) }, { agent: { model: 'glm-5.3-flash' }, models: [{ id: 'glm-5.3-flash' }] });
  const resAllowed = (await allowedDefault.call('lead', { action: 'models' })).body;
  assert.equal(resAllowed.defaultModel, 'glm-5.3-flash');
  assert.deepEqual(resAllowed.models, [{ id: 'glm-5.3-flash', name: 'glm-5.3-flash', default: true }]);
  const bare = rig(t);
  assert.deepEqual((await bare.call('lead', { action: 'models' })).body, { restricted: false, models: [], unavailable: true });
});

test("hiring is refused when it shouldn't happen, with a reason the agent can act on", async (t) => {
  const r = rig(t, { git: false }, { maxPerLead: 1 });
  r.fake.add(worker({ id: 'shell', deskId: 'desk-8', kind: 'shell', name: 'Shell 🐚' }));
  const no = async (caller: string, body: Record<string, unknown>, status: number, why: RegExp) => {
    const res = await r.call(caller, body);
    assert.equal(res.status, status, `${caller} ${JSON.stringify(body)}`);
    assert.match(res.body.error, why);
  };
  await no('lead', { action: 'hire' }, 400, /needs a task/);
  await no('lead', { action: 'hire', task: 'x', effort: 'ludicrous' }, 400, /Effort is one of low, medium, high, xhigh, max/);
  await no('lead', { action: 'hire', task: 'x', worktree: true }, 400, /isn't a git checkout/);
  await no('shell', { action: 'hire', task: 'x' }, 403, /Only agents/);
  await no('lead', { action: 'nope' }, 400, /Unknown action/);

  // No git: no worktree, without being asked.
  assert.equal((await r.call('lead', { action: 'hire', task: 'x' })).status, 200);
  assert.equal(r.fake.hired[0].worktree, false);
  assert.equal(r.fake.fetched, 0);
  await no('lead', { action: 'hire', task: 'y' }, 409, /You have 1 subagents, the most one lead has at once/);
  await no('sub1', { action: 'hire', task: 'y' }, 403, /You're a subagent of Nibble, and subagents can't hire their own/);

  r.settings.maxPerLead = 4;
  r.fake.add(worker({ id: 'tl', deskId: 'desk-9', name: 'Independent worker' }));
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
  const list = (await r.call('lead', { action: 'status' })).body;
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
  const events = async (body: Record<string, unknown> = {}) => (await r.call('lead', { action: 'status', ...body })).body;

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

  // A turn that ends without a report is news; so is a question and stopping.
  r.set('sub2', 'working');
  r.set('sub2', 'done', { task: { name: 'B', summary: 'Tidying the tests' } });
  await r.call('sub1', { action: 'report', text: 'Which branch?', question: true });
  r.set('sub1', 'working');
  r.set('sub1', 'exited', { exitCode: 1 });
  got = await events();
  assert.deepEqual(
    got.events.map((e: any) => [e.kind, e.name, e.text]),
    [
      ['done', 'Byte', 'Tidying the tests'],
      ['question', 'Pixel', 'Which branch?'],
      ['stopped', 'Pixel', 'exit code 1'],
    ],
  );
  r.fake.ws.delete('sub2');
  r.team.onWorkerGone('sub2');
  got = await events();
  assert.deepEqual(
    got.events.map((e: any) => [e.kind, e.name, e.text]),
    [['left', 'Byte', undefined]],
  );
  assert.match((await r.call('lead', { action: 'status', worker: 'Nova' })).body.error, /No subagent called Nova: yours are Pixel/);

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
    ((await again.handle(lead, { action: 'status' })).body.events as any[]).map((e) => e.text),
    ['All done'],
  );
  await again.handle(r.fake.get('sub1')!, { action: 'report', text: 'One more thing' });
  r.fake.ws.delete('lead');
  again.onWorkerGone('lead');
  const third = new Team(r.fake, { dataDir: r.dir, dir: '/proj', git: true, settings: () => r.settings, toast() {} });
  t.after(() => third.stop());
  r.fake.add(lead);
  assert.deepEqual((await third.handle(lead, { action: 'status' })).body.events, []);
});

test('a subagent leaving creates news for its lead', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'a' });
  r.set('lead', 'done');
  r.fake.ws.delete('sub1');
  r.team.onWorkerGone('sub1');
  await sleep(40);
  assert.equal(r.fake.prompts.length, 1);
  assert.match(r.fake.prompts[0][1], /Pixel left the floor/);
  assert.deepEqual(
    (await r.call('lead', { action: 'status' })).body.events.map((e: any) => [e.kind, e.name]),
    [['left', 'Pixel']],
  );
});

test('a subagent its own lead sends home is no news to that lead', async (t) => {
  const r = rig(t);
  r.fake.gone = (id) => r.team.onWorkerGone(id);
  await r.call('lead', { action: 'hire', task: 'a' });
  r.set('lead', 'done');
  assert.equal((await r.call('lead', { action: 'dismiss', worker: 'Pixel' })).status, 200);
  await sleep(40);
  assert.equal(r.fake.prompts.length, 0);
  assert.deepEqual((await r.call('lead', { action: 'status' })).body.events, []);
});

test('a subagent the owner sends home is news to its lead, saying who sent it', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'a' });
  r.set('lead', 'done');
  r.team.sendingHome('sub1', 'owner', () => {
    r.fake.ws.delete('sub1');
    r.team.onWorkerGone('sub1');
  });
  await sleep(40);
  assert.equal(r.fake.prompts.length, 1);
  assert.match(r.fake.prompts[0][1], /Pixel was sent home by the owner\./);
  assert.deepEqual(
    (await r.call('lead', { action: 'status' })).body.events.map((e: any) => [e.kind, e.name]),
    [['sent_home', 'Pixel']],
  );
});

test('a progress report wakes the lead with news that the subagent is not finished, and its turn ending is no news', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'a' });
  r.set('sub1', 'working');
  r.set('lead', 'done');
  const sent = await r.call('sub1', { action: 'report', text: 'Rebuild running in the background', progress: true });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.progress, true);
  r.set('sub1', 'done');
  await sleep(40);
  assert.equal(r.fake.prompts.length, 1);
  assert.match(r.fake.prompts[0][1], /^Droid Office notice: team update\nPixel sent a progress report: it is not finished, and waits on its own background work to wake it\.\n/);
  const events = (await r.call('lead', { action: 'status' })).body.events;
  assert.deepEqual(
    events.map((e: any) => [e.kind, e.progress]),
    [['report', true]],
  );
  assert.equal((await r.call('sub1', { action: 'report', text: 'x', progress: 'yes' })).status, 400);
  r.team.stop();
  const again = new Team(r.fake, { dataDir: r.dir, dir: '/proj', git: true, settings: () => r.settings, toast() {} });
  t.after(() => again.stop());
  const restored = (await again.handle(r.fake.get('lead')!, { action: 'status' })).body.team as any[];
  assert.equal(restored[0].report.progress, true, 'a restart keeps the report marked as progress');
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
  assert.match(text, /^Droid Office notice: team update\nPixel reported back\. Byte finished its turn without reporting\.\n\nOffice guidance: Call `team_status`/);
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
  await r.call('lead', { action: 'status' });
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
  assert.deepEqual((await r.call('lead', { action: 'status', worker: 'PIXEL', lines: 2 })).body.team[0].terminal, 'line 1\nline 2');
  assert.match((await r.call('lead', { action: 'status', worker: 'Gizmo' })).body.error, /Gizmo isn't one of your subagents: yours are Pixel/);
  assert.match((await r.call('lead', { action: 'status', worker: '' })).body.error, /Name the subagent/);
  r.set('sub1', 'working');
  assert.match((await r.call('lead', { action: 'status', worker: 'sub2' })).body.error, /No subagent called sub2/);

  assert.match((await r.call('lead', { action: 'send', worker: 'Pixel' })).body.error, /Provide text/);
  assert.equal((await r.call('lead', { action: 'send', worker: 'Pixel', text: 'Use main' })).status, 200);
  assert.equal(r.fake.prompts.at(-1)?.[0], 'sub1');
  assert.match(r.fake.prompts.at(-1)![1], /^Droid Office delivery: message from your lead Nibble \(a worker, not the owner\)\n\n## Worker message\n```text\nUse main\n```\n\n## Office guidance/);
  r.set('sub1', 'needs_input', { activity: 'Bash: npm publish' });
  assert.match((await r.call('lead', { action: 'send', worker: 'Pixel', text: 'yes' })).body.error, /waiting on an answer in its own terminal \(Bash: npm publish\)/);
  r.set('sub1', 'exited');
  assert.equal((await r.call('lead', { action: 'send', worker: 'Pixel', text: 'Carry on' })).status, 200);
  assert.equal(r.fake.resumed[0][0], 'sub1');
  assert.match(r.fake.resumed[0][1]!, /^Droid Office delivery: message from your lead Nibble/);
  assert.match(r.fake.resumed[0][1]!, /## Worker message\n```text\nCarry on\n```\n\n## Office guidance/);
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
  assert.equal(teamSummary(team), '🧭 2 subagents · 1 working · 1 needs you');
  assert.equal(teamSummary([team[0]]), '🧭 1 subagent · 1 working');
  assert.equal(teamSummary(teamOf(ws, 'lone')), undefined);
});

test('every ordinary root worker may hire, and its subagents cannot hire nested subagents', async (t) => {
  const r = rig(t);
  r.fake.add(worker({ id: 'pipes', deskId: 'desk-8', name: 'Ordinary worker' }));
  const who = (await r.call('pipes', { action: 'whoami' })).body;
  assert.equal(who.canHire, true);
  const res = await r.call('pipes', { action: 'hire', task: 'Fix the failing lint step', title: 'Fix CI on main', from: 'origin/main' });
  assert.equal(res.status, 200);
  assert.equal(r.fake.hired[0].lead, 'pipes');
  assert.equal(r.fake.hired[0].from, 'origin/main');
  assert.ok(r.fake.hired[0].worktree);
  const nested = await r.call('sub1', { action: 'hire', task: 'nested helper' });
  assert.equal(nested.status, 403);
  assert.match(nested.body.error, /subagents can't hire their own/);
  assert.equal(r.fake.hired.length, 1);
  r.settings.on = false;
  const off = await r.call('pipes', { action: 'hire', task: 'again' });
  assert.equal(off.status, 403);
  assert.match(off.body.error, /Subagents are turned off/);
});

test("a turn about to end hears what it's missing: a subagent that hasn't reported, a lead its team's news", async (t) => {
  const r = rig(t, { nudgeDelayMs: 60_000 });
  await r.call('lead', { action: 'hire', task: 'a' });
  r.set('sub1', 'working');
  const sub = () => r.fake.get('sub1')!;
  const lead = () => r.fake.get('lead')!;
  assert.match(r.team.beforeStop(sub()) ?? '', /^Droid Office notice: report to your lead\nYour turn is ending without a report to Nibble\. Call `team_report`/);
  assert.equal(r.team.beforeStop(lead()), undefined, 'no news yet');
  await r.call('sub1', { action: 'report', text: 'Which branch?', question: true });
  assert.equal(r.team.beforeStop(sub()), undefined, 'a question counts as speaking up');
  // The lead is mid-turn: its Stop carries the news, so it isn't woken for it again.
  r.set('lead', 'working');
  assert.match(r.team.beforeStop(lead()) ?? '', /^Droid Office notice: team update\nPixel asked you a question\./);
  assert.equal(r.team.beforeStop(lead()), undefined, 'told once');
  r.set('lead', 'done');
  r.set('sub1', 'done');
  r.set('sub1', 'working');
  assert.ok(r.team.beforeStop(sub()), 'a new turn needs a new report');
  await r.call('sub1', { action: 'report', text: 'First task done' });
  assert.equal(r.team.beforeStop(sub()), undefined);
  // A message queued behind the turn starts the next one without coming to rest.
  r.team.nextTurn('sub1');
  assert.ok(r.team.beforeStop(sub()), 'a queued turn needs its own report');
  r.settings.officeMcp = false;
  assert.equal(r.team.beforeStop(sub()), undefined, 'with the Office MCP off there is no tool to report with');
  r.settings.officeMcp = true;
  r.settings.wakeLead = false;
  await r.call('sub1', { action: 'report', text: 'Done' });
  assert.equal(r.team.beforeStop(lead()), undefined, 'with waking off, the lead checks for itself');
});

test('the model list limits all Office MCP callers, including external bots, unless empty', () => {
  const list = [{ id: 'a' }, { id: 'b', note: 'cheap' }];
  assert.deepEqual(modelList({ models: list }), list);
  assert.equal(modelList({ models: [] }), undefined);
  assert.equal(modelList({}), undefined);
  assert.equal(outsideModelList(list, 'b'), false);
  assert.equal(outsideModelList(list, 'd'), true, 'an unlisted model is rejected even if it was a default');
  assert.equal(outsideModelList(list, undefined), true, 'an unresolved default is outside a non-empty allowlist');
  assert.equal(outsideModelList(undefined, 'c'), false);
  assert.equal(outsideModelList(undefined, undefined), false);
  assert.match(outsideModelListMessage('claude-sonnet-4-6', list), /claude-sonnet-4-6 isn't one of the models[\s\S]*\(a, b\)/);
  assert.match(outsideModelListMessage('claude-opus-5-5', list, false), /The default model \(claude-opus-5-5\) isn't on this office's allowed list[\s\S]*\(a, b\)/);
  assert.match(outsideModelListMessage(undefined, list, false), /No default model is on this office's allowed list[\s\S]*\(a, b\)/);
});

test('structured WorkerResult inference, explicit fields, persistence and team_review round-trip cleanly', async (t) => {
  let now = 10_000;
  const r = rig(t, { now: () => now, nudgeDelayMs: 60_000 });
  const sub = (await r.call('lead', { action: 'hire', task: 'Implement feature' })).body.worker.id;
  r.set(sub, 'working');

  // Cannot review before any report exists.
  assert.equal((await r.call('lead', { action: 'review', worker: sub, verdict: 'approve', notes: 'LGTM' })).status, 409);

  // Question infers blocked, progress infers partial, plain report infers ok + provenance artifacts.
  const asked = await r.call(sub, { action: 'report', text: 'Which schema?', question: true });
  assert.deepEqual(asked.body.result, { status: 'blocked', summary: 'Which schema?' });

  const prog = await r.call(sub, { action: 'report', text: 'Running CI suite', progress: true });
  assert.deepEqual(prog.body.result, { status: 'partial', summary: 'Running CI suite' });

  // Regression: when w.pr is linked to an older PR (#409), reporting a newer PR URL (#410 / #411)
  // via top-level prUrl or result.artifacts.prUrl without explicit prNumber must infer from the
  // reported URL, never copy the stale w.pr.number.
  r.set(sub, 'working', { pr: { number: 409, url: 'https://github.com/nikships/droid-office/pull/409' } });
  const fromTopPrUrl = await r.call(sub, { action: 'report', text: 'Opened replacement PR', prUrl: 'https://github.com/nikships/droid-office/pull/410' });
  assert.deepEqual(fromTopPrUrl.body.result.artifacts, { prUrl: 'https://github.com/nikships/droid-office/pull/410', prNumber: 410 });
  assert.equal((await r.call('lead', { action: 'status' })).body.team[0].report.result.artifacts.prNumber, 410);

  const fromArtifactPrUrl = await r.call(sub, {
    action: 'report',
    text: 'Opened follow-up PR',
    result: { status: 'ok', summary: 'Follow-up ready', artifacts: { prUrl: 'https://github.com/nikships/droid-office/pull/411' } },
  });
  assert.deepEqual(fromArtifactPrUrl.body.result.artifacts, { prUrl: 'https://github.com/nikships/droid-office/pull/411', prNumber: 411 });

  const fromOpaqueUrl = await r.call(sub, { action: 'report', text: 'Custom review link', prUrl: 'https://reviews.example.com/change/abc' });
  assert.deepEqual(fromOpaqueUrl.body.result.artifacts, { prUrl: 'https://reviews.example.com/change/abc' });
  r.set(sub, 'working', { pr: undefined });

  const sha = 'b'.repeat(40);
  const prUrl = 'https://github.com/nikships/droid-office/pull/412';
  const inferred = await r.call(sub, { action: 'report', text: `Shipped ${prUrl}`, pushedSha: sha });
  assert.deepEqual(inferred.body.result, {
    status: 'ok',
    summary: `Shipped ${prUrl}`,
    artifacts: { prUrl, prNumber: 412, commits: [sha] },
  });

  // Invalid explicit result shapes are rejected before mutating state.
  for (const bad of [
    null,
    'ok',
    { status: 'great', summary: 'x' },
    { status: 'ok', summary: '   ' },
    { status: 'ok', summary: 'x', artifacts: { prNumber: 0 } },
    { status: 'ok', summary: 'x', artifacts: { mergeCommit: 'xyz' } },
    { status: 'ok', summary: 'x', remaining: [''] },
    { status: 'ok', summary: 'x', conflicts: [{}] },
  ]) {
    assert.equal((await r.call(sub, { action: 'report', text: 'bad', result: bad })).status, 400);
  }

  // Explicit structured result with conflicts and remaining items.
  const explicitResult = {
    status: 'partial' as const,
    summary: 'Implemented handlers; rebase conflict remains',
    artifacts: { prUrl, prNumber: 412, mergeCommit: 'abcdef1234567', commits: [sha], files: ['src/server/team.ts', 'tests/team.test.ts'] },
    remaining: ['Resolve conflict in prompts.ts'],
    conflicts: [{ path: 'src/shared/prompts.ts', hunks: [{ header: '@@ -600,4 +600,4 @@', ours: 'inspect diff', theirs: 'team_review' }] }],
  };
  now = 20_000;
  const reported = await r.call(sub, { action: 'report', text: 'Needs conflict resolution', result: explicitResult });
  assert.equal(reported.status, 200);
  assert.deepEqual(reported.body.result, explicitResult);
  r.set(sub, 'done');

  // Review validation.
  for (const bad of [
    { worker: sub, verdict: 'lgtm', notes: 'ok' },
    { worker: sub, verdict: 'approve', notes: '   ' },
    { worker: sub, verdict: 'approve', notes: 'ok', notify: 'yes' },
    { worker: 'missing', verdict: 'approve', notes: 'ok' },
  ]) {
    assert.ok((await r.call('lead', { action: 'review', ...bad })).status >= 400);
  }

  // request_changes records review on latest report AND sends notes to subagent by default.
  now = 30_000;
  const changes = await r.call('lead', { action: 'review', worker: 'Pixel', verdict: 'request_changes', notes: 'Resolve prompts.ts hunk and add test.' });
  assert.equal(changes.status, 200);
  assert.equal(changes.body.notified, true);
  assert.deepEqual(changes.body.review, { verdict: 'request_changes', notes: 'Resolve prompts.ts hunk and add test.', by: 'Nibble', at: 30_000 });
  assert.equal(changes.body.worker.report.review.verdict, 'request_changes');
  assert.match(r.fake.prompts.at(-1)![1], /Review verdict: request_changes\n\nResolve prompts\.ts hunk and add test\./);

  // Worker fixes and sends a fresh report: the new latest report is unreviewed until approved.
  r.set(sub, 'working');
  now = 40_000;
  await r.call(sub, {
    action: 'report',
    text: 'Resolved conflict and verified tests.',
    result: { status: 'ok', summary: 'Conflict resolved and tests green', artifacts: { prUrl, prNumber: 412, files: ['src/server/team.ts'] } },
  });
  r.set(sub, 'done');
  const beforeApprove = (await r.call('lead', { action: 'status' })).body.team[0];
  assert.equal(beforeApprove.report.result.status, 'ok');
  assert.equal(beforeApprove.report.review, undefined);

  const promptCount = r.fake.prompts.length;
  now = 50_000;
  const approved = await r.call('lead', { action: 'review', worker: 'Pixel', verdict: 'approve', notes: 'Diff verified, ready to merge.' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.notified, false, 'approve does not wake a resting worker');
  assert.equal(r.fake.prompts.length, promptCount);
  assert.equal(approved.body.worker.report.review.verdict, 'approve');

  // Survives restart via team.json.
  r.team.stop();
  const restarted = new Team(r.fake, { dataDir: r.dir, dir: '/proj', git: true, settings: () => r.settings, toast() {}, now: () => now });
  t.after(() => restarted.stop());
  const restored = (await restarted.handle(r.fake.get('lead')!, { action: 'status' })).body.team[0];
  assert.equal(restored.report.result.summary, 'Conflict resolved and tests green');
  assert.deepEqual(restored.report.review, { verdict: 'approve', notes: 'Diff verified, ready to merge.', by: 'Nibble', at: 50_000 });
});
