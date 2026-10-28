// Independent workers visiting each other's desks on one floor: the roster, reading a terminal,
// telling, asking and handing off work. office-visit (bin/office-visit.js) talks to /office/visits
// with the worker's own hook token. Only workers with no lead take part: a subagent is never on the
// roster, can't visit and can't be visited, so a lead's team stays its own (see team.ts). Where a
// visitor stands, the way it walks and how long that takes are shared/visits.ts, so the office times
// each phase by the same walk the browser shows.
//
// What a visitor says is typed into the host's session one message at a time, as soon as the
// visitor arrives: a normal message goes in with plain Enter, which steers a host that's mid-turn
// (droid reads it once its current tool call finishes) and is the next prompt for one at rest. An
// urgent message to a mid-turn host gets one Escape first, which cancels droid's turn, and goes in
// as a new prompt once it stops. A message that can't go in while the visitor stands there (a
// dialog is showing, the host needs the owner, someone just typed) waits in the host's queue.
// Visits aren't kept on disk: a restart ends them, and an asker still waiting hears so.

import { randomBytes } from 'node:crypto';
import { DESK_BY_ID } from '../shared/layout.js';
import type { ServerMsg, WorkerInfo } from '../shared/protocol.js';
import type { DroidScreen } from './droid-screen.js';
import { isAsleep, isBusy } from '../shared/status.js';
import { type Visit, type VisitKind, type VisitPhase, VISIT_KINDS, visitRoute, visitWalkMs } from '../shared/visits.js';
import { officePrompt, type PromptSource } from './prompts.js';
import { workerMessageVars } from '../shared/prompts.js';

/** What visits need from the floor's workers. Narrow on purpose, so a test can fake it. */
export interface VisitWorkers {
  list(): WorkerInfo[];
  get(id: string): WorkerInfo | undefined;
  tail(id: string, lines: number): string | undefined;
  /** Types `text` in and submits it with Enter. */
  prompt(id: string, text: string): string | undefined;
  resume(id: string, text: string): string | undefined;
  /** Sends one Escape to cancel the agent's turn, only if it's mid-turn on screen; says whether it did. */
  cancelTurn(id: string): boolean;
  /** What the agent's screen shows now. */
  turnScreen(id: string): DroidScreen | undefined;
}

export interface VisitOptions {
  /** ⚙️ Settings → Subagents & visits → Visits. */
  on(): boolean;
  emit(msg: Extract<ServerMsg, { t: 'visits' } | { t: 'visit_say' }>): void;
  toast?(text: string, level: 'info' | 'warn', workerId?: string): void;
  prompts?: PromptSource;
  now?: () => number;
}

export interface VisitReply {
  status: number;
  body: Record<string, unknown>;
}

/** What the visitor's office-visit gets once it's done waiting. */
export interface VisitResult {
  ok: boolean;
  /** look: the host's screen. */
  text?: string;
  /** ask: the host's answer. */
  answer?: string;
  /** tell, handoff: typed into the host's session while the visitor stood there. */
  delivered?: boolean;
  /** tell, handoff: its session couldn't take it while the visitor stood there, so it's still queued to go in as soon as it can. */
  queued?: boolean;
  error?: string;
}

/** A worker on the roster, as office-visit shows it. */
export interface RosterEntry {
  id: string;
  name: string;
  desk: string;
  status: WorkerInfo['status'];
  busy: boolean;
  task?: string;
  activity?: string;
  you?: true;
  /** Whose desk it's at now, when it's out visiting. */
  visiting?: string;
}

interface Run {
  visit: Visit;
  visitorName: string;
  visitorDesk: string;
  visitorDeskId: string;
  hostName: string;
  hostDesk: string;
  hostDeskId: string;
  text: string;
  title?: string;
  urgent: boolean;
  lines: number;
  walkMs: number;
  /** Not on the list yet: the visitor's last visit, which it finishes (back at its own desk) first. */
  after?: string;
  /** ask: when the asker gives up. */
  deadline?: number;
  timeoutS?: number;
  /** When office-visit last asked how it's going: an asker that stops asking has gone. */
  lastPoll: number;
  delivered?: boolean;
  answeredAt?: number;
  result?: VisitResult;
}

/** A message waiting to be typed into a host's session. */
interface Note {
  visit: string;
  from: string;
  fromName: string;
  fromDesk: string;
  kind: Exclude<VisitKind, 'look'>;
  urgent: boolean;
  text: string;
  title?: string;
  deadline?: number;
  /** When the office set about cancelling the host's turn for it. */
  interruptedAt?: number;
}

const TEXT_MAX = 20_000;
const TITLE_MAX = 80;
const LINES_DEFAULT = 80;
const LINES_MAX = 400;
export const ASK_DEFAULT_S = 300;
export const ASK_MAX_S = 1800;
/** Leaning over the host's laptop. */
export const READ_MS = 3500;
/** Standing at the desk while the message goes in: at least this long, so the bubble can be read. */
export const TALK_MIN_MS = 3000;
/** A message that can't go in (a dialog, a host that needs the owner): the visitor waits this long, then leaves it in the queue. */
export const TALK_MAX_MS = 12_000;
/** After the answer, before walking back, so the reply's bubble can be read. */
export const LINGER_MS = 3000;
/** An asker whose office-visit hasn't checked in this long has gone (killed, or its turn stopped). */
export const ABANDON_MS = 20_000;
/** Someone typed into the host this recently: they may be mid-sentence, so the message waits. */
const TYPING_MS = 5000;
/** Never two messages into one session closer than this, so they can't run together in its input box. */
const GAP_MS = 2000;
/** After a message goes in, the next normal one waits for that turn, or this long if no turn starts. */
const SETTLE_MS = 15_000;
/**
 * After Escape, how long an urgent message waits for the turn to stop. Then it's typed in anyway:
 * Enter mid-turn steers droid's running turn.
 */
export const URGENT_WAIT_MS = 5000;
/** How long a finished visit's outcome is kept for office-visit to collect, and to explain a late reply. */
const KEEP_MS = 10 * 60_000;
const TICK_MS = 250;

const URGENT_LINE = "Delivery: urgent. The sender requested cancellation of your running turn. Handle promptly without overriding the owner's task.";

const ok = (body: Record<string, unknown>): VisitReply => ({ status: 200, body });
const no = (status: number, error: string): VisitReply => ({ status, body: { error } });
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max).trim() : '');
const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const deskLabel = (deskId: string) => DESK_BY_ID.get(deskId)?.label ?? deskId;
/** `v` if it's a whole number, kept to 1..`max`; `fallback` otherwise. */
const whole = (v: unknown, max: number, fallback: number) => (Number.isInteger(v) ? Math.min(max, Math.max(1, v as number)) : fallback);
/** Set off and not yet heading home: the visitor is at, or on its way to, the host's desk. */
const outVisiting = (r: Run) => r.after === undefined && r.visit.phase !== 'returning';

/** What a visitor's message is called, and how the office's toast says it was given. */
const SAYING: Record<Note['kind'], { what: string; verb: string; icon: string }> = {
  tell: { what: 'message', verb: 'told', icon: '💬' },
  ask: { what: 'question', verb: 'asked', icon: '❓' },
  handoff: { what: 'task', verb: 'handed a task to', icon: '📦' },
};

/** "about 4 minutes", "40 seconds": how long an asker still waits. */
export function waitWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} seconds`;
  return `about ${Math.round(s / 60)} minutes`;
}

/** A worker that takes part in visits: an agent at a desk here, hired by the owner rather than by a lead. */
export function independent(w: WorkerInfo): boolean {
  return w.kind === 'agent' && !w.lead && !w.guest && !w.cloud;
}

export class Visits {
  private runs = new Map<string, Run>();
  /** Visits that ended, with how, for an office-visit still collecting them or a reply that came late. */
  private ended = new Map<string, { run: Run; at: number; why?: string }>();
  private inbox = new Map<string, Note[]>();
  /** The last message typed into each host, and whether a turn has started since. */
  private last = new Map<string, { at: number; sawWork: boolean }>();
  private timer?: NodeJS.Timeout;
  private dirty = false;
  private now: () => number;

  constructor(
    private workers: VisitWorkers,
    private opts: VisitOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Every visit on the floor, as the browser shows them. */
  list(): Visit[] {
    return [...this.runs.values()].filter((r) => r.after === undefined).map((r) => ({ ...r.visit }));
  }

  /** Why `w` can't visit anyone, if it can't. */
  cannotVisit(w: WorkerInfo): string | undefined {
    if (!this.opts.on()) return 'Visits between workers are turned off in this office (⚙️ Settings → Subagents & visits → Visits)';
    if (w.lead) {
      const boss = this.workers.get(w.lead)?.name ?? 'your lead';
      return `You're a subagent of ${boss}: subagents don't visit other workers or see the roster. Ask ${boss} with office-workers report --question instead`;
    }
    if (!independent(w)) return 'Only agents at a desk on this floor visit other workers';
    return undefined;
  }

  /** An office-visit request from `caller`, a worker that proved who it is with its hook token. */
  handle(caller: WorkerInfo, raw: unknown): VisitReply {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const why = this.cannotVisit(caller);
    if (why) return no(403, why);
    const reply = this.act(caller, b);
    this.flush();
    return reply;
  }

  /** A worker on the floor changed: a host may have started the turn its last message began. */
  onWorker(w: WorkerInfo) {
    const last = this.last.get(w.id);
    if (last && w.status === 'working') last.sawWork = true;
  }

  /** A worker left the floor: its own visits go with it, and its visitors walk back. */
  onWorkerGone(id: string) {
    const now = this.now();
    for (const run of this.runs.values()) {
      if (run.visit.visitor === id) {
        this.end(run, now, `${run.visitorName} left the floor`);
        this.dirty = true;
      } else if (run.visit.host === id) {
        this.fail(run, `${run.hostName} left the floor`, now);
      }
    }
    this.inbox.delete(id);
    this.last.delete(id);
    for (const host of [...this.inbox.keys()]) this.keepNotes(host, (n) => n.from !== id);
    this.flush();
  }

  /** Moves every visit on by the clock and types in whatever messages can go in now. */
  tick(now = this.now()) {
    if (!this.opts.on()) {
      // Turned off: nobody waits on an answer that can't come, and nothing more is typed in.
      for (const run of this.runs.values()) if (!run.result) this.fail(run, 'Visits were turned off in this office', now);
      this.inbox.clear();
    }
    for (const run of [...this.runs.values()]) this.step(run, now);
    for (const host of [...this.inbox.keys()]) this.deliver(host, now);
    for (const [id, e] of this.ended) if (now - e.at > KEEP_MS) this.ended.delete(id);
    this.flush();
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.opts.emit({ t: 'visits', visits: this.list() });
  }

  private act(caller: WorkerInfo, b: Record<string, unknown>): VisitReply {
    switch (b.action) {
      case 'whoami':
        return ok(this.whoami(caller));
      case 'roster':
        return ok({ ...this.whoami(caller), roster: this.roster(caller) });
      case 'visit':
        return this.begin(caller, b);
      case 'status':
        return this.status(caller, b);
      case 'reply':
        return this.reply(caller, b);
      default:
        return no(400, 'Unknown action: use whoami, roster, visit, status or reply');
    }
  }

  private whoami(w: WorkerInfo): Record<string, unknown> {
    const away = [...this.runs.values()].find((r) => r.visit.visitor === w.id && outVisiting(r));
    const waiting = this.inbox.get(w.id)?.length ?? 0;
    return {
      you: { id: w.id, name: w.name, desk: deskLabel(w.deskId) },
      ...(away ? { visiting: { visit: away.visit.id, host: away.hostName, kind: away.visit.kind } } : {}),
      ...(waiting ? { queued: waiting } : {}),
    };
  }

  private roster(caller: WorkerInfo): RosterEntry[] {
    const at = new Map<string, string>();
    for (const r of this.runs.values()) if (outVisiting(r)) at.set(r.visit.visitor, r.hostName);
    return this.workers
      .list()
      .filter(independent)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((w) => ({
        id: w.id,
        name: w.name,
        desk: deskLabel(w.deskId),
        status: w.status,
        busy: isBusy(w.status),
        ...(w.task ? { task: w.task.name } : {}),
        ...(w.activity ? { activity: w.activity } : {}),
        ...(w.id === caller.id ? { you: true as const } : {}),
        ...(at.has(w.id) ? { visiting: at.get(w.id) } : {}),
      }));
  }

  /** The independent worker on this floor that `ref` names (its id or name), or why not. */
  private resolve(caller: WorkerInfo, ref: unknown): WorkerInfo | VisitReply {
    const want = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
    if (!want) return no(400, 'Name the worker to visit: office-visit roster lists who is here');
    const found = this.workers.list().find((w) => w.id === want || w.name.toLowerCase() === want);
    if (!found) return no(404, `No one called ${clip(String(ref), 40)} on this floor's roster: office-visit roster lists who you can visit`);
    if (found.id === caller.id) return no(400, "That's you: visit someone else");
    if (found.lead) return no(403, `${found.name} is a subagent: subagents can't be visited, and only their own lead reaches them`);
    if (!independent(found)) return no(403, `${found.name} isn't an agent at a desk here, so it can't be visited`);
    return found;
  }

  private begin(caller: WorkerInfo, b: Record<string, unknown>): VisitReply {
    const kind = b.kind as VisitKind;
    if (!VISIT_KINDS.includes(kind)) return no(400, `A visit is one of ${VISIT_KINDS.join(', ')}`);
    const host = this.resolve(caller, b.worker);
    if (!('id' in host)) return host;
    const text = str(b.text, TEXT_MAX);
    if (kind !== 'look' && !text) return no(400, `Give the ${SAYING[kind].what} on stdin (office-visit ${kind} ${host.name} <<'EOF' … EOF)`);
    if (kind === 'look' && this.workers.tail(host.id, 1) === undefined) return no(409, `${host.name} has no terminal yet: it's ${host.status}`);
    const mine = [...this.runs.values()].filter((r) => r.visit.visitor === caller.id);
    // One whose outcome is in (a look that's read) is only finishing up: the next one waits for it.
    const busy = mine.find((r) => r.after !== undefined || (r.visit.phase !== 'returning' && !r.result));
    if (busy) return no(409, `You're already on a visit to ${busy.hostName} (${busy.visit.id}): one at a time`);
    const now = this.now();
    const back = mine.find((r) => r.after === undefined);
    const timeoutS = whole(b.timeout, ASK_MAX_S, ASK_DEFAULT_S);
    const id = `v-${randomBytes(4).toString('hex')}`;
    const run: Run = {
      visit: { id, visitor: caller.id, host: host.id, kind, phase: 'walking', slot: 0, since: now },
      visitorName: caller.name,
      visitorDesk: deskLabel(caller.deskId),
      visitorDeskId: caller.deskId,
      hostName: host.name,
      hostDesk: deskLabel(host.deskId),
      hostDeskId: host.deskId,
      text,
      urgent: b.urgent === true,
      lines: whole(b.lines, LINES_MAX, LINES_DEFAULT),
      walkMs: 0,
      lastPoll: now,
      ...(kind === 'ask' ? { timeoutS } : {}),
    };
    const title = str(b.title, TITLE_MAX);
    if (kind === 'handoff' && title) run.title = title;
    // Still finishing the last visit: it sets off again once it's home.
    if (back) run.after = back.visit.id;
    this.runs.set(id, run);
    if (!back) this.appear(run, now);
    return ok({ visit: id, kind, host: { id: host.id, name: host.name, desk: run.hostDesk }, ...(back ? { after: this.homeIn(back, now) } : { walkMs: run.walkMs }), ...(run.timeoutS !== undefined ? { timeout: timeoutS } : {}) });
  }

  /** How `caller`'s visit is going, for office-visit to wait on. */
  private status(caller: WorkerInfo, b: Record<string, unknown>): VisitReply {
    const id = typeof b.visit === 'string' ? b.visit : '';
    const run = this.runs.get(id);
    if (run && run.visit.visitor === caller.id) {
      run.lastPoll = this.now();
      return ok({ visit: id, kind: run.visit.kind, phase: run.after === undefined ? run.visit.phase : 'pending', host: run.hostName, done: !!run.result, ...(run.result ?? {}) });
    }
    const gone = this.ended.get(id);
    if (gone && gone.run.visit.visitor === caller.id) {
      return ok({ visit: id, kind: gone.run.visit.kind, phase: 'ended', host: gone.run.hostName, done: true, ...(gone.run.result ?? { ok: false, error: gone.why ?? 'The visit ended' }) });
    }
    return no(404, `No visit ${clip(id, 20) || '(none given)'} of yours: the office may have restarted, which ends every visit`);
  }

  /** The host answers an ask that's waiting at its desk. */
  private reply(caller: WorkerInfo, b: Record<string, unknown>): VisitReply {
    const id = typeof b.visit === 'string' ? b.visit.trim() : '';
    const text = str(b.text, TEXT_MAX);
    const run = this.runs.get(id) ?? this.ended.get(id)?.run;
    if (!run || run.visit.host !== caller.id || run.visit.kind !== 'ask') return no(404, `No question ${clip(id, 20) || '(none given)'} is waiting for you: the visit id is in the message that asked it`);
    if (!text) return no(400, `Give the answer on stdin (office-visit reply ${id} <<'EOF' … EOF)`);
    if (run.result || !this.runs.has(id)) return no(409, `${run.visitorName} isn't waiting any more: ${run.result?.error ?? 'its visit ended'}. Tell it with office-visit tell ${run.visitorName} if it still needs the answer`);
    const now = this.now();
    run.answeredAt = now;
    run.result = { ok: true, answer: text };
    this.dropNote(run.visit.host, id);
    this.opts.emit({ t: 'visit_say', visit: id, worker: caller.id, text });
    this.opts.toast?.(`💬 ${caller.name} answered ${run.visitorName}: “${clip(text, 90)}”`, 'info', caller.id);
    return ok({ to: run.visitorName });
  }

  /** About how long until a visit that's finishing up has its visitor back at its own desk. */
  private homeIn(run: Run, now: number): number {
    const spent = now - run.visit.since;
    if (run.visit.phase === 'returning') return Math.max(0, (run.visit.returnMs ?? run.walkMs) - spent);
    let stay = 0;
    if (run.visit.phase === 'reading') stay = READ_MS - spent;
    else if (run.visit.phase === 'talking') stay = TALK_MIN_MS - spent;
    else if (run.visit.phase === 'waiting' && run.answeredAt !== undefined) stay = LINGER_MS - (now - run.answeredAt);
    else if (run.visit.phase === 'walking') stay = run.walkMs - spent;
    return Math.max(0, stay) + run.walkMs;
  }

  /** It sets off: a place at the host's desk, and the walk there. */
  private appear(run: Run, now: number) {
    run.after = undefined;
    if (run.timeoutS !== undefined) run.deadline = now + run.timeoutS * 1000;
    const taken = new Set([...this.runs.values()].filter((r) => r !== run && r.after === undefined && r.visit.host === run.visit.host).map((r) => r.visit.slot));
    let slot = 0;
    while (taken.has(slot)) slot++;
    run.visit.slot = slot;
    run.walkMs = visitWalkMs(visitRoute(run.visitorDeskId, run.hostDeskId, slot));
    this.setPhase(run, 'walking', now);
  }

  private setPhase(run: Run, phase: VisitPhase, now: number) {
    if (phase === 'returning' && run.visit.phase === 'walking') run.visit.returnMs = Math.min(run.walkMs, Math.max(0, now - run.visit.since));
    run.visit.phase = phase;
    run.visit.since = now;
    this.dirty = true;
  }

  /** Off the list of visits under way, kept with how it ended (`why`, when it has no result to say so). */
  private end(run: Run, now: number, why?: string) {
    this.runs.delete(run.visit.id);
    this.ended.set(run.visit.id, { run, at: now, why });
  }

  private fail(run: Run, error: string, now: number) {
    if (!run.result) run.result = { ok: false, error };
    this.dropNote(run.visit.host, run.visit.id);
    if (run.after !== undefined) this.end(run, now);
    else if (run.visit.phase !== 'returning') this.setPhase(run, 'returning', now);
  }

  private step(run: Run, now: number) {
    const { visit } = run;
    if (run.after !== undefined) {
      if (this.runs.has(run.after)) return;
      const host = this.workers.get(visit.host);
      if (!host || !independent(host)) {
        run.result = { ok: false, error: `${run.hostName} isn't on the floor any more` };
        this.end(run, now);
        return;
      }
      this.appear(run, now);
      return;
    }
    const spent = now - visit.since;
    switch (visit.phase) {
      case 'walking':
        if (spent >= run.walkMs) this.arrive(run, now);
        return;
      case 'reading':
        if (spent >= READ_MS) this.setPhase(run, 'returning', now);
        return;
      case 'talking':
        if ((run.delivered || run.result) && spent >= TALK_MIN_MS) {
          run.result ??= { ok: true, delivered: true };
          this.setPhase(run, 'returning', now);
        } else if (spent >= TALK_MAX_MS) {
          run.result ??= { ok: true, queued: true };
          this.setPhase(run, 'returning', now);
        }
        return;
      case 'waiting':
        if (run.answeredAt !== undefined) {
          if (now - run.answeredAt >= LINGER_MS) this.setPhase(run, 'returning', now);
        } else if (run.result) this.setPhase(run, 'returning', now);
        else if (run.deadline !== undefined && now >= run.deadline) this.fail(run, `${run.hostName} didn't answer within ${run.timeoutS} seconds`, now);
        else if (now - run.lastPoll > ABANDON_MS) this.fail(run, 'You stopped waiting', now);
        return;
      case 'returning':
        if (spent >= (visit.returnMs ?? run.walkMs)) {
          this.end(run, now);
          this.dirty = true;
        }
        return;
    }
  }

  /** At the host's desk: it reads the screen, or says its piece. */
  private arrive(run: Run, now: number) {
    const { visit } = run;
    if (visit.kind === 'look') {
      const text = this.workers.tail(visit.host, run.lines);
      if (text === undefined) {
        run.result = { ok: false, error: `${run.hostName} has no terminal any more` };
        this.setPhase(run, 'returning', now);
        return;
      }
      run.result = { ok: true, text };
      this.setPhase(run, 'reading', now);
      this.opts.toast?.(`👀 ${run.visitorName} is reading ${run.hostName}'s screen`, 'info', visit.visitor);
      return;
    }
    this.setPhase(run, visit.kind === 'ask' ? 'waiting' : 'talking', now);
    this.opts.emit({ t: 'visit_say', visit: visit.id, worker: visit.visitor, text: run.title ? `${run.title}: ${run.text}` : run.text });
    const note: Note = {
      visit: visit.id,
      from: visit.visitor,
      fromName: run.visitorName,
      fromDesk: run.visitorDesk,
      kind: visit.kind,
      urgent: run.urgent,
      text: run.text,
      ...(run.title ? { title: run.title } : {}),
      ...(run.deadline !== undefined ? { deadline: run.deadline } : {}),
    };
    const notes = this.inbox.get(visit.host) ?? [];
    // Urgent ones go ahead of the normal ones, in the order they came.
    const at = note.urgent ? notes.findIndex((n) => !n.urgent) : -1;
    if (at >= 0) notes.splice(at, 0, note);
    else notes.push(note);
    this.inbox.set(visit.host, notes);
    const { icon, verb } = SAYING[visit.kind];
    this.opts.toast?.(`${icon} ${run.visitorName} ${verb} ${run.hostName}${run.urgent ? ' (urgent)' : ''}: “${clip(run.text, 90)}”`, 'info', visit.visitor);
    this.deliver(visit.host, now);
  }

  private dropNote(host: string, visit: string) {
    this.keepNotes(host, (n) => n.visit !== visit);
  }

  /** Keeps only the host's queued messages that pass `keep`. */
  private keepNotes(host: string, keep: (n: Note) => boolean) {
    const notes = this.inbox.get(host);
    if (!notes) return;
    const kept = notes.filter(keep);
    if (kept.length) this.inbox.set(host, kept);
    else this.inbox.delete(host);
  }

  /** Types the host's next message in, if it can take one now. One at a time, so two visitors never interleave. */
  private deliver(hostId: string, now: number) {
    const notes = this.inbox.get(hostId);
    const note = notes?.[0];
    if (!notes || !note) return;
    const host = this.workers.get(hostId);
    if (!host) return;
    const last = this.last.get(hostId);
    if (last && now - last.at < GAP_MS) return;
    // The last message's turn hasn't started (or ended): a normal one waits for it.
    if (!note.urgent && last && !last.sawWork && now - last.at < SETTLE_MS) return;
    // Typed into lately by someone (not by the last message from here): they may be mid-sentence.
    const typed = host.lastInputAt !== undefined && now - host.lastInputAt < TYPING_MS && !(last && host.lastInputAt <= last.at + 1000);
    if (typed) return;
    // A dialog the status hasn't caught up with: Enter would answer it, even if the last status was done.
    if (this.workers.turnScreen(hostId) === 'asking') return;
    switch (host.status) {
      case 'starting':
      case 'needs_input':
        // A permission prompt is the owner's to answer: even an urgent message waits for it.
        return;
      case 'working':
        // A normal message steers the running turn: plain Enter puts it in front of droid now,
        // and droid reads it once its current tool call finishes. Only an urgent one stops it.
        if (!note.urgent) break;
        if (note.interruptedAt === undefined) {
          note.interruptedAt = now;
          // The status can lag the screen: a turn that has just ended on screen gets no key at all.
          if (this.workers.cancelTurn(hostId)) return;
        }
        // Stopped on screen before its status catches up (the Stop hook and the screen settle take seconds).
        if (this.workers.turnScreen(hostId) !== 'idle' && now - note.interruptedAt < URGENT_WAIT_MS) return;
        break;
    }
    const text = this.noteText(note, now);
    const err = isAsleep(host.status) ? this.workers.resume(hostId, text) : this.workers.prompt(hostId, text);
    notes.shift();
    if (!notes.length) this.inbox.delete(hostId);
    const run = this.runs.get(note.visit);
    if (err) {
      if (run) this.fail(run, `Couldn't get it to ${host.name}: ${err}`, now);
      return;
    }
    this.last.set(hostId, { at: now, sawWork: false });
    if (run) run.delivered = true;
  }

  /** The message as the host's session gets it: who it's from, at which desk, and how to answer. */
  private noteText(n: Note, now: number): string {
    return officePrompt(this.opts.prompts, `visit.${n.kind}`, {
      from: n.fromName,
      desk: n.fromDesk,
      ...workerMessageVars(`${n.title ?? ''}\n${n.text}`),
      text: n.text,
      urgent: n.urgent ? URGENT_LINE : '',
      visit: n.visit,
      title: n.title ? `Task: ${n.title}` : '',
      wait: n.deadline !== undefined ? waitWords(n.deadline - now) : '',
    });
  }
}
