import test from 'node:test';
import assert from 'node:assert/strict';
import { ABANDON_MS, ASK_DEFAULT_S, LINGER_MS, READ_MS, TALK_MAX_MS, TALK_MIN_MS, Visits, independent, waitWords, type VisitWorkers } from '../src/server/visits.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { SUBAGENT_DEFAULTS, type AgentChoice, type ServerMsg, type WorkerInfo, type WorkerStatus } from '../src/shared/protocol.js';
import { visitRoute, visitWalkMs, type Visit } from '../src/shared/visits.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function worker(over: Partial<WorkerInfo> & { id: string; deskId: string }): WorkerInfo {
  return { kind: 'agent', name: over.id, color: '#fff', status: 'done', acked: true, createdBy: 'test', createdAt: 0, cols: 100, rows: 30, open: false, ...over };
}

class Fake implements VisitWorkers {
  ws = new Map<string, WorkerInfo>();
  typed: { id: string; text: string; queue: boolean }[] = [];
  resumed: { id: string; text: string }[] = [];
  interrupts: string[] = [];
  tails = new Map<string, string>();
  refuse?: string;
  clock = () => 0;
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
  tail(id: string, lines: number) {
    const t = this.tails.get(id);
    return t === undefined ? undefined : t.split('\n').slice(-lines).join('\n');
  }
  prompt(id: string, text: string, queue = false) {
    if (this.refuse) return this.refuse;
    this.typed.push({ id, text, queue });
    const w = this.ws.get(id);
    if (w) w.lastInputAt = this.clock();
    return undefined;
  }
  resume(id: string, text: string) {
    this.resumed.push({ id, text });
    return undefined;
  }
  interrupt(id: string) {
    this.interrupts.push(id);
  }
}

type Reply = { status: number; body: Record<string, any> };

function rig(t: { after(fn: () => void): void }) {
  const fake = new Fake();
  let clock = 1_000_000;
  fake.clock = () => clock;
  // Pixel and Nibble were hired by the owner; Byte is Pixel's subagent; Dot is another independent worker.
  fake.add(worker({ id: 'pixel', deskId: 'desk-3', name: 'Pixel', createdAt: 1, task: { name: 'Fix Login', summary: 'Fixing it' }, activity: 'Editing auth.ts', status: 'working' }));
  fake.add(worker({ id: 'nibble', deskId: 'desk-9', name: 'Nibble', createdAt: 2 }));
  fake.add(worker({ id: 'byte', deskId: 'desk-4', name: 'Byte', createdAt: 3, lead: 'pixel' }));
  fake.add(worker({ id: 'dot', deskId: 'desk-10', name: 'Dot', createdAt: 4 }));
  fake.add(worker({ id: 'sh', deskId: 'desk-5', name: 'Shell 🐚', kind: 'shell', createdAt: 5 }));
  fake.tails.set('nibble', 'line 1\nline 2\n$ npm test\nok');
  const settings = { on: true };
  const emitted: ServerMsg[] = [];
  const toasts: string[] = [];
  const visits = new Visits(fake, { on: () => settings.on, emit: (m) => emitted.push(m), toast: (text) => toasts.push(text), now: () => clock });
  t.after(() => visits.stop());
  const r = {
    fake,
    visits,
    settings,
    emitted,
    toasts,
    get now() {
      return clock;
    },
    call(caller: string, body: Record<string, unknown>): Reply {
      const w = fake.get(caller);
      if (!w) throw new Error(`no ${caller}`);
      return visits.handle(w, body) as Reply;
    },
    /** The clock moves on, a tick at a time as the office's timer would. */
    advance(ms: number) {
      const end = clock + ms;
      while (clock < end) {
        clock = Math.min(end, clock + 250);
        visits.tick(clock);
      }
    },
    set(id: string, status: WorkerStatus) {
      const w = fake.get(id)!;
      w.status = status;
      visits.onWorker({ ...w });
    },
    /** The last full list of visits the floor was sent. */
    lastList(): Visit[] {
      const m = [...emitted].reverse().find((x) => x.t === 'visits');
      return m && m.t === 'visits' ? m.visits : [];
    },
    says() {
      return emitted.filter((m) => m.t === 'visit_say');
    },
    status(caller: string, visit: string) {
      return r.call(caller, { action: 'status', visit });
    },
  };
  return r;
}

const walk = (from: string, to: string, slot: number) => visitWalkMs(visitRoute(from, to, slot));

test('the roster lists only the independent workers on this floor: no subagents, no shells, none from other floors', (t) => {
  const r = rig(t);
  const res = r.call('pixel', { action: 'roster' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.you, { id: 'pixel', name: 'Pixel', desk: 'Desk 3' });
  assert.deepEqual(
    res.body.roster.map((w: { name: string }) => w.name),
    ['Pixel', 'Nibble', 'Dot'],
  );
  assert.deepEqual(res.body.roster[0], { id: 'pixel', name: 'Pixel', desk: 'Desk 3', status: 'working', busy: true, task: 'Fix Login', activity: 'Editing auth.ts', you: true });
  assert.deepEqual(res.body.roster[1], { id: 'nibble', name: 'Nibble', desk: 'Desk 9', status: 'done', busy: false });
  // A lead with a subagent of its own is still independent, and a subagent whose lead left becomes one.
  assert.equal(independent(r.fake.get('pixel')!), true);
  assert.equal(independent(r.fake.get('byte')!), false);
  assert.equal(independent({ ...r.fake.get('byte')!, lead: undefined }), true);

  // Another floor has its own workers and its own roster: nobody here can reach them, nor they us.
  const other = new Fake();
  other.add(worker({ id: 'zed', deskId: 'desk-1', name: 'Zed' }));
  const upstairs = new Visits(other, { on: () => true, emit: () => undefined });
  const theirs = upstairs.handle(other.get('zed')!, { action: 'roster' }) as Reply;
  assert.deepEqual(
    theirs.body.roster.map((w: { name: string }) => w.name),
    ['Zed'],
  );
  assert.equal((upstairs.handle(other.get('zed')!, { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'hi' }) as Reply).status, 404);
  assert.equal(r.call('pixel', { action: 'visit', kind: 'look', worker: 'zed' }).status, 404);
});

test('subagents, other workers’ subagents and a turned-off office get a clear refusal', (t) => {
  const r = rig(t);
  for (const action of ['whoami', 'roster', 'visit', 'status', 'reply']) {
    const res = r.call('byte', { action, kind: 'tell', worker: 'Nibble', text: 'hi', visit: 'v-1' });
    assert.equal(res.status, 403, action);
    assert.match(res.body.error, /You're a subagent of Pixel: subagents don't visit other workers or see the roster/);
  }
  const target = r.call('nibble', { action: 'visit', kind: 'look', worker: 'Byte' });
  assert.equal(target.status, 403);
  assert.match(target.body.error, /Byte is a subagent: subagents can't be visited/);
  assert.equal(r.call('nibble', { action: 'visit', kind: 'tell', worker: 'byte', text: 'x' }).status, 403, 'by id too');
  assert.match(r.call('nibble', { action: 'visit', kind: 'look', worker: 'Shell 🐚' }).body.error, /isn't an agent at a desk here/);
  assert.match(r.call('sh', { action: 'roster' }).body.error, /Only agents at a desk/);
  assert.match(r.call('pixel', { action: 'visit', kind: 'look', worker: 'pixel' }).body.error, /That's you/);
  assert.match(r.call('pixel', { action: 'visit', kind: 'look', worker: 'Nobody' }).body.error, /No one called Nobody/);
  assert.match(r.call('pixel', { action: 'visit', kind: 'look' }).body.error, /Name the worker/);
  assert.match(r.call('pixel', { action: 'visit', kind: 'dance', worker: 'Nibble' }).body.error, /A visit is one of look, tell, ask, handoff/);
  assert.match(r.call('pixel', { action: 'visit', kind: 'ask', worker: 'Nibble', text: '  ' }).body.error, /Give the question on stdin/);
  assert.match(r.call('pixel', { action: 'visit', kind: 'look', worker: 'Dot' }).body.error, /Dot has no terminal yet/);
  assert.match(r.call('pixel', { action: 'nope' }).body.error, /Unknown action/);

  r.settings.on = false;
  for (const action of ['whoami', 'roster', 'visit', 'status', 'reply']) {
    const res = r.call('pixel', { action, kind: 'tell', worker: 'Nibble', text: 'hi', visit: 'v-1' });
    assert.equal(res.status, 403, action);
    assert.match(res.body.error, /Visits between workers are turned off in this office \(⚙️ Settings → Subagents → Visits\)/);
  }
  assert.equal(r.emitted.length, 0, 'nothing was shown');
});

test('a look walks over, reads the screen while leaning over the laptop, and walks back', (t) => {
  const r = rig(t);
  const start = r.now;
  const res = r.call('pixel', { action: 'visit', kind: 'look', worker: 'nibble', lines: 2 });
  assert.equal(res.status, 200);
  const id = res.body.visit;
  const ms = walk('desk-3', 'desk-9', 0);
  assert.equal(res.body.walkMs, ms);
  assert.deepEqual(res.body.host, { id: 'nibble', name: 'Nibble', desk: 'Desk 9' });
  assert.deepEqual(r.lastList(), [{ id, visitor: 'pixel', host: 'nibble', kind: 'look', phase: 'walking', slot: 0, since: start }]);
  assert.equal(r.status('pixel', id).body.done, false);
  assert.equal(r.status('nibble', id).status, 404, "it's only the visitor's to follow");

  r.advance(ms - 250);
  assert.equal(r.lastList()[0].phase, 'walking', 'the office waits out the walk before it reads');
  r.advance(250);
  assert.equal(r.lastList()[0].phase, 'reading');
  const s = r.status('pixel', id).body;
  assert.equal(s.done, true);
  assert.equal(s.text, '$ npm test\nok');
  assert.equal(r.fake.typed.length, 0, 'nothing is typed into the host');

  r.advance(READ_MS);
  assert.equal(r.lastList()[0].phase, 'returning');
  assert.equal(r.call('pixel', { action: 'whoami' }).body.visiting, undefined, 'walking back, it is no longer at the desk');
  r.advance(ms);
  assert.deepEqual(r.lastList(), [], 'back at its desk, the visit is over');
  assert.equal(r.status('pixel', id).body.text, '$ npm test\nok', 'its outcome can still be collected');
  assert.deepEqual(r.toasts, ["👀 Pixel is reading Nibble's screen"]);
});

test('a normal tell waits for the host to finish its turn; the visitor leaves it in the queue', (t) => {
  const r = rig(t);
  r.set('nibble', 'working');
  const id = r.call('pixel', { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'I renamed auth.ts to session.ts' }).body.visit;
  r.advance(walk('desk-3', 'desk-9', 0));
  assert.equal(r.lastList()[0].phase, 'talking');
  assert.deepEqual(r.says(), [{ t: 'visit_say', visit: id, worker: 'pixel', text: 'I renamed auth.ts to session.ts' }]);
  r.advance(TALK_MAX_MS);
  assert.equal(r.fake.typed.length, 0, 'not while it works');
  assert.equal(r.fake.interrupts.length, 0);
  assert.equal(r.lastList()[0].phase, 'returning');
  assert.deepEqual(r.status('pixel', id).body, { visit: id, kind: 'tell', phase: 'returning', host: 'Nibble', done: true, ok: true, queued: true });

  r.set('nibble', 'done');
  r.advance(250);
  assert.equal(r.fake.typed.length, 1);
  const { text, queue } = r.fake.typed[0];
  assert.equal(queue, false);
  assert.match(text, /^💬 Pixel \(Desk 3\), another worker on this floor, walked over to tell you this\.\n\nI renamed auth\.ts to session\.ts\n\n/);
  assert.match(text, /office-visit tell Pixel/);
  assert.doesNotMatch(text, /urgent/i);
});

test('a tell to a host at rest goes straight in, and a sleeping host is woken with it', (t) => {
  const r = rig(t);
  const id = r.call('pixel', { action: 'visit', kind: 'handoff', worker: 'Nibble', text: 'Write tests for session.ts', title: 'Session tests' }).body.visit;
  r.advance(walk('desk-3', 'desk-9', 0));
  assert.equal(r.fake.typed.length, 1);
  assert.match(r.fake.typed[0].text, /^📦 Pixel \(Desk 3\), another worker on this floor, walked over to hand you a task\.\n\nTask: Session tests\n\nWrite tests for session\.ts/);
  assert.equal(r.says()[0].text, 'Session tests: Write tests for session.ts');
  r.advance(TALK_MIN_MS);
  assert.equal(r.status('pixel', id).body.delivered, true);

  r.set('dot', 'offline');
  r.advance(walk('desk-3', 'desk-9', 0));
  r.call('pixel', { action: 'visit', kind: 'tell', worker: 'Dot', text: 'wake up' });
  r.advance(walk('desk-3', 'desk-10', 0));
  assert.equal(r.fake.resumed.length, 1);
  assert.match(r.fake.resumed[0].text, /wake up/);
});

test('an urgent message interrupts the host’s turn, and is queued behind it if the turn won’t stop', (t) => {
  const r = rig(t);
  r.set('nibble', 'working');
  const id = r.call('pixel', { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'Stop: main is broken', urgent: true }).body.visit;
  r.advance(walk('desk-3', 'desk-9', 0));
  assert.deepEqual(r.fake.interrupts, ['nibble'], 'Escape goes in at once');
  assert.equal(r.fake.typed.length, 0);
  r.set('nibble', 'done');
  r.advance(250);
  assert.equal(r.fake.typed.length, 1);
  assert.match(r.fake.typed[0].text, /It's urgent, so the office interrupted what you were doing/);
  r.advance(TALK_MIN_MS);
  assert.equal(r.status('pixel', id).body.delivered, true);
  assert.match(r.toasts.join('\n'), /Pixel told Nibble \(urgent\)/);

  // A host that keeps working after Escape gets it queued behind its turn.
  r.set('dot', 'working');
  r.advance(walk('desk-3', 'desk-9', 0));
  r.call('pixel', { action: 'visit', kind: 'tell', worker: 'Dot', text: 'Now', urgent: true });
  r.advance(walk('desk-3', 'desk-10', 0));
  assert.deepEqual(r.fake.interrupts, ['nibble', 'dot']);
  r.advance(6000);
  assert.deepEqual(r.fake.typed.at(-1), { id: 'dot', text: r.fake.typed.at(-1)!.text, queue: true });

  // A permission prompt is the owner's: even urgent waits.
  r.set('nibble', 'needs_input');
  r.advance(walk('desk-3', 'desk-10', 0));
  const before = r.fake.typed.length;
  r.call('pixel', { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'again', urgent: true });
  r.advance(walk('desk-3', 'desk-9', 0) + 3000);
  assert.equal(r.fake.typed.length, before);
  assert.deepEqual(r.fake.interrupts, ['nibble', 'dot']);
});

test('an ask waits at the desk for the answer, which reaches the asker and shows over the host', (t) => {
  const r = rig(t);
  const res = r.call('pixel', { action: 'visit', kind: 'ask', worker: 'Nibble', text: 'Which port does the dev server use?', timeout: 120 });
  const id = res.body.visit;
  assert.equal(res.body.timeout, 120);
  r.advance(walk('desk-3', 'desk-9', 0));
  assert.equal(r.lastList()[0].phase, 'waiting');
  const text = r.fake.typed[0].text;
  assert.match(text, /^❓ Pixel \(Desk 3\), another worker on this floor, is standing at your desk waiting for an answer to this question\.\n\nWhich port/);
  assert.ok(text.includes(`office-visit reply ${id} <<'EOF'`), text);
  assert.match(text, /It waits about 2 minutes more/);

  assert.equal(r.call('dot', { action: 'reply', visit: id, text: '5173' }).status, 404, 'only the host answers');
  assert.match(r.call('nibble', { action: 'reply', visit: id, text: '' }).body.error, /Give the answer on stdin/);
  for (let i = 0; i < 30; i++) {
    r.advance(1000);
    assert.equal(r.status('pixel', id).body.done, false, 'still waiting while office-visit keeps asking');
  }
  const ok = r.call('nibble', { action: 'reply', visit: id, text: '5173, and the office on 4600' });
  assert.deepEqual(ok, { status: 200, body: { to: 'Pixel' } });
  assert.deepEqual(r.says().at(-1), { t: 'visit_say', visit: id, worker: 'nibble', text: '5173, and the office on 4600' });
  const s = r.status('pixel', id).body;
  assert.equal(s.done, true);
  assert.equal(s.answer, '5173, and the office on 4600');
  assert.equal(r.lastList()[0].phase, 'waiting', 'it stays a moment while the answer is said');
  r.advance(LINGER_MS);
  assert.equal(r.lastList()[0].phase, 'returning');
  assert.match(r.call('nibble', { action: 'reply', visit: id, text: 'again' }).body.error, /isn't waiting any more/);
});

test('an ask gives up when the asker’s timeout runs out, or when the asker stops waiting', (t) => {
  const r = rig(t);
  r.set('nibble', 'working');
  const id = r.call('pixel', { action: 'visit', kind: 'ask', worker: 'Nibble', text: 'Quick one?', timeout: 15 }).body.visit;
  for (let i = 0; i < 15; i++) {
    r.advance(1000);
    r.status('pixel', id);
  }
  const s = r.status('pixel', id).body;
  assert.equal(s.done, true);
  assert.equal(s.ok, false);
  assert.match(s.error, /Nibble didn't answer within 15 seconds/);
  assert.equal(r.lastList()[0].phase, 'returning');
  r.set('nibble', 'done');
  r.advance(1000);
  assert.equal(r.fake.typed.length, 0, 'a question nobody waits for any more is never typed in');
  assert.match(r.call('nibble', { action: 'reply', visit: id, text: 'late' }).body.error, /Pixel isn't waiting any more: Nibble didn't answer/);

  // The asker's own office-visit went away (its turn was stopped): it stops waiting too.
  r.advance(walk('desk-3', 'desk-9', 0));
  const gone = r.call('pixel', { action: 'visit', kind: 'ask', worker: 'Dot', text: 'Still there?' }).body.visit;
  r.set('dot', 'working');
  r.advance(ABANDON_MS + walk('desk-3', 'desk-10', 0) + 500);
  assert.match(r.status('pixel', gone).body.error, /You stopped waiting/);
  assert.equal(ASK_DEFAULT_S, 300);
});

test('two visitors at one host stand side by side and are answered in turn, never mixed', (t) => {
  const r = rig(t);
  const a = r.call('pixel', { action: 'visit', kind: 'ask', worker: 'Nibble', text: 'First?' }).body.visit;
  const b = r.call('dot', { action: 'visit', kind: 'ask', worker: 'Nibble', text: 'Second?' }).body.visit;
  const slots = Object.fromEntries(r.lastList().map((v) => [v.visitor, v.slot]));
  assert.deepEqual(slots, { pixel: 0, dot: 1 });
  r.advance(Math.max(walk('desk-3', 'desk-9', 0), walk('desk-10', 'desk-9', 1)));
  assert.deepEqual(
    r.lastList().map((v) => v.phase),
    ['waiting', 'waiting'],
  );
  // Dot's desk is next door, so it got there first and is answered first.
  assert.equal(r.fake.typed.length, 1, 'one message at a time');
  assert.match(r.fake.typed[0].text, /Dot \(Desk 10\)[\s\S]*Second\?/);
  assert.ok(r.fake.typed[0].text.includes(b));
  for (let i = 0; i < 5; i++) {
    r.advance(1000);
    r.status('pixel', a);
  }
  assert.equal(r.fake.typed.length, 1, 'the other waits for the turn the first started');
  r.set('nibble', 'working');
  r.advance(1000);
  r.call('nibble', { action: 'reply', visit: b, text: 'Yes' });
  r.status('pixel', a);
  r.set('nibble', 'done');
  r.advance(250);
  assert.equal(r.fake.typed.length, 2);
  assert.match(r.fake.typed[1].text, /Pixel \(Desk 3\)[\s\S]*First\?/);
  assert.ok(r.fake.typed[1].text.includes(a));
  // A host that never starts a turn for a message still gets the next one in a while.
  const c = rig(t);
  c.call('pixel', { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'one' });
  c.call('dot', { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'two' });
  c.advance(walk('desk-10', 'desk-9', 1));
  assert.equal(c.fake.typed.length, 1);
  c.advance(15_000);
  assert.equal(c.fake.typed.length, 2);
});

test('a visitor may visit again once home: a visit while walking back sets off when it gets there', (t) => {
  const r = rig(t);
  const first = r.call('pixel', { action: 'visit', kind: 'look', worker: 'Nibble' }).body.visit;
  assert.match(r.call('pixel', { action: 'visit', kind: 'look', worker: 'Nibble' }).body.error, /already on a visit to Nibble/);
  const ms = walk('desk-3', 'desk-9', 0);
  r.advance(ms);
  r.advance(READ_MS);
  assert.equal(r.status('pixel', first).body.phase, 'returning');
  const next = r.call('pixel', { action: 'visit', kind: 'tell', worker: 'Dot', text: 'hi' });
  assert.equal(next.status, 200);
  assert.ok(next.body.after > 0);
  assert.equal(r.status('pixel', next.body.visit).body.phase, 'pending');
  assert.deepEqual(
    r.lastList().map((v) => v.id),
    [first],
    'not shown until it sets off',
  );
  r.advance(ms);
  assert.deepEqual(
    r.lastList().map((v) => [v.id, v.phase]),
    [[next.body.visit, 'walking']],
  );
});

test('a visit right after a look waits for that look to finish, instead of being refused', (t) => {
  const r = rig(t);
  const first = r.call('pixel', { action: 'visit', kind: 'look', worker: 'Nibble' }).body.visit;
  const ms = walk('desk-3', 'desk-9', 0);
  r.advance(ms);
  assert.equal(r.status('pixel', first).body.done, true, 'the look has its screen');
  assert.equal(r.status('pixel', first).body.phase, 'reading');
  const next = r.call('pixel', { action: 'visit', kind: 'look', worker: 'Nibble' });
  assert.equal(next.status, 200);
  assert.ok(next.body.after > ms && next.body.after <= READ_MS + ms, 'still reading, then the walk back');
  assert.match(r.call('pixel', { action: 'visit', kind: 'look', worker: 'Nibble' }).body.error, /already on a visit/, 'one waiting is the limit');
  r.advance(READ_MS + ms);
  assert.deepEqual(
    r.lastList().map((v) => [v.id, v.phase]),
    [[next.body.visit, 'walking']],
  );
});

test('a host or visitor leaving mid-visit ends it cleanly', (t) => {
  const r = rig(t);
  r.set('nibble', 'working');
  const ask = r.call('pixel', { action: 'visit', kind: 'ask', worker: 'Nibble', text: 'Hm?' }).body.visit;
  const tell = r.call('dot', { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'fyi' }).body.visit;
  r.advance(walk('desk-3', 'desk-9', 0));
  r.fake.ws.delete('nibble');
  r.visits.onWorkerGone('nibble');
  const s = r.status('pixel', ask).body;
  assert.equal(s.ok, false);
  assert.match(s.error, /Nibble left the floor/);
  assert.deepEqual(
    r.lastList().map((v) => v.phase),
    ['returning', 'returning'],
    'both walk back',
  );
  assert.match(r.status('dot', tell).body.error ?? '', /Nibble left the floor/);

  // The visitor leaving takes its visit, and what it left in a queue, with it.
  const q = rig(t);
  q.set('nibble', 'working');
  const v = q.call('pixel', { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'later' }).body.visit;
  q.advance(walk('desk-3', 'desk-9', 0));
  q.fake.ws.delete('pixel');
  q.visits.onWorkerGone('pixel');
  assert.deepEqual(q.lastList(), []);
  q.set('nibble', 'done');
  q.advance(1000);
  assert.equal(q.fake.typed.length, 0);
  assert.ok(v);

  // A message that can't be typed in says why.
  const f = rig(t);
  f.fake.refuse = 'Worker is not running';
  const bad = f.call('pixel', { action: 'visit', kind: 'tell', worker: 'Nibble', text: 'x' }).body.visit;
  f.advance(walk('desk-3', 'desk-9', 0) + TALK_MIN_MS);
  assert.match(f.status('pixel', bad).body.error, /Couldn't get it to Nibble: Worker is not running/);
});

test('turning visits off ends the ones under way', (t) => {
  const r = rig(t);
  r.set('nibble', 'working');
  const id = r.call('pixel', { action: 'visit', kind: 'ask', worker: 'Nibble', text: 'x' }).body.visit;
  r.advance(walk('desk-3', 'desk-9', 0));
  r.settings.on = false;
  r.advance(250);
  r.settings.on = true;
  assert.match(r.status('pixel', id).body.error, /Visits were turned off/);
  r.set('nibble', 'done');
  r.advance(1000);
  assert.equal(r.fake.typed.length, 0);
  assert.equal(r.status('pixel', 'v-nope').status, 404);
});

test('how long an asker still waits, in words', () => {
  assert.equal(waitWords(40_000), '40 seconds');
  assert.equal(waitWords(-5), '0 seconds');
  assert.equal(waitWords(240_000), 'about 4 minutes');
});

test('office-workers carries on as before beside visits: a lead reaches its subagent with no walk and no visit', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'droid-office-visits-team-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = rig(t);
  const sent: [string, string][] = [];
  const teamWorkers: TeamWorkers = {
    list: () => r.fake.list(),
    get: (id) => r.fake.get(id),
    deskOccupied: (id) => r.fake.list().some((w) => w.deskId === id),
    officeDefault: undefined as AgentChoice | undefined,
    hire: () => 'no',
    prompt: (id, text) => {
      sent.push([id, text]);
      return undefined;
    },
    resume: () => undefined,
    kill: async () => ({}),
    tail: (id) => r.fake.tail(id, 10),
    setTask: () => undefined,
  };
  const team = new Team(teamWorkers, { dataDir: dir, dir: '/proj', git: true, settings: () => SUBAGENT_DEFAULTS, toast: () => undefined });
  t.after(() => team.stop());
  const res = await team.handle(r.fake.get('pixel')!, { action: 'send', worker: 'Byte', text: 'Use v2' });
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [['byte', 'Use v2']], 'typed in as it is, with no visit label');
  r.advance(5000);
  assert.deepEqual(r.emitted, [], 'nobody walked anywhere');
  // The visits setting changes nothing about hiring.
  assert.equal(team.cannotHire(r.fake.get('nibble')!), undefined);
});
