// A floor's leads and their subagents. Any ordinary agent without a lead can hire
// subagents through the authenticated Office MCP team tools. A subagent is a real worker: it sits at the free desk nearest
// its lead, with its own laptop and terminal, and its WorkerInfo.lead says whose it is. This keeps
// what the lead hasn't heard yet: its subagents' reports and questions, and when one finishes a
// turn, needs input in its terminal, stops or leaves. A lead at rest is told when there's news
// (SubagentSettings.wakeLead), or polls its team's status without blocking.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DESK_BY_ID, nearestFreeSeat } from '../shared/layout.js';
import { AGENT_EFFORTS, isAgentEffort, type AgentChoice, type SubagentModel, type SubagentSettings, type WorkerInfo, type WorkerStatus, type WorkerTask } from '../shared/protocol.js';
import { isAsleep } from '../shared/status.js';
import type { DroidModelCatalogue, DroidModelOption } from './droid-models.js';
import { availabilityWords, cannotRun, type ModelAvailability, type ModelUsage } from '../shared/subscriptions.js';
import { officePrompt, type PromptSource } from './prompts.js';
import { workerMessageVars } from '../shared/prompts.js';
import { hireRefusal } from './subscriptions/map.js';
import { isBuildingAgent, MISSION_CONTROL_DOOR } from './building-agent.js';
import { modelList, outsideModelList, outsideModelListMessage } from './model-policy.js';
import { pushedSha, workerDiff } from './team-inspect.js';

/** What the team needs from the floor's workers. Narrow on purpose, so a test can fake it. */
export interface TeamWorkers {
  list(): WorkerInfo[];
  get(id: string): WorkerInfo | undefined;
  /** `id` is a building agent, leading now or not: the news kept for it outlives a restart while it is away. */
  buildingAgent?(id: string): boolean;
  deskOccupied(deskId: string): boolean;
  readonly officeDefault: AgentChoice | undefined;
  /**
   * Hires `lead`'s subagent at `deskId`; returns it, or why not. Its worktree starts from `from` (a
   * branch, tag or commit), else where its lead is.
   */
  hire(deskId: string, by: string, prompt: string, worktree: boolean, choice: Partial<AgentChoice>, lead: string, from?: string, branch?: string): WorkerInfo | string;
  prompt(id: string, text: string, queue?: boolean): string | undefined;
  notice?(id: string, text: string): boolean;
  resume(id: string, prompt?: string): string | undefined;
  kill(id: string): Promise<{ note?: string; error?: string }>;
  dismiss?(id: string, pruneWorktree: boolean, keepBranch: boolean): Promise<{ note?: string; error?: string }>;
  tail(id: string, lines: number): string | undefined;
  setTask(id: string, task: WorkerTask): void;
  fetchStart?(lead: string, from?: string): Promise<void> | undefined;
}

export interface TeamOptions {
  dataDir: string;
  /** The floor's checkout, which worktree paths are relative to. */
  dir: string;
  /** It's a git checkout, so subagents can have worktrees. */
  git: boolean;
  settings(): SubagentSettings;
  /** Droid's model list, for team_models. None: only what the settings name. */
  models?: () => Promise<DroidModelCatalogue>;
  /** Subscriptions: whether a subscription model can run now; undefined when it isn't one or nobody can tell (docs/subscriptions.md). */
  availability?: (model: string) => ModelAvailability | undefined;
  /** Subscriptions: what the plan behind a subscription model has left at `now`, for team_models. */
  usage?: (model: string, now: number) => ModelUsage | undefined;
  prompts?: PromptSource;
  toast(text: string, level: 'info' | 'warn', workerId?: string): void;
  /** How long news waits before a lead at rest is told, so a report and the turn ending with it go as one. */
  nudgeDelayMs?: number;
  now?: () => number;
}

export type TeamEventKind = 'report' | 'question' | 'done' | 'needs_input' | 'stopped' | 'left' | 'sent_home';

export type ResultStatus = 'ok' | 'blocked' | 'failed' | 'partial';

export interface WorkerResult {
  status: ResultStatus;
  summary: string;
  artifacts?: { prUrl?: string; prNumber?: number; mergeCommit?: string; commits?: string[]; files?: string[] };
  remaining?: string[];
  conflicts?: Array<{ path: string; hunks?: Array<{ header?: string; ours?: string; theirs?: string }> }>;
}

export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

export interface WorkerReview {
  verdict: ReviewVerdict;
  notes: string;
  by: string;
  at: number;
}

export const RESULT_STATUSES: readonly ResultStatus[] = ['ok', 'blocked', 'failed', 'partial'];
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['approve', 'request_changes', 'comment'];

/** What a subagent is doing, as team tools show it: its own status, or that it waits on an answer from its lead or the person. */
export type TeamState = WorkerStatus | 'blocked_on_question';

/** Delivered to subscribers (team_wait) as it happens: news for a lead, or a subagent's changed status. */
export type TeamSignal = { type: 'event'; event: TeamEvent } | { type: 'worker'; worker: WorkerInfo };

/** Something a lead hasn't heard yet about one of its subagents. */
export interface TeamEvent {
  seq: number;
  lead: string;
  worker: string;
  /** The subagent's name, which outlives it. */
  name: string;
  kind: TeamEventKind;
  text?: string;
  /** A question's suggested answers, which the lead may pick with question_answer. */
  options?: string[];
  at: number;
  /** Drained by this lead's status request. */
  seen?: boolean;
  /** A question its lead has since answered, or that the subagent moved on from in a new turn. */
  answered?: boolean;
  pushedSha?: string;
  prUrl?: string;
  /**
   * A report a subagent sent as it ends its turn before its task is finished, saying what it waits
   * on (a background job it started, which wakes it when it exits). Its status still goes to done.
   */
  progress?: true;
  result?: WorkerResult;
  review?: WorkerReview;
}

/** A subagent as the team tools show it. */
export interface TeamMember {
  id: string;
  name: string;
  status: WorkerStatus;
  /** Its status, or blocked_on_question while an asked question or a terminal question waits for an answer. */
  state: TeamState;
  desk: string;
  model?: string;
  effort?: string;
  /** Its own worktree, by its full path, and the branch (or commit) it started from. */
  worktree?: { path: string; branch: string; from?: string };
  activity?: string;
  task?: string;
  areas?: string[];
  note?: { text: string; at: number };
  pr?: { number: number; url: string };
  /** It has been given its task and isn't in the middle of a turn now. */
  settled: boolean;
  /** What it last reported or asked. */
  report?: { text: string; question: boolean; at: number; seq: number; pushedSha?: string; prUrl?: string; progress?: true; result?: WorkerResult; review?: WorkerReview };
  /** The event seq of a team_report question nobody has answered yet. */
  openQuestion?: number;
  /** At rest after a progress report, with nothing since: not finished, waiting on its own background work to wake it. */
  awaitingJob?: true;
  idleSince?: number;
  idleForMs?: number;
}

export interface TeamReply {
  status: number;
  body: Record<string, unknown>;
}

export interface TeamDelivery {
  id: string;
  name?: string;
  floor?: string;
  worker?: TeamMember;
  delivery?: string;
  error?: string;
}

/** A partial broadcast is useful; an entirely failed broadcast is a tool error. */
export function teamDeliveryReply(results: TeamDelivery[]): TeamReply {
  const sent = results.some((r) => r.delivery);
  const errors = results.map((r) => `${r.name ?? r.id}${r.floor ? ` (${r.floor})` : ''}: ${r.error}`).join('\n');
  return { status: sent ? 200 : 409, body: { results, ...(!sent ? { error: `No messages delivered: every recipient failed.\n${errors}` } : {}) } };
}

export interface TeamNote {
  areas: string[];
  text: string;
  at: number;
}

export interface TeamBoardMember {
  id: string;
  name: string;
  status: WorkerStatus;
  state: TeamState;
  task?: string;
  activity?: string;
  branch?: string;
  areas: string[];
  note?: { text: string; at: number };
  report?: { summary: string; kind: 'report' | 'question' | 'progress'; at: number };
  result?: Pick<WorkerResult, 'status' | 'summary'>;
}

export function teamBoardText(members: TeamBoardMember[]): string {
  return members
    .map((w) =>
      [
        `${w.name} (${w.id}): ${w.state}${w.task ? `, ${w.task}` : ''}${w.branch ? `, branch ${w.branch}` : ''}.`,
        ...(w.areas.length ? [`Areas: ${w.areas.join(', ')}.`] : []),
        ...(w.activity ? [`Doing: ${w.activity}.`] : []),
        ...(w.note ? [`Note: ${w.note.text}`] : []),
        ...(w.report ? [`Latest ${w.report.kind}${w.result ? ` (${w.result.status})` : ''}: ${w.report.summary}`] : []),
      ].join(' '),
    )
    .join('\n');
}

/** A model as team_models shows it to a lead choosing one. */
export interface TeamModel {
  id: string;
  name: string;
  provider?: string;
  /** Droid's credit multiplier; unset for a model on the owner's own key, or one droid didn't describe. */
  multiplier?: number;
  /** On the owner's own API key (BYOK): it costs no Factory credits. */
  custom?: true;
  legacy?: true;
  defaultEffort?: string;
  efforts?: string[];
  noImages?: true;
  promo?: string;
  /** What the office's owner says it's for. */
  note?: string;
  /** What a subagent runs when the lead leaves --model out. */
  default?: true;
  /** Allowed in Settings, but droid doesn't list it now. */
  unlisted?: true;
  /** Why a worker on it can't run now (out of quota, nobody signed in): hire refuses it. */
  cannotRun?: string;
  /** A subscription model: what its plan has left, so a lead can weigh a nearly spent plan against a full one. */
  usage?: ModelUsage;
  enabled?: boolean;
}

const TASK_MAX = 20_000;
const TITLE_MAX = 80;
const FROM_MAX = 200;
const READ_MAX = 400;
const OPTIONS_MAX = 9;
const OPTION_MAX = 200;
/** How many events the floor keeps, all leads together. */
const LOG_MAX = 400;
/** Someone typed into the lead this recently: they may be mid-sentence, so news waits. */
const TYPING_MS = 5000;

/** The most telling news about one subagent, when there's more than one. */
const WEIGHT: Record<TeamEventKind, number> = { question: 5, report: 4, needs_input: 3, stopped: 2, left: 2, sent_home: 2, done: 1 };
const NEWS: Record<TeamEventKind, string> = {
  question: 'asked you a question',
  report: 'reported back',
  needs_input: 'needs someone to answer it in its own terminal',
  stopped: 'stopped',
  left: 'left the floor',
  sent_home: 'was sent home by the owner',
  done: 'finished its turn without reporting',
};
const PROGRESS_NEWS = 'sent a progress report: it is not finished, and waits on its own background work to wake it';

const ok = (body: Record<string, unknown>): TeamReply => ({ status: 200, body });
const no = (status: number, error: string): TeamReply => ({ status, body: { error } });
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : '');
const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const noteAreas = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((a): a is string => typeof a === 'string')
        .map((a) => str(a, 200).trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];

/** One sentence per subagent, its weightiest news: "Pixel reported back. Nova finished its turn." */
function newsWords(news: TeamEvent[]): string {
  const latest = new Map<string, TeamEvent>();
  for (const e of news) {
    const had = latest.get(e.worker);
    if (!had || WEIGHT[e.kind] >= WEIGHT[had.kind]) latest.set(e.worker, e);
  }
  return [...latest.values()].map((e) => `${e.name} ${e.progress ? PROGRESS_NEWS : NEWS[e.kind]}.`).join(' ');
}

export const TEAM_EVENT_KINDS = Object.keys(WEIGHT) as TeamEventKind[];

/** The read and watch side of a team that structured status, team_wait and questions use. */
export type TeamViews = 'subscribe' | 'latest' | 'news' | 'markSeen' | 'questions' | 'reports' | 'roster';

export class Team {
  private log: TeamEvent[] = [];
  private listeners = new Set<(signal: TeamSignal) => void>();
  private seq = 0;
  /** Remote status polls advance independently of the explicitly acknowledged inbox. */
  private statusCursors = new Map<string, number>();
  /** Per lead: the last event it has been woken for. */
  private nudged = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** The last status, name and lead seen of each worker, to tell what changed. */
  private known = new Map<string, { name: string; lead?: string; status: WorkerStatus }>();
  /** Subagents that have reported in the turn they're in, whose turn ending is no news. */
  private reported = new Set<string>();
  /** Subagents that reported or asked their lead something in the turn they're in: their turn may end (see beforeStop). */
  private spoke = new Set<string>();
  /** Workers being sent home, and by whom: a lead knows when it did it, and hears when the owner did. */
  private sending = new Map<string, 'lead' | 'owner'>();
  private path: string;
  private now: () => number;
  private idleSince = new Map<string, number>();
  private notes = new Map<string, TeamNote>();

  constructor(
    private workers: TeamWorkers,
    private opts: TeamOptions,
  ) {
    this.path = path.join(opts.dataDir, 'team.json');
    this.now = opts.now ?? Date.now;
    this.restore();
    for (const w of workers.list()) {
      this.known.set(w.id, { name: w.name, lead: w.lead, status: w.status });
      if ((w.status === 'idle' || w.status === 'done') && !this.idleSince.has(w.id)) this.idleSince.set(w.id, this.now());
    }
  }

  /** A worker on the floor changed: a subagent's turn may have ended, or a lead may have come to rest with news. */
  onWorker(w: WorkerInfo) {
    this.observe(w);
    // After any news it made, so a waiter sees the event before the state it left behind.
    if (w.lead) this.emit({ type: 'worker', worker: w });
  }

  private observe(w: WorkerInfo) {
    const prev = this.known.get(w.id);
    this.known.set(w.id, { name: w.name, lead: w.lead, status: w.status });
    if (w.status !== 'idle' && w.status !== 'done') this.idleSince.delete(w.id);
    else if (!this.idleSince.has(w.id)) this.idleSince.set(w.id, this.now());
    if (!prev || prev.status === w.status) return;
    this.persist();
    if (w.status === 'working' && (prev.status === 'done' || prev.status === 'idle')) this.nextTurn(w.id);
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

  /** A worker started a new turn: what it reported in the last one doesn't count for this one. */
  nextTurn(id: string) {
    this.reported.delete(id);
    this.spoke.delete(id);
    this.settleQuestions(id);
  }

  /** A worker left the floor: forget it and discard its own news. */
  onWorkerGone(id: string) {
    const previous = this.known.get(id);
    const by = this.sending.get(id);
    if (previous?.lead && by !== 'lead' && this.workers.get(previous.lead)) this.push({ lead: previous.lead, worker: id, name: previous.name, kind: by === 'owner' ? 'sent_home' : 'left' });
    this.known.delete(id);
    this.idleSince.delete(id);
    const hadNote = this.notes.delete(id);
    this.reported.delete(id);
    this.spoke.delete(id);
    const before = this.log.length;
    this.log = this.log.filter((e) => e.lead !== id);
    this.nudged.delete(id);
    const hadCursor = this.statusCursors.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (this.log.length !== before || hadCursor || hadNote) this.persist();
  }

  /** Runs `send`, which may send worker `id` home, so its lead hears who did it. */
  sendingHome<T>(id: string, by: 'lead' | 'owner', send: () => T): T {
    // WorkerManager.kill removes the worker before its first await, so only the synchronous part needs the mark.
    this.sending.set(id, by);
    try {
      return send();
    } finally {
      this.sending.delete(id);
    }
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Hears every new event and every subagent change on this floor until the returned function is called. */
  subscribe(listener: (signal: TeamSignal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How many subscribers are listening, so tests can tell that a wait cleaned up. */
  watchers(): number {
    return this.listeners.size;
  }

  /** The last event seq on this floor: a cursor that skips everything said so far. */
  latest(): number {
    return this.seq;
  }

  /** `lead`'s events after `after` (all it still keeps when unset), heard or not, without changing what it has heard. */
  news(lead: string, filter: { after?: number; kinds?: ReadonlySet<TeamEventKind>; workers?: ReadonlySet<string>; unread?: boolean } = {}): TeamEvent[] {
    return this.log
      .filter((e) => e.lead === lead && e.seq > (filter.after ?? 0) && (!filter.unread || !e.seen) && (!filter.kinds || filter.kinds.has(e.kind)) && (!filter.workers || filter.workers.has(e.worker)))
      .map((e) => ({
        ...e,
        ...(e.options ? { options: [...e.options] } : {}),
        ...(e.result ? { result: cloneWorkerResult(e.result) } : {}),
        ...(e.review ? { review: { ...e.review } } : {}),
      }));
  }

  /** Marks these of `lead`'s events heard, as a status read does. */
  markSeen(lead: string, seqs: Iterable<number>) {
    const ids = new Set(seqs);
    let changed = false;
    for (const e of this.log)
      if (e.lead === lead && ids.has(e.seq) && !e.seen) {
        e.seen = true;
        changed = true;
      }
    if (changed) this.persist();
  }

  /** Questions `lead`'s current subagents asked with team_report that nobody has answered yet. */
  questions(lead: string): TeamEvent[] {
    return this.news(lead, { kinds: new Set(['question']) }).filter((e) => !e.answered && this.workers.get(e.worker)?.lead === lead);
  }

  /** What `lead`'s subagents reported or asked, oldest first, kept even after one leaves; `ref` picks one subagent by id or name. */
  reports(lead: string, ref?: string): TeamEvent[] {
    const want = ref?.trim().toLowerCase();
    return this.news(lead, { kinds: new Set(['report', 'question']) }).filter((e) => !want || e.worker === want || e.name.toLowerCase() === want || e.name.replace(/ 🐚$/, '').toLowerCase() === want);
  }

  /** `lead`'s subagents as team tools show them. */
  roster(lead: string): TeamMember[] {
    return this.teamOf(lead).map((w) => this.member(w));
  }

  /**
   * What a worker whose turn is ending is told instead of stopping (see WorkerManager.beforeStop): a
   * subagent that hasn't reported this turn, to report to its lead; a lead, its team's news it hasn't
   * been woken for, which then needs no waking.
   */
  beforeStop(w: WorkerInfo): string | undefined {
    // Both ask for an Office MCP tool, which refuses every call while it's off.
    if (this.opts.settings().officeMcp === false) return undefined;
    const lead = w.lead ? this.workers.get(w.lead) : undefined;
    if (lead) return this.spoke.has(w.id) ? undefined : officePrompt(this.opts.prompts, 'subagent.report', { lead: lead.name });
    if (!this.opts.settings().wakeLead) return undefined;
    const news = this.unnudged(w.id);
    if (!news.length) return undefined;
    this.nudged.set(w.id, news[news.length - 1].seq);
    this.persist();
    return officePrompt(this.opts.prompts, 'subagent.nudge', { news: newsWords(news) });
  }

  /** A lead that isn't on this floor (a building agent) came to rest: news it hasn't been woken for wakes it now. */
  leadRested(lead: string) {
    if (this.unnudged(lead).length) this.scheduleNudge(lead);
  }

  /** A former lead can still drain final reports and departures after hiring is disabled. */
  hasNews(lead: string): boolean {
    return this.log.some((event) => event.lead === lead && !event.seen);
  }

  /** Remote inbox acknowledgments are explicit and survive a lost HTTP response. */
  inbox(lead: string, ack: readonly number[] = []): TeamEvent[] {
    const ids = new Set(ack);
    for (const e of this.log) if (e.lead === lead && ids.has(e.seq)) e.seen = true;
    if (ids.size) this.persist();
    return this.log.filter((e) => e.lead === lead && !e.seen).map((e) => ({ ...e }));
  }

  /** A team operation from an authenticated office worker. */
  async handle(caller: WorkerInfo, raw: unknown): Promise<TeamReply> {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    switch (b.action) {
      case 'whoami':
        return ok(this.whoami(caller));
      case 'status':
        return this.status(caller, b);
      case 'board':
        return ok({ members: this.board(caller.lead ?? caller.id), you: caller.id });
      case 'note':
        return this.note(caller, b);
      case 'hire':
        return this.hire(caller, b);
      case 'models':
        return this.models(caller);
      case 'models_list':
        return this.models(caller, true);
      case 'diff': {
        const w = this.resolve(caller, b.worker);
        if (typeof w === 'string') return no(404, w);
        if (!this.opts.git) return no(400, 'Worker diffs require a Git floor; plain folders cannot inspect an enclosing checkout.');
        if (b.commits !== undefined && (typeof b.commits !== 'number' || !Number.isInteger(b.commits) || b.commits < 1 || b.commits > 1000)) return no(400, 'commits takes the last 1–1000 commits through HEAD.');
        if (b.base !== undefined && typeof b.base !== 'string') return no(400, 'base takes a branch, tag or commit.');
        if (b.base !== undefined && b.commits !== undefined) return no(400, 'Choose base or commits, not both.');
        try {
          return ok(await workerDiff(this.opts.dir, w, typeof b.base === 'string' ? b.base : undefined, typeof b.commits === 'number' ? b.commits : undefined));
        } catch (err) {
          return no(400, (err as Error).message);
        }
      }
      case 'log': {
        const w = this.resolve(caller, b.worker);
        if (typeof w === 'string') return no(404, w);
        const tail = Number.isInteger(b.tail) ? Math.min(READ_MAX, Math.max(1, b.tail as number)) : 100;
        const terminal = this.workers.tail(w.id, tail);
        return ok({ worker: w.id, tail, activity: w.activity ?? null, action: w.action ?? null, terminal: terminal?.slice(-48_000) ?? null, truncated: (terminal?.length ?? 0) > 48_000 });
      }
      case 'send':
        return this.send(caller, b);
      case 'review':
        return this.review(caller, b);
      case 'dismiss':
        return this.dismiss(caller, b);
      case 'report':
        return this.report(caller, b);
      default:
        return no(400, 'Unknown action: use whoami, status, hire, models, send, review, dismiss or report');
    }
  }

  /** Why `w` can't hire a subagent now, if it can't. */
  cannotHire(w: WorkerInfo): string | undefined {
    if (w.lead) {
      const boss = this.workers.get(w.lead)?.name ?? 'your lead';
      return `You're a subagent of ${boss}, and subagents can't hire their own: do your task yourself, or ask ${boss} with team_report and question: true`;
    }
    // Building agents have the owner's access, and the owner hires whatever the Subagents settings say.
    if (isBuildingAgent(w)) return undefined;
    const s = this.opts.settings();
    if (!s.on) return 'Subagents are turned off in this office (⚙️ Settings → Subagents & visits)';
    if (w.kind !== 'agent') return 'Only agents hire subagents';
    return undefined;
  }

  private whoami(w: WorkerInfo): Record<string, unknown> {
    const s = this.opts.settings();
    const why = this.cannotHire(w);
    const lead = w.lead ? this.workers.get(w.lead) : undefined;
    const team = this.teamOf(w.id).length;
    return {
      you: { id: w.id, name: w.name, desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId, role: lead ? 'subagent' : team ? 'lead' : 'worker' },
      ...(lead ? { lead: { id: lead.id, name: lead.name } } : {}),
      canHire: !why,
      ...(why ? { why } : {}),
      subagents: team,
      // Building agents have the owner's access, which no team size limits.
      ...(isBuildingAgent(w) ? {} : { max: s.maxPerLead }),
      worktree: s.worktree && this.opts.git,
      wakeLead: s.wakeLead,
      ...(modelList(w, s) ? { models: modelList(w, s)!.length } : {}),
    };
  }

  /**
   * The model a subagent runs when its lead leaves --model out: the Subagents setting, else the
   * office's default worker, else droid's own default (`droidDefault`, from its model list).
   */
  private defaultModel(droidDefault?: string): string | undefined {
    return (this.opts.settings().agent ?? this.workers.officeDefault)?.model ?? droidDefault;
  }

  /** Droid's model list (cached briefly by the office), or nothing when droid can't say. */
  private async catalogue(): Promise<DroidModelCatalogue | undefined> {
    try {
      return await this.opts.models?.();
    } catch {
      return undefined;
    }
  }

  /**
   * The models a lead may give a subagent, with what it needs to choose: credit multiplier,
   * provider, efforts and the owner's note. With no list in Settings, every current model droid has.
   */
  private async models(caller: WorkerInfo, includeDisabled = false): Promise<TeamReply> {
    const why = this.cannotHire(caller);
    if (why) return no(403, why);
    const s = this.opts.settings();
    const catalogue = await this.catalogue();
    const known = new Map([...(catalogue?.models ?? []), ...(includeDisabled ? (catalogue?.disabledModels ?? []) : [])].map((m) => [m.id, m]));
    const preferred = this.defaultModel(catalogue?.defaultModel);
    const eligible = (id: string) => !catalogue?.customOnly || known.get(id)?.custom === true;
    const fallback = preferred && eligible(preferred) ? preferred : undefined;
    const describe = (id: string, m: DroidModelOption | undefined, note?: string): TeamModel => {
      const stuck = m?.disabled ? 'Switched off in Droid.' : this.whyNot(id);
      const usage = this.opts.usage?.(id, this.now());
      return {
        id,
        name: m?.displayName ?? id,
        ...(m?.provider ? { provider: m.provider } : {}),
        ...(m?.tokenMultiplier !== undefined && !m.custom ? { multiplier: m.tokenMultiplier } : {}),
        ...(m?.custom ? { custom: true as const } : {}),
        ...(m?.legacy ? { legacy: true as const } : {}),
        ...(m?.defaultReasoningEffort ? { defaultEffort: m.defaultReasoningEffort } : {}),
        ...(m?.supportedReasoningEfforts?.length ? { efforts: m.supportedReasoningEfforts } : {}),
        ...(m?.noImages ? { noImages: true as const } : {}),
        ...(m?.promo ? { promo: m.promo } : {}),
        ...(note ? { note } : {}),
        ...(id === fallback ? { default: true as const } : {}),
        ...(catalogue && !m ? { unlisted: true as const } : {}),
        ...(stuck ? { cannotRun: stuck } : {}),
        ...(usage ? { usage } : {}),
      };
    };
    const allowed = modelList(caller, s);
    const models = includeDisabled
      ? [...new Set([...known.keys(), ...(allowed ?? []).map((m) => m.id)])].filter(eligible).map((id) => {
          const model = describe(id, known.get(id), allowed?.find((m) => m.id === id)?.note);
          return { ...model, enabled: !model.cannotRun && (!allowed || allowed.some((m) => m.id === id) || id === fallback) };
        })
      : allowed
        ? allowed.filter((a) => eligible(a.id)).map((a) => describe(a.id, known.get(a.id), a.note))
        : (catalogue?.models ?? []).filter((m) => !m.legacy).map((m) => describe(m.id, m));
    // The default is what a hire without --model runs, so the lead sees it even when the list leaves it out.
    if (fallback && !models.some((m) => m.id === fallback)) {
      const model = describe(fallback, known.get(fallback));
      models.unshift({ ...model, ...(includeDisabled ? { enabled: !model.cannotRun } : {}) });
    }
    return ok({ restricted: !!allowed, models, ...(fallback ? { defaultModel: fallback } : {}), ...(catalogue ? {} : { unavailable: true }) });
  }

  /** Only a model outside the list needs droid's own default, which subagents may always run. */
  private async droidDefaultFor(list: readonly SubagentModel[] | undefined, model: string): Promise<string | undefined> {
    const outside = !!model && !!list && !list.some((m) => m.id === model) && !this.defaultModel();
    return outside ? (await this.catalogue())?.defaultModel : undefined;
  }

  /**
   * Why `caller` can't give a worker `model` through office_worker_spawn, as it would be refused by team_hire:
   * outside the list (the default model excepted), or a model that can't run now. Undefined when it can.
   */
  async refuseSpawnModel(caller: WorkerInfo, model: string): Promise<string | undefined> {
    const list = modelList(caller, this.opts.settings());
    if (outsideModelList(list, model, this.defaultModel(await this.droidDefaultFor(list, model)))) return outsideModelListMessage(clip(model, 60));
    return this.refuseModel(model, true, list);
  }

  /** What subscriptions say about `model`: undefined when it can run, or nobody can tell. */
  private blocked(model: string | undefined): ModelAvailability | undefined {
    if (!model) return undefined;
    const a = this.opts.availability?.(model);
    return cannotRun(a) ? a : undefined;
  }

  /** Why a worker on `model` can't run now, as team_models says it; undefined when it can. */
  private whyNot(model: string): string | undefined {
    const a = this.blocked(model);
    return a ? availabilityWords(a, this.now()) : undefined;
  }

  /**
   * Why a subagent can't be hired on `model` (`undefined`: the default), naming the models the lead
   * may pick that can run; undefined when it can. `named`: the lead asked for it with --model.
   */
  private async refuseModel(model: string | undefined, named: boolean, list: readonly SubagentModel[] | undefined): Promise<string | undefined> {
    if (!this.opts.availability) return undefined;
    const picked = model ?? this.defaultModel();
    const catalogue = picked && !this.blocked(picked) ? undefined : await this.catalogue();
    const id = picked ?? catalogue?.defaultModel;
    const a = this.blocked(id);
    if (!a || !id) return undefined;
    const known = new Map((catalogue?.models ?? []).map((m) => [m.id, m]));
    const name = (x: string) => known.get(x)?.displayName?.replace(/^DroidProxy:\s*/i, '') ?? x;
    const pool = list ? list.map((m) => m.id) : (catalogue?.models ?? []).filter((m) => !m.legacy).map((m) => m.id);
    const fine = pool.filter((x) => x !== id && !this.blocked(x));
    const head = hireRefusal(name(id), a, this.now());
    const which = named ? '' : ' It is the default subagent model, so set model in team_hire.';
    if (!fine.length) return `${head}${which} No other model a subagent may run can run now either: tell whoever asked you.`;
    const shown = fine.slice(0, 8);
    return `${head}${which} Pick one that can: ${shown.join(', ')}${fine.length > shown.length ? `, and ${fine.length - shown.length} more in team_models` : ''}.`;
  }

  private teamOf(leadId: string): WorkerInfo[] {
    return this.workers
      .list()
      .filter((w) => w.lead === leadId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Metadata only: no terminal reads, Git commands, or lead inbox acknowledgments. */
  board(lead: string): TeamBoardMember[] {
    return this.roster(lead).map((w) => {
      const note = this.notes.get(w.id);
      return {
        id: w.id,
        name: w.name,
        status: w.status,
        state: w.state,
        ...(w.task ? { task: w.task } : {}),
        ...(w.activity ? { activity: clip(w.activity, 200) } : {}),
        ...(w.worktree ? { branch: w.worktree.branch } : {}),
        areas: [...(note?.areas ?? [])],
        ...(note?.text ? { note: { text: note.text, at: note.at } } : {}),
        ...(w.report ? { report: { summary: clip(w.report.result?.summary ?? w.report.text, 300), kind: w.report.question ? 'question' : w.report.progress ? 'progress' : 'report', at: w.report.at } } : {}),
        ...(w.report?.result ? { result: { status: w.report.result.status, summary: clip(w.report.result.summary, 300) } } : {}),
      };
    });
  }

  /** Kept outside the lead's literal task, capped independently from the live board. */
  siblingSnapshot(lead: string, exclude: string): string | undefined {
    const siblings = this.board(lead).filter((w) => w.id !== exclude);
    if (!siblings.length) return undefined;
    const lines = siblings.map((w) =>
      teamBoardText([
        {
          ...w,
          task: w.task ? clip(w.task, 80) : undefined,
          activity: w.activity ? clip(w.activity, 120) : undefined,
          areas: w.areas.length ? [clip(w.areas.join(', '), 180)] : [],
          note: w.note ? { ...w.note, text: clip(w.note.text, 180) } : undefined,
          report: w.report ? { ...w.report, summary: clip(w.report.summary, 180) } : undefined,
        },
      ]),
    );
    const text = lines.join('\n');
    return `## Siblings at hire time\n${text.length > 2400 ? `${text.slice(0, 2399)}…` : text}\nCurrent context: team_board.`;
  }

  private note(w: WorkerInfo, b: Record<string, unknown>): TeamReply {
    if (!w.lead) return no(403, 'Only subagents post sibling notes; leads use team_message.');
    const text = str(b.text, 1000).trim();
    if (!text) return no(400, 'Provide a short text for team_note.');
    const previous = this.notes.get(w.id);
    const areas = b.areas === undefined ? (previous?.areas ?? []) : noteAreas(b.areas);
    this.notes.set(w.id, { text, areas, at: this.now() });
    this.persist();
    const vars = workerMessageVars(`${text}${areas.length ? `\nAreas: ${areas.join(', ')}` : ''}`);
    const message = `Droid Office delivery: sibling note from ${w.name} (${w.id}), a worker, not the lead or owner.\n\n## Worker message\n${vars.fence}text\n${vars.text}\n${vars.fence}\n\n## Office guidance\nShared findings, not a new assignment.`;
    const notified: string[] = [];
    for (const sibling of this.teamOf(w.lead)) {
      if (sibling.id !== w.id && sibling.status === 'working' && !this.spoke.has(sibling.id) && this.workers.notice?.(sibling.id, message)) notified.push(sibling.id);
    }
    return ok({ note: this.notes.get(w.id), notified });
  }

  private member(w: WorkerInfo): TeamMember {
    const note = this.notes.get(w.id);
    const last = [...this.log].reverse().find((e) => e.worker === w.id && (e.kind === 'report' || e.kind === 'question'));
    const model = w.activeModel ?? w.model;
    const effort = w.activeEffort ?? w.effort;
    const open = [...this.log].reverse().find((e) => e.worker === w.id && e.kind === 'question' && !e.answered && e.lead === w.lead);
    const asking = w.status === 'needs_input' && w.ask?.kind === 'question';
    // A later event (a turn that ended without a report, a stop) means the job already woke it.
    const awaitingJob = (w.status === 'idle' || w.status === 'done') && last?.progress && !this.log.some((e) => e.worker === w.id && e.seq > last.seq);
    return {
      id: w.id,
      name: w.name,
      status: w.status,
      state: open || asking ? 'blocked_on_question' : w.status,
      desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(w.worktree ? { worktree: { path: path.join(this.opts.dir, w.worktree.path), branch: w.worktree.branch, from: w.worktree.from ?? w.worktree.base?.slice(0, 7) } } : {}),
      ...(w.activity ? { activity: w.activity } : {}),
      ...(w.task ? { task: w.task.name } : {}),
      ...(note?.areas.length ? { areas: [...note.areas] } : {}),
      ...(note?.text ? { note: { text: note.text, at: note.at } } : {}),
      ...(w.pr ? { pr: w.pr } : {}),
      settled: settled(w),
      ...(last?.text
        ? {
            report: {
              text: last.text,
              question: last.kind === 'question',
              at: last.at,
              seq: last.seq,
              ...(last.pushedSha ? { pushedSha: last.pushedSha } : {}),
              ...(last.prUrl ? { prUrl: last.prUrl } : {}),
              ...(last.progress ? { progress: true as const } : {}),
              ...(last.result ? { result: cloneWorkerResult(last.result) } : {}),
              ...(last.review ? { review: { ...last.review } } : {}),
            },
          }
        : {}),
      ...(open ? { openQuestion: open.seq } : {}),
      ...(awaitingJob ? { awaitingJob: true as const } : {}),
      ...((w.status === 'idle' || w.status === 'done') && this.idleSince.has(w.id) ? { idleSince: this.idleSince.get(w.id), idleForMs: Math.max(0, this.now() - this.idleSince.get(w.id)!) } : {}),
    };
  }

  /** One of `lead`'s subagents, by its id or its name. */
  private resolve(lead: WorkerInfo, ref: unknown): WorkerInfo | string {
    const want = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
    if (!want) return 'Name the subagent: team with action status shows your team';
    const team = this.teamOf(lead.id);
    const found = team.find((w) => w.id === want || w.name.toLowerCase() === want || w.name.replace(/ 🐚$/, '').toLowerCase() === want);
    if (found) return found;
    const other = this.workers.list().find((w) => w.id === want || w.name.toLowerCase() === want);
    if (other) return `${other.name} isn't one of your subagents${team.length ? `: yours are ${team.map((w) => w.name).join(', ')}` : ''}`;
    return `No subagent called ${String(ref)}${team.length ? `: yours are ${team.map((w) => w.name).join(', ')}` : ': you have none'}`;
  }

  /**
   * What a subagent runs: what its lead asked for, else the Subagents setting, else the office
   * default. `droidDefault` is droid's own default model, which the model list never refuses.
   */
  private choice(b: Record<string, unknown>, droidDefault: string | undefined, list: readonly SubagentModel[] | undefined): Partial<AgentChoice> | string {
    const s = this.opts.settings();
    const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : undefined;
    const effort = b.effort === undefined || b.effort === '' ? undefined : b.effort;
    if (effort !== undefined && !isAgentEffort(effort)) return `Effort is one of ${AGENT_EFFORTS.join(', ')}`;
    if (model !== undefined && outsideModelList(list, model, this.defaultModel(droidDefault))) return outsideModelListMessage(clip(model, 60));
    if (model === undefined && effort === undefined) return s.agent ? { ...s.agent } : {};
    // A worker hired with no model starts on the office default, effort and all, so what the lead
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
    if (!task) return no(400, 'The subagent needs a task: provide its brief in team_hire');
    const s = this.opts.settings();
    const asked = typeof b.model === 'string' ? b.model.trim() : '';
    const list = modelList(lead, s);
    const choice = this.choice(b, await this.droidDefaultFor(list, asked), list);
    if (typeof choice === 'string') return no(400, choice);
    const refused = await this.refuseModel(choice.model, !!asked, list);
    if (refused) return no(409, refused);
    // Building agents have the owner's access, which no team size limits.
    const building = isBuildingAgent(lead);
    const full = () => {
      if (building) return undefined;
      const n = this.teamOf(lead.id).length;
      return n >= s.maxPerLead ? `You have ${n} subagents, the most one lead has at once in this office: use team with action dismiss and its name only when both worker and worktree are no longer needed` : undefined;
    };
    const tooMany = full();
    if (tooMany) return no(409, tooMany);
    if (b.worktree === true && !this.opts.git) return no(400, "This floor's project isn't a git checkout, so subagents can't have worktrees: set worktree: false in team_hire");
    const worktree = (typeof b.worktree === 'boolean' ? b.worktree : s.worktree) && this.opts.git;
    const from = typeof b.from === 'string' && b.from.trim() ? b.from.trim() : undefined;
    const branch = typeof b.branch === 'string' ? b.branch.trim() : undefined;
    if (branch !== undefined && (!worktree || branch.length > 200 || !/^[^-\s][^\s]*$/.test(branch))) return no(400, 'branch requires a fresh worktree and a valid local branch name');
    if (from !== undefined) {
      if (!worktree) return no(400, 'from is where a subagent’s own worktree starts: hire it with a worktree, or leave from out');
      if (from.length > FROM_MAX || !/^[^-\s][^\s]*$/.test(from)) return no(400, `from takes a branch, tag or commit (got ${clip(from, 40)})`);
    }
    // Fetched, so `--from origin/main` is what's on the forge now. Without --from it starts where the
    // lead is, moved up to origin's copy of that branch when the lead's is behind it.
    if (worktree) await this.workers.fetchStart?.(lead.id, from);
    const still = this.workers.get(lead.id);
    if (!still) return no(410, "You've left the floor");
    const after = full();
    if (after) return no(409, after);
    // A building agent has no desk: its subagent sits nearest Mission Control.
    const at = DESK_BY_ID.get(still.deskId) ?? (building ? MISSION_CONTROL_DOOR : undefined);
    const seat = at && nearestFreeSeat(at.x, at.z, (id) => this.workers.deskOccupied(id));
    if (!seat) return no(409, 'Every desk and bean bag on this floor is taken: dismiss a subagent you are done with, or ask the person to send someone home');
    const info = branch === undefined ? this.workers.hire(seat.id, still.name, task, worktree, choice, still.id, from) : this.workers.hire(seat.id, still.name, task, worktree, choice, still.id, from, branch);
    if (typeof info === 'string') return no(409, info);
    const title = str(b.title, TITLE_MAX).trim();
    if (title) this.workers.setTask(info.id, { name: title, summary: clip(task, 120) });
    this.known.set(info.id, { name: info.name, lead: still.id, status: info.status });
    this.opts.toast(`🧭 ${still.name} hired ${info.name} at ${seat.label}${title ? `: ${title}` : ''}`, 'info', info.id);
    return ok({ worker: this.member(this.workers.get(info.id) ?? info), worktree: info.worktree ? path.resolve(this.opts.dir, info.worktree.path) : this.opts.dir, branch: info.worktree?.branch ?? null });
  }

  /** Snapshot and all unread news for this caller, without waiting for new events. */
  private status(lead: WorkerInfo, b: Record<string, unknown>): TeamReply {
    const named = b.worker !== undefined ? this.resolve(lead, b.worker) : undefined;
    if (typeof named === 'string') return no(404, named);
    const selected = named ? [named] : this.teamOf(lead.id);
    const lines = Number.isInteger(b.lines) ? Math.min(READ_MAX, Math.max(1, b.lines as number)) : undefined;
    const team = selected.map((w) => {
      const member = this.member(w);
      if (lines === undefined) return member;
      const text = this.workers.tail(w.id, lines);
      return { ...member, ...(text === undefined ? { terminalUnavailable: `${w.name} has no terminal yet: it's ${w.status}` } : { terminal: text }) };
    });
    const since = Number.isSafeInteger(b.since) && (b.since as number) >= 0 ? (b.since as number) : undefined;
    const kinds = Array.isArray(b.kinds) ? new Set(b.kinds.filter((k): k is TeamEventKind => TEAM_EVENT_KINDS.includes(k as TeamEventKind))) : undefined;
    return ok({ ...this.whoami(lead), team, events: this.statusNews(lead, since, kinds), latest: this.seq });
  }

  /**
   * First poll establishes a baseline; later polls return only this caller's newer events. A kinds filter
   * moves the cursor only up to the first event it leaves out, so that news stays unheard; matching news
   * after it may be returned again.
   */
  private remoteStatusNews(lead: string, kinds?: ReadonlySet<TeamEventKind>): TeamEvent[] {
    const previous = this.statusCursors.get(lead);
    const after = previous ?? this.seq;
    const news = this.log.filter((e) => e.lead === lead && e.seq > after);
    const skipped = kinds && news.find((e) => !kinds.has(e.kind));
    const next = skipped ? skipped.seq - 1 : this.seq;
    if (previous !== next) {
      this.statusCursors.set(lead, next);
      this.persist();
    }
    return news
      .filter((e) => !kinds || kinds.has(e.kind))
      .map((e) => ({
        ...e,
        ...(e.options ? { options: [...e.options] } : {}),
        ...(e.result ? { result: cloneWorkerResult(e.result) } : {}),
        ...(e.review ? { review: { ...e.review } } : {}),
      }));
  }

  /**
   * News for a status read: what the lead hasn't heard yet, or with `since` everything after that
   * cursor, including from subagents that already left. A local lead hears only what it was shown.
   */
  private statusNews(lead: WorkerInfo, since: number | undefined, kinds: ReadonlySet<TeamEventKind> | undefined) {
    // A remote lead's unheard news is its office_inbox; without since, status moves its own cursor instead.
    if (lead.remote) return since === undefined ? this.remoteStatusNews(lead.id, kinds) : this.news(lead.id, { after: since, kinds });
    const news = this.news(lead.id, since === undefined ? { unread: true, kinds } : { after: since, kinds });
    this.markSeen(
      lead.id,
      news.map((e) => e.seq),
    );
    return news.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      worker: e.worker,
      name: e.name,
      at: e.at,
      ...(e.text ? { text: e.text } : {}),
      ...(e.options ? { options: e.options } : {}),
      ...(e.pushedSha ? { pushedSha: e.pushedSha } : {}),
      ...(e.prUrl ? { prUrl: e.prUrl } : {}),
      ...(e.progress ? { progress: true as const } : {}),
      ...(e.result ? { result: cloneWorkerResult(e.result) } : {}),
      ...(e.review ? { review: { ...e.review } } : {}),
    }));
  }

  private send(lead: WorkerInfo, b: Record<string, unknown>): TeamReply {
    const text = str(b.text, TASK_MAX).trim();
    if (!text) return no(400, 'Provide text for team with action message');
    if (b.workers !== undefined || b.all === true) {
      const refs = b.all === true ? this.teamOf(lead.id).map((w) => w.id) : b.workers;
      if (!Array.isArray(refs) || !refs.length) return no(400, 'No subagents selected for this broadcast.');
      const seen = new Set<string>();
      const results: TeamDelivery[] = [];
      for (const ref of refs) {
        const w = this.resolve(lead, ref);
        if (typeof w === 'string') {
          results.push({ id: String(ref), error: w });
          continue;
        }
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        const result = this.send(lead, { worker: w.id, text, queue: b.queue });
        results.push({ id: w.id, name: w.name, ...result.body });
      }
      return teamDeliveryReply(results);
    }
    const w = this.resolve(lead, b.worker);
    if (typeof w === 'string') return no(404, w);
    if (w.status === 'starting') return no(409, `${w.name} is still starting up: try again in a few seconds`);
    if (w.status === 'needs_input') return no(409, `${w.name} is waiting on an answer in its own terminal (${w.activity ?? 'a prompt'}): someone has to answer it there, so tell the person`);
    const message = officePrompt(this.opts.prompts, 'subagent.message', { from: lead.name, ...workerMessageVars(text) });
    const asleep = isAsleep(w.status);
    const busy = w.status === 'working' && b.queue !== false;
    const noticed = busy && this.workers.notice?.(w.id, message);
    const err = noticed ? undefined : asleep ? this.workers.resume(w.id, message) : this.workers.prompt(w.id, message, busy);
    if (err) return no(409, `${w.name}: ${err}`);
    this.reported.delete(w.id);
    this.spoke.delete(w.id);
    this.settleQuestions(w.id);
    return ok({ worker: this.member(this.workers.get(w.id) ?? w), delivery: noticed ? 'next_step' : busy ? 'queued_turn' : asleep ? 'resumed' : 'sent' });
  }

  private async dismiss(lead: WorkerInfo, b: Record<string, unknown>): Promise<TeamReply> {
    const w = this.resolve(lead, b.worker);
    if (typeof w === 'string') return no(404, w);
    if (b.pruneWorktree !== undefined && typeof b.pruneWorktree !== 'boolean') return no(400, 'pruneWorktree takes true or false.');
    if (b.keepBranch !== undefined && typeof b.keepBranch !== 'boolean') return no(400, 'keepBranch takes true or false.');
    if (b.keepBranch === false && b.pruneWorktree !== true) return no(400, 'keepBranch: false requires pruneWorktree: true.');
    const safe = b.pruneWorktree !== undefined || b.keepBranch !== undefined;
    // Even false needs retention-safe dismissal: legacy kill may prune clean worktrees.
    if (safe && !this.workers.dismiss) return no(409, 'Safe worktree cleanup is unavailable on this floor; no worker was dismissed');
    let result: { note?: string; error?: string };
    this.sending.set(w.id, 'lead');
    try {
      result = await (safe ? this.workers.dismiss!(w.id, b.pruneWorktree === true, b.keepBranch !== false) : this.workers.kill(w.id));
    } finally {
      // Safe dismissal checks Git asynchronously before killing; keep attribution through those awaits.
      this.sending.delete(w.id);
    }
    const { note, error } = result;
    if (error) return no(409, `${w.name}: ${error}`);
    this.opts.toast(`👋 ${lead.name} sent ${w.name} home${note ? `. ${note}` : ''}`, 'info');
    return ok({ name: w.name, ...(note ? { note } : {}) });
  }

  private async report(w: WorkerInfo, b: Record<string, unknown>): Promise<TeamReply> {
    const lead = w.lead ? this.workers.get(w.lead) : undefined;
    if (!lead) return no(403, 'You have no lead to report to: say it in your own terminal instead');
    const text = str(b.text, TASK_MAX).trim();
    if (!text) return no(400, 'Provide text for team_report');
    if (b.pushedSha !== undefined && (typeof b.pushedSha !== 'string' || !/^[0-9a-f]{40,64}$/.test(b.pushedSha))) return no(400, 'pushedSha takes a full hexadecimal commit SHA.');
    if (b.prUrl !== undefined && (typeof b.prUrl !== 'string' || b.prUrl.length > 2000 || !URL.canParse(b.prUrl))) return no(400, 'prUrl takes a valid URL of at most 2000 characters.');
    const question = b.question === true;
    if (b.options !== undefined && !question) return no(400, 'options are only for a question: add question: true, or leave options out of a report.');
    if (b.progress !== undefined && typeof b.progress !== 'boolean') return no(400, 'progress takes true or false.');
    const progress = b.progress === true;
    if (progress && question) return no(400, 'A question already ends your turn waiting on an answer: leave progress out, or send the progress report separately.');
    const parsedResult = b.result === undefined ? undefined : parseWorkerResult(b.result);
    if (typeof parsedResult === 'string') return no(400, parsedResult);
    const options =
      question && Array.isArray(b.options)
        ? b.options
            .map((o) => str(o, OPTION_MAX).trim())
            .filter(Boolean)
            .slice(0, OPTIONS_MAX)
        : [];
    const sha = typeof b.pushedSha === 'string' ? b.pushedSha : await pushedSha(this.opts.dir, w);
    const prUrl = typeof b.prUrl === 'string' ? b.prUrl : (parsedResult?.artifacts?.prUrl ?? w.pr?.url ?? /https:\/\/(?:github\.com|gitlab\.com)\/[^\s)<>]+\/(?:pull|merge_requests)\/\d+/.exec(text)?.[0]);
    const resultPrUrl = parsedResult?.artifacts?.prUrl ?? prUrl;
    const prNumber = parsedResult?.artifacts?.prNumber ?? prNumberFromUrl(resultPrUrl) ?? (!resultPrUrl || resultPrUrl === w.pr?.url ? w.pr?.number : undefined);
    const result = buildWorkerResult(parsedResult, { status: question ? 'blocked' : progress ? 'partial' : 'ok', summary: clip(text, 240), prUrl: resultPrUrl, prNumber, sha });
    const provenance = { ...(sha ? { pushedSha: sha } : {}), ...(prUrl ? { prUrl } : {}) };
    this.push({ lead: lead.id, worker: w.id, name: w.name, kind: question ? 'question' : 'report', text, ...(options.length ? { options } : {}), ...provenance, ...(progress ? { progress: true as const } : {}), result });
    if (!question) this.reported.add(w.id);
    this.spoke.add(w.id);
    this.opts.toast(`${question ? `❓ ${w.name} asked ${lead.name}` : progress ? `⏳ ${w.name} reported progress to ${lead.name}` : `📨 ${w.name} reported to ${lead.name}`}: “${clip(text, 90)}”`, 'info', w.id);
    return ok({ lead: lead.name, ...provenance, ...(progress ? { progress: true } : {}), result: cloneWorkerResult(result) });
  }

  private review(lead: WorkerInfo, b: Record<string, unknown>): TeamReply {
    const w = this.resolve(lead, b.worker);
    if (typeof w === 'string') return no(404, w);
    if (typeof b.verdict !== 'string' || !(REVIEW_VERDICTS as readonly string[]).includes(b.verdict)) return no(400, `verdict must be one of ${REVIEW_VERDICTS.join(', ')}.`);
    const verdict = b.verdict as ReviewVerdict;
    const notes = str(b.notes, TASK_MAX).trim();
    if (!notes) return no(400, 'Provide notes for team_review.');
    if (b.notify !== undefined && typeof b.notify !== 'boolean') return no(400, 'notify takes true or false.');
    const last = [...this.log].reverse().find((e) => e.worker === w.id && e.lead === lead.id && (e.kind === 'report' || e.kind === 'question'));
    if (!last) return no(409, `${w.name} has not reported a result to review yet.`);
    const review: WorkerReview = { verdict, notes, by: lead.name, at: this.now() };
    last.review = review;
    this.persist();
    this.emit({ type: 'worker', worker: w });
    const icon = verdict === 'approve' ? '✅' : verdict === 'request_changes' ? '🔁' : '💬';
    this.opts.toast(`${icon} ${lead.name} reviewed ${w.name} (${verdict}): “${clip(notes, 90)}”`, 'info', w.id);
    const shouldNotify = typeof b.notify === 'boolean' ? b.notify : verdict === 'request_changes';
    let notified = false;
    let notifyNote: string | undefined;
    if (shouldNotify) {
      if (w.status === 'starting') notifyNote = `${w.name} is still starting up; send follow-up with team_message once ready.`;
      else if (w.status === 'needs_input') notifyNote = `${w.name} is waiting on an answer in its own terminal (${w.activity ?? 'a prompt'}).`;
      else {
        const message = officePrompt(this.opts.prompts, 'subagent.message', { from: lead.name, ...workerMessageVars(`Review verdict: ${verdict}\n\n${notes}`) });
        const err = isAsleep(w.status) ? this.workers.resume(w.id, message) : this.workers.prompt(w.id, message);
        if (err) notifyNote = `${w.name}: ${err}`;
        else {
          notified = true;
          this.reported.delete(w.id);
          this.spoke.delete(w.id);
          this.settleQuestions(w.id);
        }
      }
    }
    return ok({ worker: this.member(this.workers.get(w.id) ?? w), review: { ...review }, reportSeq: last.seq, notified, ...(notifyNote ? { notifyNote } : {}) });
  }

  private push(e: Omit<TeamEvent, 'seq' | 'at'>) {
    const event: TeamEvent = { ...e, seq: ++this.seq, at: this.now() };
    this.log.push(event);
    if (this.log.length > LOG_MAX) {
      // What's been heard goes first.
      const heard = this.log.findIndex((x) => x.seen);
      this.log.splice(heard >= 0 ? heard : 0, 1);
    }
    this.persist();
    this.scheduleNudge(e.lead);
    this.emit({ type: 'event', event: { ...event } });
  }

  private emit(signal: TeamSignal) {
    for (const listener of [...this.listeners]) {
      try {
        listener(signal);
      } catch (err) {
        console.error('Team listener failed:', err);
      }
    }
  }

  /** A subagent's open questions are over: its lead answered, or it started another turn. */
  private settleQuestions(worker: string) {
    let changed = false;
    for (const e of this.log)
      if (e.worker === worker && e.kind === 'question' && !e.answered) {
        e.answered = true;
        changed = true;
      }
    if (changed) this.persist();
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
    if (!lead || !news.length || lead.kind !== 'agent' || lead.remote) return;
    // Busy: it hears when it next reads status, or is woken once it comes to rest (onWorker).
    if (lead.status !== 'done' && lead.status !== 'idle') return;
    if (lead.lastInputAt !== undefined && this.now() - lead.lastInputAt < TYPING_MS) {
      this.scheduleNudge(leadId);
      return;
    }
    if (this.workers.prompt(leadId, officePrompt(this.opts.prompts, 'subagent.nudge', { news: newsWords(news) }))) return;
    this.nudged.set(leadId, news[news.length - 1].seq);
    this.persist();
  }

  private restore() {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { events?: unknown; nudged?: unknown; seq?: unknown; idleSince?: unknown; statusCursors?: unknown; notes?: unknown };
      if (raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes))
        for (const [id, value] of Object.entries(raw.notes)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const note = value as Record<string, unknown>;
          if (this.workers.get(id) && typeof note.text === 'string' && typeof note.at === 'number') this.notes.set(id, { text: str(note.text, 1000).trim(), areas: noteAreas(note.areas), at: note.at });
        }
      if (Number.isSafeInteger(raw.seq)) this.seq = raw.seq as number;
      if (raw.idleSince && typeof raw.idleSince === 'object')
        for (const [id, at] of Object.entries(raw.idleSince)) {
          const status = this.workers.get(id)?.status;
          // WorkerManager initially restores PTY-backed workers offline, then adopts their saved state.
          if ((status === 'idle' || status === 'done' || status === 'offline') && typeof at === 'number' && Number.isFinite(at) && at <= this.now()) this.idleSince.set(id, at);
        }
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
          ...(Array.isArray(x.options)
            ? {
                options: x.options
                  .filter((o): o is string => typeof o === 'string')
                  .map((o) => o.slice(0, OPTION_MAX))
                  .slice(0, OPTIONS_MAX),
              }
            : {}),
          ...(x.seen === true ? { seen: true } : {}),
          ...(x.answered === true ? { answered: true } : {}),
          ...(typeof x.pushedSha === 'string' && /^[0-9a-f]{40,64}$/.test(x.pushedSha) ? { pushedSha: x.pushedSha } : {}),
          ...(typeof x.prUrl === 'string' ? { prUrl: x.prUrl.slice(0, 2000) } : {}),
          ...(x.progress === true ? { progress: true as const } : {}),
          ...(restoreWorkerResult(x.result) ? { result: restoreWorkerResult(x.result) } : {}),
          ...(restoreWorkerReview(x.review) ? { review: restoreWorkerReview(x.review) } : {}),
        });
      }
      this.log = this.log.slice(-LOG_MAX);
      if (raw.nudged && typeof raw.nudged === 'object') for (const [k, v] of Object.entries(raw.nudged)) if (typeof v === 'number') this.nudged.set(k, v);
      if (raw.statusCursors && typeof raw.statusCursors === 'object') {
        for (const [id, seq] of Object.entries(raw.statusCursors)) if (Number.isSafeInteger(seq) && (seq as number) >= 0) this.statusCursors.set(id, seq as number);
      }
    } catch {
      // nothing kept yet
    }
    // A lead that didn't come back with the office has nobody to hear its news.
    this.log = this.log.filter((e) => !!this.workers.get(e.lead) || this.workers.buildingAgent?.(e.lead));
    // Cursors and inbox ids name a seq, so it never goes back, even when the newest events left with their lead.
    this.seq = this.log.reduce((m, e) => Math.max(m, e.seq), Math.max(this.seq, ...this.statusCursors.values()));
  }

  private persist() {
    try {
      writeFileSync(
        this.path,
        JSON.stringify({
          seq: this.seq,
          events: this.log,
          nudged: Object.fromEntries(this.nudged),
          idleSince: Object.fromEntries(this.idleSince),
          statusCursors: Object.fromEntries(this.statusCursors),
          notes: Object.fromEntries(this.notes),
        }),
        {
          mode: 0o600,
        },
      );
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}

const RESULT_SUMMARY_MAX = 2000;
const RESULT_ITEM_MAX = 1000;
const HUNK_TEXT_MAX = 4000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function prNumberFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const n = Number(/\/(?:pull|merge_requests)\/(\d+)(?:$|[/?#])/.exec(url)?.[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function parseStringList(value: unknown, label: string, maxItems: number, maxLen: number): string[] | string {
  if (!Array.isArray(value) || value.length > maxItems) return `${label} takes an array of at most ${maxItems} strings.`;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return `${label} takes strings only.`;
    const trimmed = str(item, maxLen).trim();
    if (!trimmed) return `${label} entries cannot be empty.`;
    out.push(trimmed);
  }
  return out;
}

function parseWorkerResult(raw: unknown): WorkerResult | string {
  if (!isPlainObject(raw)) return 'result must be an object with status and summary.';
  if (typeof raw.status !== 'string' || !(RESULT_STATUSES as readonly string[]).includes(raw.status)) return `result.status must be one of ${RESULT_STATUSES.join(', ')}.`;
  const summary = str(raw.summary, RESULT_SUMMARY_MAX).trim();
  if (!summary) return 'result.summary requires a non-empty string.';
  let artifacts: WorkerResult['artifacts'];
  if (raw.artifacts !== undefined) {
    if (!isPlainObject(raw.artifacts)) return 'result.artifacts must be an object.';
    const a = raw.artifacts;
    if (a.prUrl !== undefined && (typeof a.prUrl !== 'string' || a.prUrl.length > 2000 || !URL.canParse(a.prUrl))) return 'result.artifacts.prUrl takes a valid URL of at most 2000 characters.';
    if (a.prNumber !== undefined && (typeof a.prNumber !== 'number' || !Number.isSafeInteger(a.prNumber) || a.prNumber < 1)) return 'result.artifacts.prNumber takes a positive integer.';
    if (a.mergeCommit !== undefined && (typeof a.mergeCommit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(a.mergeCommit))) return 'result.artifacts.mergeCommit takes a hexadecimal commit SHA.';
    const commits = a.commits === undefined ? undefined : parseStringList(a.commits, 'result.artifacts.commits', 200, 200);
    if (typeof commits === 'string') return commits;
    const files = a.files === undefined ? undefined : parseStringList(a.files, 'result.artifacts.files', 500, 1024);
    if (typeof files === 'string') return files;
    const built: NonNullable<WorkerResult['artifacts']> = {
      ...(typeof a.prUrl === 'string' ? { prUrl: a.prUrl } : {}),
      ...(typeof a.prNumber === 'number' ? { prNumber: a.prNumber } : {}),
      ...(typeof a.mergeCommit === 'string' ? { mergeCommit: a.mergeCommit.toLowerCase() } : {}),
      ...(commits?.length ? { commits } : {}),
      ...(files?.length ? { files } : {}),
    };
    if (Object.keys(built).length) artifacts = built;
  }
  const remaining = raw.remaining === undefined ? undefined : parseStringList(raw.remaining, 'result.remaining', 100, RESULT_ITEM_MAX);
  if (typeof remaining === 'string') return remaining;
  let conflicts: WorkerResult['conflicts'];
  if (raw.conflicts !== undefined) {
    if (!Array.isArray(raw.conflicts) || raw.conflicts.length > 200) return 'result.conflicts takes an array of at most 200 conflict entries.';
    const parsedConflicts: NonNullable<WorkerResult['conflicts']> = [];
    for (const entry of raw.conflicts) {
      if (!isPlainObject(entry)) return 'Each result.conflicts entry must be an object with path.';
      const filePath = str(entry.path, 1024).trim();
      if (!filePath) return 'Each result.conflicts entry requires a non-empty path.';
      let hunks: NonNullable<WorkerResult['conflicts']>[number]['hunks'];
      if (entry.hunks !== undefined) {
        if (!Array.isArray(entry.hunks) || entry.hunks.length > 50) return 'result.conflicts[].hunks takes at most 50 hunks.';
        hunks = [];
        for (const h of entry.hunks) {
          if (!isPlainObject(h)) return 'Each conflict hunk must be an object.';
          if ((h.header !== undefined && typeof h.header !== 'string') || (h.ours !== undefined && typeof h.ours !== 'string') || (h.theirs !== undefined && typeof h.theirs !== 'string'))
            return 'Conflict hunk fields header, ours and theirs must be strings.';
          hunks.push({
            ...(typeof h.header === 'string' ? { header: str(h.header, 400) } : {}),
            ...(typeof h.ours === 'string' ? { ours: str(h.ours, HUNK_TEXT_MAX) } : {}),
            ...(typeof h.theirs === 'string' ? { theirs: str(h.theirs, HUNK_TEXT_MAX) } : {}),
          });
        }
      }
      parsedConflicts.push({ path: filePath, ...(hunks?.length ? { hunks } : {}) });
    }
    if (parsedConflicts.length) conflicts = parsedConflicts;
  }
  return {
    status: raw.status as ResultStatus,
    summary,
    ...(artifacts ? { artifacts } : {}),
    ...(remaining?.length ? { remaining } : {}),
    ...(conflicts ? { conflicts } : {}),
  };
}

function buildWorkerResult(explicit: WorkerResult | undefined, fallback: { status: ResultStatus; summary: string; prUrl?: string; prNumber?: number; sha?: string }): WorkerResult {
  const base = explicit ?? { status: fallback.status, summary: fallback.summary };
  const prev = base.artifacts;
  const prUrl = prev?.prUrl ?? fallback.prUrl;
  const prNumber = prev?.prNumber ?? fallback.prNumber;
  const commits = prev?.commits ?? (fallback.sha ? [fallback.sha] : undefined);
  const artifacts: NonNullable<WorkerResult['artifacts']> = {
    ...(prUrl ? { prUrl } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(prev?.mergeCommit ? { mergeCommit: prev.mergeCommit } : {}),
    ...(commits?.length ? { commits: [...commits] } : {}),
    ...(prev?.files?.length ? { files: [...prev.files] } : {}),
  };
  return {
    status: base.status,
    summary: base.summary,
    ...(Object.keys(artifacts).length ? { artifacts } : {}),
    ...(base.remaining?.length ? { remaining: [...base.remaining] } : {}),
    ...(base.conflicts?.length ? { conflicts: base.conflicts.map((c) => ({ path: c.path, ...(c.hunks ? { hunks: c.hunks.map((h) => ({ ...h })) } : {}) })) } : {}),
  };
}

function cloneWorkerResult(r: WorkerResult): WorkerResult {
  return buildWorkerResult(r, { status: r.status, summary: r.summary });
}

function restoreWorkerResult(raw: unknown): WorkerResult | undefined {
  const parsed = parseWorkerResult(raw);
  return typeof parsed === 'string' ? undefined : parsed;
}

function restoreWorkerReview(raw: unknown): WorkerReview | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.verdict !== 'string' || !(REVIEW_VERDICTS as readonly string[]).includes(raw.verdict)) return undefined;
  const notes = str(raw.notes, TASK_MAX).trim();
  const by = str(raw.by, 200).trim();
  if (!notes || !by || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined;
  return { verdict: raw.verdict as ReviewVerdict, notes, by, at: raw.at };
}

/** It has been given its task and isn't in the middle of a turn: done, waiting on input, or asleep. */
export function settled(w: WorkerInfo): boolean {
  return w.status !== 'starting' && w.status !== 'working' && w.status !== 'idle';
}
