// A floor's leads and their subagents. Any agent at a desk, and the Team lead at its kiosk, can hire
// subagents through the authenticated Office MCP team tools. A subagent is a real worker: it sits at the free desk nearest
// its lead, with its own laptop and terminal, and its WorkerInfo.lead says whose it is. This keeps
// what the lead hasn't heard yet: its subagents' reports and questions, and when one finishes a
// turn, needs input in its terminal, stops or leaves. A lead at rest is told when there's news
// (SubagentSettings.wakeLead), or polls its team's status without blocking.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DESK_BY_ID, STATION_AGENT, nearestFreeSeat } from '../shared/layout.js';
import { AGENT_EFFORTS, isAgentEffort, type AgentChoice, type SubagentSettings, type WorkerInfo, type WorkerStatus, type WorkerTask } from '../shared/protocol.js';
import { isAsleep } from '../shared/status.js';
import type { DroidModelCatalogue, DroidModelOption } from './droid-models.js';
import { availabilityWords, cannotRun, type ModelAvailability } from '../shared/subscriptions.js';
import { officePrompt, type PromptSource } from './prompts.js';
import { workerMessageVars } from '../shared/prompts.js';
import { hireRefusal } from './subscriptions/map.js';
import { pushedSha, workerDiff } from './team-inspect.js';

/** What the team needs from the floor's workers. Narrow on purpose, so a test can fake it. */
export interface TeamWorkers {
  list(): WorkerInfo[];
  get(id: string): WorkerInfo | undefined;
  deskOccupied(deskId: string): boolean;
  readonly officeDefault: AgentChoice | undefined;
  /**
   * Hires `lead`'s subagent at `deskId`; returns it, or why not. Its worktree starts from `from` (a
   * branch, tag or commit), else where its lead is.
   */
  hire(deskId: string, by: string, prompt: string, worktree: boolean, choice: Partial<AgentChoice>, lead: string, from?: string, branch?: string): WorkerInfo | string;
  prompt(id: string, text: string): string | undefined;
  resume(id: string, prompt?: string): string | undefined;
  kill(id: string): Promise<{ note?: string; error?: string }>;
  dismiss?(id: string, pruneWorktree: boolean, keepBranch: boolean): Promise<{ note?: string; error?: string }>;
  tail(id: string, lines: number): string | undefined;
  setTask(id: string, task: WorkerTask): void;
  fetchStart?(lead: string, from?: string): Promise<void> | undefined;
}

export interface TeamOptions {
  /** Remote leads own teams across floors; the normal per-lead cap still applies building-wide. */
  remoteTeamSize?(id: string): number;
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
  prompts?: PromptSource;
  toast(text: string, level: 'info' | 'warn', workerId?: string): void;
  /** How long news waits before a lead at rest is told, so a report and the turn ending with it go as one. */
  nudgeDelayMs?: number;
  now?: () => number;
}

export type TeamEventKind = 'report' | 'question' | 'done' | 'needs_input' | 'stopped' | 'left' | 'sent_home';

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
  /** Drained by this lead's status request. */
  seen?: boolean;
  pushedSha?: string;
  prUrl?: string;
}

/** A subagent as the team tools show it. */
export interface TeamMember {
  id: string;
  name: string;
  status: WorkerStatus;
  desk: string;
  model?: string;
  effort?: string;
  /** Its own worktree, by its full path, and the branch (or commit) it started from. */
  worktree?: { path: string; branch: string; from?: string };
  activity?: string;
  task?: string;
  pr?: { number: number; url: string };
  /** It has been given its task and isn't in the middle of a turn now. */
  settled: boolean;
  /** What it last reported or asked. */
  report?: { text: string; question: boolean; at: number; pushedSha?: string; prUrl?: string };
  idleSince?: number;
  idleForMs?: number;
}

export interface TeamReply {
  status: number;
  body: Record<string, unknown>;
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
  enabled?: boolean;
}

const TASK_MAX = 20_000;
const TITLE_MAX = 80;
const FROM_MAX = 200;
const READ_MAX = 400;
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

const ok = (body: Record<string, unknown>): TeamReply => ({ status: 200, body });
const no = (status: number, error: string): TeamReply => ({ status, body: { error } });
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : '');
const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** One sentence per subagent, its weightiest news: "Pixel reported back. Nova finished its turn." */
function newsWords(news: TeamEvent[]): string {
  const latest = new Map<string, TeamEvent>();
  for (const e of news) {
    const had = latest.get(e.worker);
    if (!had || WEIGHT[e.kind] >= WEIGHT[had.kind]) latest.set(e.worker, e);
  }
  return [...latest.values()].map((e) => `${e.name} ${NEWS[e.kind]}.`).join(' ');
}

export class Team {
  private log: TeamEvent[] = [];
  private seq = 0;
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
  }

  /** A worker left the floor: forget it and discard its own news. */
  onWorkerGone(id: string) {
    const previous = this.known.get(id);
    const by = this.sending.get(id);
    if (previous?.lead && by !== 'lead' && this.workers.get(previous.lead)) this.push({ lead: previous.lead, worker: id, name: previous.name, kind: by === 'owner' ? 'sent_home' : 'left' });
    this.known.delete(id);
    this.idleSince.delete(id);
    this.reported.delete(id);
    this.spoke.delete(id);
    const before = this.log.length;
    this.log = this.log.filter((e) => e.lead !== id);
    this.nudged.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (this.log.length !== before) this.persist();
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
      case 'hire':
        return this.hire(caller, b);
      case 'models':
        return this.models(caller);
      case 'models_list':
        return this.models(caller, true);
      case 'diff': {
        const w = this.resolve(caller, b.worker);
        if (typeof w === 'string') return no(404, w);
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
      case 'dismiss':
        return this.dismiss(caller, b);
      case 'report':
        return this.report(caller, b);
      default:
        return no(400, 'Unknown action: use whoami, status, hire, models, send, dismiss or report');
    }
  }

  /** Why `w` can't hire a subagent now, if it can't. */
  cannotHire(w: WorkerInfo): string | undefined {
    const s = this.opts.settings();
    const lead = STATION_AGENT.lead.name;
    if (!s.on) return 'Subagents are turned off in this office (⚙️ Settings → Subagents & visits)';
    if (w.kind !== 'agent') return 'Only agents hire subagents';
    if (w.lead) {
      const boss = this.workers.get(w.lead)?.name ?? 'your lead';
      return `You're a subagent of ${boss}, and subagents can't hire their own: do your task yourself, or ask ${boss} with team_report and question: true`;
    }
    const station = DESK_BY_ID.get(w.deskId)?.station;
    // The Pipeline agent hires the worker that heals a failed run.
    if (station === 'actions') return undefined;
    if (station && station !== 'lead') return `The ${STATION_AGENT[station].name} doesn't hire subagents: suggest the Team lead at the kiosk on the east wall for work that needs a team`;
    if (!station && !s.deskWorkers) return `Only the ${lead} hires subagents in this office (⚙️ Settings → Subagents & visits)`;
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
      ...(s.models?.length ? { models: s.models.length } : {}),
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
    const known = new Map((catalogue?.models ?? []).map((m) => [m.id, m]));
    const fallback = this.defaultModel(catalogue?.defaultModel);
    const describe = (id: string, m: DroidModelOption | undefined, note?: string): TeamModel => {
      const stuck = this.whyNot(id);
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
      };
    };
    const allowed = s.models?.length ? s.models : undefined;
    const models = includeDisabled
      ? [...new Set([...known.keys(), ...(allowed ?? []).map((m) => m.id)])].map((id) => {
          const model = describe(id, known.get(id), allowed?.find((m) => m.id === id)?.note);
          return { ...model, enabled: !model.cannotRun && (!allowed || allowed.some((m) => m.id === id) || id === fallback) };
        })
      : allowed
        ? allowed.map((a) => describe(a.id, known.get(a.id), a.note))
        : (catalogue?.models ?? []).filter((m) => !m.legacy).map((m) => describe(m.id, m));
    // The default is what a hire without --model runs, so the lead sees it even when the list leaves it out.
    if (fallback && !models.some((m) => m.id === fallback)) {
      const model = describe(fallback, known.get(fallback));
      models.unshift({ ...model, ...(includeDisabled ? { enabled: !model.cannotRun } : {}) });
    }
    return ok({ restricted: !!allowed, models, ...(fallback ? { defaultModel: fallback } : {}), ...(catalogue ? {} : { unavailable: true }) });
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
  private async refuseModel(model: string | undefined, named: boolean): Promise<string | undefined> {
    if (!this.opts.availability) return undefined;
    const picked = model ?? this.defaultModel();
    const catalogue = picked && !this.blocked(picked) ? undefined : await this.catalogue();
    const id = picked ?? catalogue?.defaultModel;
    const a = this.blocked(id);
    if (!a || !id) return undefined;
    const known = new Map((catalogue?.models ?? []).map((m) => [m.id, m]));
    const name = (x: string) => known.get(x)?.displayName?.replace(/^DroidProxy:\s*/i, '') ?? x;
    const s = this.opts.settings();
    const pool = s.models?.length ? s.models.map((m) => m.id) : (catalogue?.models ?? []).filter((m) => !m.legacy).map((m) => m.id);
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
      ...(w.worktree ? { worktree: { path: path.join(this.opts.dir, w.worktree.path), branch: w.worktree.branch, from: w.worktree.from ?? w.worktree.base?.slice(0, 7) } } : {}),
      ...(w.activity ? { activity: w.activity } : {}),
      ...(w.task ? { task: w.task.name } : {}),
      ...(w.pr ? { pr: w.pr } : {}),
      settled: settled(w),
      ...(last?.text ? { report: { text: last.text, question: last.kind === 'question', at: last.at, ...(last.pushedSha ? { pushedSha: last.pushedSha } : {}), ...(last.prUrl ? { prUrl: last.prUrl } : {}) } } : {}),
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
  private choice(b: Record<string, unknown>, droidDefault?: string): Partial<AgentChoice> | string {
    const s = this.opts.settings();
    const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : undefined;
    const effort = b.effort === undefined || b.effort === '' ? undefined : b.effort;
    if (effort !== undefined && !isAgentEffort(effort)) return `Effort is one of ${AGENT_EFFORTS.join(', ')}`;
    if (model !== undefined && s.models?.length && model !== this.defaultModel(droidDefault) && !s.models.some((m) => m.id === model)) {
      return `${clip(model, 60)} isn't one of the models this office lets subagents use (⚙️ Settings → Subagents & visits): pick one from team_models, or leave model out for the default`;
    }
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
    // Only a model outside the list needs droid's own default, which subagents may always run.
    const outside = asked && s.models?.length && !s.models.some((m) => m.id === asked) && !this.defaultModel();
    const choice = this.choice(b, outside ? (await this.catalogue())?.defaultModel : undefined);
    if (typeof choice === 'string') return no(400, choice);
    const refused = await this.refuseModel(choice.model, !!asked);
    if (refused) return no(409, refused);
    const full = () => {
      const n = lead.remote ? (this.opts.remoteTeamSize?.(lead.id) ?? this.teamOf(lead.id).length) : this.teamOf(lead.id).length;
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
    const at = DESK_BY_ID.get(still.deskId);
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
    return ok({ ...this.whoami(lead), team, events: lead.remote ? this.inbox(lead.id) : this.drainNews(lead) });
  }

  /** What the lead hasn't heard yet, including from subagents that already left; draining counts as heard. */
  private drainNews(lead: WorkerInfo): Pick<TeamEvent, 'kind' | 'worker' | 'name' | 'at' | 'text'>[] {
    const news = this.log.filter((e) => e.lead === lead.id && !e.seen);
    for (const e of news) e.seen = true;
    if (news.length) this.persist();
    return news.map((e) => ({ kind: e.kind, worker: e.worker, name: e.name, at: e.at, ...(e.text ? { text: e.text } : {}), ...(e.pushedSha ? { pushedSha: e.pushedSha } : {}), ...(e.prUrl ? { prUrl: e.prUrl } : {}) }));
  }

  private send(lead: WorkerInfo, b: Record<string, unknown>): TeamReply {
    const w = this.resolve(lead, b.worker);
    if (typeof w === 'string') return no(404, w);
    const text = str(b.text, TASK_MAX).trim();
    if (!text) return no(400, 'Provide text for team with action message');
    if (w.status === 'starting') return no(409, `${w.name} is still starting up: try again in a few seconds`);
    if (w.status === 'needs_input') return no(409, `${w.name} is waiting on an answer in its own terminal (${w.activity ?? 'a prompt'}): someone has to answer it there, so tell the person`);
    const message = officePrompt(this.opts.prompts, 'subagent.message', { from: lead.name, ...workerMessageVars(text) });
    const err = isAsleep(w.status) ? this.workers.resume(w.id, message) : this.workers.prompt(w.id, message);
    if (err) return no(409, `${w.name}: ${err}`);
    this.reported.delete(w.id);
    this.spoke.delete(w.id);
    return ok({ worker: this.member(this.workers.get(w.id) ?? w) });
  }

  private async dismiss(lead: WorkerInfo, b: Record<string, unknown>): Promise<TeamReply> {
    const w = this.resolve(lead, b.worker);
    if (typeof w === 'string') return no(404, w);
    if (b.pruneWorktree !== undefined && !this.workers.dismiss) return no(409, 'Safe worktree cleanup is unavailable on this floor; no worker was dismissed');
    let result: { note?: string; error?: string };
    this.sending.set(w.id, 'lead');
    try {
      result = await (b.pruneWorktree === undefined ? this.workers.kill(w.id) : this.workers.dismiss!(w.id, b.pruneWorktree === true, b.keepBranch !== false));
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
    const question = b.question === true;
    const sha = typeof b.pushedSha === 'string' ? b.pushedSha : await pushedSha(this.opts.dir, w);
    const prUrl = typeof b.prUrl === 'string' ? b.prUrl : (w.pr?.url ?? /https:\/\/(?:github\.com|gitlab\.com)\/[^\s)<>]+\/(?:pull|merge_requests)\/\d+/.exec(text)?.[0]);
    const provenance = { ...(sha ? { pushedSha: sha } : {}), ...(prUrl ? { prUrl } : {}) };
    this.push({ lead: lead.id, worker: w.id, name: w.name, kind: question ? 'question' : 'report', text, ...provenance });
    if (!question) this.reported.add(w.id);
    this.spoke.add(w.id);
    this.opts.toast(`${question ? `❓ ${w.name} asked ${lead.name}` : `📨 ${w.name} reported to ${lead.name}`}: “${clip(text, 90)}”`, 'info', w.id);
    return ok({ lead: lead.name, ...provenance });
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
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { events?: unknown; nudged?: unknown; idleSince?: unknown };
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
          ...(x.seen === true ? { seen: true } : {}),
          ...(typeof x.pushedSha === 'string' && /^[0-9a-f]{40,64}$/.test(x.pushedSha) ? { pushedSha: x.pushedSha } : {}),
          ...(typeof x.prUrl === 'string' ? { prUrl: x.prUrl.slice(0, 2000) } : {}),
        });
      }
      this.log = this.log.slice(-LOG_MAX);
      if (raw.nudged && typeof raw.nudged === 'object') for (const [k, v] of Object.entries(raw.nudged)) if (typeof v === 'number') this.nudged.set(k, v);
    } catch {
      // nothing kept yet
    }
    // A lead that didn't come back with the office has nobody to hear its news.
    this.log = this.log.filter((e) => !!this.workers.get(e.lead));
    this.seq = this.log.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  private persist() {
    try {
      writeFileSync(this.path, JSON.stringify({ events: this.log, nudged: Object.fromEntries(this.nudged), idleSince: Object.fromEntries(this.idleSince) }), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}

/** It has been given its task and isn't in the middle of a turn: done, waiting on input, or asleep. */
export function settled(w: WorkerInfo): boolean {
  return w.status !== 'starting' && w.status !== 'working' && w.status !== 'idle';
}
