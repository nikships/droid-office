import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, accessSync, chmodSync, mkdirSync, readdirSync, rmdirSync, rmSync, unlinkSync, constants } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import type { AgentChoice, AgentEffort, GhPull, OutsideProcess, TeamBadge, TeamEmblem, TerminalHit, WorkerInfo, WorkerKind, WorkerRepo, WorkerStatus, WorkerTask } from '../shared/protocol.js';
import { TEAM_EMBLEMS, leadBadge, memberBadge, settleTeams } from '../shared/team.js';
import { FAILS_TO_DESPAIR, outputFailed, toolAction } from '../shared/actions.js';
import { isAgentEffort } from '../shared/protocol.js';
import { OFFICE_SHELL_ID } from '../shared/office-shell.js';
import { withImages } from '../shared/drops.js';
import { CTRL_ENTER, wantsCsiEnter } from '../shared/csi-enter.js';
import { WORKSPACE_FILES, WORKTREES_DIR, Worktrees, describeWork, workspaceOf, type WorktreeCleanup, type WorktreeOwnership, type WorktreeRef, type WorktreeStart, type WorktreeState } from './worktrees.js';
import { checkoutDirty, choosePullBase, pushBranch } from './open-pull.js';
import { normalizeRepo } from '../shared/floors.js';
import { DESK_BY_ID, STATION_AGENT } from '../shared/layout.js';
import { stationBrief } from './stations.js';
import { officePrompt, type PromptSource } from './prompts.js';
import { forgeVars, PROMPTS, WORKER_VISITS, workerBranchPolicy } from '../shared/prompts.js';
import { isBusy } from '../shared/status.js';
import { forkRefusal, nearestForkSeat } from '../shared/worker-fork.js';
import { githubPulls } from './github.js';
import type { PullHost } from './forge.js';
import { forgeWords, type Forge } from '../shared/floors.js';
import { TaskNamer, fallbackTask } from './tasks.js';
import { PtyHost, SCROLLBACK, type Adopted, type Pty } from './ptys.js';
import { DroidSessionReader } from './droid-session.js';
import { isValidDroidModel, validateWorkerEffort, validateWorkerModel } from './agents.js';
import { ScrollbackStore, searchTerminal, terminalTail } from './history.js';
import { DropStore } from './drops.js';
import { screenSnapshot } from './screen.js';
import { snapshotScreen, type ScreenFrame } from './screen-frame.js';
import { SCREEN_SETTLE_MS, readDroidScreen, screenStatus, type DroidScreen } from './droid-screen.js';
import type { Capacity } from './machine.js';
import { setupStep, writePlan, writeSetupScript, type SetupStep } from './worktree-setup.js';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;
type Worktree = NonNullable<WorkerInfo['worktree']>;

/** Workers' names, and their colors; guests (see guests.ts) pick from the same. */
export const NAMES = [
  'Pixel',
  'Byte',
  'Nibble',
  'Sprocket',
  'Widget',
  'Gizmo',
  'Bolt',
  'Cosmo',
  'Dot',
  'Echo',
  'Fizz',
  'Glitch',
  'Hopper',
  'Jinx',
  'Kilo',
  'Lumen',
  'Mochi',
  'Noodle',
  'Orbit',
  'Pip',
  'Quark',
  'Rivet',
  'Sparky',
  'Tofu',
  'Uno',
  'Volt',
  'Waffle',
  'Zippy',
];
export const COLORS = ['#ff8a5b', '#5bc0eb', '#9bc53d', '#fde74c', '#c3423f', '#b388eb', '#f7aef8', '#72ddf7', '#ffb400', '#00a6a6'];

// Env vars from a parent terminal session (e.g. starting the office from inside another agent)
// that don't belong in a worker's terminal.
// ELECTRON_RUN_AS_NODE: the Mac app runs the office on Electron's Node; a worker that kept it would
// turn every Electron app it starts (VS Code's `code`, another app) into a bare Node process.
const SCRUB_ENV = new Set(['NO_COLOR', 'FORCE_COLOR', 'VSCODE_INJECTION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'ELECTRON_RUN_AS_NODE']);
const SCRUB_PREFIXES = ['NEBULA_', 'DROID_OFFICE_'];
const scrubbed = (k: string) => SCRUB_ENV.has(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p));

const SCREEN_INTERVAL_MS = 250;
/** How a refusal on a plain folder's floor starts (see Floor.plain). */
const PLAIN_FLOOR = 'This floor is a plain folder, not a git checkout';
/** What a worker with a live terminal can be doing. */
const RUNNING = new Set<unknown>(['starting', 'idle', 'working', 'done', 'needs_input'] satisfies WorkerStatus[]);
const KEYFRAME_MS = 8000;
/** How often a steady typist's "last typed" time is refreshed for everyone. */
const TYPED_REFRESH_MS = 15_000;
/** How many of a worker's latest prompts and tool calls the task namer sees. */
const TASK_PROMPTS = 5;
const TASK_TOOLS = 10;
/** While a worker works, refresh its task summary after this many tool calls, at most this often. */
const TASK_REFRESH_TOOLS = 8;
const TASK_REFRESH_MS = 90_000;
const PR_TITLE_MAX = 72;
const PR_TASK_MAX = 2500;
/** The most other repositories one worker can take on (see WorkerInfo.repos). */
export const MAX_REPOS = 8;
/** Around the list of a change's pull requests in each of their descriptions, so it can be brought up to date. */
const RELATED_START = '<!-- agent-office:related -->';
const RELATED_END = '<!-- /agent-office:related -->';
/**
 * A hook finding the office restarting (its workers keep running through that) retries, once a
 * second, this many times in all: long enough for a dev-server reload.
 */
const HOOK_TRIES = 6;
/** How often every worker's folder is checked for having been deleted. */
const WATCH_MS = 10_000;
/** How often each agent's screen is checked against its status (see reconcile). */
const SCREEN_CHECK_MS = 1000;
/**
 * How long after its Stop a worker whose screen can't confirm it (an unreadable layout, a quoted
 * spinner) counts as done anyway: no hook and nothing printed since, while a real turn prints every second.
 */
const STOP_FALLBACK_MS = 10_000;
/**
 * How long a launch prompt waits for SessionStart before the input box on its screen is enough to
 * type it in: well past a normal start, so it only matters when the hooks can't reach the office.
 */
const LAUNCH_PROMPT_FALLBACK_MS = 15_000;
/** How long a new terminal waits for SessionStart (after its worktree setup, if any) before it looks stuck on a login. */
const BOOT_BLOCKED_MS = 12_000;
/** The most of a failed worktree setup's output its worker is told. */
const SETUP_OUTPUT_MAX = 3000;
/** Tools that ask the person a question: droid's is AskUser. */
const ASK_TOOLS = new Set<unknown>(['AskUser', 'AskUserQuestion', 'request_user_input']);
/** How often a terminal with new output is saved to disk, so even a crash loses at most this much. */
const SAVE_SCROLLBACK_MS = 15_000;
/** Between a worker's saved scrollback and what it prints after the office restarted. */
const RESTORED_NOTE = '\x1b[2m──── the office restarted · earlier output above ────\x1b[0m\r\n';
/**
 * What a worker whose terminal didn't make it through a restart (the machine rebooted, the terminal
 * host was replaced or died) is resumed with when it was in the middle of something, so it carries on
 * by itself instead of waiting at every desk for someone to type "continue".
 */
export const CARRY_ON_PROMPT = 'continue — the office restarted and interrupted you. Pick up where you left off; if you were waiting on an answer or a permission, ask again.';

export interface HookEnv {
  url: string;
  token: string;
}

/** Another floor's repository for a worker to work in too (see WorkerInfo.repos). */
export interface RepoSource {
  floor: string;
  /** The floor's name, for messages. */
  name: string;
  /** owner/name on the forge, when known. */
  repo?: string;
  /** Its checkout. */
  dir: string;
}

/** A pull request 'worker.pr' opened, or found already open, for a worker's branch. */
export interface OpenedPr {
  /** For a worker across repositories: which of its repositories (the folder in its workspace). */
  repo?: string;
  number: number;
  url: string;
  /** The branch already had it. */
  existed: boolean;
  /** The worktree still has uncommitted changes, which aren't in it. */
  dirty: boolean;
}

interface Worker {
  info: WorkerInfo;
  pty?: Pty;
  term?: HeadlessTerminal;
  ser?: InstanceType<typeof serialize.SerializeAddon>;
  /** The screen so far, for a browser opening the terminal (see screen.ts). */
  snapshot?: () => string;
  screenDirty: boolean;
  lastLines: string[];
  leftNeedsInputAt: number;
  keyframeAt: number;
  hookToken: string;
  /** Droid never reported SessionStart: it's stuck on a login or hooks screen. */
  bootBlocked?: boolean;
  /** The first message for this run of its droid, typed in once droid can take it (see launch), and when the run started. */
  launchPrompt?: { text: string; at: number };
  /**
   * Sessions of the subagents its droid started with the Task tool. Their hooks come with this
   * worker's token but their own session id, and their SessionStart and Stop are theirs, not its.
   */
  subSessions: Set<string>;
  /** The latest tool each session started (PreToolUse), to know which one a permission prompt is about. */
  lastTool: Map<string, string>;
  /** Who raised its needs_input from a hook: the session asking, and the tool it asks about. */
  asking?: { session: string; tool?: string };
  /** When its last hook came in, and its terminal last printed something (see reconcile). */
  hookAt: number;
  outputAt: number;
  /** When its own session's Stop came, with no hook since: a finish its screen hasn't confirmed yet. */
  stopAt?: number;
  /** What its screen has shown since when (see droid-screen.ts). */
  screenSeen?: { state: DroidScreen; since: number };
  /** Test runs and builds that have failed in a row (see FAILS_TO_DESPAIR). */
  failStreak: number;
  /** Its latest prompts and tool calls, for naming its task. */
  prompts: string[];
  tools: string[];
  toolsSinceNamed: number;
  namedAt: number;
  /** Bumped by /clear: a new conversation, so a new task. */
  taskEpoch: number;
  /** Its terminal in the host as of the last save, and how it was doing, to pick back up after a restart. */
  saved?: { ptyId: string; status: WorkerStatus; acked: boolean; waitingSince?: number; launchPrompt?: { text: string; at: number } };
  /** Its process went away mid-turn with the office or the terminal host: its next start carries on (CARRY_ON_PROMPT). */
  interrupted?: boolean;
  /** Output since its scrollback was last saved to disk. */
  unsaved?: boolean;
  /** Where this run's own output starts, below the scrollback carried over from before. */
  fresh?: { readonly line: number };
  /** Its lost worktree is being put back (see rebuild): the folder coming back mustn't wake it before that's done. */
  rebuilding?: boolean;
  /** Branches present at hire time, per repository; never included in gun dismissal. */
  worktreeOwnership?: Record<string, WorktreeOwnership>;
  /** The plan its first terminal runs before the agent, to make its new worktree ready (see worktree-setup.ts). */
  setupPlan?: string;
  /** Its terminal is running that plan; when it finished, so the agent gets its own time to start after it. */
  settingUp?: boolean;
  setupDoneAt?: number;
  /** Until SessionStart gives the twin its own id, restarts must fork, never resume the source. */
  pendingFork?: { sessionId: string; prompt?: string };
}

export interface WorkerEvents {
  update(info: WorkerInfo): void;
  remove(workerId: string, shot?: boolean): void;
  data(workerId: string, data: string, connectionIds: string[]): void;
  screen(workerId: string, frame: ScreenFrame): void;
  /** `workerId` names the worker it is about, when one is (a shot worker's dismissal). */
  toast(text: string, level: 'info' | 'warn' | 'error', workerId?: string): void;
  /** The office moved the project's checkout onto `branch` (see Worktrees.freshen). */
  checkout?(branch: string): void;
}

export class WorkerManager {
  private workers = new Map<string, Worker>();
  /** Which connections have each worker's terminal open (workerId -> connection IDs). */
  private subscribers = new Map<string, Set<string>>();
  private statePath: string;
  /** Workers saved at a seat that no longer exists: never run, kept in the file untouched. */
  private retired: unknown[] = [];
  private droidSettingsPath: string;
  /** The Droid hook commands, reused for per-worker model overlays (see droidSettings). */
  private droidHooks: Record<string, unknown[]> = {};
  private trees: Worktrees;
  /** The checkout's branch when the office opened this floor (see the constructor). */
  private configuredBase?: string;
  private droidSessions = new DroidSessionReader();
  private agentPath: string | null = null;

  /** Desks and names taken by the floor's guests (see guests.ts), which the office's hires leave alone. */
  holds?: { desk(deskId: string): boolean; names(): Iterable<string>; inCheckout?(): string[] };
  /**
   * ⚙️ Settings → Workers: a fresh worker starts from the latest of the default branch, its worktree
   * cut from origin's and the checkout brought there for one without (see freshen). Off, or unset:
   * from the branch the checkout is on, which is left alone.
   */
  freshMain?: () => boolean;
  /** ⚙️ Settings → Subagents & visits → Visits: a worker with no lead is told about office-visit when it starts. */
  visitsOn?: () => boolean;
  /** The floor's pull requests as the board last listed them, to tell a checkout whose branch merged (see settleCheckout). */
  pullList?: () => GhPull[];
  /** Subscriptions: why an agent on this model can't start now (out of quota, say); undefined when it can (docs/subscriptions.md). */
  modelGate?: (model: string | undefined) => string | undefined;
  private settling = false;

  private get forge(): Forge {
    return this.pulls.forge ?? 'github';
  }
  /** Where the office-workers command is, for every agent's PATH: how a lead runs its subagents (see team.ts). */
  private teamBin: string | undefined;
  /** The script a new worktree's terminal runs before its agent (see worktree-setup.ts). */
  private setupScript: string | undefined;
  private screenTimer: NodeJS.Timeout;
  /** The office is shutting down: workers exiting now are being stopped, not failing to resume. */
  private closing = false;
  /** Closing for good (Ctrl+C), not restarting: whatever the workers were doing is stopped on purpose. */
  private stopping = false;
  private namer: TaskNamer;
  private watchTimer: NodeJS.Timeout;
  private statusTimer: NodeJS.Timeout;
  /** Runs the workers' terminals outside the office, so they outlive a restart of it (see ptys.ts). */
  private host: PtyHost;
  /**
   * The boss monitor's shell, set by the floor before start(). It claims its terminal in this host
   * before unclaimed sessions are ended. A WorkerManager built on its own (tests) leaves it unset.
   */
  officeShell?: { start(): Promise<void>; shutdown(keep: boolean): void };

  /** The terminal host this floor's workers and the boss shell share. */
  get terminals(): PtyHost {
    return this.host;
  }
  /** Each worker's terminal on disk, so a restart doesn't wipe it (see history.ts). */
  private scrollback: ScrollbackStore;
  private drops: DropStore;
  private saveTimer: NodeJS.Timeout;

  constructor(
    private dir: string,
    private dataDir: string,
    private agentCmd: string,
    private agentArgs: string[],
    private hook: HookEnv,
    private events: WorkerEvents,
    /** The office's worker limit, across every floor (see machine.ts). */
    private capacity?: Capacity,
    /** Where workers' pull requests are opened: GitHub, or the floor's GitLab project. */
    private pulls: PullHost & { forge?: Forge } = githubPulls,
    /** The office's prompts and the worker a new one starts on when nobody picks, as set in Settings (see prompts.ts). */
    private prompts?: PromptSource,
    /** The floor is a plain folder, not a git checkout of its own (see Floor.plain). */
    private plain = false,
  ) {
    this.trees = new Worktrees(dir, plain);
    if (!plain) this.trees.ensureBranchFile();
    // The branch the checkout was on when this floor opened: a pull request's configured base. The
    // live branch is tried after it (see open-pull.ts). Freshening the checkout does not move this.
    this.configuredBase = this.trees.currentBranch();
    this.statePath = path.join(dataDir, 'workers.json');
    this.droidSettingsPath = path.join(dataDir, 'droid-hooks.json');
    this.writeHookSettings();
    // The task queue's command, from before the queue was taken out.
    rmSync(path.join(dataDir, 'bin', 'office-queue'), { force: true });
    rmSync(path.join(dataDir, 'bin', 'office-queue.cmd'), { force: true });
    this.teamBin = this.writeOfficeCommand(path.join('bin', 'team'), 'office-workers', "Droid Office's subagents, for every agent");
    // In the same folder, so it's on every agent's PATH with office-workers.
    this.writeOfficeCommand(path.join('bin', 'team'), 'office-whiteboard', "The floor's Whiteboard, for every agent");
    this.writeOfficeCommand(path.join('bin', 'team'), 'office-visit', 'Visits between independent workers on a floor');
    try {
      this.setupScript = writeSetupScript(dataDir);
    } catch {
      // without it, new worktrees just aren't set up
    }
    this.agentPath = resolveAgent(agentCmd);
    this.namer = new TaskNamer(
      this.agentPath,
      childEnv(),
      () => officePrompt(this.prompts, 'office.namer'),
      (id, task, ctx) => {
        const w = this.workers.get(id);
        if (!w || w.taskEpoch !== ctx.epoch) return;
        w.info.task = task;
        this.emitUpdate(w);
        this.persist();
      },
    );
    this.host = new PtyHost(dataDir, () => this.events.toast("The workers' terminal host stopped — resuming them", 'warn'));
    this.scrollback = new ScrollbackStore(dataDir);
    this.drops = new DropStore(dataDir);
    this.restore();
    this.scrollback.prune(new Set(this.workers.keys()));
    // The boss shell's drops live in the same folder and are not a worker's.
    this.drops.prune(new Set([...this.workers.keys(), OFFICE_SHELL_ID]));
    for (const w of this.workers.values()) this.refreshDroidModel(w);
    this.screenTimer = setInterval(() => this.flushScreens(), SCREEN_INTERVAL_MS);
    this.watchTimer = setInterval(() => {
      for (const w of this.workers.values()) this.watchFolder(w);
    }, WATCH_MS);
    this.statusTimer = setInterval(() => this.reconcile(), SCREEN_CHECK_MS);
    this.saveTimer = setInterval(() => {
      for (const w of this.workers.values()) if (w.unsaved) this.saveScrollback(w);
    }, SAVE_SCROLLBACK_MS);
  }

  /**
   * Picks every worker whose terminal outlived the last office (a dev-server reload, an upgrade)
   * back up where it is, mid-turn or not. Whoever else was at a desk when the office stopped (a
   * restart, a crash) gets straight back to work, carrying on with whatever it was in the middle of.
   * Call once, before anyone can walk in.
   */
  async start() {
    await this.host.connect();
    await Promise.all(
      [...this.workers.values()].map(async (w) => {
        const saved = w.saved;
        w.saved = undefined;
        const adopted = saved && (await this.host.attach(saved.ptyId));
        if (adopted) {
          if (this.workers.get(w.info.id) !== w || this.closing) adopted.pty.kill();
          else this.adopt(w, adopted, saved);
        }
      }),
    );
    // Before unclaimed sessions are ended, so a shell the host kept is not taken for a leftover.
    if (this.officeShell) await this.officeShell.start();
    // Terminals nobody saved a claim on (their worker was sent home as the office went down).
    this.host.killUnclaimed();
    // Whoever's worktree was deleted while the office was down stays asleep, marked lost, rather than failing to start.
    for (const w of this.workers.values()) this.checkLost(w);
    this.wakeAll();
    // It may have switched branches while the office was down, its terminal still going.
    void this.syncBranches();
  }

  /**
   * Fetches the branch a fresh worker starts from (the default branch, or the one the project is on;
   * see freshMain), so it starts from what's on the forge now (see Worktrees.fetch). With `checkout`,
   * for one hired into the project's checkout, which is only moved when freshMain is on. Undefined
   * when there's nothing to wait for.
   */
  fetchBase(checkout = false): Promise<void> | undefined {
    const fresh = this.freshBase();
    if (checkout && !fresh) return undefined;
    return this.trees.fetch(fresh ? 'main' : 'checkout');
  }

  private freshBase(): boolean {
    return !!this.trees.selectedBranch() || (this.freshMain?.() ?? false);
  }

  branchState() {
    return { branches: this.trees.branches(), defaultBranch: this.trees.defaultBranch(), selectedBranch: this.trees.selectedBranch() };
  }

  get baseBranch(): string | undefined {
    return this.trees.baseBranch();
  }

  get selectedBranch(): string | undefined {
    return this.trees.selectedBranch();
  }

  /** An explicit floor switch has the same no-data-loss and checkout-occupancy guards as a hire. */
  async selectBranch(branch: string | null): Promise<string | undefined> {
    if (this.selectingBranch) return 'A floor branch switch is already in progress';
    if (branch !== null && (!this.trees.validBranch(branch) || !this.trees.branches().includes(branch))) return 'Choose an existing local or origin branch';
    const target = branch ?? this.trees.defaultBranch();
    if (!target) return 'This floor has no default branch';
    this.selectingBranch = true;
    try {
      await this.trees.fetchRef(`origin/${target}`);
      const r = this.freshenWith(false, target);
      if (r.kept && r.branch !== target) return `Couldn't switch the floor to ${target}: ${r.kept}`;
      this.trees.saveBranch(branch);
      this.events.checkout?.(r.branch ?? target);
      this.events.toast(`🌿 Floor branch set to ${target}${branch === null ? ' (repository default)' : ''}${r.kept ? `: ${r.kept}` : ''}`, 'info');
      return undefined;
    } catch (err) {
      return `Couldn't switch the floor branch: ${(err as Error).message}`;
    } finally {
      this.selectingBranch = false;
    }
  }

  private selectingBranch = false;

  /**
   * Fetches what a subagent of `lead` starts from, independently of freshMain: the origin branch the
   * lead picked, or the one its own HEAD is on, so a lead sitting on an old main doesn't hand it that.
   */
  fetchStart(lead: string, from?: string): Promise<void> | undefined {
    const boss = this.workers.get(lead)?.info;
    if (!boss) return undefined;
    const cwd = boss.worktree ? path.join(this.dir, boss.worktree.path) : this.dir;
    const where = existsSync(cwd) ? cwd : this.dir;
    if (from !== undefined) return this.trees.fetchRef(from, where);
    const branch = this.trees.resolve('HEAD', where)?.branch;
    return branch ? this.trees.refresh(branch) : undefined;
  }

  get resolvedAgent(): string | null {
    return this.agentPath;
  }

  /** Droid was installed after the floor opened (Setup): new workers and the task namer run it from `file`. */
  setAgentPath(file: string) {
    this.agentPath = file;
    this.namer.setDroid(file);
  }

  /** What an agent starts on when whoever starts it doesn't pick, when one was set in Settings (else Droid's own default). */
  get officeDefault(): AgentChoice | undefined {
    return this.prompts?.agent();
  }

  list(): WorkerInfo[] {
    return [...this.workers.values()].map((w) => w.info);
  }

  get(id: string): WorkerInfo | undefined {
    return this.workers.get(id)?.info;
  }

  /** Read-only conversation identity. Never accepts a caller-supplied path or session. */
  threadSession(id: string): { sessionId: string; cwd: string } | undefined {
    const info = this.workers.get(id)?.info;
    if (info?.kind !== 'agent' || info.cloud || info.guest || !info.sessionId) return undefined;
    return { sessionId: info.sessionId, cwd: this.cwd(info) };
  }

  /** The workers' terminal process IDs, so the guest scan leaves them out. */
  owners(): number[] {
    return [...this.workers.values()].flatMap((w) => (w.pty?.pid ? [w.pty.pid] : []));
  }

  deskOccupied(deskId: string): boolean {
    for (const w of this.workers.values()) if (w.info.deskId === deskId) return true;
    return !!this.holds?.desk(deskId);
  }

  /** Whether one of the office's own workers sits there, guests aside. */
  ownDesk(deskId: string): boolean {
    for (const w of this.workers.values()) if (w.info.deskId === deskId) return true;
    return false;
  }

  /** Each worker in a folder of its own (its worktree or workspace), with that folder: whose a process started by hand there is. */
  folders(): { id: string; folder?: string }[] {
    return [...this.workers.values()].map((w) => ({ id: w.info.id, folder: w.info.worktree ? this.cwd(w.info) : undefined }));
  }

  /** The Droid sessions the office's own workers here are in, which are never a guest's. */
  sessionIds(): Set<string> {
    return new Set([...this.workers.values()].flatMap((w) => (w.info.sessionId ? [w.info.sessionId] : [])));
  }

  /** The agent processes someone started by hand in each worker's own folder (see guests.ts attribute). */
  setOutside(outside: ReadonlyMap<string, OutsideProcess[]>) {
    for (const w of this.workers.values()) {
      const now = outside.get(w.info.id);
      if (JSON.stringify(now) === JSON.stringify(w.info.outside)) continue;
      if (now?.length) w.info.outside = now;
      else delete w.info.outside;
      this.emitUpdate(w);
    }
  }

  /**
   * Hires a worker at a desk. `repos` are other floors' repositories a worker in its own worktree
   * works in too (see makeWorkspace).
   * `lead` hires a subagent for that worker (see team.ts): it's told who hired it and how to report back.
   * A subagent's worktree starts where its lead is, or from `from` (a branch, tag or commit) when the
   * lead names one; nobody else's freshMain applies to it, and its checkout is never moved for it.
   */
  spawn(
    deskId: string,
    by: string,
    prompt?: string,
    worktree = false,
    kind: Exclude<WorkerKind, 'cloud'> = 'agent',
    model?: string,
    effort?: AgentEffort,
    repos: RepoSource[] = [],
    lead?: string,
    /** Pictures staged for its first prompt (see stageImage), listed after it. */
    images?: readonly string[],
    from?: string,
  ): WorkerInfo | string {
    if (this.selectingBranch) return 'Wait for the floor branch switch to finish before hiring';
    // Nobody picked (a board agent, say): the office's default worker, model and effort included.
    const picked = kind === 'agent' && model === undefined ? this.officeDefault : undefined;
    if (picked) ({ model, effort } = picked);
    const modelError = validateWorkerModel(kind, model);
    if (modelError) return modelError;
    const effortError = validateWorkerEffort(kind, effort);
    if (effortError) return effortError;
    const gated = kind === 'agent' ? this.modelGate?.(model) : undefined;
    if (gated) return gated;
    const seat = DESK_BY_ID.get(deskId);
    if (!seat) return 'Unknown desk';
    if (this.deskOccupied(deskId)) return seat.station ? `The ${STATION_AGENT[seat.station].name} is already there` : `That ${seat.beanbag ? 'bean bag' : 'desk'} is taken`;
    if (kind === 'shell' && seat.station) return 'A board agent is always an agent, not a shell';
    if (this.plain && seat.station && seat.station !== 'lead') return `${PLAIN_FLOOR}, so it has no ${STATION_AGENT[seat.station].name}`;
    if (this.plain && worktree) return `${PLAIN_FLOOR}, so workers can't have worktrees`;
    if (repos.length && (kind !== 'agent' || !worktree || seat.station)) return 'Only a worker in its own worktree can work in other repositories too';
    if (repos.length > MAX_REPOS) return `A worker can take on at most ${MAX_REPOS} other repositories`;
    const fresh = !this.plain && this.freshBase();
    let start: WorktreeStart = fresh ? 'main' : 'checkout';
    if (from !== undefined && (lead === undefined || !worktree)) return 'Only a subagent in its own worktree starts from a branch its lead picks';
    if (lead !== undefined) {
      const boss = this.workers.get(lead)?.info;
      if (!boss) return 'Its lead has left';
      if (boss.lead) return "A subagent can't hire subagents of its own";
      if (kind !== 'agent' || seat.station) return 'A subagent is an agent at a desk or a bean bag';
      if (worktree) {
        const at = this.leadStart(boss, from);
        if (typeof at === 'string') return at;
        start = at;
      }
    }
    const full = this.capacity?.full();
    if (full) return full;
    const used = new Set([...this.workers.values()].map((w) => w.info.name.replace(/ 🐚$/, '')).concat([...(this.holds?.names() ?? [])]));
    const agent = seat.station && STATION_AGENT[seat.station];
    const name = agent ? agent.name : (NAMES.find((n) => !used.has(n)) ?? `Worker ${this.workers.size + 1}`);
    const id = randomBytes(6).toString('hex');
    let wt: WorkerInfo['worktree'];
    let others: WorkerRepo[] | undefined;
    if (!worktree && fresh && kind === 'agent' && !seat.station && lead === undefined) this.freshenCheckout(name);
    if (worktree) {
      const slug = `${name.toLowerCase()}-${id.slice(0, 4)}`;
      const made = repos.length ? this.makeWorkspace(slug, repos, start) : this.trees.create(slug, undefined, this.dir, start);
      if (typeof made === 'string') return made;
      if ('repos' in made) {
        ({ worktree: wt, repos: others } = made);
        for (const note of made.notes) this.events.toast(`🌿 ${name}'s worktree of ${note}`, 'info');
      } else {
        const { note, ...ref } = made;
        wt = ref;
        if (note) this.events.toast(`🌿 ${name}'s worktree ${note}`, 'info');
      }
    }
    const team = lead !== undefined ? this.formTeam(lead) : undefined;
    const text = kind === 'agent' && images?.length ? withImages(prompt ?? '', this.drops.adopt(id, images)) : prompt?.trim();
    // What the card shows when the prompt was pictures alone.
    const shown = prompt?.trim() || (text ? 'See the attached images' : undefined);
    const info: WorkerInfo = {
      id,
      kind,
      model,
      effort,
      deskId,
      name: kind === 'shell' ? `${name} 🐚` : name,
      color: kind === 'shell' ? '#8d99ae' : agent ? agent.color : COLORS[Math.floor(Math.random() * COLORS.length)],
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt: kind === 'shell' ? undefined : shown,
      worktree: wt,
      repos: others,
      cols: 100,
      rows: 30,
      open: false,
      activity: shown && kind !== 'shell' ? truncate(shown, 80) : prompt ? truncate(prompt, 80) : undefined,
      ...(lead !== undefined ? { lead } : {}),
      ...(team ? { team: memberBadge(team) } : {}),
    };
    const w = newWorker(info);
    if (info.worktree) w.worktreeOwnership = Object.fromEntries(this.treesOf(info).map((t) => [t.dir, t.trees.ownership(t.ref.branch)]));
    if (wt) w.setupPlan = this.planSetup(id, wt, others);
    this.workers.set(id, w);
    if (info.prompt) this.notePrompt(w, info.prompt);
    this.launch(w, this.briefed(w, kind === 'shell' ? undefined : text || undefined), undefined);
    this.persist();
    return info;
  }

  /** A peer with a private snapshot of the source's repositories and conversation, between turns only. */
  async fork(id: string, by: string, prompt?: string): Promise<WorkerInfo | string> {
    if (this.closing || this.selectingBranch) return 'Wait for the office to finish restarting or switching branches';
    if (this.plain) return `${PLAIN_FLOOR}, so there's no worktree to fork a worker into`;
    const source = this.workers.get(id);
    if (!source) return 'No such worker';
    const why = forkRefusal(source.info);
    if (why) return why;
    const screen = source.term && readDroidScreen(screenRows(source.term));
    if (screen === 'busy' || screen === 'asking') return 'Wait until its turn ends before forking';
    if (source.launchPrompt || source.settingUp) return 'Wait for its first prompt and worktree setup to finish';
    const full = this.capacity?.full();
    if (full) return full;
    const sourceDesk = DESK_BY_ID.get(source.info.deskId);
    if (!sourceDesk) return 'The source desk is no longer on this floor';
    const seat = nearestForkSeat(sourceDesk, (desk) => this.deskOccupied(desk));
    if (!seat) return 'Every desk and bean bag on this floor is taken';
    const used = new Set([...this.workers.values()].map((w) => w.info.name).concat([...(this.holds?.names() ?? [])]));
    const stem = `${source.info.name} ⑂`;
    let name = stem;
    for (let n = 2; used.has(name); n++) name = `${stem} ${n}`;
    const twinId = randomBytes(6).toString('hex');
    const slug = `fork-${twinId}`;
    const many = !!source.info.repos?.length;
    const originals = source.info.worktree ? this.treesOf(source.info) : [{ name: path.basename(this.dir), dir: this.dir, trees: this.trees, ref: undefined }];
    const made: { trees: Worktrees; ref: WorktreeRef }[] = [];
    let primary: WorkerInfo['worktree'];
    const others: WorkerRepo[] = [];
    try {
      for (const [i, original] of originals.entries()) {
        const cwd = original.ref?.path ? path.resolve(original.dir, original.ref.path) : original.dir;
        const wt = original.trees.fork(slug, cwd, many ? original.name : undefined, this.dir);
        if (typeof wt === 'string') throw new Error(wt);
        made.push({ trees: original.trees, ref: { ...wt, path: path.relative(original.dir, path.join(this.dir, wt.path)) } });
        if (i === 0) primary = { ...wt, from: source.info.worktree?.from ?? wt.from };
        else others.push({ ...source.info.repos![i - 1], ...wt, from: source.info.repos![i - 1].from ?? wt.from, pr: undefined });
      }
      if (many)
        this.writeBrief(
          primary!,
          others.map((r) => ({ name: r.name, project: r.repo ?? r.name, from: r.from })),
        );
    } catch (err) {
      const errors: string[] = [];
      for (const m of made.reverse()) {
        const result = await m.trees.sendHome(m.ref, 'all');
        if (result.error) errors.push(result.error);
      }
      if (many) clearWorkspace(path.join(this.dir, WORKTREES_DIR, slug));
      return `${(err as Error).message}${errors.length ? `; incomplete fork cleanup failed: ${errors.join('; ')}` : ''}`;
    }
    const text = prompt?.trim() || undefined;
    const info: WorkerInfo = {
      id: twinId,
      kind: 'agent',
      model: source.info.activeModel ?? source.info.model,
      effort: source.info.activeModel ? source.info.activeEffort : source.info.effort,
      deskId: seat.id,
      name,
      color: source.info.color,
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt: text ?? source.info.prompt,
      task: source.info.task ? { ...source.info.task } : undefined,
      worktree: primary,
      repos: many ? others : undefined,
      forkedFrom: { workerId: id, name: source.info.name, sessionId: source.info.sessionId! },
      cols: source.info.cols,
      rows: source.info.rows,
      open: false,
    };
    const w = newWorker(info);
    w.pendingFork = { sessionId: source.info.sessionId!, prompt: text };
    w.worktreeOwnership = Object.fromEntries(this.treesOf(info).map((t) => [t.dir, t.trees.ownership(t.ref.branch)]));
    w.setupPlan = this.planSetup(twinId, primary!, info.repos, source.info);
    this.workers.set(twinId, w);
    // Persist the fork intent before starting a process, so a restart cannot attach to the parent's session.
    this.persist();
    this.launch(w, text, undefined);
    return info;
  }

  /** The team `leadId` leads, which it starts wearing the markings of with its first hire. */
  private formTeam(leadId: string): TeamBadge | undefined {
    const lead = this.workers.get(leadId);
    if (!lead) return undefined;
    const badge = leadBadge(
      lead.info,
      [...this.workers.values()].map((w) => w.info),
    );
    if (lead.info.team !== badge) {
      lead.info.team = badge;
      this.emitUpdate(lead);
    }
    return badge;
  }

  /**
   * Where a subagent's worktree starts: `from` when its lead names it, else where the lead is (its
   * own worktree's HEAD, or the checkout's for a lead in the checkout), so what the lead has
   * committed is there. Says why not when `from` is nothing git knows.
   */
  private leadStart(lead: WorkerInfo, from: string | undefined): WorktreeStart | string {
    const cwd = lead.worktree ? path.join(this.dir, lead.worktree.path) : this.dir;
    const at = this.trees.resolve(from ?? 'HEAD', existsSync(cwd) ? cwd : this.dir);
    if (at) return from === undefined ? this.trees.caughtUp(at) : at;
    return from === undefined ? `${lead.name}'s checkout has no commit to start from` : `There's no branch, tag or commit called ${from} here`;
  }

  /**
   * A fresh worker without a worktree starts in the project's checkout: it's brought to the latest
   * of the default branch first, unless someone else is working there or it holds work that a branch
   * switch would get in the way of (see Worktrees.freshen). Toasts what happened when it's news.
   */
  private freshenCheckout(name: string) {
    const r = this.freshenWith(this.trees.delivered(this.pullList?.() ?? []));
    if (r.switchedFrom) {
      this.events.checkout?.(r.branch ?? r.main ?? '');
      this.events.toast(`🌿 Switched the checkout from ${r.switchedFrom} to ${r.main} for ${name}`, 'info');
    }
    if (r.kept) this.events.toast(`🌿 ${name} starts on ${r.branch ?? 'the checkout'} as it is, not the latest ${r.main}: ${r.kept}`, 'info');
  }

  /**
   * Worktrees.freshen with who's in the checkout sorted out: guests and workers mid-turn block it;
   * workers at rest only block leaving a branch they may come back to, which they don't once its
   * work has landed (`delivered`).
   */
  private freshenWith(delivered: boolean, target?: string) {
    const there = [...this.workers.values()].filter((w) => w.pty && !w.info.worktree && !boardAgent(w.info));
    const active = there.filter((w) => isBusy(w.info.status)).map((w) => w.info.name);
    const resting = delivered ? [] : there.filter((w) => !isBusy(w.info.status)).map((w) => w.info.name);
    return this.trees.freshen([...active, ...(this.holds?.inCheckout?.() ?? [])], resting, target);
  }

  /**
   * Puts the project's checkout back on the latest default branch once the branch it's on has merged,
   * so the next worker hired starts from there even when whoever merged it never switched back (or a
   * person merged it on the forge). Called when the pull request list comes in. Quiet when it has to
   * leave the checkout alone (it looks again with the next list), and does nothing with *Latest main*
   * off. Never touches a branch whose work hasn't landed, uncommitted changes, or a worker mid-turn.
   */
  async settleCheckout(): Promise<void> {
    if (this.settling || this.selectingBranch || !this.freshBase()) return;
    const landed = () => this.trees.delivered(this.pullList?.() ?? []);
    if (!landed()) return;
    this.settling = true;
    try {
      await this.trees.fetch('main');
      if (this.selectingBranch) return;
      if (!landed()) return;
      const r = this.freshenWith(true);
      if (!r.switchedFrom) return;
      this.events.checkout?.(r.branch ?? r.main ?? '');
      this.events.toast(`🌿 Switched the checkout from ${r.switchedFrom} to ${r.main}: its pull request merged`, 'info');
    } finally {
      this.settling = false;
    }
  }

  /**
   * The plan that makes a new worker's worktrees ready (each repository's own, across repositories),
   * written for its terminal to run; nothing when no step has anything to do.
   */
  private planSetup(id: string, wt: Worktree, others: WorkerRepo[] | undefined, source?: WorkerInfo): string | undefined {
    if (!this.setupScript) return undefined;
    try {
      const many = !!others?.length;
      const steps = [
        setupStep(source?.worktree ? path.join(this.dir, source.worktree.path) : this.dir, path.join(this.dir, wt.path), this.dataDir, many ? path.basename(wt.path) : undefined),
        ...(others ?? []).map((r, i) => setupStep(source?.repos?.[i] ? path.join(this.dir, source.repos[i].path) : r.dir, path.join(this.dir, r.path), path.join(r.dir, '.droid-office'), r.name)),
      ].filter((s): s is SetupStep => !!s);
      return steps.length ? writePlan(this.dataDir, id, steps) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Why nobody can be hired anywhere in the office right now (its worker limit), if so. */
  full(): string | undefined {
    return this.capacity?.full();
  }

  /**
   * One of the office's own workers in place of a guest whose droid just quit (see Floor.bringIn): at
   * its desk, with its name and color, in the floor's checkout, resuming its session `sessionId`.
   * Its model and effort stay the session's own.
   */
  takeIn(guest: WorkerInfo, sessionId: string, by: string): WorkerInfo | string {
    const seat = DESK_BY_ID.get(guest.deskId);
    if (!seat || seat.station) return 'A guest is brought in at a desk or a bean bag';
    if (this.deskOccupied(guest.deskId)) return `That ${seat.beanbag ? 'bean bag' : 'desk'} is taken`;
    const full = this.capacity?.full();
    if (full) return full;
    const used = new Set([...this.workers.values()].map((w) => w.info.name.replace(/ 🐚$/, '')).concat([...(this.holds?.names() ?? [])]));
    const name = !used.has(guest.name) ? guest.name : (NAMES.find((n) => !used.has(n)) ?? `Worker ${this.workers.size + 1}`);
    const id = randomBytes(6).toString('hex');
    const prompt = guest.prompt?.trim() || undefined;
    const info: WorkerInfo = {
      id,
      kind: 'agent',
      deskId: guest.deskId,
      name,
      color: guest.color,
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt,
      sessionId,
      activeModel: guest.activeModel,
      activeEffort: guest.activeEffort,
      cols: 100,
      rows: 30,
      open: false,
      activity: prompt ? truncate(prompt, 80) : undefined,
      task: guest.task?.name ? { name: guest.task.name, summary: prompt ? truncate(prompt, 140) : 'Brought in from outside the office' } : undefined,
    };
    const w = newWorker(info);
    if (prompt) w.prompts = [prompt.replace(/\s+/g, ' ')];
    this.workers.set(id, w);
    this.launch(w, undefined, sessionId);
    this.persist();
    return info;
  }

  /**
   * A first prompt with what the agent is told ahead of it, for a session starting from nothing: a
   * board agent what it's there for, a subagent who hired it and how to report back. What shows on
   * its card is the prompt alone.
   */
  private briefed(w: Worker, prompt: string | undefined): string | undefined {
    const station = DESK_BY_ID.get(w.info.deskId)?.station;
    if (station) return `${stationBrief(station, this.forge, this.prompts)}\n\n${prompt ?? 'Wait for the owner to give you a task in this terminal.'}`;
    if (!prompt) return prompt;
    const lead = w.info.lead ? this.workers.get(w.info.lead)?.info : undefined;
    if (!lead) return prompt;
    const wt = w.info.worktree;
    const where = wt
      ? `You work in your own git worktree, ${path.join(this.dir, wt.path)}, on the branch ${wt.branch} made for this task from ${wt.from ?? wt.base.slice(0, 7)}: commit your work there.`
      : this.plain
        ? "You work in the floor's folder, which isn't a git checkout and which other people and workers use too: don't undo or overwrite anyone else's files."
        : "You work in the project's main checkout, which other people and workers use too: don't switch branches, stash, reset or commit in it unless your task says to.";
    return `${officePrompt(this.prompts, 'subagent.brief', { name: w.info.name, lead: lead.name, where, ...forgeVars(this.forge) })}\n\n${prompt}`;
  }

  /** The end of a worker's terminal as plain text, its scrollback included: what a lead reads of its subagent. */
  tail(id: string, lines: number): string | undefined {
    const term = this.workers.get(id)?.term;
    if (!term) return undefined;
    const buf = term.buffer.active;
    const text = (y: number) => buf.getLine(y)?.translateToString(true) ?? '';
    // The rows under the cursor are blank until something is written there: they aren't the end.
    let end = buf.length;
    while (end > 0 && !text(end - 1).trim()) end--;
    const out: string[] = [];
    for (let y = Math.max(0, end - Math.max(1, lines)); y < end; y++) out.push(text(y));
    return out.join('\n');
  }

  /** The card over a worker's head, until its own sign writer has something better (a subagent's title from its lead). */
  setTask(id: string, task: WorkerTask) {
    const w = this.workers.get(id);
    if (!w) return;
    w.info.task = { name: task.name.trim().slice(0, 60), summary: task.summary.trim().slice(0, 140) };
    this.emitUpdate(w);
    this.persist();
  }

  /**
   * The workspace of a worker across repositories: `.droid-office/worktrees/<slug>`, with a worktree of
   * this floor's project and of each of `repos` in it, all on office/<slug>, and a brief for the agent
   * (the 'worker.repos' prompt, as AGENTS.md). All or nothing: when one repository
   * can't have its worktree, the ones already made are taken out again.
   */
  private makeWorkspace(slug: string, repos: RepoSource[], start: WorktreeStart = 'checkout'): { worktree: NonNullable<WorkerInfo['worktree']>; repos: WorkerRepo[]; notes: string[] } | string {
    // A branch can only be checked out once per repository, and two floors can be checkouts of the same one.
    const seen = new Map<string, string>();
    const own = this.trees.commonDir();
    if (!own) return "This floor's project isn't a git checkout";
    seen.set(own, "this floor's project");
    for (const r of repos) {
      const common = new Worktrees(r.dir).commonDir();
      if (!common) return `${r.name} isn't a git checkout`;
      const twin = seen.get(common);
      if (twin) return `${r.name} is the same repository as ${twin}`;
      seen.set(common, r.name);
    }
    const names = workspaceNames([this.dir, ...repos.map((r) => r.dir)]);
    const made: { trees: Worktrees; ref: WorktreeRef }[] = [];
    const fail = (why: string) => {
      // Fresh branches with nothing on them: nothing is lost taking them out again.
      void (async () => {
        for (const m of made.reverse()) await m.trees.sendHome(m.ref, 'all');
        clearWorkspace(path.join(this.dir, WORKTREES_DIR, slug));
      })();
      return why;
    };
    const first = this.trees.create(slug, names[0], this.dir, start);
    if (typeof first === 'string') return fail(first);
    const { note, ...primary } = first;
    const notes = note ? [`${names[0]} ${note}`] : [];
    made.push({ trees: this.trees, ref: primary });
    const others: WorkerRepo[] = [];
    for (const [i, r] of repos.entries()) {
      const trees = new Worktrees(r.dir);
      // A commit names this repository's history alone: the others start from their own branch.
      const wt = trees.create(slug, names[i + 1], this.dir, typeof start === 'object' ? 'checkout' : start);
      if (typeof wt === 'string') return fail(`${r.name}: ${wt}`);
      if (wt.note) notes.push(`${names[i + 1]} ${wt.note}`);
      made.push({ trees, ref: { ...wt, path: path.relative(r.dir, path.join(this.dir, wt.path)) } });
      others.push({ floor: r.floor, name: names[i + 1], repo: r.repo, dir: r.dir, path: wt.path, branch: wt.branch, base: wt.base, from: wt.from });
    }
    try {
      this.writeBrief(
        primary,
        repos.map((r, i) => ({ name: names[i + 1], project: r.repo ?? r.name, from: others[i].from })),
      );
    } catch (err) {
      return fail(`Could not write the workspace's brief: ${(err as Error).message}`);
    }
    return { worktree: primary, repos: others, notes };
  }

  /**
   * The brief in the workspace of a worker across repositories, which folder is which project (the
   * 'worker.repos' prompt), as AGENTS.md. `primary` is its own floor's worktree, in the
   * workspace like `others`. Throws when it can't be written.
   */
  private writeBrief(primary: { path: string; branch: string; from?: string }, others: { name: string; project: string; from?: string }[]) {
    const home = originRepo(this.dir) ?? path.basename(this.dir);
    const line = (folder: string, project: string, from?: string, extra = '') => `- \`${folder}/\`: ${project}${from ? `, cut from ${from}` : ''}${extra}`;
    const brief = officePrompt(this.prompts, 'worker.repos', {
      branch: primary.branch,
      home,
      repos: [line(path.basename(primary.path), home, primary.from, " (this floor's project)"), ...others.map((o) => line(o.name, o.project, o.from))].join('\n'),
    });
    for (const file of WORKSPACE_FILES) writeFileSync(path.join(this.dir, path.dirname(primary.path), file), `${brief.trim()}\n`);
  }

  /** Starts a worker that isn't running again, carrying on its session, with `prompt` as its next message. */
  resume(id: string, prompt?: string): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (w.pty) return 'Worker is already running';
    if (this.checkLost(w, true)) return lostMessage(w.info);
    clockWork(w.info, 'starting');
    w.info.status = 'starting';
    w.info.exitCode = undefined;
    // A board agent or a subagent with no session to carry on starts over, so it needs telling what it's for again.
    const first = w.info.sessionId ? prompt : this.briefed(w, prompt);
    if (prompt) {
      w.info.activity = truncate(prompt, 80);
      this.notePrompt(w, prompt);
    }
    // Cut off mid-turn by a restart: it gets on with it, as whoever was watching would have told it to.
    const carryOn = !prompt && w.interrupted && w.info.kind === 'agent' && !!w.info.sessionId;
    w.interrupted = false;
    this.launch(w, carryOn ? CARRY_ON_PROMPT : first, w.info.sessionId);
    return undefined;
  }

  /** Opens a pre-made agent without inventing an owner task, reusing its session when it exists. */
  openStation(deskId: string, by: string): WorkerInfo | string {
    if (!DESK_BY_ID.get(deskId)?.station) return 'There is no agent to ask there';
    const w = [...this.workers.values()].find((worker) => worker.info.deskId === deskId);
    if (!w) return this.spawn(deskId, by);
    if (!w.pty) {
      const error = this.resume(w.info.id);
      if (error) return error;
    }
    return w.info;
  }

  /**
   * A request for the agent standing by a board (see STATIONS): typed into its session, which is woken
   * up with it if it's asleep, or it's hired there with it when nobody is. Returns what went wrong, or
   * the agent and whether it was just hired.
   */
  station(deskId: string, by: string, text: string, model?: string, effort?: AgentEffort, images?: readonly string[]): { info: WorkerInfo; hired: boolean } | string {
    if (!DESK_BY_ID.get(deskId)?.station) return 'There is no agent to ask there';
    const clean = text.replace(/\r\n?/g, '\n').trim();
    if (!clean && !images?.length) return 'Empty prompt';
    const w = [...this.workers.values()].find((x) => x.info.deskId === deskId);
    if (!w) {
      const info = this.spawn(deskId, by, clean, false, 'agent', model, effort, [], undefined, images);
      return typeof info === 'string' ? info : { info, hired: true };
    }
    // Typed into the question it's asking, the prompt would answer it.
    if (w.info.status === 'needs_input') return `The ${w.info.name} is waiting on an answer in its terminal`;
    if (!w.pty) w.info.lastInputAt = Date.now();
    const err = w.pty ? this.prompt(w.info.id, clean, images) : this.resume(w.info.id, withImages(clean, this.drops.adopt(w.info.id, images ?? [])) || undefined);
    return err ?? { info: w.info, hired: false };
  }

  /** Finder reuses the Team lead and its standard brief; never type a task into a running turn or a CLI question. */
  dispatchLead(text: string, model?: string): { info: WorkerInfo; hired: boolean } | string {
    if (this.closing) return 'The office is closing';
    if (!text.trim()) return 'Empty prompt';
    const w = [...this.workers.values()].find((x) => x.info.deskId === 'station-lead');
    if (w) {
      if (isBusy(w.info.status) || w.launchPrompt || (w.info.lastInputAt !== undefined && Date.now() - w.info.lastInputAt < 2000)) {
        return 'The Team lead is busy or waiting on input. Open its thread and try again when it is ready.';
      }
      const effectiveModel = model ?? w.info.activeModel ?? w.info.model;
      const error = validateWorkerModel('agent', effectiveModel) ?? this.modelGate?.(effectiveModel);
      if (error) return error;
      if (model && model !== (w.info.activeModel ?? w.info.model)) {
        if (this.checkLost(w, true)) return lostMessage(w.info);
        // Model overlays apply at launch, so resume the same conversation rather than typing a CLI command.
        const proc = w.pty;
        w.pty = undefined;
        proc?.kill();
        w.info.model = model;
        w.info.effort = undefined;
        w.info.activeModel = undefined;
        w.info.activeEffort = undefined;
      }
    }
    const result = this.station('station-lead', 'Finder', text, model);
    if (typeof result !== 'string') result.info.lastInputAt = Date.now();
    return result;
  }

  /** Keeps a picture pasted into a prompt that isn't sent yet; its id, or undefined when it isn't a picture or couldn't be kept. */
  stageImage(name: string, body: Buffer): string | undefined {
    return this.drops.stage(name, body);
  }

  /** Throws away staged pictures: taken out of the prompt, or the prompt was never sent. */
  unstage(ids: readonly string[]) {
    this.drops.unstage(ids);
  }

  /** The worker whose terminal holds this hook token: how a worker proves it's asking for itself. */
  authenticate(id: string, token: string): WorkerInfo | undefined {
    const w = this.workers.get(id);
    return w?.pty && token && safeEq(token, w.hookToken) ? w.info : undefined;
  }

  /** Starts every worker that isn't running: nobody should be found asleep at their desk. */
  wakeAll() {
    for (const w of this.workers.values()) if (!w.pty) this.resume(w.info.id);
  }

  /** Keeps a file dropped or pasted into a worker's terminal on this machine; where it is, for the terminal to type. */
  drop(id: string, name: string, type: string, body: Buffer): string | undefined {
    return this.workers.has(id) ? this.drops.save(id, name, type, body) : undefined;
  }

  /** Normal hits only open terminals in the client. A fully charged shot dismisses immediately. */
  shoot(id: string, superShot = false): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (this.closing) return 'The office is closing';
    if (!superShot) return undefined;
    void this.kill(id, undefined, undefined, undefined, true).then(
      ({ note, error }) => {
        if (note) this.events.toast(note, 'info', id);
        if (error) this.events.toast(error, 'warn', id);
      },
      (err: Error) => this.events.toast(`Couldn't dismiss ${w.info.name}: ${err.message}`, 'warn', id),
    );
    return undefined;
  }

  /**
   * Sends a worker home. For one with its own worktree, `cleanup` says what becomes of it; with no
   * choice given, the worktree and branch go only when they hold no work, where `landed` (its merged
   * pull request's head commit) is work delivered. Resolves once that's done, with a line for the team
   * about the worktree.
   */
  async kill(id: string, cleanup?: WorktreeCleanup, landed?: string, landedRepos?: Record<string, string | undefined>, shot = false): Promise<{ note?: string; error?: string }> {
    const w = this.workers.get(id);
    if (!w) return {};
    this.workers.delete(id);
    this.subscribers.delete(id);
    this.namer.forget(id);
    const proc = w.pty;
    w.pty = undefined; // so the exit handler knows this worker is gone and stays quiet
    try {
      proc?.kill();
    } catch {
      // already gone
    }
    w.term?.dispose();
    this.scrollback.remove(id);
    this.drops.remove(id);
    if (w.info.kind === 'agent') {
      try {
        rmSync(path.join(this.dataDir, `system-${id}.md`), { force: true });
        if (w.info.model !== undefined || w.info.effort !== undefined) rmSync(path.join(this.dataDir, `droid-${id}.json`), { force: true });
      } catch {
        // a leftover overlay is harmless: the next launch rewrites it
      }
    }
    this.events.remove(id, shot);
    // Its subagents stay at their desks, working for nobody now.
    for (const sub of this.workers.values()) {
      if (sub.info.lead !== id) continue;
      delete sub.info.lead;
      this.emitUpdate(sub);
    }
    this.persist();
    if (!w.info.worktree) return {};
    if (shot) return this.dismissWorktrees(w);
    // On the branch its work is on, should it have switched since it last came to rest.
    const wt = await this.current(w.info.worktree);
    const name = w.info.name;
    if (w.info.repos?.length) return this.clearRepos(w.info, cleanup, landed, landedRepos);
    if (!cleanup) {
      const work = describeWork(await this.trees.inspect(wt, landed));
      if (work) return { note: `Kept ${name}'s worktree and branch ${wt.branch} — it has ${work}` };
      cleanup = 'all';
    }
    if (cleanup === 'keep') return { note: `Kept ${name}'s worktree and branch ${wt.branch}` };
    const sent = await this.trees.sendHome(wt, cleanup);
    if (sent.error) return { error: `Couldn't delete ${name}'s worktree: ${sent.error}` };
    return { note: `Deleted ${name}'s ${sent.note}` };
  }

  private async dismissWorktrees(w: Worker): Promise<{ note?: string; error?: string }> {
    let trees: ReturnType<WorkerManager['treesOf']>;
    try {
      trees = this.treesOf(w.info);
    } catch (err) {
      return { error: `Couldn't delete ${w.info.name}'s worktrees: ${(err as Error).message}` };
    }
    const errors = (
      await Promise.all(
        trees.map(async (t) => {
          try {
            const error = await t.trees.dismiss(t.ref, this.dir, w.worktreeOwnership?.[t.dir]);
            return error && `${t.name}: ${error}`;
          } catch (err) {
            return `${t.name}: ${(err as Error).message}`;
          }
        }),
      )
    ).filter((e): e is string => !!e);
    if (errors.length) return { error: `Couldn't delete all of ${w.info.name}'s worktrees: ${errors.join('; ')}` };
    if (w.info.repos?.length) clearWorkspace(path.join(this.dir, workspaceOf(w.info)!));
    return { note: `Deleted ${w.info.name}'s worktrees and owned branches` };
  }

  /** Sending home a worker across repositories: what `kill` does with a worktree, for each of its worktrees, and then its workspace. */
  private async clearRepos(info: WorkerInfo, cleanup: WorktreeCleanup | undefined, landed?: string, landedRepos?: Record<string, string | undefined>): Promise<{ note?: string; error?: string }> {
    const trees = this.treesOf(info, landed, landedRepos);
    const { name } = info;
    const branch = info.worktree!.branch;
    const where = trees.map((t) => t.name).join(', ');
    if (!cleanup) {
      const held = (await Promise.all(trees.map(async (t) => ({ name: t.name, work: describeWork(await t.trees.inspect(t.ref, t.landed)) })))).filter((t) => t.work);
      if (held.length) return { note: `Kept ${name}'s worktrees and branch ${branch} in ${where} — ${held.map((t) => `${t.name} has ${t.work}`).join('; ')}` };
      cleanup = 'all';
    }
    if (cleanup === 'keep') return { note: `Kept ${name}'s worktrees and branch ${branch} in ${where}` };
    const sent = await Promise.all(trees.map(async (t) => ({ name: t.name, ...(await t.trees.sendHome(t.ref, cleanup)) })));
    const errors = sent.filter((t) => t.error).map((t) => `${t.name}: ${t.error}`);
    if (errors.length) return { error: `Couldn't delete all of ${name}'s worktrees: ${errors.join('; ')}` };
    clearWorkspace(path.join(this.dir, workspaceOf(info)!));
    return { note: reposHomeNote(name, branch, where, sent) };
  }

  /**
   * Each worktree a worker across repositories has, its own floor's first: its folder in the
   * workspace, git plumbing for its repository, its worktree in that repository's terms, and the
   * commit its merged pull request delivered, when known.
   */
  private treesOf(info: WorkerInfo, landed?: string, landedRepos?: Record<string, string | undefined>): { name: string; dir: string; trees: Worktrees; ref: WorktreeRef; landed?: string }[] {
    const wt = info.worktree!;
    return [
      { name: path.basename(wt.path), dir: this.dir, trees: this.trees, ref: wt, landed },
      ...(info.repos ?? []).map((r) => ({
        name: r.name,
        dir: r.dir,
        trees: new Worktrees(r.dir),
        ref: { path: path.relative(r.dir, path.join(this.dir, r.path)), branch: r.branch, base: r.base },
        landed: landedRepos?.[r.floor],
      })),
    ];
  }

  /**
   * Whether any worktree of a worker across repositories holds work its merged pull requests didn't
   * deliver (`landed` and `landedRepos`, as for kill): then it doesn't go home by itself yet.
   */
  async holdsWork(id: string, landed?: string, landedRepos?: Record<string, string | undefined>): Promise<boolean> {
    const info = this.workers.get(id)?.info;
    if (!info?.worktree) return false;
    const states = await Promise.all(this.treesOf(info, landed, landedRepos).map(async (t) => describeWork(await t.trees.inspect(t.ref, t.landed))));
    return states.some(Boolean);
  }

  /** What a worker's worktree holds, so whoever sends it home knows what deleting it would lose. */
  async inspectWorktree(id: string): Promise<WorktreeState | undefined> {
    const w = this.workers.get(id);
    const info = w?.info;
    if (!w || !info?.worktree) return undefined;
    if (!info.repos?.length) {
      await this.syncBranch(w);
      return this.trees.inspect(info.worktree);
    }
    const repos = await Promise.all(this.treesOf(info).map(async (t) => ({ name: t.name, state: await t.trees.inspect(t.ref) })));
    const sum = (k: 'dirty' | 'ahead' | 'unpushed') => repos.reduce((n, r) => n + r.state[k], 0);
    const errors = repos.filter((r) => r.state.error).map((r) => `${r.name}: ${r.state.error}`);
    return { exists: repos.every((r) => r.state.exists), dirty: sum('dirty'), ahead: sum('ahead'), unpushed: sum('unpushed'), error: errors.length ? errors.join('; ') : undefined, repos };
  }

  /** Every worker's worktree branch, looked at again (see syncBranch): for when new pull requests may have come in. */
  async syncBranches(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => this.syncBranch(w)));
  }

  /**
   * Keeps `worktree.branch` on the branch the worktree is actually on. Agents often make their own
   * (`git checkout -b fix-x`, because the task or the repo's instructions say to) and open the pull
   * request from there, and the PR badge, O at the desk and sending it home go by it. A worker across
   * repositories keeps the branch it was given in each (see openPrs).
   */
  private async syncBranch(w: Worker): Promise<void> {
    const wt = w.info.worktree;
    if (!wt || w.info.repos?.length) return;
    const now = await this.current(wt);
    // Sent home meanwhile, or another look got there first.
    if (now === wt || this.workers.get(w.info.id) !== w || w.info.worktree !== wt) return;
    w.info.worktree = now;
    this.emitUpdate(w);
    this.persist();
  }

  /** A worktree on the branch it's on now (see Worktrees.followed); the same one when nothing moved. */
  private async current(wt: Worktree): Promise<Worktree> {
    const now = await this.trees.followed(wt);
    if (now === wt) return wt;
    return { ...wt, branch: now.branch, made: now.made };
  }

  /**
   * Whether the folder a worker works in (its worktree, or its workspace across repositories) is gone:
   * deleted outside the office. It's then marked lost (WorkerInfo.lost) for whoever comes to its desk,
   * instead of failing to start over and over; once the folder is back, it isn't any more.
   */
  private checkLost(w: Worker, recheck = false): boolean {
    const { info } = w;
    if (!info.worktree || existsSync(this.cwd(info))) {
      if (info.lost) {
        info.lost = undefined;
        this.emitUpdate(w);
      }
      return false;
    }
    // Where its branch is only changes by hand: looked at again when someone tries to start it.
    if (info.lost && !recheck) return true;
    const branch = this.trees.branchState(info.worktree.branch);
    if (branch !== info.lost?.branch) {
      info.lost = { branch };
      this.emitUpdate(w);
    }
    return true;
  }

  /**
   * Every so often: a worktree deleted under a worker marks it lost, and one put back by hand
   * (`git worktree add` at the same place) sets an asleep worker back to work.
   */
  private watchFolder(w: Worker) {
    if (!w.info.worktree || w.rebuilding) return;
    const was = !!w.info.lost;
    if (!this.checkLost(w) && was && !w.pty) this.resume(w.info.id);
  }

  /**
   * Puts a lost worker's worktree back where it was (see Worktrees.restore) and starts it again,
   * carrying on its conversation; across repositories, each worktree that's gone and the workspace's
   * brief.
   * Resolves to whether it `rebuilt` anything, with a note on where a branch came back from (or why
   * there was nothing to do), or to what went wrong.
   */
  async rebuild(id: string): Promise<{ rebuilt?: boolean; note?: string; error?: string }> {
    const w = this.workers.get(id);
    if (!w) return { error: 'No such worker' };
    const { info } = w;
    if (!info.worktree) return { error: `${info.name} works in the main checkout` };
    if (w.rebuilding) return {};
    const folder = this.cwd(info);
    const wasLost = !!info.lost || this.checkLost(w);
    const froms: string[] = [];
    if (!existsSync(folder)) {
      const across = !!info.repos?.length;
      w.rebuilding = true;
      try {
        for (const t of this.treesOf(info)) {
          if (t.ref.path && existsSync(path.resolve(t.dir, t.ref.path))) continue;
          const r = await t.trees.restore(t.ref);
          const which = across ? `${t.name}'s ` : '';
          if ('error' in r) return { error: `Couldn't rebuild ${info.name}'s worktree${across ? ` of ${t.name}` : ''}: ${r.error}` };
          if (r.from === 'origin') froms.push(`${which}${t.ref.branch} came back from origin`);
          if (r.from === 'gone') froms.push(`${which}${t.ref.branch} was deleted too, so it starts again from where it began`);
        }
        if (across) {
          try {
            this.writeBrief(
              info.worktree,
              info.repos!.map((r) => ({ name: r.name, project: r.repo ?? r.name, from: r.from })),
            );
          } catch {
            // The worktrees are what it needs; the brief only says which folder is which.
          }
        }
      } finally {
        w.rebuilding = false;
      }
    }
    if (wasLost && !this.checkLost(w)) this.restartIn(w);
    if (!wasLost) {
      if (!w.pty) this.resume(id);
      return { note: `${info.name}'s worktree is already there` };
    }
    return { rebuilt: true, note: froms.join('; ') || undefined };
  }

  /**
   * Starts a worker in its folder again: an asleep one wakes up, and one whose process was left running
   * in the folder deleted from under it starts over in the new one, carrying on its conversation.
   */
  private restartIn(w: Worker) {
    const proc = w.pty;
    if (proc) {
      if (midTurn(w)) w.interrupted = true;
      // Gone before it exits, so the exit handler knows it was the office and stays quiet.
      w.pty = undefined;
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
    this.resume(w.info.id);
  }

  /** Subscribes one connection to a worker's terminal; opening it acknowledges its wait for attention. */
  attach(id: string, clientId: string): { data: string; cols: number; rows: number; shared: boolean } | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    let subs = this.subscribers.get(id);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(id, subs);
    }
    const shared = [...subs].some((id) => id !== clientId);
    subs.add(clientId);
    let changed = this.syncOpen(w);
    if (!w.info.acked && w.info.status !== 'needs_input') {
      w.info.acked = true;
      changed = true;
    }
    if (changed) this.emitUpdate(w);
    const data = w.snapshot ? w.snapshot() : offlineBanner(w.info);
    return { data, cols: w.info.cols, rows: w.info.rows, shared };
  }

  /** Lines of every worker's terminal holding `needle` (a searchKey), newest first, at most `perWorker` each. */
  search(needle: string, perWorker: number): { hits: TerminalHit[]; more: boolean } {
    const hits: TerminalHit[] = [];
    let more = false;
    for (const w of this.workers.values()) {
      if (!w.term) continue;
      const found = searchTerminal(w.term, needle, perWorker);
      more ||= found.more;
      for (const hit of found.hits) hits.push({ workerId: w.info.id, ...hit });
    }
    return { hits, more };
  }

  /** Unsubscribes one connection from a worker's terminal. */
  detach(id: string, clientId: string) {
    const w = this.workers.get(id);
    if (!w) return;
    if (this.unsubscribe(id, clientId) && this.syncOpen(w)) this.emitUpdate(w);
  }

  /** Unsubscribes one connection from every terminal; other connections keep streaming. */
  detachAll(clientId: string) {
    for (const w of this.workers.values()) {
      if (this.unsubscribe(w.info.id, clientId) && this.syncOpen(w)) this.emitUpdate(w);
    }
  }

  /** Removes one connection's subscription; empty entries go, so removed workers leave nothing behind. */
  private unsubscribe(id: string, clientId: string): boolean {
    const subs = this.subscribers.get(id);
    if (!subs?.delete(clientId)) return false;
    if (!subs.size) this.subscribers.delete(id);
    return true;
  }

  /**
   * Cancels a Droid agent's turn with one Escape, and only while it's really mid-turn: its status
   * is working and its screen shows droid's busy spinner. Says whether it sent it. An agent at rest
   * never gets the key. Not Ctrl+C: droid only arms "press again to exit" with one, and two quit it.
   */
  cancelTurn(id: string): boolean {
    const w = this.workers.get(id);
    if (!w?.pty || !w.term || w.info.kind !== 'agent' || w.info.status !== 'working') return false;
    if (readDroidScreen(screenRows(w.term)) !== 'busy') return false;
    w.pty.write('\x1b');
    return true;
  }

  /** What a Droid agent's screen shows now: busy on a turn, asking, or at rest (see droid-screen.ts). */
  turnScreen(id: string): DroidScreen | undefined {
    const w = this.workers.get(id);
    return w?.term && w.info.kind === 'agent' ? readDroidScreen(screenRows(w.term)) : undefined;
  }

  /** Keystrokes from an attached browser. */
  write(id: string, data: string) {
    const w = this.workers.get(id);
    if (!w?.pty) return;
    w.pty.write(data);
    let changed = this.typed(w);
    if (w.info.status === 'needs_input' && w.info.acked === false) {
      w.info.acked = true;
      changed = true;
    }
    if (changed) this.emitUpdate(w);
  }

  /**
   * Remembers that the terminal took input. Says whether that's news: input after a pause (not
   * every keystroke, or a typist would flood every connection with updates).
   */
  private typed(w: Worker): boolean {
    const now = Date.now();
    const last = w.info.lastInputAt;
    if (last !== undefined && now - last < TYPED_REFRESH_MS) return false;
    w.info.lastInputAt = now;
    return true;
  }

  /**
   * Types a prompt into the agent's input box and submits it, with any staged pictures listed after
   * it. With `queue`, an agent gets Ctrl+Enter instead of Enter, as a desktop terminal sends it, so
   * Droid queues the message behind its current turn.
   */
  prompt(id: string, text: string, images?: readonly string[], queue = false): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (!w.pty) return 'Worker is not running';
    const typed = text.replace(/\r\n?/g, '\n').trim();
    const clean = images?.length ? withImages(typed, this.drops.adopt(id, images)) : typed;
    if (!clean) return 'Empty prompt';
    this.typeIn(w, clean, queue && wantsCsiEnter(w.info.kind) ? CTRL_ENTER : '\r');
    const shown = typed || 'See the attached images';
    w.info.activity = truncate(shown, 80);
    this.notePrompt(w, shown);
    w.info.lastInputAt = Date.now();
    this.emitUpdate(w);
    return undefined;
  }

  /** Types a message into the agent's input box and submits it with `submit`. */
  private typeIn(w: Worker, text: string, submit = '\r') {
    // Bracketed paste keeps multi-line prompts in one message, then Enter submits.
    w.pty?.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => w.pty?.write(submit), 120);
  }

  /** Types in the message this run of its droid was started for, if it hasn't been yet. */
  private sendLaunchPrompt(w: Worker) {
    const pending = w.launchPrompt;
    w.launchPrompt = undefined;
    if (!pending) return;
    if (w.pty) {
      w.info.lastInputAt = Date.now();
      this.typeIn(w, pending.text);
    }
    // Saved at once, so an office restarting now doesn't type it in a second time.
    this.persist();
  }

  /**
   * Pushes a worktree worker's branch and opens a pull request (a merge request on GitLab) for it,
   * with a title and body drafted from its task. Resolves to the PR, or to a message saying why
   * there is none. The branch may already have an open PR (a second press, or one opened by hand):
   * that one is used. A worker across repositories gets one in each repository it committed to
   * (see openPrs).
   */
  async openPr(id: string, by: string): Promise<{ prs: OpenedPr[]; failed: string[] } | string> {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    const { info } = w;
    const wt = info.worktree;
    const words = forgeWords(this.forge);
    if (!wt) return `${info.name} works in the main checkout — only workers with their own worktree can open a ${words.pr}`;
    if (info.prOpening) return `${info.name}'s ${words.pull} is already being opened`;
    if (isBusy(info.status)) {
      return `${info.name} is still ${info.status === 'needs_input' ? 'waiting on input' : info.status} — wait until it's done`;
    }
    if (info.repos?.length) return this.openPrs(w, by);
    const cwd = path.join(this.dir, wt.path);
    if (!existsSync(cwd)) return `${info.name}'s worktree is gone (${wt.path})`;
    info.prOpening = true;
    this.emitUpdate(w);
    try {
      // The PR comes from the branch its work is on, which may be one it made itself.
      await this.syncBranch(w);
      const branch = info.worktree?.branch ?? wt.branch;
      const commits = (await run('git', ['log', '--reverse', '--format=%h %s', `${wt.base}..${branch}`], cwd)).split('\n').filter(Boolean);
      const dirty = await checkoutDirty(cwd);
      if (!commits.length) return dirty ? `${info.name} hasn't committed anything yet — ask it to commit first` : `${info.name} has no commits on ${branch} yet`;
      const open = await this.pulls.findOpenPull(branch, cwd);
      if (open) {
        info.pr = open;
        this.persist();
        return { prs: [{ ...open, existed: true, dirty }], failed: [] };
      }
      await pushBranch(cwd, branch, 90_000);
      const base = await choosePullBase(this.trees, branch, { from: wt.from, configured: this.trees.selectedBranch() ?? this.configuredBase, current: this.trees.currentBranch(), defaultBranch: this.trees.defaultBranch() });
      const { title, body } = draftPr(info, commits, by);
      const { number, url } = await this.pulls.createPull(cwd, branch, base, title, body);
      info.pr = { number, url };
      this.persist();
      return { prs: [{ number, url, existed: false, dirty }], failed: [] };
    } catch (err) {
      return `Couldn't open a ${words.pr} for ${info.name}: ${(err as Error).message}`;
    } finally {
      info.prOpening = false;
      // The worker may have been sent home meanwhile; an update would bring it back as a ghost.
      if (this.workers.get(id) === w) this.emitUpdate(w);
    }
  }

  /**
   * 'worker.pr' for a worker across repositories: a pull request in each repository it committed to
   * (or the one its branch already has there), with every one of them listed in each one's
   * description, so they're reviewed and merged together. The issue its task came from is closed by
   * its own floor's pull request; the others only mention it.
   */
  private async openPrs(w: Worker, by: string): Promise<{ prs: OpenedPr[]; failed: string[] } | string> {
    const { info } = w;
    const wt = info.worktree!;
    const home = originRepo(this.dir);
    const parts = [
      { name: path.basename(wt.path), dir: this.dir, path: wt.path, branch: wt.branch, base: wt.base, from: wt.from, pr: info.pr, own: true, set: (pr: { number: number; url: string }) => (info.pr = pr) },
      ...info.repos!.map((r) => ({ ...r, own: false, set: (pr: { number: number; url: string }) => (r.pr = pr) })),
    ];
    const gone = parts.filter((p) => !existsSync(path.join(this.dir, p.path)));
    if (gone.length) return `${info.name}'s worktree${gone.length > 1 ? 's' : ''} of ${gone.map((p) => p.name).join(', ')} ${gone.length > 1 ? 'are' : 'is'} gone`;
    info.prOpening = true;
    this.emitUpdate(w);
    const prs: (OpenedPr & { cwd: string })[] = [];
    const failed: string[] = [];
    const uncommitted: string[] = [];
    try {
      for (const p of parts) {
        const cwd = path.join(this.dir, p.path);
        try {
          const dirty = await checkoutDirty(cwd);
          const known = p.pr ?? (await this.pulls.findOpenPull(p.branch, cwd));
          if (known) {
            p.set(known);
            prs.push({ repo: p.name, ...known, existed: true, dirty, cwd });
            continue;
          }
          const commits = (await run('git', ['log', '--reverse', '--format=%h %s', `${p.base}..${p.branch}`], cwd)).split('\n').filter(Boolean);
          if (!commits.length) {
            if (dirty) uncommitted.push(p.name);
            continue;
          }
          await pushBranch(cwd, p.branch, 90_000);
          const repo = new Worktrees(p.dir);
          const base = await choosePullBase(repo, p.branch, { from: p.from, configured: repo.selectedBranch() ?? (p.own ? this.configuredBase : undefined), current: repo.currentBranch(), defaultBranch: repo.defaultBranch() });
          const { title, body } = draftPr(info, commits, by, p.own ? undefined : { home });
          const pr = await this.pulls.createPull(cwd, p.branch, base, title, body);
          p.set(pr);
          this.persist();
          prs.push({ repo: p.name, ...pr, existed: false, dirty, cwd });
        } catch (err) {
          failed.push(`Couldn't open a PR in ${p.name}: ${(err as Error).message}`);
        }
      }
      if (!prs.length) {
        if (failed.length) return failed.join('; ');
        return uncommitted.length ? `${info.name} hasn't committed anything yet in ${uncommitted.join(', ')} — ask it to commit first` : `${info.name} has no commits on ${wt.branch} yet in any of its repositories`;
      }
      if (prs.length > 1 && prs.some((p) => !p.existed)) {
        for (const p of prs) {
          try {
            const ref = { number: p.number, url: p.url };
            const body = this.pulls.pullBody ? await this.pulls.pullBody(ref, p.cwd) : undefined;
            if (body === undefined || !this.pulls.setPullBody) {
              failed.push(`Couldn't list the other pull requests on ${p.repo} #${p.number}: this forge can't edit a pull request's description`);
              continue;
            }
            const next = withRelated(body, relatedBlock(prs, p.url, wt.branch));
            if (next !== body) await this.pulls.setPullBody(ref, p.cwd, next);
          } catch (err) {
            failed.push(`Couldn't list the other pull requests on ${p.repo} #${p.number}: ${(err as Error).message}`);
          }
        }
      }
      this.persist();
      return { prs: prs.map(({ cwd: _cwd, ...p }) => p), failed };
    } finally {
      info.prOpening = false;
      if (this.workers.get(info.id) === w) this.emitUpdate(w);
    }
  }

  resize(id: string, cols: number, rows: number) {
    const w = this.workers.get(id);
    if (!w?.pty || !w.term) return;
    cols = clamp(Math.floor(cols), 20, 400);
    rows = clamp(Math.floor(rows), 5, 200);
    if (cols === w.info.cols && rows === w.info.rows) return;
    w.info.cols = cols;
    w.info.rows = rows;
    try {
      w.pty.resize(cols, rows);
      w.term.resize(cols, rows);
    } catch {
      // pty may have exited between checks
    }
    w.screenDirty = true;
    w.lastLines = [];
    this.emitUpdate(w);
  }

  /** Droid lifecycle hook callback: what a worker is doing, from its hooks. */
  handleHook(workerId: string, token: string, event: string, payload: unknown): boolean {
    const w = this.workers.get(workerId);
    if (!w?.pty || !safeEq(token, w.hookToken)) return false;
    if (!payload || typeof payload !== 'object') return false;
    const report = payload as Record<string, unknown>;
    if (report.hook_event_name !== event) return false;
    if (event === 'WorktreeSetup') return this.setupHook(w, report);
    if (w.info.kind !== 'agent' || typeof report.session_id !== 'string' || !report.session_id) return false;
    if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'].includes(event)) return false;
    const session = report.session_id;
    const caller = typeof report.calling_session_id === 'string' && report.calling_session_id ? report.calling_session_id : undefined;
    if (event === 'SessionStart' && caller) {
      // A subagent its droid just started (the Task tool): a session of its own, inside this one's turn.
      w.info.sessionId ??= caller;
      if (caller !== w.info.sessionId && !w.subSessions.has(caller)) return false;
      w.subSessions.add(session);
    }
    const sub = w.subSessions.has(session);
    if (!sub && event !== 'SessionStart' && w.info.sessionId && session !== w.info.sessionId) return false;
    w.hookAt = Date.now();
    w.stopAt = !sub && event === 'Stop' ? w.hookAt : undefined;
    if (sub) this.subagentHook(w, event, report);
    else this.sessionHook(w, event, report);
    this.emitUpdate(w);
    this.persist();
    return true;
  }

  /** The setup script in a new worktree's terminal (see worktree-setup.ts) started, or finished. */
  private setupHook(w: Worker, report: Record<string, unknown>): boolean {
    const { info } = w;
    if (!w.settingUp) return false;
    if (report.phase === 'start') {
      const commands = Array.isArray(report.commands) ? report.commands.filter((c): c is string => typeof c === 'string') : [];
      if (commands.length && info.kind === 'agent' && info.status === 'starting') info.activity = truncate(`Setting up its worktree: ${commands.join(' · ')}`, 80);
    } else if (report.phase === 'done') {
      w.settingUp = false;
      w.setupDoneAt = Date.now();
      if (info.activity?.startsWith('Setting up its worktree')) info.activity = undefined;
      const failed = (Array.isArray(report.failed) ? report.failed : []).filter((f): f is { command: string; code: number; label?: string; output?: string } => !!f && typeof f.command === 'string');
      if (failed.length) {
        const what = failed.map((f) => `${f.label ? `${f.label}: ` : ''}\`${f.command}\` (exit ${f.code})`).join(', ');
        const output = failed
          .map((f) => (typeof f.output === 'string' ? f.output.slice(-SETUP_OUTPUT_MAX) : ''))
          .filter(Boolean)
          .join('\n\n');
        // The agent can't see what ran before it, and Droid clears the terminal when it starts: it's told with its first message.
        if (w.launchPrompt) {
          w.launchPrompt.text = `${setupFailedNote(what, output)}\n\n${w.launchPrompt.text}`;
          this.persist();
        }
        this.events.toast(`🌿 ${info.name}'s worktree setup failed: ${what}.${w.launchPrompt ? ` ${info.name}'s first message says so, with the error.` : ''}`, 'warn', info.id);
      }
    } else return false;
    this.emitUpdate(w);
    return true;
  }

  /** A hook from the worker's own session. */
  private sessionHook(w: Worker, event: string, report: Record<string, unknown>) {
    const session = report.session_id as string;
    if (event === 'SessionStart') {
      if ((w.info.sessionId && w.info.sessionId !== session) || report.source === 'clear') this.clearTask(w);
      w.info.sessionId = session;
      w.pendingFork = undefined;
      w.subSessions.clear();
      w.lastTool.clear();
      w.bootBlocked = false;
      w.settingUp = false;
      w.info.activity = undefined;
      this.setStatus(w, 'idle');
      this.sendLaunchPrompt(w);
    } else if (event === 'UserPromptSubmit') {
      w.bootBlocked = false;
      w.info.action = undefined;
      if (typeof report.prompt === 'string') {
        w.info.activity = truncate(report.prompt, 80);
        this.notePrompt(w, report.prompt);
      }
      this.setStatus(w, 'working');
    } else if (event === 'PreToolUse') this.toolStarted(w, session, report);
    else if (event === 'PostToolUse') {
      this.noteOutcome(w, report, false);
      // A subagent that asked has finished, its question answered.
      if (w.asking && w.asking.session !== session && report.tool_name === 'Task') this.setStatus(w, 'working');
      else this.toolFinished(w, session, report);
    } else if (event === 'Notification') {
      // Droid sends idle_prompt when a turn is cancelled (Esc) instead of Stop, prompt or no prompt.
      if (report.notification_type === 'idle_prompt' && (w.info.status === 'working' || (w.info.status === 'needs_input' && !w.bootBlocked))) this.setStatus(w, 'done');
      else this.notified(w, session, report);
    }
    // Stop runs before Droid finishes: another Stop hook can block it and continue the turn.
    // Only reconcile's settled, quiet input box confirms completion, without publishing a false done.
    // /model can change it between turns, and droid writes the file a moment after SessionStart.
    if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'Stop') this.refreshDroidModel(w);
  }

  /**
   * A hook from one of its subagents. It works inside the worker's turn, and its permission prompts
   * and questions show in the worker's terminal; its own start, prompt and end are not the worker's.
   */
  private subagentHook(w: Worker, event: string, report: Record<string, unknown>) {
    const session = report.session_id as string;
    if (event === 'PreToolUse') this.toolStarted(w, session, report);
    else if (event === 'PostToolUse') {
      this.noteOutcome(w, report, false);
      this.toolFinished(w, session, report);
    } else if (event === 'Notification') this.notified(w, session, report);
    else if ((event === 'SessionStart' || event === 'UserPromptSubmit') && (w.info.status === 'done' || w.info.status === 'idle')) this.setStatus(w, 'working');
  }

  private toolStarted(w: Worker, session: string, report: Record<string, unknown>) {
    const tool = report.tool_name;
    if (typeof tool === 'string') w.lastTool.set(session, tool);
    if (ASK_TOOLS.has(tool)) {
      this.setStatus(w, 'needs_input');
      w.asking = { session, tool: tool as string };
      return;
    }
    w.info.activity = describeTool(report);
    w.info.action = toolAction(tool, report.tool_input);
    this.noteTool(w, w.info.activity);
    // Moving on means its question was answered, unless another session is the one asking.
    if (w.info.status !== 'needs_input' || !w.asking || w.asking.session === session) this.setStatus(w, 'working');
  }

  /** A tool the session asked about (permission to run it, or a question) has run: it was answered. */
  private toolFinished(w: Worker, session: string, report: Record<string, unknown>) {
    const { asking } = w;
    if (w.info.status !== 'needs_input' || !asking || asking.session !== session) return;
    if (asking.tool === undefined || asking.tool === report.tool_name) this.setStatus(w, 'working');
  }

  private notified(w: Worker, session: string, report: Record<string, unknown>) {
    if (report.notification_type !== 'permission_prompt' && report.notification_type !== 'elicitation_dialog') return;
    w.info.activity = typeof report.message === 'string' ? truncate(report.message, 80) : 'Waiting for input';
    this.setStatus(w, 'needs_input');
    w.asking = { session, tool: w.lastTool.get(session) };
  }

  /**
   * Confirms completion and heals missed hooks: once the screen settles without recent hooks,
   * status follows it (see droid-screen.ts). Runs every second; `now` is for tests.
   */
  reconcile(now = Date.now()) {
    for (const w of this.workers.values()) {
      const { info } = w;
      // No SessionStart came for it (the hook can't reach the office), but droid's input box is up.
      if (w.launchPrompt && w.pty && w.term && now - w.launchPrompt.at >= LAUNCH_PROMPT_FALLBACK_MS && readDroidScreen(screenRows(w.term)) === 'idle') this.sendLaunchPrompt(w);
      if (info.kind !== 'agent' || !w.pty || !w.term || w.bootBlocked || !info.sessionId || info.status === 'starting') {
        w.screenSeen = undefined;
        continue;
      }
      const state = readDroidScreen(screenRows(w.term));
      if (w.stopAt !== undefined && info.status === 'working' && state !== 'asking' && now - w.stopAt >= STOP_FALLBACK_MS && now - w.outputAt >= STOP_FALLBACK_MS) {
        this.setStatus(w, 'done');
        continue;
      }
      if (!state) {
        w.screenSeen = undefined;
        continue;
      }
      if (w.screenSeen?.state !== state) w.screenSeen = { state, since: now };
      if (now - w.screenSeen.since < SCREEN_SETTLE_MS || now - w.hookAt < SCREEN_SETTLE_MS) continue;
      const next = screenStatus(info.status, state, now - w.outputAt >= SCREEN_SETTLE_MS);
      if (!next) continue;
      if (next === 'needs_input') info.activity = 'Waiting for input';
      this.setStatus(w, next);
    }
  }

  /** Looks up the model and effort droid says the worker's session runs, which no hook reports. */
  private refreshDroidModel(w: Worker) {
    const { sessionId } = w.info;
    if (w.info.kind !== 'agent' || !sessionId) return;
    void this.droidSessions.read(sessionId, this.cwd(w.info)).then((seen) => {
      if (!seen || this.workers.get(w.info.id) !== w || w.info.sessionId !== sessionId) return;
      if (seen.model === w.info.activeModel && seen.effort === w.info.activeEffort) return;
      w.info.activeModel = seen.model;
      w.info.activeEffort = seen.effort;
      this.emitUpdate(w);
    });
  }

  /** A new message for the worker: show it right away, and have its task (re)named. */
  private notePrompt(w: Worker, prompt: string) {
    if (w.info.kind !== 'agent') return;
    const clean = prompt.replace(/\s+/g, ' ').trim();
    // Bare slash commands (/model, /compact), repeats and the office's own carry-on aren't new work.
    if (!clean || /^\/\S+$/.test(clean) || w.prompts.at(-1) === clean || clean === CARRY_ON_PROMPT) return;
    w.prompts = [...w.prompts, clean].slice(-TASK_PROMPTS);
    const hadTask = !!w.info.task;
    if (!hadTask) w.info.task = fallbackTask(clean);
    // "yes", "go ahead", "2": a reply within the same task, not worth a new name.
    if (hadTask && clean.length < 16) return;
    this.nameTask(w);
  }

  private noteTool(w: Worker, tool: string) {
    w.tools = [...w.tools, tool].slice(-TASK_TOOLS);
    w.toolsSinceNamed++;
    if (w.info.task && w.toolsSinceNamed >= TASK_REFRESH_TOOLS && Date.now() - w.namedAt > TASK_REFRESH_MS) this.nameTask(w);
  }

  /**
   * A tool call finished. Tests or a build that failed again (by exit code, or by the summary it
   * printed when the exit code was piped away) and the worker puts its head in its hands, until its
   * next tool call; a passing run ends the streak.
   */
  private noteOutcome(w: Worker, payload: any, failed: boolean) {
    if (payload?.is_interrupt || toolAction(payload?.tool_name, payload?.tool_input) !== 'test') return;
    const res = payload?.tool_response;
    const output = [payload?.error, res?.stdout, res?.stderr].filter((s) => typeof s === 'string').join('\n');
    if (!failed && !outputFailed(output)) {
      w.failStreak = 0;
      return;
    }
    if (++w.failStreak < FAILS_TO_DESPAIR || w.info.action === 'failing') return;
    w.info.action = 'failing';
    this.emitUpdate(w);
  }

  private nameTask(w: Worker) {
    w.toolsSinceNamed = 0;
    w.namedAt = Date.now();
    const previous = w.info.task && w.prompts.length > 1 ? w.info.task : undefined;
    this.namer.request(w.info.id, { prompts: w.prompts, tools: w.tools, previous, epoch: w.taskEpoch });
  }

  private clearTask(w: Worker) {
    w.taskEpoch++;
    w.prompts = [];
    w.tools = [];
    w.toolsSinceNamed = 0;
    this.namer.forget(w.info.id);
    if (!w.info.task) return;
    w.info.task = undefined;
    this.emitUpdate(w);
    this.persist();
  }

  /**
   * The office is closing. On a restart (`keep`), terminals in the host keep running for the next
   * office to pick back up; otherwise every worker stops.
   */
  shutdown(keep = false) {
    if (this.closing) return;
    this.closing = true;
    this.stopping = !keep;
    this.officeShell?.shutdown(keep);
    clearInterval(this.screenTimer);
    clearInterval(this.watchTimer);
    clearInterval(this.statusTimer);
    clearInterval(this.saveTimer);
    for (const w of this.workers.values()) {
      // Before the process goes, so the next office shows what it was doing, not how it was stopped.
      if (w.unsaved) this.saveScrollback(w);
      if (keep && w.pty?.id) continue;
      // A restart only takes this one down because it runs in-process: the next office carries on its turn.
      if (keep && midTurn(w)) w.interrupted = true;
      try {
        w.pty?.kill();
      } catch {
        // ignore
      }
    }
    this.persist(true);
    if (keep) this.host.detach();
    else this.host.stop();
  }

  // ---------------------------------------------------------------------------

  private launch(w: Worker, prompt: string | undefined, resumeSessionId: string | undefined) {
    const { info } = w;
    // Its folder was deleted meanwhile: it waits, marked lost, for someone to rebuild it or send it home.
    if (this.checkLost(w)) {
      clockWork(info, 'exited');
      info.status = 'exited';
      this.emitUpdate(w);
      return;
    }
    // The new terminal starts with what the last one showed (on a resume), or with what was saved
    // when the office last stopped, so earlier output is still there to scroll back to and search.
    const restarted = !w.term;
    const before = w.term && w.ser ? terminalTail(w.term, w.ser, SCROLLBACK) : this.scrollback.load(info.id);
    const prelude = before ? `${before}\r\n${restarted ? RESTORED_NOTE : ''}` : undefined;
    const term = this.newTerm(w);
    if (prelude) {
      // Writes are parsed in order, so this lands before anything the new process prints.
      term.write(prelude, () => {
        if (w.term === term) w.fresh = term.registerMarker(0);
      });
    }

    const shell = defaultShell();
    const isShell = info.kind === 'shell';
    const command = this.command(info);
    const commandPath = isShell ? undefined : this.agentPath;
    const args = isShell ? (WIN && !process.env.SHELL ? [] : ['-l']) : [...this.agentArgs];
    if (!isShell) {
      // Interactive droid takes no --model flag: the model is pinned in its settings overlay.
      const system = this.systemPromptFile(info);
      args.unshift('--settings', this.droidSettings(info), ...(system ? ['--append-system-prompt-file', system] : []));
      if (resumeSessionId) args.push('--resume', resumeSessionId);
      else if (w.pendingFork) args.push('--cwd', this.cwd(info), '--fork', w.pendingFork.sessionId);
    }
    // Typed in at SessionStart rather than passed as `droid -- <prompt>`: droid started with a
    // prompt argument never opens /rewind-conversation for the rest of that run.
    const first = w.pendingFork?.prompt ?? prompt;
    w.launchPrompt = !isShell && first ? { text: first, at: Date.now() } : undefined;
    w.hookToken = randomBytes(16).toString('hex');
    // A new process: whatever subagents and prompts the last one had went with it.
    w.subSessions.clear();
    w.lastTool.clear();
    w.asking = undefined;
    const env = childEnv();
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      DROID_OFFICE_WORKER_ID: info.id,
      DROID_OFFICE_HOOK_URL: this.hook.url,
      DROID_OFFICE_HOOK_TOKEN: w.hookToken,
    });
    // Any agent runs its subagents with office-workers, and uses the Whiteboard with office-whiteboard.
    const bins = [!isShell && this.teamBin].filter((d): d is string => !!d);
    if (bins.length) {
      // Windows spells it Path.
      const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
      env[key] = [...bins, env[key]].filter(Boolean).join(path.delimiter);
    }

    const cwd = this.cwd(info);
    // A workspace isn't a repository, but it's inside this floor's checkout: git run in it must not
    // find that checkout (and switch its branch, say) instead of saying it's no repository.
    if (info.repos?.length) env.GIT_CEILING_DIRECTORIES = [path.dirname(cwd), env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
    // A plain folder can sit inside someone else's checkout: git run in it must not find that one.
    else if (this.trees.ceiling) env.GIT_CEILING_DIRECTORIES = [this.trees.ceiling, env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
    // The host keeps its own copy of the screen for the next office: it starts with the same history.
    const where = { cwd, env, cols: info.cols, rows: info.rows, prelude };
    // Only a new worktree's first terminal: a resume finds it ready.
    const plan = resumeSessionId ? undefined : w.setupPlan;
    w.setupPlan = undefined;
    let proc: Pty;
    try {
      if (plan && this.setupScript) {
        const file = isShell ? shell : (commandPath ?? command);
        const line = setupLine({ node: process.execPath, script: this.setupScript, plan, file, quoteFile: isShell || !!commandPath, args, cmd: WIN && !process.env.SHELL });
        w.settingUp = true;
        if (!isShell) info.activity = 'Setting up its worktree';
        proc = this.host.spawn({ file: shell, args: shellRun(line), ...where });
      } else if (isShell) {
        proc = this.host.spawn({ file: shell, args, ...where });
      } else if (commandPath) {
        proc = this.host.spawn({ file: commandPath, args, ...where });
      } else {
        // Not found on PATH: let a login shell find it (nvm, asdf, ~/.local/bin ...).
        const line = ['exec', command, ...args].map((a, i) => (i < 2 ? a : shq(a))).join(' ');
        proc = this.host.spawn({ file: shell, args: shellRun(line), ...where });
      }
    } catch (err) {
      this.startFailed(w, (err as Error).message);
      return;
    }
    if (isShell) info.status = 'idle';
    this.follow(w, proc, term);
    this.emitUpdate(w);
    this.persist();
  }

  /** Takes back a terminal the host kept running while the office was down. */
  private adopt(w: Worker, adopted: Adopted, saved: NonNullable<Worker['saved']>) {
    const { info } = w;
    // It kept working through the restart: nothing to carry on.
    w.interrupted = false;
    // Its droid hadn't taken its first message yet: SessionStart (or the screen fallback) still types it in.
    w.launchPrompt = saved.launchPrompt;
    info.cols = adopted.cols;
    info.rows = adopted.rows;
    const term = this.newTerm(w);
    // Scrollback and all, the history from before this run included: only what it prints from here
    // on can say it's stuck on a login.
    term.write(adopted.snapshot, () => {
      if (w.term === term) w.fresh = term.registerMarker(0);
    });
    this.setTitle(w, adopted.title);
    // A hook that came in since the office started already says how it's doing.
    if (info.status === 'offline') {
      info.status = saved.status;
      info.acked = saved.acked;
      info.waitingSince = saved.waitingSince;
    }
    this.follow(w, adopted.pty, term);
    this.emitUpdate(w);
  }

  /** A fresh screen for a worker's terminal, and the title off it. */
  private newTerm(w: Worker): HeadlessTerminal {
    const term = new headless.Terminal({ cols: w.info.cols, rows: w.info.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    term.loadAddon(ser as any);
    // Unicode 11 widths, matching the browser terminals: powerline glyphs, emoji, CJK and
    // combining marks wrap and serialize at the right cells.
    term.loadAddon(new unicode11.Unicode11Addon() as any);
    term.unicode.activeVersion = '11';
    term.onTitleChange((title: string) => this.setTitle(w, title));
    w.term?.dispose();
    w.term = term;
    w.ser = ser;
    w.snapshot = screenSnapshot(term, ser);
    w.lastLines = [];
    w.screenDirty = true;
    w.fresh = undefined;
    return term;
  }

  private setTitle(w: Worker, title: string) {
    const clean = title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (clean && clean !== w.info.title && !/^droid$/i.test(clean)) {
      w.info.title = clean;
      this.emitUpdate(w);
    }
  }

  /** Shows a worker's terminal output as it comes, and deals with the process ending. */
  private follow(w: Worker, proc: Pty, term: HeadlessTerminal) {
    const { info } = w;
    w.pty = proc;
    proc.onData((data) => {
      term.write(data);
      w.outputAt = Date.now();
      w.screenDirty = true;
      w.unsaved = true;
      if (info.open) this.events.data(info.id, data, this.subscriberIds(info.id));
    });
    proc.onExit(({ exitCode, error, lost }) => {
      if (w.pty !== proc || this.workers.get(info.id) !== w) return;
      w.pty = undefined;
      if (error) {
        this.startFailed(w, error);
        return;
      }
      // The terminal host died and took the process with it: nothing the worker did.
      if (lost && !this.closing) {
        if (midTurn(w)) w.interrupted = true;
        this.resume(info.id);
        return;
      }
      info.exitCode = exitCode;
      info.status = 'exited';
      const hint = info.kind === 'shell' ? ' — press R to restart' : info.sessionId ? ' — press R to resume' : '';
      const msg = `\r\n\x1b[2m[${info.name} exited with code ${exitCode}${hint}]\x1b[0m\r\n`;
      term.write(msg);
      if (info.open) this.events.data(info.id, msg, this.subscriberIds(info.id));
      w.screenDirty = true;
      w.unsaved = true;
      this.emitUpdate(w);
      this.persist();
      void this.syncBranch(w);
    });
    // SessionStart fires as soon as Droid can take input. Still silent after a while means it is
    // blocked on a human: login, first-run onboarding, hook setup. Flag it so it jumps. A worktree
    // still being set up isn't Droid yet: the wait starts once that's done.
    const check = () => {
      if (info.status !== 'starting' || w.pty !== proc) return;
      const left = w.settingUp ? BOOT_BLOCKED_MS : (w.setupDoneAt ?? 0) + BOOT_BLOCKED_MS - Date.now();
      if (left > 0) return void setTimeout(check, Math.min(left, 3000)).unref();
      if (info.kind === 'agent') {
        w.bootBlocked = true;
        info.activity = 'Waiting on Droid setup or hooks — open the terminal';
        this.setStatus(w, 'needs_input');
      } else this.setStatus(w, 'idle');
    };
    setTimeout(check, BOOT_BLOCKED_MS).unref();
  }

  private startFailed(w: Worker, message: string) {
    const what = this.command(w.info);
    const msg = `\r\n\x1b[31mFailed to start ${what}: ${message}\x1b[0m\r\n`;
    w.info.status = 'exited';
    w.info.exitCode = -1;
    w.term?.write(msg);
    if (w.info.open) this.events.data(w.info.id, msg, this.subscriberIds(w.info.id));
    w.screenDirty = true;
    w.unsaved = true;
    this.events.toast(`Could not start ${what}: ${message}`, 'error');
    this.emitUpdate(w);
  }

  /** What a worker's terminal runs: the shell, or the configured Droid command. */
  private command(info: WorkerInfo): string {
    return info.kind === 'shell' ? defaultShell() : this.agentCmd;
  }

  /** Where a worker works: its worktree, a workspace for a worker across repositories, or the project itself. */
  private cwd(info: WorkerInfo): string {
    const rel = workspaceOf(info);
    return rel ? path.join(this.dir, rel) : this.dir;
  }

  private setStatus(w: Worker, status: WorkerStatus) {
    if (w.info.status === status) return;
    if (w.info.status === 'needs_input') w.leftNeedsInputAt = Date.now();
    w.info.status = status;
    if (status !== 'working') w.stopAt = undefined;
    if (status !== 'needs_input') w.asking = undefined;
    // Done, idle or asleep: it's not acting anything out any more.
    if (status !== 'working' && status !== 'needs_input') w.info.action = undefined;
    // Nobody is looking at the terminal right now -> raise the flag (the worker jumps).
    if (status === 'done' || status === 'needs_input') {
      w.info.acked = status === 'done' && w.info.open;
      w.info.waitingSince = Date.now();
    } else w.info.acked = true;
    this.emitUpdate(w);
    // What a restarted office picks the worker back up as, should its terminal outlive this one.
    if (w.pty?.id) this.persist();
    // At rest: it may have made a branch of its own this turn, and opened its PR from there.
    if (status === 'done' || status === 'idle') void this.syncBranch(w);
  }

  /** The connections subscribed to a worker's terminal, oldest first. */
  private subscriberIds(id: string): string[] {
    return [...(this.subscribers.get(id) ?? [])];
  }

  /** Syncs the public open flag with the subscriptions; says whether it changed. */
  private syncOpen(w: Worker): boolean {
    const open = (this.subscribers.get(w.info.id)?.size ?? 0) > 0;
    if (w.info.open === open) return false;
    w.info.open = open;
    return true;
  }

  private emitUpdate(w: Worker) {
    this.events.update({ ...w.info });
  }

  /** One worker's current visible rows, for revalidating a question without serializing all PTYs. */
  screenLines(id: string): string[] | undefined {
    const term = this.workers.get(id)?.term;
    const frame = term && snapshotScreen(term, []);
    return frame ? Array.from({ length: frame.rows }, (_, row) => (frame.lines[row] ?? []).map((r) => r[0]).join('')) : undefined;
  }

  /** Full screens for every running worker — sent to people as they walk in. */
  fullScreens() {
    const out: { workerId: string; frame: ScreenFrame }[] = [];
    for (const w of this.workers.values()) {
      if (!w.term) continue;
      const frame = snapshotScreen(w.term, []);
      if (frame) out.push({ workerId: w.info.id, frame });
    }
    return out;
  }

  private flushScreens() {
    const now = Date.now();
    for (const w of this.workers.values()) {
      if (!w.term) continue;
      // Diffs can be dropped for slow clients, so resend the whole screen now and then.
      if (now - w.keyframeAt > KEYFRAME_MS) {
        w.keyframeAt = now;
        w.lastLines = [];
        w.screenDirty = true;
      }
      if (!w.screenDirty) continue;
      w.screenDirty = false;
      const frame = snapshotScreen(w.term, w.lastLines);
      if (frame) this.events.screen(w.info.id, frame);
    }
  }

  private writeHookSettings() {
    // Minimal VPS images sometimes lack curl; the office's own node binary is always there.
    const nodeHook = path.join(this.dataDir, 'hook.cjs');
    writeFileSync(
      nodeHook,
      `const http = require('http');
const event = process.argv[2];
let body = '';
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  const url = new URL(process.env.DROID_OFFICE_HOOK_URL + '/hooks/droid');
  url.searchParams.set('worker', process.env.DROID_OFFICE_WORKER_ID);
  url.searchParams.set('event', event);
  const send = (tries) => {
    const req = http.request(url, { method: 'POST', timeout: 3000, headers: { authorization: 'Bearer ' + process.env.DROID_OFFICE_HOOK_TOKEN, 'content-type': 'application/json' } }, (res) => res.resume());
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' && tries > 1) setTimeout(() => send(tries - 1), 1000);
    });
    req.on('timeout', () => req.destroy());
    req.end(body);
  };
  send(${HOOK_TRIES});
});
`,
      { mode: 0o600 },
    );
    const commandFor = (event: string) => {
      const curl =
        `curl -sS -m 3 --retry ${HOOK_TRIES - 1} --retry-delay 1 --retry-connrefused -X POST -H "Authorization: Bearer $DROID_OFFICE_HOOK_TOKEN" -H "Content-Type: application/json" ` +
        `--data-binary @- "$DROID_OFFICE_HOOK_URL/hooks/droid?worker=$DROID_OFFICE_WORKER_ID&event=${event}"`;
      return (
        `if [ -z "$DROID_OFFICE_WORKER_ID" ] || [ -z "$DROID_OFFICE_HOOK_URL" ]; then exit 0; fi; ` +
        `if command -v curl >/dev/null 2>&1; then ${curl} >/dev/null 2>&1; ` +
        `else ${runAsNode().sh}${shq(process.execPath)} ${shq(nodeHook)} ${event} >/dev/null 2>&1; fi; true`
      );
    };
    const droidHooks: Record<string, unknown[]> = {};
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']) {
      droidHooks[event] = [{ hooks: [{ type: 'command', command: commandFor(event) }] }];
    }
    this.droidHooks = droidHooks;
    writeFileSync(this.droidSettingsPath, JSON.stringify({ hooks: droidHooks }, null, 2), { mode: 0o600 });
  }

  /**
   * The settings file a Droid worker launches with. Interactive droid has no --model flag: a
   * worker with a model or effort pinned gets its own overlay with the office hooks and a
   * sessionDefaultSettings override, merged for that process only, so the global default is
   * untouched. Rewritten on every launch, so a resume pins the same model again.
   */
  private droidSettings(info: WorkerInfo): string {
    if (info.model === undefined && info.effort === undefined) return this.droidSettingsPath;
    const file = path.join(this.dataDir, `droid-${info.id}.json`);
    const sessionDefaultSettings: Record<string, string> = {};
    if (info.model !== undefined) sessionDefaultSettings.model = info.model;
    if (info.effort !== undefined) sessionDefaultSettings.reasoningEffort = info.effort;
    writeFileSync(file, JSON.stringify({ hooks: this.droidHooks, sessionDefaultSettings }, null, 2), { mode: 0o600 });
    return file;
  }

  /**
   * Writes the worker.system prompt for `info` into the data dir and returns the file, or nothing when
   * the prompt is empty or can't be written (the worker then starts without it). Rewritten on every
   * launch, so a resume picks up the prompt as it is now.
   */
  private systemPromptFile(info: WorkerInfo): string | undefined {
    const file = path.join(this.dataDir, `system-${info.id}.md`);
    // A plain folder has no branches to keep in sync.
    const branchPolicy = this.plain ? '' : workerBranchPolicy(this.trees.baseBranch() ?? this.trees.currentBranch(), this.trees.branchFile);
    const template = this.prompts?.text('worker.system') ?? PROMPTS['worker.system'].text;
    // Only a worker with no lead may visit the others; a subagent isn't told office-visit exists.
    const visits = info.kind === 'agent' && !info.lead && this.visitsOn?.() ? WORKER_VISITS : '';
    let text = officePrompt(this.prompts, 'worker.system', { name: info.name, visits, branchPolicy });
    // A saved system prompt from before visits existed still tells the worker about them.
    if (text && visits && !template.includes('{{visits}}')) text += `\n\n${visits}`;
    // A saved system prompt may predate the floor selector. Keep it, but don't let its generic
    // default-branch instructions override an explicit owner choice.
    if (text && branchPolicy && this.trees.selectedBranch() && !template.includes('{{branchPolicy}}')) text += `\n\n${branchPolicy}`;
    if (text && info.forkedFrom)
      text += `\n\nYou are ${info.name}, an independent fork of ${info.forkedFrom.name}'s conversation. Your files are a private snapshot in your own worktree. The original may keep working. You are not the original worker or its subagent: use your own worker id and do not act on its terminal, worktree or team.`;
    try {
      if (!text) {
        rmSync(file, { force: true });
        return undefined;
      }
      writeFileSync(file, `${text}\n`, { mode: 0o600 });
      return file;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes one of the office's agent commands (office-workers, office-whiteboard) into `sub` of the data
   * dir, running bin/<name>.js with the office's own node, and returns that directory. Rewritten on
   * every start, so after an upgrade it runs the new install's script.
   */
  private writeOfficeCommand(sub: string, name: string, what: string): string | undefined {
    const script = officeScript(name);
    if (!script) return undefined;
    const dir = path.join(this.dataDir, sub);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    const node = runAsNode();
    writeFileSync(file, `#!/bin/sh\n# ${what} (see bin/${name}.js).\n${node.sh}exec ${shq(process.execPath)} ${shq(script)} "$@"\n`, { mode: 0o700 });
    chmodSync(file, 0o700);
    // cmd.exe and PowerShell find it by PATHEXT; Git Bash (Droid's shell there) runs the sh one.
    if (WIN) writeFileSync(`${file}.cmd`, `@${node.cmd}"${process.execPath}" "${script}" %*\r\n`);
    return dir;
  }

  private saveScrollback(w: Worker) {
    if (!w.term || !w.ser) return;
    w.unsaved = false;
    this.scrollback.save(w.info.id, terminalTail(w.term, w.ser, SCROLLBACK));
  }

  private persist(onShutdown = false) {
    // A stopped manager's pending namer/terminal callbacks must not overwrite its successor's state.
    if (this.closing && !onShutdown) return;
    const saved = [...this.workers.values()].map(({ info, hookToken, pty, bootBlocked, stopAt, interrupted, worktreeOwnership, launchPrompt, pendingFork }) => ({
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
      pr: info.pr,
      lead: info.lead,
      team: info.team,
      // A terminal still running in the host, to pick back up after a restart. Its hooks keep the token.
      hookToken,
      // Its first message, while its droid hasn't taken it yet: the next office types it in at SessionStart.
      pty: pty?.id ? { id: pty.id, status: info.status, acked: info.acked, waitingSince: info.waitingSince, launchPrompt } : undefined,
      // In the middle of something: if its terminal doesn't make it through a restart, it carries on after.
      midTurn: !this.stopping && (!!interrupted || midTurn({ info, bootBlocked, stopAt })),
    }));
    try {
      writeFileSync(this.statePath, JSON.stringify([...saved, ...this.retired], null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }

  private restore() {
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
        if (s.id && typeof s.deskId === 'string' && !DESK_BY_ID.has(s.deskId)) this.retired.push(s);
        if (!s.id || !s.deskId || !DESK_BY_ID.has(s.deskId) || this.deskOccupied(s.deskId)) continue;
        const shell = s.kind === 'shell';
        const info: WorkerInfo = {
          id: s.id,
          kind: shell ? 'shell' : 'agent',
          model: shell ? undefined : restoredModel(s.model),
          effort: shell ? undefined : isAgentEffort(s.effort) ? s.effort : undefined,
          deskId: s.deskId,
          name: s.name ?? 'Worker',
          color: s.color ?? COLORS[0],
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
          pr: s.pr && typeof s.pr.number === 'number' && typeof s.pr.url === 'string' ? { number: s.pr.number, url: s.pr.url } : undefined,
          cols: 100,
          rows: 30,
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
            launchPrompt: typeof launch?.text === 'string' && launch.text && typeof launch.at === 'number' ? { text: launch.text, at: launch.at } : undefined,
          };
        }
        // Mid-turn as the office went down: cut off, unless its terminal is picked back up still
        // running (adopt). An office from before midTurn only said so for a terminal in the host.
        w.interrupted = typeof s.midTurn === 'boolean' ? s.midTurn : s.pty?.status === 'working' || s.pty?.status === 'needs_input';
        if (info.prompt) w.prompts = [info.prompt.replace(/\s+/g, ' ').trim()];
        this.workers.set(info.id, w);
      }
      // A lead that didn't come back, or is a subagent itself, leads nobody.
      for (const w of this.workers.values()) {
        const lead = w.info.lead && this.workers.get(w.info.lead);
        if (w.info.lead && (!lead || lead.info.lead)) delete w.info.lead;
      }
      // Markings follow who leads whom now; an office from before them gives each team its own.
      const teams = settleTeams([...this.workers.values()].map((w) => w.info));
      for (const w of this.workers.values()) {
        const badge = teams.get(w.info.id);
        if (badge) w.info.team = badge;
        else delete w.info.team;
      }
    } catch {
      // corrupt state file: start fresh
    }
  }
}
// ---------------------------------------------------------------------------

/** In the middle of a turn: working, or asking something (not stuck on a trust or login screen). */
/** An agent at the issues, PR or Pipelines kiosk, which works through the forge whatever branch the checkout is on. */
function boardAgent(info: WorkerInfo): boolean {
  const station = DESK_BY_ID.get(info.deskId)?.station;
  return !!station && station !== 'lead';
}

/** Cut off if it stopped now. A turn that already sent its Stop has finished, even before its screen confirms it. */
function midTurn({ info, bootBlocked, stopAt }: Pick<Worker, 'info' | 'bootBlocked' | 'stopAt'>): boolean {
  return info.kind === 'agent' && stopAt === undefined && (info.status === 'working' || (info.status === 'needs_input' && !bootBlocked));
}

/** The rows a terminal shows now, its scrollback left out. */
function screenRows(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) rows.push(buf.getLine(y)?.translateToString(true) ?? '');
  return rows;
}

function newWorker(info: WorkerInfo, hookToken = randomBytes(16).toString('hex')): Worker {
  return {
    info,
    screenDirty: true,
    lastLines: [],
    leftNeedsInputAt: 0,
    keyframeAt: 0,
    hookToken,
    failStreak: 0,
    prompts: [],
    tools: [],
    toolsSinceNamed: 0,
    namedAt: 0,
    taskEpoch: 0,
    subSessions: new Set(),
    lastTool: new Map(),
    hookAt: 0,
    outputAt: 0,
  };
}

/** When a legacy `lastInput: {by, at}` record says input last landed, if it says so sanely. */
function legacyLastInputAt(lastInput: unknown): number | undefined {
  const at = (lastInput as { at?: unknown } | null)?.at;
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

function restoredModel(model: unknown): string | undefined {
  return isValidDroidModel(model) ? model : undefined;
}

/** The office's environment, minus anything that would make a child think it's a nested session. */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !scrubbed(k)) env[k] = v;
  return env;
}

function validTeam(t: unknown): TeamBadge | undefined {
  const v = t as Partial<TeamBadge> | undefined;
  if (!v || typeof v.id !== 'string' || !v.id || (v.role !== 'lead' && v.role !== 'member') || typeof v.leadName !== 'string') return undefined;
  if (typeof v.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(v.accent) || !TEAM_EMBLEMS.includes(v.emblem as TeamEmblem)) return undefined;
  return { id: v.id, role: v.role, accent: v.accent, emblem: v.emblem as TeamEmblem, leadName: v.leadName.slice(0, 80) };
}

function validTask(t: unknown): WorkerTask | undefined {
  const v = t as Partial<WorkerTask> | undefined;
  return typeof v?.name === 'string' && typeof v.summary === 'string' ? { name: v.name, summary: v.summary } : undefined;
}

/** bin/<name>.js in the install this office runs from (src/server under tsx, dist/server/server built). */
function officeScript(name: string): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
    const file = path.join(dir, 'bin', `${name}.js`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/**
 * What a script prefixes to `process.execPath` to run a .js file with it. Under the Mac app that's
 * the Electron binary, which only behaves as Node with ELECTRON_RUN_AS_NODE set, and workers don't
 * inherit that (SCRUB_ENV), so the commands written for them set it themselves.
 */
export function runAsNode(versions: NodeJS.ProcessVersions = process.versions): { sh: string; cmd: string } {
  return versions.electron ? { sh: 'ELECTRON_RUN_AS_NODE=1 ', cmd: 'set "ELECTRON_RUN_AS_NODE=1" & ' } : { sh: '', cmd: '' };
}

const WIN = process.platform === 'win32';

/** The shell workers get when none is configured: $SHELL on Unix, cmd.exe on Windows. */
export function defaultShell(): string {
  return process.env.SHELL || (WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash');
}

/**
 * The command line a new worktree's first terminal runs: the setup script (see worktree-setup.ts)
 * with the office's own node, then the agent (or the shell) in its place. `quoteFile` says `file` is
 * a path; otherwise it's a command for the shell to find. `cmd` writes it for cmd.exe.
 */
export function setupLine(o: { node: string; script: string; plan: string; file: string; quoteFile: boolean; args: string[]; cmd: boolean; asNode?: { sh: string; cmd: string } }): string {
  const node = o.asNode ?? runAsNode();
  const q = o.cmd ? cmdq : shq;
  const setup = `${q(o.node)} ${q(o.script)} ${q(o.plan)}`;
  const run = [o.quoteFile ? q(o.file) : o.file, ...o.args.map(q)].join(' ');
  return o.cmd ? `${node.cmd}${setup} & ${run}` : `${node.sh}${setup}; exec ${run}`;
}

/** What a worker whose worktree setup failed is told ahead of its first message, with the end of what the command printed. */
export function setupFailedNote(what: string, output = ''): string {
  const note = `Note from Droid Office: setting up your new worktree failed (${what}), so its dependencies may be missing. Run the setup again yourself if your task needs them.`;
  return output.trim() ? `${note} The end of its output:\n\n\`\`\`\n${output.trim()}\n\`\`\`` : note;
}

/** How to have the default shell run one command line. */
function shellRun(line: string): string[] {
  return WIN && !process.env.SHELL ? ['/d', '/s', '/c', line] : ['-l', '-i', '-c', line];
}

export function resolveCommand(cmd: string): string | null {
  // Windows runs files by extension: `droid` is really droid.exe / droid.cmd. An npm shim with
  // no extension is a sh script the console can't run, so only take it when asked for by name.
  const exts = WIN && !path.extname(cmd) ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const usable = (p: string): string | null => {
    for (const ext of exts) {
      try {
        accessSync(p + ext, constants.X_OK);
        return p + ext;
      } catch {
        // keep looking
      }
    }
    return null;
  };
  if (cmd.includes('/') || (WIN && cmd.includes('\\'))) {
    const found = usable(cmd);
    return found && path.resolve(found);
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const found = usable(path.join(dir, cmd));
    if (found) return found;
  }
  if (WIN && !process.env.SHELL) return null;
  try {
    const found = execFileSync(defaultShell(), ['-l', '-i', '-c', `command -v ${shq(cmd)}`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .pop();
    if (found?.startsWith('/')) return found;
  } catch {
    // fall through
  }
  return null;
}

/**
 * The office's Droid: `cmd` on PATH (or the login shell's), else where Droid's installer puts it,
 * ~/.local/bin/droid, which the Mac app's PATH lacks until the owner's shell profile adds it.
 */
export function resolveAgent(cmd: string): string | null {
  const found = resolveCommand(cmd);
  if (found || cmd !== 'droid' || WIN) return found;
  const installed = path.join(homedir(), '.local', 'bin', 'droid');
  try {
    accessSync(installed, constants.X_OK);
    return installed;
  } catch {
    return null;
  }
}

function describeTool(payload: any): string {
  const name = payload?.tool_name ?? 'tool';
  const input = payload?.tool_input ?? {};
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? '';
  return truncate(detail ? `${name}: ${detail}` : String(name), 80);
}

function offlineBanner(info: WorkerInfo): string {
  const hint = info.kind === 'shell' ? ' Press R to restart it.' : info.sessionId ? ' Press R to resume the session.' : '';
  return `\x1b[2m${info.name} is not running.${hint}\x1b[0m\r\n`;
}

/**
 * Sending every repository home. When each one deleted or kept the same branch, the sentence is the
 * one a single branch would get; otherwise each repository says what `sendHome` did.
 */
function reposHomeNote(name: string, branch: string, where: string, sent: { name: string; note?: string }[]): string {
  const notes = sent.map((t) => t.note);
  if (notes.every((n) => n === `worktree and branch ${branch}`)) return `Deleted ${name}'s worktrees and branch ${branch} in ${where}`;
  if (notes.every((n) => n === `worktree and kept branch ${branch}`)) return `Deleted ${name}'s worktrees in ${where} and kept branch ${branch}`;
  return `Deleted ${name}'s worktrees in ${where}: ${sent.map((t) => `${t.name} ${t.note}`).join('; ')}`;
}

/** Runs a command without blocking the office; rejects with the last lines of its stderr. */
function run(cmd: string, args: string[], cwd: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ') || `${cmd} failed`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * The folder each checkout gets in a workspace: its folder's name, made safe, with -2, -3… when two
 * checkouts share one (owner-a/api and owner-b/api).
 */
export function workspaceNames(dirs: string[]): string[] {
  const used = new Set<string>();
  return dirs.map((dir) => {
    let base =
      path
        .basename(path.resolve(dir))
        .replace(/[^\w.-]+/g, '-')
        .replace(/^[.-]+/, '') || 'project';
    if (WORKSPACE_FILES.has(base)) base = `${base}-repo`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Takes a workspace folder away once its worktrees are gone: only the brief the office wrote, never anything else left in it. */
function clearWorkspace(abs: string) {
  try {
    for (const name of readdirSync(abs)) if (WORKSPACE_FILES.has(name)) unlinkSync(path.join(abs, name));
    rmdirSync(abs);
  } catch {
    // already gone, or something else is in it: it stays
  }
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

/** owner/name of a checkout's origin, when it has one the office can name. */
function originRepo(dir: string): string | undefined {
  try {
    return normalizeRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim());
  } catch {
    return undefined;
  }
}

/** owner/name#12 for a pull request on GitHub (which links it with its title), else its URL. */
export function prRef(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : url;
}

/** The list of a change's pull requests across repositories, for the description of the one at `self`. */
export function relatedBlock(prs: { repo?: string; url: string }[], self: string, branch: string): string {
  const lines = prs.map((p) => `- ${p.repo ? `**${p.repo}**: ` : ''}${prRef(p.url)}${p.url === self ? ' (this one)' : ''}`);
  return [RELATED_START, `**One change across ${prs.length} repositories**, each on \`${branch}\`: review and merge them together.`, '', ...lines, RELATED_END].join('\n');
}

/** A description with its list of related pull requests put in, or brought up to date. */
export function withRelated(body: string, block: string): string {
  const at = body.indexOf(RELATED_START);
  const end = at < 0 ? -1 : body.indexOf(RELATED_END, at);
  if (end >= 0) return body.slice(0, at) + block + body.slice(end + RELATED_END.length);
  return body.trim() ? `${body.trimEnd()}\n\n${block}` : block;
}

/**
 * A pull request title and body from what the worker was asked to do. The title is the issue's
 * title when the task came off the issues board, else the task's first line; the body carries the
 * task, the commits, a "Closes #n" when the task asked for one, and which desk it came from. With
 * `other`, it's for one of the other repositories of a worker across repositories: the issue is its
 * own floor's (`home`), so this one only mentions it.
 */
function draftPr(info: WorkerInfo, commits: string[], by: string, other?: { home?: string }): { title: string; body: string } {
  const task = (info.prompt ?? '').replace(/\r\n?/g, '\n').trim();
  const firstLine =
    task
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  // The issues board hands work over as: Work on GitHub issue #12: "Title" (or GitLab issue).
  const issue = /\bissue #(\d+):\s*["“](.+?)["”]\.?\s*$/i.exec(firstLine);
  const title = truncate(issue?.[2] || firstLine.replace(/[.:;,]+$/, '') || commits[0]?.replace(/^\S+\s+/, '') || info.worktree?.branch || info.name, PR_TITLE_MAX);
  const closes = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^\n]{0,40}?#(\d+)/i.exec(task)?.[1] ?? issue?.[1];
  const parts: string[] = [];
  if (task) parts.push(`## Task\n\n${task.length > PR_TASK_MAX ? `${task.slice(0, PR_TASK_MAX)}…` : task}`);
  parts.push(`## Commits\n\n${commits.map((c) => `- \`${c.slice(0, c.indexOf(' '))}\` ${c.slice(c.indexOf(' ') + 1)}`).join('\n')}`);
  if (closes && !other) parts.push(`Closes #${closes}`);
  else if (closes && other?.home) parts.push(`Part of ${other.home}#${closes}`);
  parts.push(`_Opened from Droid Office by ${by} · ${info.name} at ${DESK_BY_ID.get(info.deskId)?.label ?? info.deskId}_`);
  return { title, body: parts.join('\n\n') };
}

function truncate(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One argument for cmd.exe. */
function cmdq(s: string) {
  return `"${s.replace(/"/g, '""')}"`;
}

function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** How long a worker has spent working (ms), the stretch it's in now included. */
export function workedMs(info: WorkerInfo, now = Date.now()): number | undefined {
  const ms = (info.workedMs ?? 0) + (info.workingSince === undefined ? 0 : Math.max(0, now - info.workingSince));
  return ms > 0 ? ms : undefined;
}

/** What starting a worker whose worktree was deleted (see WorkerInfo.lost) says instead. */
function lostMessage(info: WorkerInfo): string {
  return `${info.name}'s worktree ${workspaceOf(info)} was deleted outside droid-office — rebuild it or send ${info.name} home from its desk`;
}

/** Keeps count of how long a worker has worked (WorkerInfo.workedMs) as it goes from its status into `next`. */
export function clockWork(info: WorkerInfo, next: WorkerStatus, now = Date.now()) {
  if (next === 'working') {
    info.workingSince ??= now;
    return;
  }
  if (info.workingSince === undefined) return;
  info.workedMs = workedMs(info, now);
  info.workingSince = undefined;
}
