// Independent workers visiting each other's desks on one floor: the roster, reading a terminal,
// telling, asking and handing off work. The Office MCP calls this service directly.
// Only workers with no lead take part: a subagent is never on the
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
// Asks walk home after delivery like tells; replies arrive later as queued session deliveries.
// Visits and open questions aren't kept on disk: a restart ends them.

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
  /** Mid-turn, through its hooks rather than typed in (see WorkerManager.tell). */
  tell?(id: string, text: string): string | undefined;
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

/** The outcome of delivering a visit, not of waiting for an answer. */
export interface VisitResult {
  ok: boolean;
  /** Typed into the host's session while the visitor stood there. */
  delivered?: boolean;
  /** Its session couldn't take it while the visitor stood there, so it's still queued. */
  queued?: boolean;
  error?: string;
}

/** A worker on the roster. */
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
  walkMs: number;
  /** Not on the list yet: the visitor's last visit, which it finishes (back at its own desk) first. */
  after?: string;
  /** Ask delivery expires after this time; a delivered question gets a fresh reply window. */
  deadline?: number;
  delivered?: boolean;
  answeredAt?: number;
  questionError?: string;
  result?: VisitResult;
}

/** A message waiting to be typed into a host's session. */
interface Note {
  visit: string;
  from: string;
  fromName: string;
  fromDesk: string;
  kind: VisitKind | 'reply';
  urgent: boolean;
  text: string;
  title?: string;
  /** When the office set about cancelling the host's turn for it. */
  interruptedAt?: number;
  /** A reply's question, reopened if the reply can't be typed in. */
  question?: Run;
}

const TEXT_MAX = 20_000;
const TITLE_MAX = 80;
const LINES_DEFAULT = 80;
const LINES_MAX = 400;
export const ASK_REPLY_MS = 30 * 60_000;
/** Standing at the desk while the message goes in: at least this long, so the bubble can be read. */
export const TALK_MIN_MS = 3000;
/** A message that can't go in (a dialog, a host that needs the owner): the visitor waits this long, then leaves it in the queue. */
export const TALK_MAX_MS = 12_000;
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
/** How long a finished visit's outcome, or an expired question, is kept to explain a late reply. */
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
const SAYING: Record<VisitKind, { what: string; verb: string; icon: string }> = {
  tell: { what: 'message', verb: 'told', icon: '💬' },
  ask: { what: 'question', verb: 'asked', icon: '❓' },
  handoff: { what: 'task', verb: 'handed a task to', icon: '📦' },
};

/** "about 30 minutes", "40 seconds": the reply window in words. */
export function waitWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} seconds`;
  return `about ${Math.round(s / 60)} minutes`;
}

/** A worker that takes part in visits: an agent at a desk here, hired by the owner rather than by a lead. */
export function independent(w: WorkerInfo): boolean {
  return w.kind === 'agent' && !w.lead && !w.cloud;
}

export class Visits {
  private runs = new Map<string, Run>();
  /** Reply eligibility outlives the asker's walk home and does not require polling. */
  private questions = new Map<string, Run>();
  /** Visits that ended, with how, to explain a reply that came late. */
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
      return `You're a subagent of ${boss}: subagents don't visit other workers or see the roster. Ask ${boss} with team_report and question: true instead`;
    }
    if (!independent(w)) return 'Only agents at a desk on this floor visit other workers';
    return undefined;
  }

  /** A request from the authenticated Office MCP caller. */
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
    for (const run of [...this.questions.values()]) {
      if (run.visit.visitor === id || run.visit.host === id) this.closeQuestion(run, `${this.workers.get(id)?.name ?? (run.visit.visitor === id ? run.visitorName : run.hostName)} left the floor`, now);
    }
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
      for (const run of [...this.questions.values()]) this.closeQuestion(run, 'Visits were turned off in this office', now);
      this.inbox.clear();
    }
    for (const run of [...this.questions.values()]) {
      if (run.deadline !== undefined && now >= run.deadline) this.closeQuestion(run, 'This ask expired: questions stay open for 30 minutes after delivery. Use visit_message to ask again or send a tell.', now);
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
      case 'look': {
        const host = this.resolve(caller, b.worker);
        if (!('id' in host)) return host;
        const text = this.workers.tail(host.id, whole(b.lines, LINES_MAX, LINES_DEFAULT));
        return text === undefined ? no(409, `${host.name} has no terminal yet: it's ${host.status}`) : ok({ host: host.name, text });
      }
      case 'reply':
        return this.reply(caller, b);
      default:
        return no(400, 'Unknown action: use whoami, roster, visit, look or reply');
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
    if (!want) return no(400, 'Name the worker to visit: visit_roster lists who is here');
    const found = this.workers.list().find((w) => w.id === want || w.name.toLowerCase() === want);
    if (!found) return no(404, `No one called ${clip(String(ref), 40)} on this floor's roster: visit_roster lists who you can visit`);
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
    if (!text) return no(400, `Give the ${SAYING[kind].what} in visit_message's text parameter`);
    const mine = [...this.runs.values()].filter((r) => r.visit.visitor === caller.id);
    // One walking home is only finishing up: the next one waits for it.
    const busy = mine.find((r) => r.after !== undefined || r.visit.phase !== 'returning');
    if (busy) return no(409, `You're already on a visit to ${busy.hostName} (${busy.visit.id}): one at a time`);
    const now = this.now();
    const back = mine.find((r) => r.after === undefined);
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
      walkMs: 0,
    };
    const title = str(b.title, TITLE_MAX);
    if (kind === 'handoff' && title) run.title = title;
    // Still finishing the last visit: it sets off again once it's home.
    if (back) run.after = back.visit.id;
    this.runs.set(id, run);
    if (kind === 'ask') this.questions.set(id, run);
    if (!back) this.appear(run, now);
    return ok({ visit: id, kind, host: { id: host.id, name: host.name, desk: run.hostDesk }, ...(back ? { after: this.homeIn(back, now) } : { walkMs: run.walkMs }), queued: true });
  }

  /** The host answers a delivered ask; the answer is a new non-urgent session delivery. */
  private reply(caller: WorkerInfo, b: Record<string, unknown>): VisitReply {
    const id = typeof b.visit === 'string' ? b.visit.trim() : '';
    const text = str(b.text, TEXT_MAX);
    const run = this.questions.get(id) ?? this.runs.get(id) ?? this.ended.get(id)?.run;
    if (!run || run.visit.host !== caller.id || run.visit.kind !== 'ask') return no(404, `No question ${clip(id, 20) || '(none given)'} is addressed to you: the visit id is in the message that asked it`);
    if (!text) return no(400, 'Give the answer in visit_reply’s text parameter');
    const now = this.now();
    if (run.deadline !== undefined && now >= run.deadline && this.questions.has(id)) this.closeQuestion(run, 'This ask expired: questions stay open for 30 minutes after delivery. Use visit_message to send a tell instead.', now);
    if (run.questionError) return no(409, run.questionError);
    if (run.answeredAt !== undefined) return no(409, `You already answered this ask. Use visit_message to tell ${run.visitorName} anything else`);
    if (!this.questions.has(id)) return no(409, 'This ask is no longer open. Use visit_message to send a tell instead');
    if (!run.delivered) return no(409, 'This question has not been delivered to your session yet');
    run.answeredAt = now;
    this.questions.delete(id);
    const notes = this.inbox.get(run.visit.visitor) ?? [];
    const note: Note = { visit: id, from: caller.id, fromName: caller.name, fromDesk: deskLabel(caller.deskId), kind: 'reply', urgent: false, text, question: run };
    notes.push(note);
    this.inbox.set(run.visit.visitor, notes);
    const error = this.deliver(run.visit.visitor, now);
    if (error && !notes.includes(note)) return no(409, `Couldn't deliver your answer to ${run.visitorName}: ${error}. Retry visit_reply when its session is available`);
    if (!this.runs.has(id)) this.ended.set(id, { run, at: now });
    this.opts.emit({ t: 'visit_say', visit: id, worker: caller.id, text });
    this.opts.toast?.(`💬 ${caller.name} answered ${run.visitorName}: “${clip(text, 90)}”`, 'info', caller.id);
    return ok({ visit: id, to: run.visitorName, ...(notes.includes(note) ? { queued: true } : { delivered: true }) });
  }

  /** A reply that couldn't be typed in leaves its question open, so the host can answer again. */
  private reopen(run: Run, note: Note, error: string) {
    if (run.questionError) return;
    run.answeredAt = undefined;
    this.questions.set(run.visit.id, run);
    this.opts.toast?.(`Couldn't get ${note.fromName}'s answer to ${run.visitorName}: ${error}. The question is open again.`, 'warn', note.from);
  }

  private closeQuestion(run: Run, error: string, now: number) {
    this.questions.delete(run.visit.id);
    run.questionError = error;
    this.dropNote(run.visit.host, run.visit.id);
    if (!this.runs.has(run.visit.id)) this.ended.set(run.visit.id, { run, at: now, why: error });
    if (!run.delivered && this.runs.has(run.visit.id)) this.fail(run, error, now);
  }

  /** About how long until a visit that's finishing up has its visitor back at its own desk. */
  private homeIn(run: Run, now: number): number {
    const spent = now - run.visit.since;
    if (run.visit.phase === 'returning') return Math.max(0, (run.visit.returnMs ?? run.walkMs) - spent);
    let stay = 0;
    if (run.visit.phase === 'talking') stay = TALK_MIN_MS - spent;
    else if (run.visit.phase === 'walking') stay = run.walkMs - spent;
    return Math.max(0, stay) + run.walkMs;
  }

  /** It sets off: a place at the host's desk, and the walk there. */
  private appear(run: Run, now: number) {
    run.after = undefined;
    if (run.visit.kind === 'ask') run.deadline = now + ASK_REPLY_MS;
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
    if (run.visit.kind === 'ask') {
      this.questions.delete(run.visit.id);
      run.questionError = error;
    }
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
        this.fail(run, `${run.hostName} isn't on the floor any more`, now);
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
      case 'talking':
        if ((run.delivered || run.result) && spent >= TALK_MIN_MS) {
          run.result ??= { ok: true, delivered: true };
          this.setPhase(run, 'returning', now);
        } else if (spent >= TALK_MAX_MS) {
          run.result ??= { ok: true, queued: true };
          this.setPhase(run, 'returning', now);
        }
        return;
      case 'returning':
        if (spent >= (visit.returnMs ?? run.walkMs)) {
          this.end(run, now);
          this.dirty = true;
        }
        return;
    }
  }

  /** At the host's desk: it says its piece. */
  private arrive(run: Run, now: number) {
    const { visit } = run;
    this.setPhase(run, 'talking', now);
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
    // A remote host has no terminal to pace: its MCP inbox queues the message.
    if (!host.remote && this.mustWait(hostId, host, note, now)) return;
    const text = this.noteText(note);
    // A normal message mid-turn goes through the host's hooks when they can carry it (see WorkerManager.tell).
    const err = host.remote ? this.workers.prompt(hostId, text) : isAsleep(host.status) ? this.workers.resume(hostId, text) : !note.urgent && this.workers.tell ? this.workers.tell(hostId, text) : this.workers.prompt(hostId, text);
    notes.shift();
    if (!notes.length) this.inbox.delete(hostId);
    const run = note.kind === 'reply' ? undefined : (this.runs.get(note.visit) ?? this.questions.get(note.visit));
    if (err) {
      if (run) this.fail(run, `Couldn't get it to ${host.name}: ${err}`, now);
      if (note.question) this.reopen(note.question, note, err);
      return err;
    }
    this.last.set(hostId, { at: now, sawWork: false });
    if (run) {
      run.delivered = true;
      if (run.visit.kind === 'ask') run.deadline = now + ASK_REPLY_MS;
    }
  }

  /** Whether a local host's terminal can't take `note` yet; may stop its turn for an urgent one. */
  private mustWait(hostId: string, host: WorkerInfo, note: Note, now: number): boolean {
    const last = this.last.get(hostId);
    if (last && now - last.at < GAP_MS) return true;
    // The last message's turn hasn't started (or ended): a normal one waits for it.
    if (!note.urgent && last && !last.sawWork && now - last.at < SETTLE_MS) return true;
    // Typed into lately by someone (not by the last message from here): they may be mid-sentence.
    if (host.lastInputAt !== undefined && now - host.lastInputAt < TYPING_MS && !(last && host.lastInputAt <= last.at + 1000)) return true;
    // A dialog the status hasn't caught up with: Enter would answer it, even if the last status was done.
    if (this.workers.turnScreen(hostId) === 'asking') return true;
    switch (host.status) {
      case 'starting':
      case 'needs_input':
        // A permission prompt is the owner's to answer: even an urgent message waits for it.
        return true;
      case 'working':
        // A normal message steers the running turn: plain Enter puts it in front of droid now,
        // and droid reads it once its current tool call finishes. Only an urgent one stops it.
        if (!note.urgent) return false;
        if (note.interruptedAt === undefined) {
          note.interruptedAt = now;
          // The status can lag the screen: a turn that has just ended on screen gets no key at all.
          if (this.workers.cancelTurn(hostId)) return true;
        }
        // Stopped on screen before its status catches up (the Stop hook and the screen settle take seconds).
        return this.workers.turnScreen(hostId) !== 'idle' && now - note.interruptedAt < URGENT_WAIT_MS;
    }
    return false;
  }

  /** The message as the host's session gets it: who it's from, at which desk, and how to answer. */
  private noteText(n: Note): string {
    return officePrompt(this.opts.prompts, `visit.${n.kind}`, {
      from: n.fromName,
      desk: n.fromDesk,
      ...workerMessageVars(`${n.title ?? ''}\n${n.text}`),
      text: n.text,
      urgent: n.urgent ? URGENT_LINE : '',
      visit: n.visit,
      title: n.title ? `Task: ${n.title}` : '',
      wait: n.kind === 'ask' ? waitWords(ASK_REPLY_MS) : '',
    });
  }
}
