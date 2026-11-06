import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ChangesState, FloorInfo, ProjectInfo, ServerMsg, WorkerInfo } from '../shared/protocol.js';
import { isBusy } from '../shared/status.js';
import { isCheckout, type FloorDef } from './building.js';
import { excludeFromGit } from './config.js';
import { OFFICE_SHELL_ID } from '../shared/office-shell.js';
import { OfficeShell } from './office-shell.js';
import { COLORS, NAMES, WorkerManager, type HookEnv } from './workers.js';
import { CloudWorkers } from './cloud-workers.js';
import { GitHub, MergeWatch } from './github.js';
import { GitLab } from './gitlab.js';
import { NoBoard, type Board } from './forge.js';
import { forgeOf, forgeWords, type Forge, type ForgeWords } from '../shared/floors.js';
import { floorPipelines, type Pipelines } from './pipelines.js';
import { stateWord } from '../shared/pipelines.js';
import { Changes } from './changes.js';
import { debounce, type ToolRefresh } from './hook-refresh.js';
import { Decor } from './decor.js';
import { Docs } from './docs.js';
import { FloorJira, type JiraOffice } from './jira.js';
import { landedWorkers } from './leave-on-merge.js';
import type { Capacity } from './machine.js';
import type { PromptSource } from './prompts.js';
import { Team } from './team.js';
import { Visits } from './visits.js';
import type { DroidModelCatalogue } from './droid-models.js';
import type { SubagentSettings } from '../shared/protocol.js';
import type { ModelAvailability } from '../shared/subscriptions.js';
import type { WorktreeSetupState } from '../shared/worktree-setup.js';
import { setupState, writeOverride } from './worktree-setup.js';
import { WhiteboardStore, renderInfo } from './whiteboard.js';
import type { WhiteboardRenderers } from './whiteboard-render.js';
import { boardReaders } from './whiteboard-agent.js';
import { waitingStatus } from './office-status.js';
import type { RemoteWorkers } from './remote-workers.js';

type ToastLevel = 'info' | 'warn' | 'error';

/** A worker left a floor's desks. A remote desk moving to another floor is not a departure from its teams, conversations or board. */
export function workerLeft(id: string, remote: Pick<RemoteWorkers, 'identity'> | undefined, floor: { team?: Pick<Team, 'onWorkerGone'>; visits?: Pick<Visits, 'onWorkerGone'>; whiteboard?: Pick<WhiteboardStore, 'forgetReader'> }) {
  if (remote?.identity(id)) return;
  floor.team?.onWorkerGone(id);
  floor.visits?.onWorkerGone(id);
  // A dismissed worker's read points would hold the board's tombstones for good.
  floor.whiteboard?.forgetReader(id);
}

/** What a floor needs from the building around it. */
export interface FloorContext {
  remoteWorkers?: RemoteWorkers;
  remoteRevoke?(id: string): void;
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
  /** ⚙️ Settings: a fresh worker starts from the latest of the default branch (see WorkerManager.freshMain). */
  freshMain(): boolean;
  /** ⚙️ Settings → Subagents & visits: how workers hire subagents. */
  subagents(): SubagentSettings;
  /** Droid's model list, which leads choose subagents' models from. */
  droidModels?(): Promise<DroidModelCatalogue>;
  /** Subscriptions: why an agent on `model` can't start now, or undefined when it can (docs/subscriptions.md). */
  modelGate?(model: string | undefined): string | undefined;
  /** Subscriptions: whether a subscription model can run now; undefined when it isn't one or nobody can tell. */
  modelAvailability?(model: string): ModelAvailability | undefined;
  /** Another floor of the building: a worker across repositories works in its project too (see WorkerInfo.repos). */
  floor(id: string): Floor | undefined;
  /** This floor's pull requests came back: a worker on another floor with a repository here may have landed. */
  pullsChanged(floor: Floor): void;
  /** Whether a worker on another floor works in this floor's project too. */
  lent(floor: Floor): boolean;
  /** What renders Whiteboard cards to images, shared by every floor (each gets its own view); none is the office without one. */
  renderer?: WhiteboardRenderers;
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
/** Pipelines are looked at again when someone walks in after this long. */
const PIPELINES_STALE_MS = 20_000;
/** How long after a worker's push or pull request command the boards are asked again, once per burst of them. */
const BOARD_AFTER_TOOL_MS = 1500;
/** A push's CI runs take a few seconds to show up on the forge. */
const PIPELINES_AFTER_PUSH_MS = 6000;

/** What `git` says about a checkout: its name, branch and origin for the top bar. A plain folder has neither. */
export function projectInfo(dir: string, name: string, agentCmd: string, agentArgs: string[], forge: Forge = 'github', plain = false): ProjectInfo {
  const git = (args: string[]) => {
    // Inside someone else's checkout, git would answer for that one.
    if (plain) return undefined;
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
 * One floor of the building: a project's checkout with its own desks and workers, issues, pipelines
 * and PR boards and pictures, all kept in that checkout's .droid-office folder.
 */
export class Floor {
  readonly id: string;
  readonly dir: string;
  /** Not a git checkout of its own: no worktrees, branches, boards, pipelines or CI, and nothing asks gh or glab about it. */
  readonly plain: boolean;
  readonly project: ProjectInfo;
  private branchInfo: Pick<FloorInfo, 'baseBranch' | 'selectedBranch'> = {};
  readonly workers: WorkerManager;
  /** The login shell on the boss's monitor. Not a worker. */
  readonly shell: OfficeShell;
  /** The issue and PR boards, on GitHub or GitLab as the floor's repository is. */
  readonly board: Board;
  /** The floor's Jira epic, as the issue board's Jira tab (see jira.ts). */
  readonly jira: FloorJira;
  /** Its repository's GitHub Actions runs, or its GitLab project's pipelines (see pipelines.ts). */
  readonly pipelines: Pipelines;
  readonly changes: Changes;
  readonly decor: Decor;
  /** The bookshelf: the project's Markdown files (see docs.ts). */
  readonly docs: Docs;
  /** Leads and the subagents they hire with the Office MCP's team tools (see team.ts). */
  readonly team: Team;
  /** Independent workers visiting each other's desks with the Office MCP's visit tools (see visits.ts). */
  readonly visits: Visits;
  /** Workers whose Droid session runs on a Factory computer, not on this machine (see cloud-workers.ts). */
  readonly cloud: CloudWorkers;
  /** The floor's Whiteboard, in its checkout's .droid-office/whiteboard (see whiteboard.ts). */
  readonly whiteboard: WhiteboardStore;
  /** Settles once the workers whose terminals outlived the last office are picked back up, and the rest woken. */
  readonly ready: Promise<void>;
  private timer: NodeJS.Timeout;
  /** Pull requests merging, to ring the gong for. */
  private merges = new MergeWatch();
  /** A look for workers whose pull request merged, due shortly (see sendLandedHome). */
  private landedTimer?: NodeJS.Timeout;
  /** Workers across repositories whose worktrees are being checked before they go home. */
  private landing = new Set<string>();
  /** How this floor's forge names things: PR #n on GitHub, MR !n on GitLab. */
  private words: ForgeWords;
  /** The forge looked at again after workers' pushes and pull request commands (see afterTool). */
  private boardSoon = debounce(() => void this.board.refresh(), BOARD_AFTER_TOOL_MS);
  private pipelinesSoon = debounce(() => void this.pipelines.refresh(), PIPELINES_AFTER_PUSH_MS);

  constructor(
    readonly def: FloorDef,
    private ctx: FloorContext,
  ) {
    this.id = def.id;
    this.dir = def.dir;
    this.plain = !isCheckout(def.dir);
    const dataDir = path.join(def.dir, '.droid-office');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // Leftover from when guests were supported: remove it so stale state is cleaned up.
    try {
      rmSync(path.join(dataDir, 'guests.json'), { force: true });
    } catch {
      // ignore
    }
    // A plain folder has no .git of its own: its info/exclude would be some other checkout's.
    if (!this.plain) excludeFromGit(def.dir);
    const forge = forgeOf(def.repo) ?? 'github';
    const words = forgeWords(forge);
    this.words = words;
    this.project = projectInfo(def.dir, def.name, ctx.agentCmd, ctx.agentArgs, forge, this.plain);
    this.docs = new Docs(def.dir);
    const onIssues = (state: Board['issues']) => ctx.emit(this, { t: 'gh.issues', state });
    const onPulls = (state: Board['pulls']) => {
      ctx.emit(this, { t: 'gh.pulls', state });
      if (state.loading || state.error) return;
      // A worker may have opened one from a branch it made itself, mid-turn or from a shell.
      void this.workers.syncBranches();
      // A branch that merged is no place for the next worker to start from.
      void this.workers.settleCheckout().catch(() => undefined);
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
    this.board = this.plain ? new NoBoard() : forge === 'gitlab' && def.repo ? new GitLab(def.dir, def.repo, onIssues, onPulls) : new GitHub(def.dir, onIssues, onPulls);

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
          this.team?.onWorker(worker);
          this.visits?.onWorker(worker);
          ctx.workerChanged(this, worker);
          // Its turn ended, or whoever had its terminal open closed it: it may be free to go now.
          this.sendLandedHome();
        },
        remove: (workerId, shot) => {
          this.changes?.forget(workerId);
          ctx.emit(this, { t: 'worker.remove', workerId, ...(shot ? { shot } : {}) });
          workerLeft(workerId, ctx.remoteWorkers, this);
          ctx.workerChanged(this, workerId);
        },
        data: (workerId, data, connectionIds) => ctx.termData(workerId, data, connectionIds),
        screen: (workerId, frame) => ctx.emit(this, { t: 'screen', workerId, ...frame }, true),
        toast: (text, level, workerId) => ctx.toast(this, text, level, workerId),
        checkout: (branch) => {
          this.project.branch = branch;
          this.branchInfo = { baseBranch: this.workers.baseBranch, selectedBranch: this.workers.selectedBranch };
        },
        tool: (workerId, refresh) => {
          if (refresh.changes) this.changes.touched(workerId);
          this.afterTool(refresh);
          // Its other repositories are other floors' projects: their boards may have changed too.
          for (const r of this.workers.get(workerId)?.repos ?? []) this.ctx.floor(r.floor)?.afterTool(refresh);
        },
      },
      ctx.capacity,
      this.board,
      ctx.prompts,
      this.plain,
      ctx.remoteWorkers && ctx.remoteRevoke ? { store: ctx.remoteWorkers, floor: this.id, revoke: ctx.remoteRevoke } : undefined,
    );
    this.branchInfo = { baseBranch: this.workers.baseBranch, selectedBranch: this.workers.selectedBranch };

    const own = this.workers;
    const ownNames = () => own.list().map((w) => w.name.replace(/ 🐚$/, ''));
    this.cloud = new CloudWorkers(
      dataDir,
      { deskTaken: (id) => own.ownDesk(id), names: ownNames, pool: { names: NAMES, colors: COLORS } },
      {
        update: (worker) => {
          ctx.emit(this, { t: 'worker.update', worker });
          ctx.workerChanged(this, worker);
        },
        remove: (workerId) => {
          ctx.emit(this, { t: 'worker.remove', workerId });
          ctx.workerChanged(this, workerId);
        },
        // Not droppable: unlike a PTY's, this screen is only sent again once its transcript moves.
        screen: (workerId, frame) => ctx.emit(this, { t: 'screen', workerId, ...frame, full: true }),
      },
    );
    this.workers.holds = {
      desk: (id) => this.cloud.deskTaken(id),
      names: () => this.cloud.names(),
    };
    this.workers.freshMain = () => ctx.freshMain();
    this.workers.visitsOn = () => ctx.subagents().visits;
    this.workers.pullList = () => this.board.pulls.items;
    this.workers.modelGate = (model) => ctx.modelGate?.(model);
    // Only while subagents can be hired through the Office MCP: the refusal points the worker there.
    this.workers.denyTask = () => {
      const s = ctx.subagents();
      return s.denyTask && s.on && s.officeMcp;
    };
    this.workers.beforeStop = (info) => this.team.beforeStop(info);
    this.workers.nextTurn = (info) => this.team.nextTurn(info.id);

    // The 🚀 Pipelines board: runs that end while someone watches say so (a failure always, a pass when the office started it).
    this.pipelines = floorPipelines(
      def.dir,
      forge,
      def.repo,
      {
        state: (state) => ctx.emit(this, { t: 'pipelines', state }),
        finished: (run, ours) => {
          if (run.state !== 'failure' && !(ours && run.state === 'success')) return;
          const icon = run.state === 'failure' ? '❌' : '✅';
          ctx.toast(this, `${icon} ${run.workflow} #${run.number} ${stateWord(run)} on ${run.branch}: ${run.title}`, run.state === 'failure' ? 'warn' : 'info');
        },
      },
      this.plain,
    );
    if (!this.plain) this.pipelines.start(() => this.ctx.connections(this) > 0);

    const workers = this.workers;

    this.team = new Team(
      {
        list: () => workers.list(),
        get: (id) => workers.get(id) ?? workers.remoteIdentity(id),
        deskOccupied: (id) => workers.deskOccupied(id),
        get officeDefault() {
          return workers.officeDefault;
        },
        hire: (deskId, by, prompt, worktree, c, lead, from, branch) => workers.spawn(deskId, by, prompt, worktree, 'agent', c.model, c.effort, [], lead, undefined, from, branch),
        prompt: (id, text) => workers.tell(id, text),
        resume: (id, text) => workers.resume(id, text),
        kill: (id) => workers.kill(id),
        dismiss: (id, pruneWorktree, keepBranch) => workers.dismissTeam(id, pruneWorktree, keepBranch),
        tail: (id, lines) => workers.tail(id, lines),
        setTask: (id, task) => workers.setTask(id, task),
        fetchStart: (lead, from) => workers.fetchStart(lead, from),
      },
      {
        dataDir,
        dir: def.dir,
        git: !this.plain && !!this.project.branch,
        settings: () => ctx.subagents(),
        ...(ctx.droidModels ? { models: ctx.droidModels.bind(ctx) } : {}),
        availability: (model) => ctx.modelAvailability?.(model),
        prompts: ctx.prompts,
        toast: (text, level, workerId) => ctx.toast(this, text, level, workerId),
      },
    );

    this.visits = new Visits(
      {
        list: () => workers.list(),
        get: (id) => workers.get(id) ?? workers.remoteIdentity(id),
        tail: (id, lines) => workers.tail(id, lines),
        prompt: (id, text) => workers.prompt(id, text),
        tell: (id, text) => workers.tell(id, text),
        resume: (id, text) => workers.resume(id, text),
        cancelTurn: (id) => workers.cancelTurn(id),
        turnScreen: (id) => workers.turnScreen(id),
      },
      {
        on: () => ctx.subagents().visits,
        emit: (msg) => ctx.emit(this, msg),
        prompts: ctx.prompts,
        toast: (text, level, workerId) => ctx.toast(this, text, level, workerId),
      },
    );
    this.visits.start();

    // What each worker changed, for the Changes window at its desk (see changes.ts).
    this.changes = new Changes(
      this.project.branch,
      (workerId, repo) => {
        const w = this.workers.get(workerId);
        // Nothing to diff, and git there could answer for a checkout the folder is inside.
        if (!w || this.plain) return undefined;
        // Against the branch its worktree was cut from (which may not be the one the checkout is on), else the checkout's.
        if (!repo)
          return {
            name: w.name,
            cwd: w.worktree ? path.join(def.dir, w.worktree.path) : def.dir,
            rel: w.worktree?.path ?? '',
            worktreeBase: w.worktree?.base,
            baseBranch: w.worktree?.from ?? this.workers.selectedBranch ?? this.project.branch ?? null,
            prBaseFallback: this.workers.selectedBranch ?? this.project.branch ?? null,
            hooked: w.kind === 'agent',
          };
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
          prBaseFallback: other?.workers.selectedBranch ?? other?.project.branch ?? null,
          openPull: (branch) => (other ? openPull(other, branch) : undefined),
          refreshGitHub: () => void other?.board.refresh(),
          hooked: w.kind === 'agent',
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
    this.whiteboard = new WhiteboardStore(def.dir, {
      readers: () => boardReaders(this.workers.list()),
      renderer: ctx.renderer?.floor(this.id, {
        onRendered: (card) => {
          const store = this.whiteboard;
          const info =
            store &&
            renderInfo(
              store.renderer,
              store.board.cards.find((c) => c.id === card),
              card,
            );
          if (info) ctx.emit(this, { t: 'whiteboard.rendered', floor: this.id, card, info });
        },
        resolveMarks: (card, key, marks) => this.whiteboard?.resolveMarks(card, key, marks),
      }),
      onPatch: (patch, { origin, caps }) => ctx.emit(this, { t: 'whiteboard', floor: this.id, update: { kind: 'patch', patch }, ...(origin ? { origin } : {}), ...(Object.keys(caps).length ? { caps } : {}) }),
    });
    this.shell = new OfficeShell(def.dir, dataDir, this.workers.terminals, {
      screen: (frame) => ctx.emit(this, { t: 'screen', workerId: OFFICE_SHELL_ID, ...frame }, true),
      data: (data, ids) => ctx.termData(OFFICE_SHELL_ID, data, ids),
    });
    // Started with the workers, so a shell the host kept is claimed before leftover sessions are ended.
    this.workers.officeShell = this.shell;
    this.ready = this.workers.start();
    // Pruning counts the workers' read points, so it waits for the workers to be back.
    const startBoard = () => this.whiteboard.start();
    void this.ready.then(startBoard, startBoard);

    void this.board.refresh();
    void this.jira.refresh();
    // A floor with an owner connection on it, or work under way, keeps its boards fresh; the others check in now and then.
    this.timer = setInterval(() => {
      const active = this.active();
      if (active || Date.now() - this.board.issues.fetchedAt > IDLE_REFRESH_MS) void this.board.refresh();
      if (active || Date.now() - this.jira.fetchedAt > IDLE_REFRESH_MS) void this.jira.refresh();
    }, REFRESH_MS);
  }

  /** A worker's tool call may have changed this floor's pull requests or started CI (see hook-refresh.ts). */
  afterTool(refresh: ToolRefresh) {
    if (this.plain) return;
    if (refresh.board) this.boardSoon();
    if (refresh.pipelines) this.pipelinesSoon();
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
      for (const landed of landedWorkers(this.workers.list(), this.board.pulls.items, pullsOf)) {
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

  /** Everyone at a desk here: the office's workers and its cloud workers. */
  everyone(): WorkerInfo[] {
    return [...this.workers.list(), ...this.cloud.list()];
  }

  /** Someone just walked in: boards that haven't been looked at in a while get fetched again. */
  arrived() {
    if (Date.now() - Math.max(this.board.issues.fetchedAt, this.board.pulls.fetchedAt) > REFRESH_MS) void this.board.refresh();
    if (Date.now() - this.jira.fetchedAt > REFRESH_MS) void this.jira.refresh();
    if (Date.now() - this.pipelines.state.fetchedAt > PIPELINES_STALE_MS) void this.pipelines.refresh();
  }

  private active(): boolean {
    return this.ctx.connections(this) > 0 || this.ctx.lent(this) || this.workers.list().some((w) => isBusy(w.status));
  }

  /** How this floor's new worktrees are set up, read from its checkout now (see worktree-setup.ts). */
  worktreeSetup(): WorktreeSetupState {
    return setupState(this.id, this.dir, path.join(this.dir, '.droid-office'), !!this.project.branch);
  }

  /** The floor's own worktree setup, set in ⚙️ Settings; null goes back to the repository's or the detected one. */
  setWorktreeSetup(setup: { setup: string; copy: string[] } | null, by: string): WorktreeSetupState {
    writeOverride(path.join(this.dir, '.droid-office'), setup && { ...setup, by, at: Date.now() });
    return this.worktreeSetup();
  }

  info(): FloorInfo {
    const ws = this.everyone();
    return {
      id: this.id,
      name: this.def.name,
      repo: this.def.repo,
      dir: this.dir,
      branch: this.project.branch,
      ...this.branchInfo,
      palette: this.def.palette,
      ...(this.plain ? { plain: true } : {}),
      addedBy: this.def.addedBy,
      addedAt: this.def.addedAt,
      workers: ws.length,
      busy: ws.filter((w) => w.status === 'working').length,
      waiting: ws.filter((w) => waitingStatus(w)).length,
    };
  }

  /** With `keep` (a restart), the workers' terminals keep running for the next office to pick up. */
  shutdown(keep = false) {
    clearInterval(this.timer);
    clearTimeout(this.landedTimer);
    this.boardSoon.cancel();
    this.pipelinesSoon.cancel();
    this.board.stop();
    this.pipelines.stop();
    this.team.stop();
    this.visits.stop();
    this.changes.stop();
    this.whiteboard.stop();
    this.workers.shutdown(keep);
  }
}
