import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GeminiDecisionsStore, type DecisionAnswer } from '../src/server/gemini-decisions.js';
import { Team, type TeamOptions, type TeamWorkers } from '../src/server/team.js';
import {
  asksForAction,
  BLOCK_CHATTER_MIN,
  BLOCK_TRAFFIC_MIN,
  buildWakeRequest,
  coachText,
  pullRequestsOf,
  resolveWakeAnswers,
  siblingAddressed,
  substanceSignals,
  WakeFilter,
  wakeGuard,
  type WakeGate,
  type WakePacket,
  type WakeVerdict,
} from '../src/server/wake-filter.js';
import { emptyGeminiState, emptyWakeFilterTelemetry } from '../src/shared/gemini-vibes.js';
import { SUBAGENT_DEFAULTS, type AgentChoice, type WorkerInfo, type WorkerStatus, type WorkerTask } from '../src/shared/protocol.js';

const KEY = 'AIzaSyWakeFilterTestKey000000000000000';

function packet(over: Omit<Partial<WakePacket>, 'message'> & { message?: Partial<WakePacket['message']> } = {}): WakePacket {
  const { message, ...rest } = over;
  return {
    channel: 'team_report',
    lead: { id: 'lead', name: 'Orchestrator', building: true, status: 'done', task: 'Ship Pick 02', steps: [{ content: 'Merge every branch together', status: 'in_progress' }], tail: 'Waiting on Byte.' },
    sender: { id: 'sub1', name: 'Pixel', task: 'Wake filter' },
    teammates: [{ id: 'sub2', name: 'Byte', status: 'working', task: 'Settings UI', areas: ['src/client/ui/gemini-settings.ts'] }],
    ...rest,
    message: { text: 'Done.', ...message },
  };
}

const choice = (c: string, probabilities: Record<string, number>): DecisionAnswer => ({ type: 'choice', choice: c, confidence: probabilities[c] ?? 0, probabilities });
const noul = (v: number): DecisionAnswer => ({ type: 'noul', noul: v, confidence: Math.max(v, 1 - v) });
const probs = (wake: number, hold: number, silent: number, block: number) => ({ wake_immediately: wake, hold_for_batch: hold, record_silently: silent, block_and_coach: block });

test('guardrails force wakes for questions, failures, asks and the last teammate, and rule out blocking anything concrete', () => {
  assert.equal(wakeGuard(packet({ message: { question: true } })).forced, 'wake_immediately');
  assert.equal(wakeGuard(packet({ message: { resultStatus: 'failed' } })).reason, 'result failed');
  assert.equal(wakeGuard(packet({ message: { conflicts: 2 } })).reason, 'merge conflicts');
  assert.equal(wakeGuard(packet({ channel: 'lead_notify', message: { kind: 'blocker' } })).reason, 'kind blocker');
  assert.equal(wakeGuard(packet({ message: { text: 'Ready for your merge whenever.' } })).reason, 'asks for action');
  // A mid-turn update announcing a new pull request wakes; repeating an announced one does not.
  const pr = 'https://github.com/nikships/droid-office/pull/432';
  assert.equal(wakeGuard(packet({ channel: 'lead_notify', message: { kind: 'update', text: `Opened promote-fix PR #432 (${pr})` } })).reason, 'new pull request');
  assert.equal(wakeGuard(packet({ message: { progress: true, text: 'CI running', prUrl: pr } })).reason, 'new pull request');
  assert.equal(wakeGuard(packet({ message: { progress: true, text: `Still on ${pr}`, previousPrs: [pr] } })).forced, undefined);
  assert.deepEqual(pullRequestsOf({ text: `${pr} and ${pr}`, prUrl: pr }), [pr]);
  assert.equal(wakeGuard(packet({ teammates: [{ id: 'sub2', name: 'Byte', status: 'done' }] })).reason, 'last active teammate finished');
  // A progress report is not the batch finishing.
  assert.equal(wakeGuard(packet({ teammates: [], message: { progress: true } })).forced, undefined);
  // Visits never force on the tell itself; they only decide whether blocking is allowed.
  assert.equal(wakeGuard(packet({ channel: 'visit_tell', teammates: [], message: { kind: 'tell', text: 'can you look?' } })).forced, undefined);

  const chatter = wakeGuard(packet({ channel: 'team_note', message: { text: 'Still chugging along, feeling great!' } }));
  assert.equal(chatter.blockable, true);
  assert.deepEqual(chatter.noBlock, []);
  for (const text of ['Renamed buildWakeRequest in src/server/wake-filter.ts', '12 tests passed', 'Conflict with Byte', 'see #440', 'commit 7e3eb74f', 'Is this ok?', 'See https://x.dev', '`npm test`']) {
    assert.equal(wakeGuard(packet({ channel: 'team_note', message: { text } })).blockable, false, text);
  }
  assert.equal(wakeGuard(packet({ channel: 'team_note', message: { text: 'ok', areasChanged: true } })).blockable, false);
  assert.equal(wakeGuard(packet({ channel: 'team_note', message: { text: 'ok', pushedSha: 'abc1234', previousSha: 'abc1234' } })).blockable, true);
  assert.equal(wakeGuard(packet({ channel: 'team_note', message: { text: 'ok', pushedSha: 'abc1235', previousSha: 'abc1234' } })).blockable, false);
  assert.equal(wakeGuard(packet({ channel: 'team_note', message: { text: 'x'.repeat(601) } })).blockable, false);
  assert.ok(wakeGuard(packet({ message: { text: 'ok' } })).noBlock.includes('team_report always records'));
  assert.ok(wakeGuard(packet({ channel: 'lead_notify', message: { text: 'ok', kind: 'question' } })).noBlock.includes('lead_notify beyond update'));
  assert.ok(wakeGuard(packet({ channel: 'visit_tell', message: { text: 'ok', kind: 'ask' } })).noBlock.includes('visit beyond tell'));

  assert.equal(asksForAction('Need your decision on the schema'), true);
  assert.equal(asksForAction('Should I keep going?'), true);
  assert.equal(asksForAction('Phase one done, starting phase two'), false);
  assert.deepEqual(substanceSignals('All good here'), []);
});

test('the request carries the lead plan, team board, sender chatter and scrubbed message with one noul per sibling', () => {
  const p = packet({
    channel: 'team_note',
    siblings: [
      { id: 'sub2', name: 'Byte', status: 'working', task: 'Settings UI', areas: ['src/client/ui/gemini-settings.ts'] },
      { id: 'sub3', name: 'Dot', status: 'working' },
    ],
    teammates: [
      { id: 'sub2', name: 'Byte', status: 'working', task: 'Settings UI' },
      { id: 'sub3', name: 'Dot', status: 'working', report: { kind: 'report', summary: 'Docs ready', status: 'ok' } },
      { id: 'sub4', name: 'Echo', status: 'done', floor: 'Android' },
    ],
    message: { text: `Token ${KEY} leaked in a log, rotated it.`, areas: ['src/server/wake-filter.ts'], areasChanged: true },
  });
  const { input, questions, siblingKeys } = buildWakeRequest(p, { routine: 3, total: 4, sinceLastMs: 42_000 }, [KEY]);
  assert.doesNotMatch(input, /AIzaSy/);
  assert.match(input, /\[redacted\]/);
  assert.match(input, /\[in_progress\] Merge every branch together/);
  assert.match(input, /3 other teammates, 2 actively mid-turn, 1 settled/);
  assert.match(input, /Echo \(floor Android\)/);
  assert.match(input, /latest report \(ok\): Docs ready/);
  assert.match(input, /3 routine updates in the last 5 minutes .*previous update 42s ago/);
  assert.match(input, /new areas src\/server\/wake-filter.ts/);
  assert.deepEqual(Object.keys(questions), ['traffic', 'pure_chatter', 'sib_0', 'sib_1']);
  assert.equal(questions.traffic?.type, 'choice');
  assert.deepEqual(
    siblingKeys.map(([k, s]) => [k, s.id]),
    [
      ['sib_0', 'sub2'],
      ['sib_1', 'sub3'],
    ],
  );
  assert.match(questions.sib_0!.instructions, /Settings UI.*gemini-settings\.ts/);

  const huge = buildWakeRequest(
    packet({ teammates: Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, status: 'working', task: 'x'.repeat(500) })), lead: { id: 'l', name: 'L', tail: 'y\n'.repeat(5000) }, message: { text: 'z'.repeat(9000) } }),
    { routine: 0, total: 0 },
  );
  assert.ok(huge.input.length <= 14_000);
  assert.match(huge.input, /26 more not shown/);
  assert.match(huge.input, /no earlier update/);
  assert.equal(Object.keys(huge.questions).length, 2);
});

test('only two agreeing high-confidence chatter answers on a blockable message block it; unsure quiet routes wake', () => {
  const note = packet({ channel: 'team_note', siblings: [], message: { text: 'Still chugging along, feeling great!' } });
  const g = wakeGuard(note);
  const block = (traffic: number, chatter: number) => resolveWakeAnswers(note, g, { traffic: choice('block_and_coach', probs(0.02, 0, 1 - traffic - 0.02, traffic)), pure_chatter: noul(chatter) });
  const locked = block(BLOCK_TRAFFIC_MIN, BLOCK_CHATTER_MIN);
  assert.equal(locked.traffic, 'block_and_coach');
  assert.match(locked.coach!, /Noise gate: .*your siblings/);
  assert.deepEqual(locked.notify, []);
  assert.equal(block(BLOCK_TRAFFIC_MIN - 0.01, 0.99).traffic, 'record_silently');
  assert.equal(block(0.97, BLOCK_CHATTER_MIN - 0.01).traffic, 'record_silently');
  // A concrete message never blocks, however sure the model is.
  const concrete = packet({ channel: 'team_note', siblings: [], message: { text: '3 tests passed' } });
  assert.equal(resolveWakeAnswers(concrete, wakeGuard(concrete), { traffic: choice('block_and_coach', probs(0, 0, 0.01, 0.99)), pure_chatter: noul(0.99) }).traffic, 'record_silently');
  // Below the quiet floor the message wakes.
  assert.equal(resolveWakeAnswers(note, g, { traffic: choice('record_silently', probs(0.45, 0.1, 0.45, 0)) }).traffic, 'wake_immediately');
  assert.equal(resolveWakeAnswers(note, g, {}).traffic, 'wake_immediately');
  assert.equal(resolveWakeAnswers(note, g, { traffic: choice('nonsense', { nonsense: 1 }) }).reason, 'no traffic answer');

  const report = packet();
  const rg = wakeGuard(report);
  assert.equal(resolveWakeAnswers(report, rg, { traffic: choice('hold_for_batch', probs(0.2, 0.8, 0, 0)) }).traffic, 'hold_for_batch');
  // A finished teammate is never just recorded: with others still running it is held for the batch.
  assert.equal(resolveWakeAnswers(report, rg, { traffic: choice('record_silently', probs(0.1, 0.1, 0.8, 0)) }).traffic, 'hold_for_batch');
  const done = packet({ channel: 'done' });
  assert.equal(resolveWakeAnswers(done, wakeGuard(done), { traffic: choice('block_and_coach', probs(0, 0, 0.1, 0.9)), pure_chatter: noul(0.99) }).traffic, 'hold_for_batch');
  const progress = packet({ message: { progress: true } });
  assert.equal(resolveWakeAnswers(progress, wakeGuard(progress), { traffic: choice('record_silently', probs(0.1, 0, 0.9, 0)) }).traffic, 'record_silently');
  // Waiting on its own job while others work, a progress report may ride along with the batch.
  assert.equal(resolveWakeAnswers(progress, wakeGuard(progress), { traffic: choice('hold_for_batch', probs(0.1, 0.9, 0, 0)) }).traffic, 'hold_for_batch');
  const notify = packet({ channel: 'lead_notify', message: { kind: 'update' } });
  assert.equal(resolveWakeAnswers(notify, wakeGuard(notify), { traffic: choice('hold_for_batch', probs(0.1, 0.9, 0, 0)) }).traffic, 'record_silently');
  // A held note is relevant to someone: it reaches siblings now.
  assert.equal(resolveWakeAnswers(note, g, { traffic: choice('hold_for_batch', probs(0.1, 0.9, 0, 0)) }).traffic, 'wake_immediately');
  const forced = packet({ message: { question: true } });
  const fv = resolveWakeAnswers(forced, wakeGuard(forced), { traffic: choice('record_silently', probs(0, 0, 1, 0)) });
  assert.equal(fv.traffic, 'wake_immediately');
  assert.equal(fv.source, 'guard');
});

test('team_note reaches only siblings it is relevant to, by model score or by naming them, their areas or an overlap', () => {
  const siblings = [
    { id: 'sub2', name: 'Byte', status: 'working', areas: ['src/client/ui/'] },
    { id: 'sub3', name: 'Dot', status: 'working', areas: ['docs/office-mcp.md'] },
    { id: 'sub4', name: 'Echo 🐚', status: 'working' },
  ];
  const note = (text: string, areas?: string[]) => packet({ channel: 'team_note', siblings, teammates: siblings, message: { text, ...(areas ? { areas } : {}) } });
  assert.equal(siblingAddressed(note('heads up echo, the API moved'), siblings[2]!), true);
  assert.equal(siblingAddressed(note('updated docs/office-mcp.md'), siblings[1]!), true);
  assert.equal(siblingAddressed(note('mine', ['src/client/ui/gemini-settings.ts']), siblings[0]!), true);
  assert.equal(siblingAddressed(note('bytes are fun'), siblings[0]!), false);

  const p = note('WakePacket gained a siblings field', ['src/server/wake-filter.ts']);
  const keys = siblings.map((s, i) => [`sib_${i}`, s] as [string, (typeof siblings)[number]]);
  const wake = resolveWakeAnswers(p, wakeGuard(p), { traffic: choice('wake_immediately', probs(0.9, 0, 0.1, 0)), sib_0: noul(0.72), sib_1: noul(0.2), sib_2: noul(0.59) }, keys);
  assert.deepEqual(wake.notify, ['sub2']);
  // Missing per-sibling answers fail open for that sibling.
  assert.deepEqual(resolveWakeAnswers(p, wakeGuard(p), { traffic: choice('wake_immediately', probs(1, 0, 0, 0)) }, keys).notify, ['sub2', 'sub3', 'sub4']);
  const silent = note('Dot: docs/office-mcp.md moved its anchors around');
  assert.deepEqual(resolveWakeAnswers(silent, wakeGuard(silent), { traffic: choice('record_silently', probs(0.1, 0, 0.9, 0)) }, keys).notify, ['sub3']);
  assert.match(coachText(packet()), /not delivered to Orchestrator/);
});

const capture = (answers: Record<string, DecisionAnswer>, tokens = 915) =>
  new Response(JSON.stringify({ answers, usage: { total_input_tokens: tokens, total_output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });

function filterRig(
  over: { on?: boolean; connected?: boolean; rejected?: string; airgapped?: boolean } = {},
  respond: (body: { input: string; questions: Record<string, unknown> }, init: RequestInit) => Promise<Response> | Response = () => capture({}),
) {
  const state = {
    on: over.on ?? true,
    connected: over.connected ?? true,
    rejected: over.rejected,
    airgapped: over.airgapped ?? false,
    calls: 0,
    bodies: [] as { input: string; questions: Record<string, unknown> }[],
    usage: [] as [number, number][],
    changes: 0,
    decisions: 0,
  };
  let clock = 1_000_000;
  const filter = new WakeFilter({
    store: { apiKey: () => (state.connected ? KEY : undefined), connected: () => state.connected, wakeFilterOn: () => state.on, rejected: () => state.rejected },
    airgapped: () => state.airgapped,
    now: () => (clock += 25),
    timeoutMs: 40,
    fetchImpl: async (url, init) => {
      state.calls++;
      assert.match(String(url), /\/v1beta\/decisions/);
      const body = JSON.parse(String(init?.body)) as { input: string; questions: Record<string, unknown> };
      state.bodies.push(body);
      return respond(body, init!);
    },
    onUsage: (tokens, ms) => state.usage.push([tokens, ms]),
    onChange: () => state.changes++,
    onDecision: () => state.decisions++,
  });
  return { filter, state };
}

test('WakeFilter is off when disabled, disconnected, rejected or airgapped, and delivers as before', async () => {
  for (const over of [{ on: false }, { connected: false }, { rejected: 'bad key' }, { airgapped: true }]) {
    const { filter, state } = filterRig(over);
    assert.equal(filter.active(), false);
    const v = await filter.decide(packet());
    assert.equal(v.traffic, 'wake_immediately');
    assert.equal(v.source, 'bypass');
    assert.equal(state.calls, 0);
  }
  assert.deepEqual(emptyGeminiState().wakeFilter, emptyWakeFilterTelemetry());
  assert.equal(emptyGeminiState().wakeFilterOn, true);
});

test('WakeFilter routes in one call, counts telemetry, tracks chatter and pushed heads, and never sends the key in the body', async () => {
  const { filter, state } = filterRig({}, (body) =>
    body.questions.sib_0
      ? capture({ traffic: choice('block_and_coach', probs(0.01, 0, 0.04, 0.95)), pure_chatter: noul(0.97), sib_0: noul(0.05) }, 1200)
      : capture({ pure_chatter: { type: 'noul', noul: 0.01, confidence: 0.99 }, traffic: choice('record_silently', probs(0.12, 0.01, 0.87, 0)) }),
  );
  assert.equal(filter.active(), true);
  const first = await filter.decide(packet({ message: { text: 'Phase one green, starting phase two', progress: true, pushedSha: 'aaaaaaa1111' } }));
  assert.equal(first.traffic, 'record_silently');
  assert.equal(first.source, 'model');
  assert.equal(first.inputTokens, 915);
  assert.equal(first.latencyMs, 25);
  assert.deepEqual(state.usage, [[915, 25]]);
  assert.equal(JSON.stringify(state.bodies[0]).includes(KEY), false);

  const second = await filter.decide(packet({ message: { text: 'Phase two going', progress: true, pushedSha: 'aaaaaaa1111' } }));
  assert.equal(second.traffic, 'record_silently');
  assert.match(state.bodies[1]!.input, /unchanged since its last message/);
  // The first push was a new commit, so it does not count as chatter; the unchanged head does.
  assert.match(state.bodies[1]!.input, /0 routine updates in the last 5 minutes .*\(1 messages total\)/);
  assert.equal(filter.previousSha('sub1'), 'aaaaaaa1111');
  assert.deepEqual({ ...filter.chatterOf('sub1'), sinceLastMs: undefined }, { routine: 1, total: 2, sinceLastMs: undefined });

  const sibling = { id: 'sub2', name: 'Byte', status: 'working' };
  const blocked = await filter.decide(packet({ channel: 'team_note', siblings: [sibling], teammates: [sibling], message: { text: 'Still chugging along, feeling great!' } }));
  assert.equal(blocked.traffic, 'block_and_coach');
  assert.deepEqual(blocked.notify, []);

  const forced = await filter.decide(packet({ message: { question: true } }));
  assert.equal(forced.source, 'guard');
  assert.equal(state.calls, 3);
  const pr = 'https://github.com/nikships/droid-office/pull/440';
  assert.equal((await filter.decide(packet({ channel: 'lead_notify', message: { kind: 'update', text: `Opened ${pr}` } }))).reason, 'guard: new pull request');
  assert.equal(state.calls, 3);
  await filter.decide(packet({ channel: 'lead_notify', message: { kind: 'update', text: `CI still running on ${pr}` } }));
  assert.equal(state.calls, 4, 'an announced PR goes to the model');
  const t = filter.telemetry();
  assert.deepEqual([t.evaluated, t.woken, t.held, t.silent, t.blocked, t.siblingFiltered, t.failedOpen, t.lastLatencyMs], [6, 2, 0, 3, 1, 1, 0, 25]);
  assert.equal(state.decisions, 6);
  assert.ok(state.changes >= 4);
});

test('WakeFilter fails open on HTTP errors, network failures, timeouts and safety blocks', async () => {
  const cases: [string, (body: unknown, init: RequestInit) => Promise<Response> | Response][] = [
    ['http', () => new Response(JSON.stringify({ error: { message: `quota for ${KEY}` } }), { status: 503 })],
    ['network', () => Promise.reject(new Error(`connect ECONNREFUSED ${KEY}`))],
    ['timeout', (_b, init) => new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))],
    ['blocked', () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 })],
  ];
  for (const [name, respond] of cases) {
    const { filter, state } = filterRig({}, respond);
    const v = await filter.decide(packet({ message: { progress: true } }));
    assert.equal(v.traffic, 'wake_immediately', name);
    assert.equal(v.source, 'fail_open', name);
    assert.equal(v.reason.includes(KEY), false, name);
    assert.equal(filter.telemetry().failedOpen, 1, name);
    assert.equal(filter.telemetry().evaluated, 0, name);
    assert.equal(state.decisions, 1, name);
  }
});

test('the wake filter setting persists in gemini.json and defaults on', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'droid-office-wake-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new GeminiDecisionsStore(dir);
  assert.equal(store.wakeFilterOn(), true);
  assert.equal(store.setWakeFilterOn(true), undefined);
  assert.equal(store.setWakeFilterOn(false), undefined);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'gemini.json'), 'utf8')).wakeFilterOn, false);
  assert.equal(new GeminiDecisionsStore(dir).wakeFilterOn(), false);
  assert.equal(store.vibesOn(), true);
});

// --- Team integration ---

function worker(over: Partial<WorkerInfo> & { id: string; deskId: string }): WorkerInfo {
  return { kind: 'agent', name: over.id, color: '#fff', status: 'done', acked: true, createdBy: 'test', createdAt: Date.now(), cols: 100, rows: 30, open: false, ...over };
}

class Fake implements TeamWorkers {
  ws = new Map<string, WorkerInfo>();
  officeDefault: AgentChoice | undefined = undefined;
  prompts: [string, string][] = [];
  notices: [string, string][] = [];
  hookDelivery = true;
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
  hire(deskId: string, _by: string, _prompt: string, _worktree: boolean, _choice: Partial<AgentChoice>, lead: string) {
    const id = `sub${++this.n}`;
    return this.add(worker({ id, deskId, name: ['Pixel', 'Byte', 'Dot', 'Echo'][this.n - 1] ?? id, status: 'starting', lead }));
  }
  prompt(id: string, text: string) {
    this.prompts.push([id, text]);
    return undefined;
  }
  notice(id: string, text: string) {
    if (!this.hookDelivery) return false;
    this.notices.push([id, text]);
    return true;
  }
  resume() {
    return undefined;
  }
  async kill(id: string) {
    this.ws.delete(id);
    return {};
  }
  tail() {
    return 'lead terminal: waiting on the team';
  }
  setTask(id: string, task: WorkerTask) {
    const w = this.ws.get(id);
    if (w) w.task = task;
  }
}

class Gate implements WakeGate {
  on = true;
  calls: WakePacket[] = [];
  route: (p: WakePacket) => WakeVerdict | Promise<WakeVerdict> = (p) =>
    p.teammates.some((m) => m.status === 'working' || m.status === 'starting') ? { traffic: 'hold_for_batch', source: 'model', reason: 'batch' } : { traffic: 'wake_immediately', source: 'model', reason: 'last' };
  active() {
    return this.on;
  }
  async decide(p: WakePacket) {
    this.calls.push(p);
    return this.route(p);
  }
}

function rig(t: { after(fn: () => void): void }, over: Partial<TeamOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'droid-office-wake-team-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = new Fake();
  fake.add(worker({ id: 'lead', deskId: 'desk-1', name: 'Nibble', task: { name: 'Lead', summary: 'Merge the batch' } }));
  const gate = new Gate();
  const opts = { dataDir: dir, dir: '/proj', git: false, settings: () => ({ ...SUBAGENT_DEFAULTS }), toast() {}, nudgeDelayMs: 5, wakeFilter: gate, ...over };
  const team = new Team(fake, opts);
  t.after(() => team.stop());
  const set = (id: string, status: WorkerStatus) => {
    const w = fake.get(id)!;
    w.status = status;
    team.onWorker({ ...w });
  };
  const call = async (caller: string, body: Record<string, unknown>) => (await team.handle(fake.get(caller)!, body)) as { status: number; body: Record<string, any> };
  const leadPrompts = () => fake.prompts.filter(([id]) => id === 'lead').map(([, text]) => text);
  return { dir, fake, gate, team, set, call, leadPrompts, opts };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a completion is held while teammates work and the whole batch wakes the lead once', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'One' });
  await r.call('lead', { action: 'hire', task: 'Two' });
  r.set('sub1', 'working');
  r.set('sub2', 'working');
  const first = await r.call('sub1', { action: 'report', text: 'Pixel finished the wake filter.' });
  assert.equal(first.status, 200);
  assert.equal(first.body.traffic, 'hold_for_batch');
  assert.equal(r.gate.calls[0]!.channel, 'team_report');
  assert.match(r.gate.calls[0]!.lead.tail ?? '', /waiting on the team/);
  assert.equal(r.gate.calls[0]!.lead.task, 'Lead: Merge the batch');
  r.set('sub1', 'done');
  await sleep(30);
  assert.equal(r.leadPrompts().length, 0);
  // The held report is still on record for anyone who asks.
  assert.equal(r.team.reports('lead').length, 1);
  assert.equal(r.team.news('lead')[0]!.gate, 'held');

  const second = await r.call('sub2', { action: 'report', text: 'Byte finished the settings UI.' });
  assert.equal(second.body.traffic, 'wake_immediately');
  r.set('sub2', 'done');
  await sleep(30);
  const prompts = r.leadPrompts();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Pixel/);
  assert.match(prompts[0]!, /Byte/);
  assert.equal(
    r.team.news('lead').some((e) => e.gate),
    false,
  );
});

test('a held batch wakes its lead at the max-hold ceiling or once the last teammate leaves', async (t) => {
  const r = rig(t, { holdMaxMs: 40 });
  await r.call('lead', { action: 'hire', task: 'One' });
  await r.call('lead', { action: 'hire', task: 'Two' });
  r.set('sub1', 'working');
  r.set('sub2', 'working');
  await r.call('sub1', { action: 'report', text: 'Done with one.' });
  await sleep(15);
  assert.equal(r.leadPrompts().length, 0);
  await sleep(80);
  assert.equal(r.leadPrompts().length, 1);

  const r2 = rig(t);
  await r2.call('lead', { action: 'hire', task: 'One' });
  await r2.call('lead', { action: 'hire', task: 'Two' });
  r2.set('sub1', 'working');
  r2.set('sub2', 'working');
  await r2.call('sub1', { action: 'report', text: 'Done with one.' });
  r2.set('sub1', 'done');
  await r2.fake.kill('sub2');
  r2.team.onWorkerGone('sub2');
  await sleep(30);
  assert.equal(r2.leadPrompts().length, 1);
});

test('routine updates are recorded silently, survive a restart, and never wake or delay the lead', async (t) => {
  const r = rig(t);
  r.gate.route = (p) => (p.message.progress ? { traffic: 'record_silently', source: 'model', reason: 'routine' } : { traffic: 'wake_immediately', source: 'model', reason: 'final' });
  await r.call('lead', { action: 'hire', task: 'One' });
  r.set('sub1', 'working');
  const progress = await r.call('sub1', { action: 'report', text: 'CI is running, will check back.', progress: true });
  assert.equal(progress.body.traffic, 'record_silently');
  await sleep(30);
  assert.equal(r.leadPrompts().length, 0);
  assert.equal(r.team.news('lead')[0]!.gate, 'silent');
  assert.equal(r.team.beforeStop(r.fake.get('lead')!), undefined);
  const status = await r.call('lead', { action: 'status' });
  assert.match(JSON.stringify(status.body.events), /CI is running/);

  const again = new Team(r.fake, { ...r.opts, wakeFilter: undefined });
  t.after(() => again.stop());
  assert.equal(again.news('lead')[0]!.gate, 'silent');

  await r.call('sub1', { action: 'report', text: 'All finished.' });
  await sleep(30);
  const prompts = r.leadPrompts();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Pixel reported back/);
});

test('questions skip the gate; an off or failing gate delivers exactly as before', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'One' });
  await r.call('lead', { action: 'hire', task: 'Two' });
  r.set('sub1', 'working');
  r.set('sub2', 'working');
  const q = await r.call('sub1', { action: 'report', text: 'Which schema?', question: true });
  assert.equal(q.status, 200);
  assert.equal(q.body.traffic, undefined);
  assert.equal(r.gate.calls.length, 0);
  await sleep(30);
  assert.equal(r.leadPrompts().length, 1);

  r.gate.route = () => Promise.reject(new Error('boom'));
  const failed = await r.call('sub2', { action: 'report', text: 'Finished two.' });
  assert.equal(failed.body.traffic, 'wake_immediately');
  await sleep(30);
  assert.equal(r.leadPrompts().length, 2);

  r.gate.on = false;
  const calls = r.gate.calls.length;
  const off = await r.call('sub2', { action: 'report', text: 'Again.' });
  assert.equal(off.body.traffic, undefined);
  assert.equal(r.gate.calls.length, calls);
});

test('a blocked held report is still recorded, and a pending answer is released by news that wakes the lead', async (t) => {
  const r = rig(t);
  await r.call('lead', { action: 'hire', task: 'One' });
  await r.call('lead', { action: 'hire', task: 'Two' });
  r.set('sub1', 'working');
  r.set('sub2', 'working');
  let answer!: (v: WakeVerdict) => void;
  r.gate.route = () => new Promise<WakeVerdict>((resolve) => (answer = resolve));
  const pending = r.call('sub1', { action: 'report', text: 'Thinking out loud.' });
  await sleep(5);
  assert.equal(r.team.news('lead')[0]!.gate, 'held');
  // A question wakes the lead and carries the pending report with it.
  await r.call('sub2', { action: 'report', text: 'Blocked: which API?', question: true });
  answer({ traffic: 'block_and_coach', source: 'model', reason: 'chatter', coach: 'Noise gate: stop' });
  assert.equal((await pending).body.traffic, 'block_and_coach');
  await sleep(30);
  assert.equal(r.leadPrompts().length, 1);
  assert.match(r.leadPrompts()[0]!, /Thinking out loud|Pixel/);
  assert.equal(r.team.reports('lead').length, 2);
});

test('team_note gating: blocked notes are not posted, quiet ones skip irrelevant siblings, nobody to interrupt skips the gate', async (t) => {
  const r = rig(t);
  for (const task of ['One', 'Two', 'Three']) await r.call('lead', { action: 'hire', task });
  r.set('sub1', 'working');
  r.set('sub2', 'working');
  r.set('sub3', 'working');
  r.gate.route = (p) => {
    assert.deepEqual(
      p.siblings?.map((s) => s.id),
      ['sub2', 'sub3'],
    );
    return /chugging/.test(p.message.text)
      ? { traffic: 'block_and_coach', source: 'model', reason: 'chatter', coach: 'Noise gate: heads-down', notify: [] }
      : { traffic: 'wake_immediately', source: 'model', reason: 'contract', notify: ['sub3'] };
  };
  const blocked = await r.call('sub1', { action: 'note', text: 'Still chugging along!' });
  assert.equal(blocked.body.blocked, true);
  assert.equal(blocked.body.coach, 'Noise gate: heads-down');
  assert.equal(r.fake.notices.length, 0);
  assert.equal(r.team.board('lead').find((m) => m.id === 'sub1')!.note, undefined);

  const sent = await r.call('sub1', { action: 'note', text: 'Renamed WakePacket.siblings', areas: ['src/server/wake-filter.ts'] });
  assert.deepEqual(sent.body.notified, ['sub3']);
  assert.deepEqual(sent.body.skipped, ['sub2']);
  assert.equal(sent.body.traffic, 'wake_immediately');
  assert.match(r.gate.calls[1]!.message.areas?.join() ?? '', /wake-filter/);
  assert.equal(r.gate.calls[1]!.message.areasChanged, true);
  assert.equal(r.team.board('lead').find((m) => m.id === 'sub1')!.note?.text, 'Renamed WakePacket.siblings');

  r.set('sub2', 'done');
  r.set('sub3', 'done');
  const calls = r.gate.calls.length;
  const lonely = await r.call('sub1', { action: 'note', text: 'Still chugging along!' });
  assert.equal(lonely.body.blocked, undefined);
  assert.equal(r.gate.calls.length, calls);
});

test('a building lead sees teammates on other floors and its own view through the wake context', async (t) => {
  const r = rig(t, {
    leadView: () => ({ name: 'Orchestrator', building: true, status: 'working', steps: [{ content: 'Wait for both floors', status: 'in_progress' }] }),
    teammatesElsewhere: (_lead, rich) => [{ id: 'far', name: 'Far', status: 'working', ...(rich ? { floor: 'Android' } : {}) }],
  });
  await r.call('lead', { action: 'hire', task: 'One' });
  r.set('sub1', 'working');
  await r.call('sub1', { action: 'note', text: 'mine', areas: ['src/a.ts'] });
  const ctx = r.team.wakeContext('lead', r.fake.get('sub1')!);
  assert.equal(ctx.lead.name, 'Orchestrator');
  assert.equal(ctx.lead.building, true);
  assert.deepEqual(ctx.lead.steps, [{ content: 'Wait for both floors', status: 'in_progress' }]);
  assert.deepEqual(ctx.sender.areas, ['src/a.ts']);
  assert.deepEqual(ctx.teammates, [{ id: 'far', name: 'Far', status: 'working', floor: 'Android' }]);
  // The far teammate is still working, so this completion is held.
  assert.equal((await r.call('sub1', { action: 'report', text: 'Done.' })).body.traffic, 'hold_for_batch');
  assert.deepEqual(r.team.localTeammates('lead'), [{ id: 'sub1', name: 'Pixel', status: 'working' }]);
});
