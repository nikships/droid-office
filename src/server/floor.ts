import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ChangesState, FloorInfo, ProjectInfo, ServerMsg, WorkerInfo } from '../shared/protocol.js';
import { isBusy } from '../shared/status.js';
import { DESK_BY_ID } from '../shared/layout.js';
import type { FloorDef } from './building.js';
import { excludeFromGit } from './config.js';
import { WorkerManager, type HookEnv } from './workers.js';
import { GitHub, MergeWatch } from './github.js';
import { GitLab } from './gitlab.js';
import type { Board } from './forge.js';
import { forgeOf, forgeWords, type Forge, type ForgeWords } from '../shared/floors.js';
import { TaskQueue } from './queue.js';
import { Changes } from './changes.js';
import { Decor } from './decor.js';
import { Docs } from './docs.js';
import { Court } from './court.js';
import { Jukebox } from './jukebox.js';
import { MeetingRoom } from './meetings.js';
import { Worktrees } from './worktrees.js';
import { FloorJira, type JiraOffice } from './jira.js';
import { landedWorkers } from './leave-on-merge.js';
import type { Capacity } from './machine.js';
import { officePrompt, type PromptSource } from './prompts.js';
import { Team } from './team.js';
import type { SubagentSettings } from '../shared/protocol.js';

type ToastLevel = 'info' | 'warn' | 'error';

/** What a floor needs from the building around it. */
export interface FloorContext {
  agentCmd: string;
  agentArgs: string[];
  hook: HookEnv;
  /** The office's worker limit, across every floor. */
  capacity: Capacity;
  /** The office's Jira connection, which every floor's epic goes through. */
  jira: JiraOffice;
  /** The office's prompts and the worker a new one starts on when nobody picks, as set in Settings. */
  prompts: PromptSource;
  /** To everyone on this floor. */
  emit(floor: Floor, msg: ServerMsg, droppable?: boolean): void;
  /** To everyone on this floor; `workerId` names the worker it is about, when one is. */
  toast(floor: Floor, text: string, level?: ToastLevel, workerId?: string): void;
  /** A worker's terminal output, for whoever has that terminal open. */
  termData(workerId: string, data: string, connectionIds: string[]): void;
  /** What a worker changed, for whoever has its Changes window open. */
  changes(state: ChangesState, clients: string[]): void;
  /** A worker on this floor changed, or left (then just its id). */
  workerChanged(floor: Floor, w: WorkerInfo | string): void;
  /** How many owner connections are on this floor right now. */
  connections(floor: Floor): number;
  /** ⚙️ Settings: a worker whose pull request merged goes home by itself. */
  leaveOnMerge(): boolean;
  /** ⚙️ Settings → Subagents: how workers hire subagents. */
  subagents(): SubagentSettings;
  /** Another floor of the building: a worker across repositories works in its project too (see WorkerInfo.repos). */
  floor(id: string): Floor | undefined;
  /** This floor's pull requests came back: a worker on another floor with a repository here may have landed. */
  pullsChanged(floor: Floor): void;
  /** Whether a worker on another floor works in this floor's project too. */
  lent(floor: Floor): boolean;
}

/** The open pull request on a floor's board whose head is `branch`. */
function openPull(floor: Floor, branch: string): { number: number; url: string } | undefined {
  const pr = floor.board.pulls.items.find((p) => p.state === 'OPEN' && p.headRefName === branch);
  return pr ? { number: pr.number, url: pr.url } : undefined;
}

/** How long after a PR list or a worker's change the office looks for workers whose PR merged. */
const LANDED_DELAY_MS = 1500;
/** Boards on a floor nobody is on, with nothing running, are asked GitHub or GitLab about this seldom. */
const IDLE_REFRESH_MS = 10 * 60_000;
const REFRESH_MS = 90_000;

/** What `git` says about a checkout: its name, branch and origin for the top bar. */
export function projectInfo(dir: string, name: string, agentCmd: string, agentArgs: string[], forge: Forge = 'github'): ProjectInfo {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  return {
    name,
    dir,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    remote: git(['remote', 'get-url', 'origin']),
    forge,
    agentCmd: [agentCmd, ...agentArgs].join(' '),
  };
}

/**
 * One floor of the building: a project's checkout with its own desks and workers, issues and PR
 * boards, task queue, pictures and jukebox, all kept in that checkout's .droid-office folder.
 */
export class Floor {
  readonly id: string;
  readonly dir: string;
  readonly project: ProjectInfo;
  readonly workers: WorkerManager;
  /** The issue and PR boards, on GitHub or GitLab as the floor's repository is. */
  readonly board: Board;
  /** The floor's Jira epic, as the issue board's Jira tab (see jira.ts). */
  readonly jira: FloorJira;
  readonly queue: TaskQueue;
  readonly changes: Changes;
  readonly decor: Decor;
  readonly jukebox: Jukebox;
  /** The meeting room, where workers work through a question together (see meetings.ts). */
  readonly meetings: MeetingRoom;
  /** The bookshelf: the project's Markdown files (see docs.ts). */
  readonly docs: Docs;
  /** Leads and the subagents they hire with office-workers (see team.ts). */
  readonly team: Team;
  /** Settles once the workers whose terminals outlived the last office are picked back up, and the rest woken. */
  readonly ready: Promise<void>;
  /** The basketball by the hoop: who has it, or how it was last thrown. */
  readonly court = new Court();
  private timer: NodeJS.Timeout;
  /** Pull requests merging, to ring the gong for. */
  private merges = new MergeWatch();
  /** A look for workers whose pull request merged, due shortly (see sendLandedHome). */
  private landedTimer?: NodeJS.Timeout;
  /** Workers across repositories whose worktrees are being checked before they go home. */
  private landing = new Set<string>();
  /** How this floor's forge names things: PR #n on GitHub, MR !n on GitLab. */
  private words: ForgeWords;

  constructor(
    readonly def: FloorDef,
    private ctx: FloorContext,
  ) {
    this.id = def.id;
    this.dir = def.dir;
    const dataDir = path.join(def.dir, '.droid-office');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    excludeFromGit(def.dir);
    const forge = forgeOf(def.repo) ?? 'github';
    const words = forgeWords(forge);
    this.words = words;
    this.project = projectInfo(def.dir, def.name, ctx.agentCmd, ctx.agentArgs, forge);
    this.docs = new Docs(def.dir);
    const onIssues = (state: Board['issues']) => ctx.emit(this, { t: 'gh.issues', state });
    const onPulls = (state: Board['pulls']) => {
      ctx.emit(this, { t: 'gh.pulls', state });
      this.queue?.onPulls(state.items);
      if (state.loading || state.error) return;
      // A worker may have opened one from a branch it made itself, mid-turn or from a shell.
      void this.workers.syncBranches();
      for (const p of this.merges.look(state.items)) {
        ctx.toast(this, `🎉 ${words.pr} ${words.ref(p.number)} merged: ${p.title}`);
        this.merged(p.number);
      }
      this.sendLandedHome();
      ctx.pullsChanged(this);
    };
    this.jira = new FloorJira(dataDir, ctx.jira, {
      state: (state) => ctx.emit(this, { t: 'jira', state }),
      board: (state) => ctx.emit(this, { t: 'jira.board', state }),
    });
    this.board = forge === 'gitlab' && def.repo ? new GitLab(def.dir, def.repo, onIssues, onPulls) : new GitHub(def.dir, onIssues, onPulls);

    this.workers = new WorkerManager(
      def.dir,
      dataDir,
      ctx.agentCmd,
      ctx.agentArgs,
      ctx.hook,
      {
        update: (worker) => {
          ctx.emit(this, { t: 'worker.update', worker });
          // Still being built: the first updates come from waking the workers already at their desks.
          this.queue?.onWorker(worker);
          this.meetings?.onWorker(worker);
          this.team?.onWorker(worker);
          ctx.workerChanged(this, worker);
          // Its turn ended, or whoever had its terminal open closed it: it may be free to go now.
          this.sendLandedHome();
        },
        remove: (workerId) => {
          this.changes?.forget(workerId);
          ctx.emit(this, { t: 'worker.remove', workerId });
          this.queue?.onWorkerGone(workerId);
          this.meetings?.onWorkerGone(workerId);
          this.team?.onWorkerGone(workerId);
          ctx.workerChanged(this, workerId);
        },
        data: (workerId, data, connectionIds) => ctx.termData(workerId, data, connectionIds),
        screen: (workerId, frame) => ctx.emit(this, { t: 'screen', workerId, ...frame }, true),
        toast: (text, level, workerId) => ctx.toast(this, text, level, workerId),
      },
      ctx.capacity,
      this.board,
      ctx.prompts,
    );

    // The 📋 task queue seats workers by itself: it watches the workers and links PRs from GitHub.
    const queued = this.workers;
    this.queue = new TaskQueue(
      dataDir,
      {
        get officeDefault() {
          return queued.officeDefault;
        },
        list: () => queued.list(),
        deskOccupied: (id) => queued.deskOccupied(id),
        spawn: (deskId, by, prompt, worktree, kind, model, effort, images) => queued.spawn(deskId, by, prompt, worktree, kind, model, effort, undefined, [], undefined, images),
        unstage: (ids) => queued.unstage(ids),
        kill: (id) => queued.kill(id),
        fetchBase: () => queued.fetchBase(),
      },
      !!this.project.branch,
      {
        update: (state) => {
          ctx.emit(this, { t: 'queue', state });
          // A task's pull request may just have been linked (or merged).
          this.sendLandedHome();
        },
        toast: (text, level) => ctx.toast(this, text, level),
        claimIssue: (issue) => this.board.claim(issue),
        refreshGitHub: () => void this.board.refresh(),
        room: () => ctx.capacity.room(),
        emptied: () => {
          ctx.toast(this, '📋 The queue is empty: every task is done 🎉');
          ctx.emit(this, { t: 'gong', why: 'queue' });
        },
        worktreeNote: () => officePrompt(ctx.prompts, 'queue.worktree'),
      },
    );

    // Meetings seat their own workers round the meeting room's table and run them round by round.
    const workers = this.workers;

    this.team = new Team(
      {
        list: () => workers.list(),
        get: (id) => workers.get(id),
        deskOccupied: (id) => workers.deskOccupied(id),
        get officeDefault() {
          return workers.officeDefault;
        },
        hire: (deskId, by, prompt, worktree, c, lead) => workers.spawn(deskId, by, prompt, worktree, 'agent', c.model, c.effort, undefined, [], lead),
        prompt: (id, text) => workers.prompt(id, text),
        resume: (id, text) => workers.resume(id, text),
        kill: (id) => workers.kill(id),
        tail: (id, lines) => workers.tail(id, lines),
        setTask: (id, task) => workers.setTask(id, task),
        fetchBase: () => workers.fetchBase(),
      },
      {
        dataDir,
        dir: def.dir,
        git: !!this.project.branch,
        settings: () => ctx.subagents(),
        prompts: ctx.prompts,
        toast: (text, level, workerId) => ctx.toast(this, text, level, workerId),
      },
    );
    this.meetings = new MeetingRoom(
      def.dir,
      dataDir,
      {
        get officeDefault() {
          return workers.officeDefault;
        },
        list: () => this.workers.list(),
        seat: (deskId, by, prompt, model, effort, meeting, images) => this.workers.spawn(deskId, by, prompt, false, 'agent', model, effort, meeting, [], undefined, images),
        prompt: (id, text) => this.workers.prompt(id, text),
        write: (id, data) => this.workers.write(id, data),
        kill: (id) => this.workers.kill(id),
      },
      this.project.branch ? new Worktrees(def.dir) : undefined,
      {
        update: (state) => ctx.emit(this, { t: 'meeting', state }),
        toast: (text, level) => ctx.toast(this, text, level),
        postReview: (pr, file) => this.board.review(pr, file),
        prompt: (id) => ctx.prompts.text(id),
      },
      forge,
    );

    // What each worker changed, for the Changes window at its desk (see changes.ts).
    this.changes = new Changes(
      this.project.branch,
      (workerId, repo) => {
        const w = this.workers.get(workerId);
        if (!w) return undefined;
        if (!repo) return { name: w.name, cwd: w.worktree ? path.join(def.dir, w.worktree.path) : def.dir, rel: w.worktree?.path ?? '', worktreeBase: w.worktree?.base };
        // One of the other floors' repositories it works in: diffed against, and PRs opened against, that floor's branch.
        const r = w.repos?.find((x) => x.floor === repo);
        if (!r) return undefined;
        const other = ctx.floor(r.floor);
        return {
          name: w.name,
          cwd: path.join(def.dir, r.path),
          rel: r.path,
          worktreeBase: r.base,
          baseBranch: r.from ?? null,
          openPull: (branch) => (other ? openPull(other, branch) : undefined),
          refreshGitHub: () => void other?.board.refresh(),
        };
      },
      (branch) => openPull(this, branch),
      {
        state: (state, ids) => ctx.changes(state, ids),
        toast: (text, level) => ctx.toast(this, text, level),
        refreshGitHub: () => void this.board.refresh(),
      },
      this.board,
    );

    this.decor = new Decor(dataDir);
    this.jukebox = new Jukebox(dataDir);
    this.ready = this.workers.start();

    void this.board.refresh();
    void this.jira.refresh();
    // A floor with an owner connection on it, or work under way, keeps its boards fresh; the others check in now and then.
    this.timer = setInterval(() => {
      const active = this.active();
      if (active || Date.now() - this.board.issues.fetchedAt > IDLE_REFRESH_MS) void this.board.refresh();
      if (active || Date.now() - this.jira.fetchedAt > IDLE_REFRESH_MS) void this.jira.refresh();
    }, REFRESH_MS);
  }

  /** Pull request `n` merged (`by` someone, from the PR window): the gong rings, once per PR. */
  merged(n: number, by?: string) {
    if (this.merges.ring(n)) this.ctx.emit(this, { t: 'gong', why: 'merged', pr: n, by });
  }

  /**
   * With ⚙️ Settings' *go home once merged* on, sends home every worker whose pull request merged,
   * once it's at rest and nobody has its terminal open, deleting its worktree and branch unless they
   * hold work that isn't on the remote. Called whenever that might have changed; it looks a moment
   * later, once for a burst of calls, and not from inside the event that prompted it.
   */
  sendLandedHome() {
    if (this.landedTimer || !this.ctx.leaveOnMerge()) return;
    this.landedTimer = setTimeout(() => {
      this.landedTimer = undefined;
      if (!this.ctx.leaveOnMerge()) return;
      const pullsOf = (id: string) => this.ctx.floor(id)?.board.pulls.items;
      for (const landed of landedWorkers(this.workers.list(), this.board.pulls.items, this.queue.state().tasks, pullsOf)) {
        const { worker, head, heads } = landed;
        if (!worker.repos?.length) {
          this.goHome(worker, `${this.words.pr} ${this.words.ref(landed.pr)} merged`, head);
          continue;
        }
        // Across repositories, one PR can merge before another repository's work even has one:
        // it goes once nothing is left that its merged PRs didn't deliver.
        if (this.landing.has(worker.id)) continue;
        this.landing.add(worker.id);
        void this.workers
          .holdsWork(worker.id, head, heads)
          .catch(() => true)
          .then((held) => {
            this.landing.delete(worker.id);
            if (!held && this.workers.get(worker.id) === worker) this.goHome(worker, `its pull requests merged (${landed.prs?.join(', ')})`, head, heads);
          });
      }
    }, LANDED_DELAY_MS);
  }

  private goHome(worker: WorkerInfo, why: string, head?: string, heads?: Record<string, string | undefined>) {
    const done = this.workers.kill(worker.id, undefined, head, heads);
    this.ctx.toast(this, `🏠 ${worker.name} went home: ${why}`);
    void done.then(({ note, error }) => {
      if (note) this.ctx.toast(this, note);
      if (error) this.ctx.toast(this, error, 'warn');
    });
  }

  /** Someone just walked in: boards that haven't been looked at in a while get fetched again. */
  arrived() {
    if (Date.now() - Math.max(this.board.issues.fetchedAt, this.board.pulls.fetchedAt) > REFRESH_MS) void this.board.refresh();
    if (Date.now() - this.jira.fetchedAt > REFRESH_MS) void this.jira.refresh();
  }

  private active(): boolean {
    return this.ctx.connections(this) > 0 || this.ctx.lent(this) || this.workers.list().some((w) => isBusy(w.status)) || this.queue.state().tasks.some((t) => t.status !== 'done') || this.meetings.state().current?.status === 'running';
  }

  info(): FloorInfo {
    const ws = this.workers.list();
    return {
      id: this.id,
      name: this.def.name,
      repo: this.def.repo,
      dir: this.dir,
      branch: this.project.branch,
      palette: this.def.palette,
      addedBy: this.def.addedBy,
      addedAt: this.def.addedAt,
      workers: ws.filter((w) => !DESK_BY_ID.get(w.deskId)?.station).length,
      busy: ws.filter((w) => w.status === 'working').length,
      waiting: ws.filter((w) => w.kind === 'agent' && (w.status === 'needs_input' || (w.status === 'done' && !w.acked))).length,
    };
  }

  /** With `keep` (a restart), the workers' terminals keep running for the next office to pick up. */
  shutdown(keep = false) {
    clearInterval(this.timer);
    clearTimeout(this.landedTimer);
    this.board.stop();
    this.queue.shutdown();
    this.meetings.shutdown();
    this.team.stop();
    this.changes.stop();
    this.workers.shutdown(keep);
  }
}
