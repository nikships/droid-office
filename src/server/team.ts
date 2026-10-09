// A floor's leads and their subagents. Any agent at a desk, and the Team lead at its kiosk, can hire
// subagents with the office-workers command (bin/office-workers.js), which talks to /office/workers
// with the droid's own hook token. A subagent is a real droid: it sits at the free desk nearest
// its lead, with its own laptop and terminal, and its WorkerInfo.lead says whose it is. This keeps
// what the lead hasn't heard yet: its subagents' reports and questions, and when one finishes a
// turn, needs input in its terminal, stops or leaves. A lead at rest is told when there's news
// (SubagentSettings.wakeLead), so it doesn't have to sit in `office-workers wait`.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DESK_BY_ID, STATION_AGENT, nearestFreeSeat } from '../shared/layout.js';
import { AGENT_EFFORTS, isAgentEffort, type AgentChoice, type SubagentSettings, type WorkerInfo, type WorkerStatus, type WorkerTask } from '../shared/protocol.js';
import { isAsleep } from '../shared/status.js';
import { officePrompt, type PromptSource } from './prompts.js';

/** What the team needs from the floor's droids. Narrow on purpose, so a test can fake it. */
export interface TeamWorkers {
  list(): WorkerInfo[];
  get(id: string): WorkerInfo | undefined;
  deskOccupied(deskId: string): boolean;
  readonly officeDefault: AgentChoice | undefined;
  /** Hires `lead`'s subagent at `deskId`; returns it, or why not. */
  hire(deskId: string, by: string, prompt: string, worktree: boolean, choice: Partial<AgentChoice>, lead: string): WorkerInfo | string;
  prompt(id: string, text: string): string | undefined;
  resume(id: string, prompt?: string): string | undefined;
  kill(id: string): Promise<{ note?: string; error?: string }>;
  tail(id: string, lines: number): string | undefined;
  setTask(id: string, task: WorkerTask): void;
  fetchBase?(): Promise<void> | undefined;
}

export interface TeamOptions {
  dataDir: string;
  /** The floor's checkout, which worktree paths are relative to. */
  dir: string;
  /** It's a git checkout, so subagents can have worktrees. */
  git: boolean;
  settings(): SubagentSettings;
  prompts?: PromptSource;
  toast(text: string, level: 'info' | 'warn', workerId?: string): void;
  /** How long news waits before a lead at rest is told, so a report and the turn ending with it go as one. */
  nudgeDelayMs?: number;
  now?: () => number;
}

export type TeamEventKind = 'report' | 'question' | 'done' | 'needs_input' | 'stopped' | 'left';

/** Something a lead hasn't heard yet about one of its subagents. */
export interface TeamEvent {
  seq: number;
  lead: string;
  worker: string;
  /** The subagent's name, which outlives it. */
  name: string;
  kind: TeamEventKind;
  text?: string;
  at: number;
  /** Handed to the lead by `office-workers wait`. */
  seen?: boolean;
}

/** A subagent as `office-workers` shows it. */
export interface TeamMember {
  id: string;
  name: string;
  status: WorkerStatus;
  desk: string;
  model?: string;
  effort?: string;
  /** Its own worktree, by its full path. */
  worktree?: { path: string; branch: string };
  activity?: string;
  task?: string;
  pr?: { number: number; url: string };
  /** It has been given its task and isn't in the middle of a turn now. */
  settled: boolean;
  /** What it last reported or asked. */
  report?: { text: string; question: boolean; at: number };
}

export interface TeamReply {
  status: number;
  body: Record<string, unknown>;
}

const TASK_MAX = 20_000;
const TITLE_MAX = 80;
const READ_DEFAULT = 80;
const READ_MAX = 400;
/** How many events the floor keeps, all leads together. */
const LOG_MAX = 400;
/** Someone typed into the lead this recently: they may be mid-sentence, so news waits. */
const TYPING_MS = 5000;

/** The most telling news about one subagent, when there's more than one. */
const WEIGHT: Record<TeamEventKind, number> = { question: 5, report: 4, needs_input: 3, left: 2, stopped: 2, done: 1 };
const NEWS: Record<TeamEventKind, string> = {
  question: 'asked you a question',
  report: 'reported back',
  needs_input: 'needs someone to answer it in its own terminal',
  left: 'left',
  stopped: 'stopped',
  done: 'finished its turn without reporting',
};

const ok = (body: Record<string, unknown>): TeamReply => ({ status: 200, body });
const no = (status: number, error: string): TeamReply => ({ status, body: { error } });
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : '');
const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

export class Team {
  private log: TeamEvent[] = [];
  private seq = 0;
  /** Per lead: the last event it has been woken for. */
  private nudged = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** The last status, name and lead seen of each droid, to tell what changed (and who left). */
  private known = new Map<string, { name: string; lead?: string; status: WorkerStatus }>();
  /** Subagents that have reported in the turn they're in, whose turn ending is no news. */
  private reported = new Set<string>();
  private path: string;
  private now: () => number;

  constructor(
    private workers: TeamWorkers,
    private opts: TeamOptions,
  ) {
    this.path = path.join(opts.dataDir, 'team.json');
    this.now = opts.now ?? Date.now;
    this.restore();
    for (const w of workers.list()) this.known.set(w.id, { name: w.name, lead: w.lead, status: w.status });
  }

  /** A droid on the floor changed: a subagent's turn may have ended, or a lead may have come to rest with news. */
  onWorker(w: WorkerInfo) {
    const prev = this.known.get(w.id);
    this.known.set(w.id, { name: w.name, lead: w.lead, status: w.status });
    if (!prev || prev.status === w.status) return;
    if (w.status === 'working' && (prev.status === 'done' || prev.status === 'idle')) this.reported.delete(w.id);
    if ((w.status === 'done' || w.status === 'idle') && this.unnudged(w.id).length) this.scheduleNudge(w.id);
    if (!w.lead || prev.status === 'offline') return;
    let kind: TeamEventKind | undefined;
    if (w.status === 'done' && (prev.status === 'working' || prev.status === 'needs_input')) {
      if (this.reported.delete(w.id)) return;
      kind = 'done';
    } else if (w.status === 'needs_input') kind = 'needs_input';
    else if (w.status === 'exited') kind = 'stopped';
    if (!kind) return;
    const text = kind === 'needs_input' ? w.activity : kind === 'done' ? (w.task?.summary ?? w.activity) : w.exitCode !== undefined ? `exit code ${w.exitCode}` : undefined;
    this.push({ lead: w.lead, worker: w.id, name: w.name, kind, ...(text ? { text } : {}) });
  }

  /** A droid left the floor: its lead hears so, and a lead's own news goes with it. */
  onWorkerGone(id: string) {
    const prev = this.known.get(id);
    this.known.delete(id);
    this.reported.delete(id);
    const before = this.log.length;
    this.log = this.log.filter((e) => e.lead !== id);
    this.nudged.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (prev?.lead && this.workers.get(prev.lead)) this.push({ lead: prev.lead, worker: id, name: prev.name, kind: 'left' });
    else if (this.log.length !== before) this.persist();
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** An office-workers request from `caller`, a droid that proved who it is with its hook token. */
  async handle(caller: WorkerInfo, raw: unknown): Promise<TeamReply> {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    switch (b.action) {
      case 'whoami':
        return ok(this.whoami(caller));
      case 'list':
        return ok({ ...this.whoami(caller), team: this.teamOf(caller.id).map((w) => this.member(w)) });
      case 'hire':
        return this.hire(caller, b);
      case 'events':
        return this.events(caller, b);
      case 'read':
        return this.read(caller, b);
      case 'send':
        return this.send(caller, b);
      case 'dismiss':
        return this.dismiss(caller, b);
      case 'report':
        return this.report(caller, b);
      default:
        return no(400, 'Unknown action: use whoami, list, hire, events, read, send, dismiss or report');
    }
  }

  /** Why `w` can't hire a subagent now, if it can't. */
  cannotHire(w: WorkerInfo): string | undefined {
    const s = this.opts.settings();
    const lead = STATION_AGENT.lead.name;
    if (!s.on) return 'Subagents are turned off in this office (⚙️ Settings → Subagents)';
    if (w.kind !== 'agent') return 'Only agents hire subagents';
    if (w.lead) {
      const boss = this.workers.get(w.lead)?.name ?? 'your lead';
      return `You're a subagent of ${boss}, and subagents can't hire their own: do your task yourself, or ask ${boss} with office-workers report --question`;
    }
    if (w.meeting) return "Droids at the meeting table don't hire subagents";
    const station = DESK_BY_ID.get(w.deskId)?.station;
    if (station && station !== 'lead') return `The ${STATION_AGENT[station].name} doesn't hire subagents: put the work on the task queue with office-queue`;
    if (!station && !s.deskWorkers) return `Only the ${lead} hires subagents in this office (⚙️ Settings → Subagents)`;
    return undefined;
  }

  private whoami(w: WorkerInfo): Record<string, unknown> {
    const s = this.opts.settings();
    const why = this.cannotHire(w);
    const lead = w.lead ? this.workers.get(w.lead) : undefined;
    const team = this.teamOf(w.id).length;
    const station = DESK_BY_ID.get(w.deskId)?.station;
    return {
      you: { id: w.id, name: w.name, desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId, role: lead ? 'subagent' : team || station === 'lead' ? 'lead' : 'worker' },
      ...(lead ? { lead: { id: lead.id, name: lead.name } } : {}),
      canHire: !why,
      ...(why ? { why } : {}),
      subagents: team,
      max: s.maxPerLead,
      worktree: s.worktree && this.opts.git,
      wakeLead: s.wakeLead,
    };
  }

  private teamOf(leadId: string): WorkerInfo[] {
    return this.workers
      .list()
      .filter((w) => w.lead === leadId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private member(w: WorkerInfo): TeamMember {
    const last = [...this.log].reverse().find((e) => e.worker === w.id && (e.kind === 'report' || e.kind === 'question'));
    const model = w.activeModel ?? w.model;
    const effort = w.activeEffort ?? w.effort;
    return {
      id: w.id,
      name: w.name,
      status: w.status,
      desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(w.worktree ? { worktree: { path: path.join(this.opts.dir, w.worktree.path), branch: w.worktree.branch } } : {}),
      ...(w.activity ? { activity: w.activity } : {}),
      ...(w.task ? { task: w.task.name } : {}),
      ...(w.pr ? { pr: w.pr } : {}),
      settled: settled(w),
      ...(last?.text ? { report: { text: last.text, question: last.kind === 'question', at: last.at } } : {}),
    };
  }

  /** One of `lead`'s subagents, by its id or its name. */
  private resolve(lead: WorkerInfo, ref: unknown): WorkerInfo | string {
    const want = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
    if (!want) return 'Name the subagent: office-workers list shows your team';
    const team = this.teamOf(lead.id);
    const found = team.find((w) => w.id === want || w.name.toLowerCase() === want || w.name.replace(/ 🐚$/, '').toLowerCase() === want);
    if (found) return found;
    const other = this.workers.list().find((w) => w.id === want || w.name.toLowerCase() === want);
    if (other) return `${other.name} isn't one of your subagents${team.length ? `: yours are ${team.map((w) => w.name).join(', ')}` : ''}`;
    return `No subagent called ${String(ref)}${team.length ? `: yours are ${team.map((w) => w.name).join(', ')}` : ': you have none'}`;
  }

  /** What a subagent runs: what its lead asked for, else the Subagents setting, else the office default. */
  private choice(b: Record<string, unknown>): Partial<AgentChoice> | string {
    const s = this.opts.settings();
    const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : undefined;
    const effort = b.effort === undefined || b.effort === '' ? undefined : b.effort;
    if (effort !== undefined && !isAgentEffort(effort)) return `Effort is one of ${AGENT_EFFORTS.join(', ')}`;
    if (model === undefined && effort === undefined) return s.agent ? { ...s.agent } : {};
    // A droid hired with no model starts on the office default, effort and all, so what the lead
    // leaves out comes from the setting, else from that default.
    const base = s.agent ?? this.workers.officeDefault;
    const pickedModel = model ?? base?.model;
    const pickedEffort = effort ?? base?.effort;
    return { ...(pickedModel ? { model: pickedModel } : {}), ...(pickedEffort ? { effort: pickedEffort } : {}) };
  }

  private async hire(lead: WorkerInfo, b: Record<string, unknown>): Promise<TeamReply> {
    const why = this.cannotHire(lead);
    if (why) return no(403, why);
    const task = str(b.task, TASK_MAX).trim();
    if (!task) return no(400, 'The subagent needs a task: give its brief on stdin (office-workers hire --title "…" <<\'EOF\' … EOF)');
    const choice = this.choice(b);
    if (typeof choice === 'string') return no(400, choice);
    const s = this.opts.settings();
    const full = () => {
      const n = this.teamOf(lead.id).length;
      return n >= s.maxPerLead ? `You have ${n} subagents, the most one lead has at once in this office: dismiss one you're done with first (office-workers dismiss <name>)` : undefined;
    };
    const tooMany = full();
    if (tooMany) return no(409, tooMany);
    if (b.worktree === true && !this.opts.git) return no(400, "This floor's project isn't a git checkout, so subagents can't have worktrees: hire with --no-worktree");
    const worktree = (typeof b.worktree === 'boolean' ? b.worktree : s.worktree) && this.opts.git;
    // Its worktree starts from what's on the forge now, as the queue's do.
    if (worktree) await this.workers.fetchBase?.();
    const still = this.workers.get(lead.id);
    if (!still) return no(410, "You've left the floor");
    const after = full();
    if (after) return no(409, after);
    const at = DESK_BY_ID.get(still.deskId);
    const seat = at && nearestFreeSeat(at.x, at.z, (id) => this.workers.deskOccupied(id));
    if (!seat) return no(409, 'Every desk and bean bag on this floor is taken: dismiss a subagent you are done with, or ask the person to send someone home');
    const info = this.workers.hire(seat.id, still.name, task, worktree, choice, still.id);
    if (typeof info === 'string') return no(409, info);
    const title = str(b.title, TITLE_MAX).trim();
    if (title) this.workers.setTask(info.id, { name: title, summary: clip(task, 120) });
    this.known.set(info.id, { name: info.name, lead: still.id, status: info.status });
    this.opts.toast(`🧭 ${still.name} hired ${info.name} at ${seat.label}${title ? `: ${title}` : ''}`, 'info', info.id);
    return ok({ worker: this.member(this.workers.get(info.id) ?? info) });
  }

  /** What the lead hasn't heard yet, for `office-workers wait`, which then counts as heard. */
  private events(lead: WorkerInfo, b: Record<string, unknown>): TeamReply {
    let only: Set<string> | undefined;
    if (Array.isArray(b.workers) && b.workers.length) {
      only = new Set();
      for (const ref of b.workers) {
        const w = this.resolve(lead, ref);
        // One that's gone may still have news waiting: its last word, or that it left.
        const gone = typeof w === 'string' ? this.log.find((e) => e.lead === lead.id && (e.worker === ref || e.name.toLowerCase() === String(ref).toLowerCase())) : undefined;
        if (typeof w !== 'string') only.add(w.id);
        else if (gone) only.add(gone.worker);
        else return no(404, w);
      }
    }
    const news = this.log.filter((e) => e.lead === lead.id && !e.seen && (!only || only.has(e.worker)));
    for (const e of news) e.seen = true;
    if (news.length) this.persist();
    return ok({
      events: news.map((e) => ({ kind: e.kind, worker: e.worker, name: e.name, at: e.at, ...(e.text ? { text: e.text } : {}) })),
      team: this.teamOf(lead.id).map((w) => this.member(w)),
    });
  }

  private read(lead: WorkerInfo, b: Record<string, unknown>): TeamReply {
    const w = this.resolve(lead, b.worker);
    if (typeof w === 'string') return no(404, w);
    const lines = Number.isInteger(b.lines) ? Math.min(READ_MAX, Math.max(1, b.lines as number)) : READ_DEFAULT;
    const text = this.workers.tail(w.id, lines);
    if (text === undefined) return no(409, `${w.name} has no terminal yet: it's ${w.status}`);
    return ok({ worker: this.member(w), text });
  }

  private send(lead: WorkerInfo, b: Record<string, unknown>): TeamReply {
    const w = this.resolve(lead, b.worker);
    if (typeof w === 'string') return no(404, w);
    const text = str(b.text, TASK_MAX).trim();
    if (!text) return no(400, "Give the message on stdin (office-workers send <name> <<'EOF' … EOF)");
    if (w.downedUntil !== undefined) return no(409, `${w.name} is down: it can't take a message until someone revives it`);
    if (w.status === 'starting') return no(409, `${w.name} is still starting up: try again in a few seconds`);
    if (w.status === 'needs_input') return no(409, `${w.name} is waiting on an answer in its own terminal (${w.activity ?? 'a prompt'}): someone has to answer it there, so tell the person`);
    const err = isAsleep(w.status) ? this.workers.resume(w.id, text) : this.workers.prompt(w.id, text);
    if (err) return no(409, `${w.name}: ${err}`);
    this.reported.delete(w.id);
    return ok({ worker: this.member(this.workers.get(w.id) ?? w) });
  }

  private async dismiss(lead: WorkerInfo, b: Record<string, unknown>): Promise<TeamReply> {
    const w = this.resolve(lead, b.worker);
    if (typeof w === 'string') return no(404, w);
    const { note, error } = await this.workers.kill(w.id);
    if (error) return no(409, `${w.name}: ${error}`);
    this.opts.toast(`👋 ${lead.name} sent ${w.name} home${note ? `. ${note}` : ''}`, 'info');
    return ok({ name: w.name, ...(note ? { note } : {}) });
  }

  private report(w: WorkerInfo, b: Record<string, unknown>): TeamReply {
    const lead = w.lead ? this.workers.get(w.lead) : undefined;
    if (!lead) return no(403, "Nobody hired you with office-workers, so there's no lead to report to: say it in your own terminal instead");
    const text = str(b.text, TASK_MAX).trim();
    if (!text) return no(400, "Give the report on stdin (office-workers report <<'EOF' … EOF)");
    const question = b.question === true;
    this.push({ lead: lead.id, worker: w.id, name: w.name, kind: question ? 'question' : 'report', text });
    if (!question) this.reported.add(w.id);
    this.opts.toast(`${question ? `❓ ${w.name} asked ${lead.name}` : `📨 ${w.name} reported to ${lead.name}`}: “${clip(text, 90)}”`, 'info', w.id);
    return ok({ lead: lead.name });
  }

  private push(e: Omit<TeamEvent, 'seq' | 'at'>) {
    this.log.push({ ...e, seq: ++this.seq, at: this.now() });
    if (this.log.length > LOG_MAX) {
      // What's been heard goes first.
      const heard = this.log.findIndex((x) => x.seen);
      this.log.splice(heard >= 0 ? heard : 0, 1);
    }
    this.persist();
    this.scheduleNudge(e.lead);
  }

  /** News for `lead` it hasn't heard or been woken for. */
  private unnudged(lead: string): TeamEvent[] {
    const after = this.nudged.get(lead) ?? 0;
    return this.log.filter((e) => e.lead === lead && !e.seen && e.seq > after);
  }

  private scheduleNudge(lead: string) {
    if (this.timers.has(lead)) return;
    this.timers.set(
      lead,
      setTimeout(() => {
        this.timers.delete(lead);
        this.nudge(lead);
      }, this.opts.nudgeDelayMs ?? 4000),
    );
  }

  /** Tells a lead at rest what its team has to say, once per batch of news. */
  private nudge(leadId: string) {
    if (!this.opts.settings().wakeLead) return;
    const lead = this.workers.get(leadId);
    const news = this.unnudged(leadId);
    if (!lead || !news.length || lead.kind !== 'agent' || lead.downedUntil !== undefined) return;
    // Busy: it hears when it next waits, or is woken once it comes to rest (onWorker).
    if (lead.status !== 'done' && lead.status !== 'idle') return;
    if (lead.lastInputAt !== undefined && this.now() - lead.lastInputAt < TYPING_MS) {
      this.scheduleNudge(leadId);
      return;
    }
    const latest = new Map<string, TeamEvent>();
    for (const e of news) {
      const had = latest.get(e.worker);
      if (!had || WEIGHT[e.kind] >= WEIGHT[had.kind]) latest.set(e.worker, e);
    }
    const said = [...latest.values()].map((e) => `${e.name} ${NEWS[e.kind]}.`).join(' ');
    if (this.workers.prompt(leadId, officePrompt(this.opts.prompts, 'subagent.nudge', { news: said }))) return;
    this.nudged.set(leadId, news[news.length - 1].seq);
    this.persist();
  }

  private restore() {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { events?: unknown; nudged?: unknown };
      const kinds = new Set<string>(Object.keys(WEIGHT));
      for (const e of Array.isArray(raw.events) ? raw.events : []) {
        if (!e || typeof e !== 'object') continue;
        const x = e as Record<string, unknown>;
        if (typeof x.lead !== 'string' || typeof x.worker !== 'string' || typeof x.name !== 'string' || !kinds.has(String(x.kind)) || typeof x.seq !== 'number' || typeof x.at !== 'number') continue;
        this.log.push({
          seq: x.seq,
          lead: x.lead,
          worker: x.worker,
          name: x.name,
          kind: x.kind as TeamEventKind,
          at: x.at,
          ...(typeof x.text === 'string' ? { text: x.text.slice(0, TASK_MAX) } : {}),
          ...(x.seen === true ? { seen: true } : {}),
        });
      }
      this.log = this.log.slice(-LOG_MAX);
      if (raw.nudged && typeof raw.nudged === 'object') for (const [k, v] of Object.entries(raw.nudged)) if (typeof v === 'number') this.nudged.set(k, v);
    } catch {
      // nothing kept yet
    }
    // A lead that didn't come back with the office has nobody to hear its news.
    const here = new Set(this.workers.list().map((w) => w.id));
    this.log = this.log.filter((e) => here.has(e.lead));
    this.seq = this.log.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  private persist() {
    try {
      writeFileSync(this.path, JSON.stringify({ events: this.log, nudged: Object.fromEntries(this.nudged) }), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}

/** It has been given its task and isn't in the middle of a turn: done, waiting on input, or asleep. */
export function settled(w: WorkerInfo): boolean {
  return w.status !== 'starting' && w.status !== 'working' && w.status !== 'idle';
}
