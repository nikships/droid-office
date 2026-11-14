import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AskedQuestion, TeamBadge, TeamEmblem, WorkerAsk, WorkerInfo, WorkerRepo, WorkerStatus, WorkerTask } from '../../shared/protocol.js';
import { isAgentEffort } from '../../shared/protocol.js';
import { TEAM_EMBLEMS, settleTeams } from '../../shared/team.js';
import { DESK_BY_ID } from '../../shared/layout.js';
import { validTodoProgress } from '../../shared/todos.js';
import type { WorktreeOwnership } from '../worktrees.js';
import { isValidDroidModel } from '../agents.js';
import { midTurn, newWorker, type Worker } from './state.js';

interface RecoveryContext {
  deskless: boolean;
  cols: number;
  rows: number;
  color: string;
  buildingKnown(id: string): boolean;
  heldDesk(id: string): boolean;
}

interface SaveState {
  closing: boolean;
  stopping: boolean;
  onShutdown: boolean;
}

/** Owns the on-disk worker schema, legacy validation and records whose seats no longer exist. */
export class WorkerStateStore {
  private statePath: string;
  /** Workers saved at a seat that no longer exists: never run, kept in the file untouched. */
  private retired: unknown[] = [];

  constructor(
    dataDir: string,
    private context: RecoveryContext,
  ) {
    this.statePath = path.join(dataDir, 'workers.json');
  }
  save(workers: Iterable<Worker>, state: SaveState) {
    // A stopped manager's pending callbacks must not overwrite its successor's state.
    if (state.closing && !state.onShutdown) return;
    const saved = [...workers]
      .filter((w) => !w.info.remote)
      .map(({ info, hookToken, pty, bootBlocked, stopAt, interrupted, worktreeOwnership, launchPrompt, pendingFork, outbox }) => ({
        id: info.id,
        kind: info.kind,
        model: info.model,
        effort: info.effort,
        deskId: info.deskId,
        name: info.name,
        color: info.color,
        createdBy: info.createdBy,
        createdAt: info.createdAt,
        prompt: info.prompt,
        worktree: info.worktree,
        worktreeOwnership,
        repos: info.repos,
        title: info.title,
        sessionId: info.sessionId,
        forkedFrom: info.forkedFrom,
        pendingFork,
        activity: info.activity,
        task: info.task,
        taskSince: info.taskSince,
        todos: info.todos,
        pr: info.pr,
        lead: info.lead,
        team: info.team,
        // A terminal still running in the host, to pick back up after a restart. Its hooks keep the token.
        hookToken,
        // Its first message, while its droid hasn't taken it yet: the next office types it in at SessionStart.
        // Notices it was promised and hasn't been handed yet, which the next office hands over instead.
        // The question or permission prompt it waits on, so a terminal picked back up can still be answered from the hooks' account of it.
        pty: pty?.id
          ? { id: pty.id, status: info.status, acked: info.acked, waitingSince: info.waitingSince, ...(info.status === 'needs_input' && info.ask ? { ask: info.ask } : {}), launchPrompt, ...(outbox.length ? { outbox } : {}) }
          : undefined,
        // In the middle of something: if its terminal doesn't make it through a restart, it carries on after.
        midTurn: !state.stopping && (!!interrupted || midTurn({ info, bootBlocked, stopAt })),
      }));
    try {
      writeFileSync(this.statePath, JSON.stringify([...saved, ...this.retired], null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }

  restore(workers: Map<string, Worker>) {
    if (!existsSync(this.statePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as (Partial<WorkerInfo> & {
        hookToken?: unknown;
        pty?: any;
        midTurn?: unknown;
        worktreeOwnership?: Record<string, WorktreeOwnership>;
        pendingFork?: Worker['pendingFork'];
        /** An office from before subscriptions kept who last typed here; only the time carries over. */
        lastInput?: unknown;
      })[];
      for (const s of saved) {
        // A building agent's id is its own: no floor seats a record that claims one.
        const seated = (this.context.deskless ? s.deskId === '' : !!s.deskId && DESK_BY_ID.has(s.deskId)) && !(s.id && this.context.buildingKnown(s.id));
        if (s.id && typeof s.deskId === 'string' && !seated) this.retired.push(s);
        if (!s.id || typeof s.deskId !== 'string' || !seated || (!this.context.deskless && ([...workers.values()].some((w) => w.info.deskId === s.deskId) || this.context.heldDesk(s.deskId)))) continue;
        const shell = s.kind === 'shell';
        const info: WorkerInfo = {
          id: s.id,
          kind: shell ? 'shell' : 'agent',
          model: shell ? undefined : restoredModel(s.model),
          effort: shell ? undefined : isAgentEffort(s.effort) ? s.effort : undefined,
          deskId: s.deskId,
          name: s.name ?? 'Worker',
          color: s.color ?? this.context.color,
          status: 'offline',
          acked: true,
          createdBy: s.createdBy ?? '?',
          createdAt: s.createdAt ?? Date.now(),
          prompt: s.prompt,
          worktree: s.worktree,
          repos: s.worktree ? validRepos(s.repos) : undefined,
          title: s.title,
          sessionId: s.sessionId,
          forkedFrom: s.forkedFrom && typeof s.forkedFrom.workerId === 'string' && typeof s.forkedFrom.name === 'string' && typeof s.forkedFrom.sessionId === 'string' ? s.forkedFrom : undefined,
          activity: s.activity,
          task: validTask(s.task),
          taskSince: typeof s.taskSince === 'number' && Number.isFinite(s.taskSince) && s.taskSince > 0 ? s.taskSince : undefined,
          ...(!shell && validTodoProgress(s.todos) ? { todos: validTodoProgress(s.todos) } : {}),
          pr: s.pr && typeof s.pr.number === 'number' && typeof s.pr.url === 'string' ? { number: s.pr.number, url: s.pr.url } : undefined,
          cols: this.context.cols,
          rows: this.context.rows,
          open: false,
          lastInputAt: legacyLastInputAt(s.lastInput),
          ...(typeof s.lead === 'string' && s.kind !== 'shell' ? { lead: s.lead } : {}),
          ...(s.kind !== 'shell' && validTeam(s.team) ? { team: validTeam(s.team) } : {}),
        };
        const w = newWorker(info, typeof s.hookToken === 'string' && s.hookToken ? s.hookToken : undefined);
        w.worktreeOwnership = s.worktreeOwnership;
        if (!info.sessionId && typeof s.pendingFork?.sessionId === 'string') w.pendingFork = { sessionId: s.pendingFork.sessionId, prompt: typeof s.pendingFork.prompt === 'string' ? s.pendingFork.prompt : undefined };
        w.screenDirty = false;
        if (typeof s.pty?.id === 'string') {
          const status: WorkerStatus = RUNNING.has(s.pty.status) ? s.pty.status : 'idle';
          const launch = s.pty.launchPrompt;
          w.saved = {
            ptyId: s.pty.id,
            status,
            acked: s.pty.acked !== false,
            waitingSince: typeof s.pty.waitingSince === 'number' ? s.pty.waitingSince : undefined,
            ask: status === 'needs_input' ? validAsk(s.pty.ask) : undefined,
            launchPrompt: typeof launch?.text === 'string' && launch.text && typeof launch.at === 'number' ? { text: launch.text, at: launch.at } : undefined,
            outbox: Array.isArray(s.pty.outbox) ? s.pty.outbox.filter((n: unknown): n is string => typeof n === 'string' && !!n) : undefined,
          };
        }
        // Mid-turn as the office went down: cut off, unless its terminal is picked back up still
        // running (adopt). An office from before midTurn only said so for a terminal in the host.
        w.interrupted = typeof s.midTurn === 'boolean' ? s.midTurn : s.pty?.status === 'working' || s.pty?.status === 'needs_input';
        workers.set(info.id, w);
      }
      // A lead that didn't come back, or is a subagent itself, leads nobody.
      for (const w of workers.values()) {
        if (!w.info.lead || (!workers.has(w.info.lead) && this.context.buildingKnown(w.info.lead))) continue;
        const lead = workers.get(w.info.lead)?.info;
        if (!lead || lead.lead) delete w.info.lead;
      }
      // Markings follow who leads whom now; an office from before them gives each team its own.
      const teams = settleTeams([...workers.values()].map((w) => w.info));
      for (const w of workers.values()) {
        const badge = teams.get(w.info.id);
        if (badge) w.info.team = badge;
        else delete w.info.team;
      }
    } catch {
      // corrupt state file: start fresh
    }
  }
}

/** What a worker with a live terminal can be doing. */
const RUNNING = new Set<unknown>(['starting', 'idle', 'working', 'done', 'needs_input'] satisfies WorkerStatus[]);
/** When a legacy `lastInput: {by, at}` record says input last landed, if it says so sanely. */
function legacyLastInputAt(lastInput: unknown): number | undefined {
  const at = (lastInput as { at?: unknown } | null)?.at;
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

function restoredModel(model: unknown): string | undefined {
  return isValidDroidModel(model) ? model : undefined;
}

function validTeam(t: unknown): TeamBadge | undefined {
  const v = t as Partial<TeamBadge> | undefined;
  if (!v || typeof v.id !== 'string' || !v.id || (v.role !== 'lead' && v.role !== 'member') || typeof v.leadName !== 'string') return undefined;
  if (typeof v.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(v.accent) || !TEAM_EMBLEMS.includes(v.emblem as TeamEmblem)) return undefined;
  return { id: v.id, role: v.role, accent: v.accent, emblem: v.emblem as TeamEmblem, leadName: v.leadName.slice(0, 80) };
}

function validAsk(a: unknown): WorkerAsk | undefined {
  const v = a as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object') return undefined;
  const sub = v.sub === true ? { sub: true as const } : {};
  if (v.kind === 'question' && Array.isArray(v.questions)) {
    const questions = v.questions.flatMap((q: Partial<AskedQuestion> | null) =>
      q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.every((o) => typeof o === 'string') && typeof q.multiSelect === 'boolean'
        ? [{ question: q.question, ...(typeof q.topic === 'string' ? { topic: q.topic } : {}), options: [...q.options], multiSelect: q.multiSelect }]
        : [],
    );
    return questions.length ? { kind: 'question', questions, ...sub } : undefined;
  }
  if (v.kind !== 'permission' || typeof v.tool !== 'string') return undefined;
  const text = (key: 'command' | 'file' | 'risk' | 'summary') => (typeof v[key] === 'string' ? { [key]: v[key] as string } : {});
  return { kind: 'permission', tool: v.tool, ...text('command'), ...text('file'), ...text('risk'), ...text('summary'), ...sub };
}

function validTask(t: unknown): WorkerTask | undefined {
  const v = t as Partial<WorkerTask> | undefined;
  return typeof v?.name === 'string' && typeof v.summary === 'string'
    ? {
        name: v.name,
        summary: v.summary,
        ...(v.generated === true
          ? {
              generated: true,
              ...(typeof v.textHash === 'string' && /^[a-f0-9]{64}$/.test(v.textHash) ? { textHash: v.textHash } : {}),
              ...(typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) && v.updatedAt > 0 ? { updatedAt: v.updatedAt } : {}),
            }
          : {}),
      }
    : undefined;
}

/** The other repositories of a worker across repositories, as workers.json kept them. */
function validRepos(raw: unknown): WorkerRepo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const repos = raw.flatMap((row): WorkerRepo[] => {
    if (!row || typeof row !== 'object') return [];
    const r = row as { floor?: unknown; name?: unknown; repo?: unknown; dir?: unknown; path?: unknown; branch?: unknown; base?: unknown; from?: unknown; pr?: { number?: unknown; url?: unknown } };
    const floor = str(r.floor);
    const name = str(r.name);
    const dir = str(r.dir);
    const rel = str(r.path);
    const branch = str(r.branch);
    const base = str(r.base);
    if (!floor || !name || !dir || !rel || !branch || !base) return [];
    const pr = r.pr && typeof r.pr.number === 'number' && typeof r.pr.url === 'string' ? { number: r.pr.number, url: r.pr.url } : undefined;
    return [{ floor, name, repo: str(r.repo), dir, path: rel, branch, base, from: str(r.from), pr }];
  });
  return repos.length ? repos : undefined;
}
