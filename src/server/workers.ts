import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import type { AgentChoice, AgentEffort, GhPull, TeamBadge, TerminalHit, WorkerAsk, WorkerInfo, WorkerKind, WorkerRepo, WorkerStatus, WorkerTask } from '../shared/protocol.js';
import type { ToolRefresh } from './hook-refresh.js';
import { leadBadge, memberBadge } from '../shared/team.js';
import { OFFICE_SHELL_ID } from '../shared/office-shell.js';
import { withImages } from '../shared/drops.js';
import { readDroidQueue } from '../shared/droid-queue.js';
import { detectBlockingTool, type BlockingToolState, type WorkerQueueState } from './worker-queue.js';
import { countCtrlEnterInputs, isCancelInput, isClearQueueInput } from '../shared/kitty.js';
import { WORKSPACE_FILES, WORKTREES_DIR, Worktrees, describeWork, workspaceOf, type WorktreeCleanup, type WorktreeRef, type WorktreeStart, type WorktreeState } from './worktrees.js';
import { checkoutDirty, choosePullBase, pushBranch } from './open-pull.js';
import { normalizeRepo } from '../shared/floors.js';
import { DESK_BY_ID, nextFreeSeat, type DeskDef } from '../shared/layout.js';
import { officePrompt, type PromptSource } from './prompts.js';
import { forgeVars, placeholders, PROMPTS, withoutReminders, workerMessageVars } from '../shared/prompts.js';
import { isBusy } from '../shared/status.js';
import { linearTaskOf } from '../shared/linear.js';
import { fallbackTask } from './tasks.js';
import { todosFinished } from '../shared/todos.js';
import type { WorkerRuntimeSnapshot } from './worker-status.js';
import { forkRefusal, nearestForkSeat } from '../shared/worker-fork.js';
import { githubPulls } from './github.js';
import type { PullHost, PullRef } from './forge.js';
import { forgeWords, type Forge } from '../shared/floors.js';
import { PtyHost, SCROLLBACK, type Adopted, type Pty } from './ptys.js';
import { DroidSessionReader } from './droid-session.js';
import { validateWorkerEffort, validateWorkerModel } from './agents.js';
import { ScrollbackStore, plainTail, searchTerminal, terminalTail } from './history.js';
import { DropStore, type SharedDropImages } from './drops.js';
import { screenSnapshot, setTerminalResponder } from './screen.js';
import { snapshotScreen, type ScreenFrame } from './screen-frame.js';
import { readScreenMenu } from '../shared/asks.js';
import { SCREEN_SETTLE_MS, readDroidScreen, screenStatus, type DroidScreen } from './droid-screen.js';
import type { Capacity } from './machine.js';
import { setupStep, writePlan, writeSetupScript, type SetupStep } from './worktree-setup.js';
import type { BuildingAgents } from './building-agent.js';
import { pickUniqueForkName, pickUniqueSeat, pickUniqueWorkerName, readHeadBranch } from './floor-watch.js';

import { newWorker, midTurn, screenRows, type Worker } from './worker-runtime/state.js';
import { WorkerDelivery } from './worker-runtime/delivery.js';
import { WorkerHooks, STOP_GRACE_MS } from './worker-runtime/hooks.js';
import { WorkerHookSpool, HOOK_VERSION, SPOOL_MAX_BYTES, SPOOL_RECHECK_MS, safeEq } from './worker-runtime/hook-transport.js';
import { WorkerLaunchSettings } from './worker-runtime/launch-settings.js';
import { childEnv, runAsNode, defaultShell, setupLine, setupFailedNote, resolveCommand, resolveAgent, WIN, shellRun, shq } from './worker-runtime/process.js';
import { WorkerStateStore } from './worker-runtime/persistence.js';
import { truncate } from './worker-runtime/activity.js';

export { STOP_GRACE_MS, HOOK_VERSION, SPOOL_MAX_BYTES, childEnv, runAsNode, defaultShell, setupLine, setupFailedNote, resolveCommand, resolveAgent };

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;
type Worktree = NonNullable<WorkerInfo['worktree']>;

/** Widescreen default PTY dimensions matching the 3D laptop's 106:63 display at 0.6:1.25 cell aspect. */
export const DEFAULT_COLS = 136;
export const DEFAULT_ROWS = 39;

/** Workers' names, and their colors. */
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

const SCREEN_INTERVAL_MS = 250;
/** How a refusal on a plain folder's floor starts (see Floor.plain). */
const PLAIN_FLOOR = 'This floor is a plain folder, not a git checkout';
const KEYFRAME_MS = 8000;
/** How often a steady typist's "last typed" time is refreshed for everyone. */
const TYPED_REFRESH_MS = 15_000;
const PR_TITLE_MAX = 72;
const PR_TASK_MAX = 2500;
/** The most other repositories one worker can take on (see WorkerInfo.repos). */
export const MAX_REPOS = 8;
/** Around the list of a change's pull requests in each of their descriptions, so it can be brought up to date. */
const RELATED_START = '<!-- agent-office:related -->';
const RELATED_END = '<!-- /agent-office:related -->';
/** How often every worker's folder is checked for having been deleted. */
const WATCH_MS = 10_000;
/** How often each agent's screen is checked against its status (see reconcile). */
const SCREEN_CHECK_MS = 1000;
/**
 * How long a launch prompt waits for SessionStart before the input box on its screen is enough to
 * type it in: well past a normal start, so it only matters when the hooks can't reach the office.
 */
const LAUNCH_PROMPT_FALLBACK_MS = 15_000;
/** How long a new terminal waits for SessionStart (after its worktree setup, if any) before it looks stuck on a login. */
const BOOT_BLOCKED_MS = 12_000;
/** A worker's activity while its terminal looks stuck before SessionStart, with no menu on its screen to answer. */
const BOOT_BLOCKED = 'Waiting on Droid setup or hooks — open the terminal';
/** The most of a failed worktree setup's output its worker is told. */
const SETUP_OUTPUT_MAX = 3000;
/** How often a terminal with new output is saved to disk, so even a crash loses at most this much. */
const SAVE_SCROLLBACK_MS = 15_000;
/** Between a worker's saved scrollback and what it prints after the office restarted. */
const RESTORED_NOTE = '\x1b[2m──── the office restarted · earlier output above ────\x1b[0m\r\n';
/**
 * What a worker whose terminal didn't make it through a restart (the machine rebooted, the terminal
 * host was replaced or died) is resumed with when it was in the middle of something, so it carries on
 * by itself instead of waiting at every desk for someone to type "continue".
 */
export const CARRY_ON_PROMPT = 'Droid Office notice: restart recovery\nYour turn was interrupted by an office restart. Continue your existing task. If waiting on an answer or permission, ask again.';

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

export interface WorkerEvents {
  update(info: WorkerInfo): void;
  remove(workerId: string, shot?: boolean): void;
  data(workerId: string, data: string, connectionIds: string[]): void;
  screen(workerId: string, frame: ScreenFrame): unknown;
  /** `workerId` names the worker it is about, when one is (a shot worker's dismissal). */
  toast(text: string, level: 'info' | 'warn' | 'error', workerId?: string): void;
  /** The office moved the project's checkout onto `branch` (see Worktrees.freshen). */
  checkout?(branch: string): void;
  /** A worker's tool call finished that may have changed what the office shows (see hook-refresh.ts). */
  tool?(workerId: string, refresh: ToolRefresh): void;
}

export class WorkerManager {
  private workers = new Map<string, Worker>();
  /** Which connections have each worker's terminal open (workerId -> connection IDs). */
  private subscribers = new Map<string, Set<string>>();
  private state: WorkerStateStore;
  private trees: Worktrees;
  /** The checkout's branch when the office opened this floor (see the constructor). */
  private configuredBase?: string;
  private droidSessions = new DroidSessionReader();
  private agentPath: string | null = null;

  /** Desks and names taken by other workers (cloud workers on this floor, or live workers on other floors). */
  holds?: {
    desk(deskId: string): boolean;
    names(): Iterable<string>;
    liveDeskElsewhere?(deskId: string): { worker: WorkerInfo; floorName: string } | undefined;
    liveNamesElsewhere?(): Iterable<string>;
    allNamesElsewhere?(): Iterable<string>;
  };
  /**
   * ⚙️ Settings → Workers: a fresh worker starts from the latest of the default branch, its worktree
   * cut from origin's and the checkout brought there for one without (see freshen). Off, or unset:
   * from the branch the checkout is on, which is left alone.
   */
  freshMain?: () => boolean;
  /** ⚙️ Settings → Subagents & visits → Visits: a worker with no lead is told about the visit tools when it starts. */
  visitsOn?: () => boolean;
  /** The floor's pull requests as the board last listed them, to tell a checkout whose branch merged (see settleCheckout). */
  pullList?: () => GhPull[];
  /** Subscriptions: why an agent on this model can't start now (out of quota, say); undefined when it can (docs/subscriptions.md). */
  modelGate?: (model: string | undefined) => string | undefined;
  /** ⚙️ Settings → Subagents & visits: Droid's built-in Task tool is refused (see hookEntries). Unset: refused. */
  denyTask?: () => boolean;
  /**
   * What the office tells a worker whose turn is about to end instead of letting it stop, once: its
   * team's news, or a subagent's reminder to report (see Team.beforeStop). Only asked when its Stop can be blocked.
   */
  beforeStop?: (info: WorkerInfo) => string | undefined;
  /** Current sibling metadata for a fresh subagent brief, separate from its literal task. */
  subagentContext?: (info: WorkerInfo) => string | undefined;
  /** A turn ended and the message queued behind it starts the next one, with no rest between (see stopped). */
  nextTurn?: (info: WorkerInfo) => void;
  /** The system prompt its agents start with, in place of worker.system (the Orchestrator's brief). */
  systemPrompt?: (info: WorkerInfo) => string | undefined;
  /** Tools its agents' droid calls without Droid's permission prompt, by a PreToolUse matcher, and why. */
  allowTools?: { matcher: string; reason: string };
  /** A worker that stays asleep when the floor wakes everyone (the Orchestrator while it is off). */
  asleep?: (info: WorkerInfo) => boolean;
  private settling = false;
  private spoolTimer?: NodeJS.Timeout;

  private get forge(): Forge {
    return this.pulls.forge ?? 'github';
  }
  /** The script a new worktree's terminal runs before its agent (see worktree-setup.ts). */
  private setupScript: string | undefined;
  private screenTimer: NodeJS.Timeout;
  /** The office is shutting down: workers exiting now are being stopped, not failing to resume. */
  private closing = false;
  /** Closing for good (Ctrl+C), not restarting: whatever the workers were doing is stopped on purpose. */
  private stopping = false;
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
  private delivery: WorkerDelivery;
  private hooks: WorkerHooks;
  private spool: WorkerHookSpool;
  private settings: WorkerLaunchSettings;

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
    /** The building's agents (docs/mission-control.md), who lead subagents here from no desk: `floor` is this one. */
    private building?: { agents: BuildingAgents; floor: string },
    /** Workers here have no desk: the Orchestrator's own session (see orchestrator.ts). */
    deskless = false,
  ) {
    this.trees = new Worktrees(dir, plain);
    if (!plain) this.trees.ensureBranchFile();
    // The branch the checkout was on when this floor opened: a pull request's configured base. The
    // live branch is tried after it (see open-pull.ts). Freshening the checkout does not move this.
    this.configuredBase = this.trees.currentBranch();
    this.state = new WorkerStateStore(dataDir, {
      deskless,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      color: COLORS[0],
      buildingKnown: (id) => !!this.building?.agents.known(id),
      heldDesk: (id) => !!this.holds?.desk(id),
    });
    this.settings = new WorkerLaunchSettings(dataDir, {
      denyTask: () => this.denyTask?.() ?? true,
      allowTools: () => this.allowTools,
      systemPrompt: () => this.systemPrompt,
      visitsOn: () => this.visitsOn?.() ?? false,
      plain,
      trees: this.trees,
      prompts,
    });
    // The task queue's command, from before the queue was taken out.
    rmSync(path.join(dataDir, 'bin', 'office-queue'), { force: true });
    rmSync(path.join(dataDir, 'bin', 'office-queue.cmd'), { force: true });
    // The office-workers, office-whiteboard and office-visit commands, from before the Office MCP.
    rmSync(path.join(dataDir, 'bin', 'team'), { recursive: true, force: true });
    try {
      this.setupScript = writeSetupScript(dataDir);
    } catch {
      // without it, new worktrees just aren't set up
    }
    this.agentPath = resolveAgent(agentCmd);
    this.host = new PtyHost(dataDir, () => this.events.toast("The workers' terminal host stopped — resuming them", 'warn'));
    this.scrollback = new ScrollbackStore(dataDir);
    this.drops = new DropStore(dataDir);
    this.delivery = new WorkerDelivery({
      get: (id) => this.workers.get(id),
      closing: () => this.closing,
      persist: () => this.persist(),
      update: (w) => this.emitUpdate(w),
      notePrompt: (w, text) => this.notePrompt(w, text),
      resume: (id, text) => this.resume(id, text),
      drops: this.drops,
    });
    this.hooks = new WorkerHooks({
      get: (id) => this.workers.get(id),
      closing: () => this.closing,
      persist: () => this.persist(),
      update: (w) => this.emitUpdate(w),
      setStatus: (w, status) => this.setStatus(w, status),
      setup: (w, report) => this.setupHook(w, report),
      refreshModel: (w) => this.refreshDroidModel(w),
      syncBranch: (w) => this.syncBranch(w),
      tool: (id, refresh) => this.events.tool?.(id, refresh),
      notePrompt: (w, text) => this.notePrompt(w, text),
      beforeStop: (info) => this.beforeStop?.(info),
      nextTurn: (info) => this.nextTurn?.(info),
      delivery: this.delivery,
    });
    this.spool = new WorkerHookSpool(dataDir, {
      get: (id) => this.workers.get(id),
      workers: () => this.workers.values(),
      accept: (w, event, payload, from) => this.hooks.accept(w, event, payload, from),
    });
    this.state.restore(this.workers);
    this.scrollback.prune(new Set(this.workers.keys()));
    this.spool.prune();
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
    if (this.closing) return;
    await this.host.connect();
    if (this.closing) return;
    await Promise.all(
      [...this.workers.values()].map(async (w) => {
        if (w.info.remote) return;
        const saved = w.saved;
        w.saved = undefined;
        const adopted = saved && (await this.host.attach(saved.ptyId));
        if (adopted) {
          if (this.workers.get(w.info.id) !== w || this.closing) adopted.pty.kill();
          else {
            this.adopt(w, adopted, saved);
            // Its droid kept running while the office was down: what it said meanwhile, before any live hook.
            this.spool.replay(w);
            // Notices from the last office: typed in if it's at rest by now, else handed over by its hooks.
            this.delivery.flushOutbox(w);
          }
        }
        // A process that didn't make it: its spooled hooks are about a turn that's over.
        else rmSync(this.spool.file(w.info.id), { force: true });
      }),
    );
    // A hook that failed while this office was coming up (before its worker was picked back up) spooled meanwhile.
    this.spoolTimer = setTimeout(() => this.replaySpools(), SPOOL_RECHECK_MS);
    this.spoolTimer.unref();
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
    const boss = this.get(lead) ?? this.buildingIdentity(lead);
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

  /** Droid was installed after the floor opened (Setup): new workers run it from `file`. */
  setAgentPath(file: string) {
    this.agentPath = file;
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

  /** A building agent (the Orchestrator or an external bot): it leads subagents here from Mission Control, at no desk of this floor. */
  buildingIdentity(id: string): WorkerInfo | undefined {
    return this.workers.has(id) ? undefined : this.building?.agents.identity(id);
  }

  /** `id` is a building agent, leading now or not (the Orchestrator while it is off): what it left here stays its own. */
  buildingAgent(id: string): boolean {
    return !this.workers.has(id) && !!this.building?.agents.known(id);
  }

  /** `id` leads nobody here any more: its subagents carry on as independent workers. */
  releaseLead(id: string) {
    let changed = false;
    for (const w of this.workers.values()) {
      if (w.info.lead !== id) continue;
      delete w.info.lead;
      changed = true;
      this.emitUpdate(w);
    }
    if (changed) this.persist();
  }

  /** The folder an agent's droid runs in, where its project skills and commands come from. */
  agentFolder(id: string): string | undefined {
    const info = this.workers.get(id)?.info;
    return info?.kind === 'agent' && !info.cloud && !info.remote ? this.cwd(info) : undefined;
  }

  /**
   * Read-only conversation identity. Never accepts a caller-supplied path or session: the file is the
   * one the worker's own hooks named for its session, when they have.
   */
  threadSession(id: string): { sessionId: string; cwd: string; drops?: string; transcript?: string } | undefined {
    const w = this.workers.get(id);
    const info = w?.info;
    if (!w || info?.kind !== 'agent' || info.cloud || !info.sessionId) return undefined;
    return { sessionId: info.sessionId, cwd: this.cwd(info), drops: this.drops.folder(id), ...(w.transcript ? { transcript: w.transcript } : {}) };
  }

  /** Whether the worker is in a turn, so its newest Thread activity can still be working. */
  threadBusy(id: string): boolean {
    const status = this.workers.get(id)?.info.status;
    return !!status && isBusy(status);
  }

  /** The global sign writer never accepts an external path, nor writes after this manager closes. */
  labelSession(id: string): { sessionId: string; cwd: string; transcript?: string; epoch: number; since?: number } | undefined {
    if (this.closing) return;
    const w = this.workers.get(id);
    const session = this.threadSession(id);
    if (w && session) return { ...session, epoch: w.taskEpoch, since: w.info.taskSince };
  }

  localDeskOccupied(deskId: string): boolean {
    return this.ownDesk(deskId) || !!this.holds?.desk(deskId);
  }

  deskOccupied(deskId: string): boolean {
    return this.localDeskOccupied(deskId) || !!this.holds?.liveDeskElsewhere?.(deskId);
  }

  /** The seat `choose` picks for an automatic hire, avoiding desks live workers hold on other floors while another is free. */
  pickSeat(choose: (taken: (id: string) => boolean) => DeskDef | undefined): DeskDef | undefined {
    return pickUniqueSeat(choose, (id) => this.localDeskOccupied(id), this.holds?.liveDeskElsewhere ? (id) => !!this.holds?.liveDeskElsewhere?.(id) : undefined);
  }

  /** Whether one of the office's own workers sits there. */
  ownDesk(deskId: string): boolean {
    for (const w of this.workers.values()) if (w.info.deskId === deskId) return true;
    return false;
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
    branch?: string,
  ): WorkerInfo | string {
    if (this.selectingBranch) return 'Wait for the floor branch switch to finish before hiring';
    // Nobody picked a model: the office's default worker, model and effort included.
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
    // Only this floor's occupants count: a seat the office picks avoids other floors' live workers
    // before it gets here (pickSeat), while a seat someone names is theirs whatever other floors hold.
    if (this.localDeskOccupied(deskId)) return `That ${seat.beanbag ? 'bean bag' : 'desk'} is taken`;
    if (this.plain && worktree) return `${PLAIN_FLOOR}, so workers can't have worktrees`;
    if (repos.length && (kind !== 'agent' || !worktree)) return 'Only a worker in its own worktree can work in other repositories too';
    if (repos.length > MAX_REPOS) return `A worker can take on at most ${MAX_REPOS} other repositories`;
    const fresh = !this.plain && this.freshBase();
    let start: WorktreeStart = fresh ? 'main' : 'checkout';
    if (from !== undefined && (lead === undefined || !worktree)) return 'Only a subagent in its own worktree starts from a branch its lead picks';
    if (branch !== undefined && (lead === undefined || !worktree || repos.length)) return 'A named branch requires a subagent with one fresh worktree';
    if (lead !== undefined) {
      const boss = this.get(lead) ?? this.buildingIdentity(lead);
      if (!boss) return 'Its lead has left';
      if (boss.lead) return "A subagent can't hire subagents of its own";
      if (kind !== 'agent') return 'A subagent is an agent at a desk or a bean bag';
      if (worktree) {
        const at = this.leadStart(boss, from);
        if (typeof at === 'string') return at;
        start = at;
      }
    }
    const full = this.capacity?.full();
    if (full) return full;
    const sameFloorNames = [...this.workers.values()].map((w) => w.info.name).concat([...(this.holds?.names() ?? [])]);
    const name = pickUniqueWorkerName(NAMES, sameFloorNames, this.holds?.liveNamesElsewhere?.() ?? [], this.holds?.allNamesElsewhere?.() ?? []);
    const id = randomBytes(6).toString('hex');
    let wt: WorkerInfo['worktree'];
    let others: WorkerRepo[] | undefined;
    if (!worktree && fresh && kind === 'agent' && lead === undefined) this.freshenCheckout(name);
    if (worktree) {
      const slug = `${name.toLowerCase()}-${id.slice(0, 4)}`;
      const made = repos.length ? this.makeWorkspace(slug, repos, start) : this.trees.create(slug, undefined, this.dir, start, branch);
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
      color: kind === 'shell' ? '#8d99ae' : COLORS[Math.floor(Math.random() * COLORS.length)],
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt: kind === 'shell' ? undefined : shown,
      worktree: wt,
      repos: others,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      open: false,
      activity: shown && kind !== 'shell' ? truncate(shown, 80) : prompt ? truncate(prompt, 80) : undefined,
      ...(lead !== undefined ? { lead } : {}),
      ...(team ? { team: memberBadge(team) } : {}),
    };
    const w = newWorker(info);
    this.notePrompt(w, shown ?? '');
    if (info.worktree) w.worktreeOwnership = Object.fromEntries(this.treesOf(info).map((t) => [t.dir, t.trees.ownership(t.ref.branch)]));
    if (wt) w.setupPlan = this.planSetup(id, wt, others);
    this.workers.set(id, w);
    this.launch(w, this.briefed(w, kind === 'shell' ? undefined : text || undefined), undefined);
    this.persist();
    return info;
  }

  /** A peer with a separate conversation and, on git floors, a private repository snapshot, between turns only. */
  async fork(id: string, by: string, prompt?: string): Promise<WorkerInfo | string> {
    if (this.closing || this.selectingBranch) return 'Wait for the office to finish restarting or switching branches';
    const source = this.workers.get(id);
    if (!source) return 'No such worker';
    const modelError = this.modelGate?.(source.info.activeModel ?? source.info.model);
    if (modelError) return modelError;
    const why = forkRefusal(source.info);
    if (why) return why;
    const screen = source.term && readDroidScreen(screenRows(source.term));
    if (screen === 'busy' || screen === 'asking') return 'Wait until its turn ends before forking';
    if (source.launchPrompt || source.settingUp) return 'Wait for its first prompt and worktree setup to finish';
    const full = this.capacity?.full();
    if (full) return full;
    const sourceDesk = DESK_BY_ID.get(source.info.deskId);
    if (!sourceDesk) return 'The source desk is no longer on this floor';
    const seat = this.pickSeat((desk) => nearestForkSeat(sourceDesk, desk));
    if (!seat) return 'Every desk and bean bag on this floor is taken';
    const sameFloorNames = [...this.workers.values()].map((w) => w.info.name).concat([...(this.holds?.names() ?? [])]);
    const name = pickUniqueForkName(source.info.name, sameFloorNames, this.holds?.liveNamesElsewhere?.() ?? [], this.holds?.allNamesElsewhere?.() ?? []);
    const twinId = randomBytes(6).toString('hex');
    const slug = `fork-${twinId}`;
    const many = !!source.info.repos?.length;
    const originals = this.plain ? [] : source.info.worktree ? this.treesOf(source.info) : [{ name: path.basename(this.dir), dir: this.dir, trees: this.trees, ref: undefined }];
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
    if (primary) {
      w.worktreeOwnership = Object.fromEntries(this.treesOf(info).map((t) => [t.dir, t.trees.ownership(t.ref.branch)]));
      w.setupPlan = this.planSetup(twinId, primary, info.repos, source.info);
    }
    this.workers.set(twinId, w);
    // Persist the fork intent before starting a process, so a restart cannot attach to the parent's session.
    this.persist();
    this.launch(w, text, undefined);
    return info;
  }

  /** The team `leadId` leads, which it starts wearing the markings of with its first hire. */
  private formTeam(leadId: string): TeamBadge | undefined {
    const lead = this.workers.get(leadId);
    if (!lead) {
      const agent = this.buildingIdentity(leadId);
      if (!agent) return undefined;
      // A building agent sits on no floor: its team here wears what its subagents here already wear, else a look new to this floor.
      const worn = [...this.workers.values()].find((w) => w.info.lead === leadId && w.info.team?.id === leadId)?.info.team;
      return worn ? { ...worn, role: 'lead' } : leadBadge(agent, this.list());
    }
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
   * Worktrees.freshen with who's in the checkout sorted out: workers mid-turn block it;
   * workers at rest only block leaving a branch they may come back to, which they don't once its
   * work has landed (`delivered`).
   */
  private freshenWith(delivered: boolean, target?: string) {
    const there = [...this.workers.values()].filter((w) => w.pty && !w.info.worktree);
    const active = there.filter((w) => isBusy(w.info.status)).map((w) => w.info.name);
    const resting = delivered ? [] : there.filter((w) => !isBusy(w.info.status)).map((w) => w.info.name);
    return this.trees.freshen(active, resting, target);
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
   * A first prompt with what the agent is told ahead of it, for a session starting from nothing: a
   * subagent who hired it and how to report back. What shows on
   * its card is the prompt alone.
   */
  private briefed(w: Worker, prompt: string | undefined): string | undefined {
    if (!prompt) return prompt;
    const lead = w.info.lead ? (this.get(w.info.lead) ?? this.buildingIdentity(w.info.lead)) : undefined;
    if (!lead) return prompt;
    const wt = w.info.worktree;
    const where = wt
      ? `You work in your own git worktree, ${path.join(this.dir, wt.path)}, on the branch ${wt.branch} made for this task from ${wt.from ?? wt.base.slice(0, 7)}: commit your work there.`
      : this.plain
        ? "You work in the floor's folder, which isn't a git checkout and which other people and workers use too: don't undo or overwrite anyone else's files."
        : "You work in the project's main checkout, which other people and workers use too: don't switch branches, stash, reset or commit in it unless your task says to.";
    const template = this.prompts?.text('subagent.brief') ?? PROMPTS['subagent.brief'].text;
    const brief = officePrompt(this.prompts, 'subagent.brief', { name: w.info.name, lead: lead.name, where, ...forgeVars(this.forge), ...workerMessageVars(prompt) });
    const taskBrief = placeholders(template).includes('text') ? brief : `${brief}\n\n${prompt}`;
    const context = this.subagentContext?.(w.info);
    return context ? `${taskBrief}\n\n${context}` : taskBrief;
  }

  /** The end of a worker's terminal as plain text, its scrollback included: what a lead reads of its subagent. */
  tail(id: string, lines: number): string | undefined {
    const info = this.workers.get(id)?.info;
    if (info?.remote) return `${info.name} is an external worker. No local terminal is available.\nStatus: ${info.status}\n${info.activity ?? ''}`;
    const term = this.workers.get(id)?.term;
    return term ? plainTail(term, lines) : undefined;
  }

  /** Keep a PR opened through Office MCP on the worker card and across restarts. */
  recordPull(id: string, pr: PullRef) {
    const w = this.workers.get(id);
    if (!w || this.closing) return;
    w.info.pr = pr;
    this.emitUpdate(w);
    this.persist();
  }

  /** The card over a worker's head, until its own sign writer has something better (a subagent's title from its lead). */
  setTask(id: string, task: WorkerTask) {
    const w = this.workers.get(id);
    if (!w || this.closing) return;
    w.info.task = {
      name: task.name.trim().slice(0, 60),
      summary: task.summary.trim().slice(0, 140),
      ...(task.generated
        ? {
            generated: true,
            ...(typeof task.textHash === 'string' && /^[a-f0-9]{64}$/.test(task.textHash) ? { textHash: task.textHash } : {}),
            ...(typeof task.updatedAt === 'number' && Number.isFinite(task.updatedAt) && task.updatedAt > 0 ? { updatedAt: task.updatedAt } : {}),
          }
        : {}),
    };
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

  /**
   * Starts a worker that isn't running again, carrying on its session, with `prompt` as its next
   * message and any staged pictures listed after it.
   */
  resume(id: string, prompt?: string, images?: readonly string[]): string | undefined {
    if (this.buildingIdentity(id)) return prompt ? this.prompt(id, prompt) : 'A building agent is not started from a floor';
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (w.pty) return 'Worker is already running';
    const modelError = w.info.kind === 'agent' ? this.modelGate?.(w.info.activeModel ?? w.info.model) : undefined;
    if (modelError) return modelError;
    if (this.checkLost(w, true)) return lostMessage(w.info);
    clockWork(w.info, 'starting');
    w.info.status = 'starting';
    w.info.exitCode = undefined;
    const text = images?.length ? withImages(prompt ?? '', this.drops.adopt(id, images)) : prompt;
    // A subagent with no session to carry on starts over, so it needs telling what it's for again.
    const first = w.info.sessionId ? text : this.briefed(w, text);
    const shown = (prompt && withoutReminders(prompt)) || (text ? 'See the attached images' : undefined);
    if (shown) {
      w.info.activity = truncate(shown, 80);
      this.notePrompt(w, shown);
    }
    // Cut off mid-turn by a restart: it gets on with it, as whoever was watching would have told it to.
    const carryOn = !text && w.interrupted && w.info.kind === 'agent' && !!w.info.sessionId;
    w.interrupted = false;
    this.launch(w, carryOn ? CARRY_ON_PROMPT : first, w.info.sessionId);
    return undefined;
  }

  /**
   * Starts an agent that has no desk, under a fixed id (the Orchestrator, in its own manager). Its first
   * prompt is typed in once its droid is ready.
   */
  spawnDeskless(id: string, name: string, color: string, by: string, prompt: string, model?: string, effort?: AgentEffort, images?: readonly string[]): WorkerInfo | string {
    if (this.closing) return 'The office is closing';
    if (this.workers.has(id)) return 'Already started';
    const modelError = validateWorkerModel('agent', model) ?? validateWorkerEffort('agent', effort) ?? this.modelGate?.(model);
    if (modelError) return modelError;
    const typed = prompt.replace(/\r\n?/g, '\n').trim();
    const text = images?.length ? withImages(typed, this.drops.adopt(id, images)) : typed;
    if (!text) return 'Empty prompt';
    const shown = withoutReminders(typed) || 'See the attached images';
    const info: WorkerInfo = {
      id,
      kind: 'agent',
      model,
      effort,
      deskId: '',
      name,
      color,
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt: shown,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      open: false,
      activity: truncate(shown, 80),
    };
    const w = newWorker(info);
    this.notePrompt(w, shown);
    this.workers.set(id, w);
    this.launch(w, text, undefined);
    this.persist();
    return info;
  }

  /** Stops a worker's process and keeps it, conversation and all, to resume later. */
  halt(id: string): boolean {
    const w = this.workers.get(id);
    const proc = w?.pty;
    if (!w || !proc) return false;
    w.pty = undefined;
    w.launchPrompt = undefined;
    for (const entry of w.inFlight) clearTimeout(entry.timer);
    w.inFlight.clear();
    w.activeTool.clear();
    w.sentQueue = [];
    w.queued = 0;
    try {
      proc.kill();
    } catch {
      // already gone
    }
    clockWork(w.info, 'exited');
    w.info.status = 'exited';
    w.info.acked = true;
    w.currentTool = undefined;
    w.completedTool = undefined;
    delete w.info.ask;
    this.emitUpdate(w);
    this.persist();
    return true;
  }

  /** Stops a worker and forgets it and its conversation, but not who it leads: a new conversation for the same agent. */
  forget(id: string): boolean {
    const w = this.workers.get(id);
    if (!w) return false;
    this.workers.delete(id);
    this.subscribers.delete(id);
    const proc = w.pty;
    w.pty = undefined;
    for (const entry of w.inFlight) clearTimeout(entry.timer);
    w.inFlight.clear();
    clearTimeout(w.outboxTimer);
    try {
      proc?.kill();
    } catch {
      // already gone
    }
    w.term?.dispose();
    this.scrollback.remove(id);
    this.drops.remove(id);
    rmSync(this.spool.file(id), { force: true });
    this.events.remove(id);
    this.persist();
    return true;
  }

  /** The model and effort an agent runs on from its next launch; a running one keeps its current process until then. */
  choose(id: string, model: string | undefined, effort: AgentEffort | undefined): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    const error = validateWorkerModel('agent', model) ?? validateWorkerEffort('agent', effort);
    if (error) return error;
    w.info.model = model;
    w.info.effort = effort;
    w.info.activeModel = undefined;
    w.info.activeEffort = undefined;
    this.emitUpdate(w);
    this.persist();
    return undefined;
  }

  /** Finder reuses an ordinary worker it hired; never overwrite a running turn or CLI question. */
  dispatchWorker(text: string, model?: string): { info: WorkerInfo; hired: boolean } | string {
    if (this.closing) return 'The office is closing';
    if (!text.trim()) return 'Empty prompt';
    const w = [...this.workers.values()].find((x) => x.info.createdBy === 'Finder' && x.info.kind === 'agent' && !x.info.lead && !x.info.remote);
    if (w) {
      if (isBusy(w.info.status) || w.launchPrompt || (w.info.lastInputAt !== undefined && Date.now() - w.info.lastInputAt < 2000)) {
        return 'The Finder worker is busy or waiting on input. Open its thread and try again when it is ready.';
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
    if (w) {
      w.info.lastInputAt = Date.now();
      const error = w.pty ? this.prompt(w.info.id, text) : this.resume(w.info.id, text);
      return error ?? { info: w.info, hired: false };
    }
    const seat = this.pickSeat(nextFreeSeat);
    if (!seat) return 'No free desks or bean bags for Finder dispatch';
    const info = this.spawn(seat.id, 'Finder', text, false, 'agent', model);
    if (typeof info === 'string') return info;
    info.lastInputAt = Date.now();
    return { info, hired: true };
  }

  /** Keeps a picture pasted into a prompt that isn't sent yet; its id, or undefined when it isn't a picture or couldn't be kept. */
  stageImage(name: string, body: Buffer): string | undefined {
    return this.drops.stage(name, body);
  }

  /** Throws away staged pictures: taken out of the prompt, or the prompt was never sent. */
  unstage(ids: readonly string[]) {
    this.drops.unstage(ids);
  }

  /** Connects the office-wide image store so prompts and team messages can adopt Tailnet-uploaded image ids. */
  setSharedImages(shared: SharedDropImages | undefined) {
    this.drops.setShared(shared);
  }

  /** Whether `id` names a staged or office-uploaded image this worker can adopt. */
  hasImage(id: string): boolean {
    return this.drops.hasImage(id);
  }

  /** Reads a staged or office-uploaded image's raw bytes. */
  stagedPicture(id: string): { body: Buffer; ext: string } | undefined {
    return this.drops.stagedPicture(id);
  }

  /** Whether its process is running. */
  running(id: string): boolean {
    return !!this.workers.get(id)?.pty;
  }

  /** The worker whose terminal holds this hook token: how a worker proves it's asking for itself. */
  authenticate(id: string, token: string): WorkerInfo | undefined {
    const w = this.workers.get(id);
    return w?.pty && token && safeEq(token, w.hookToken) ? w.info : undefined;
  }

  /** Starts every worker that isn't running: nobody should be found asleep at their desk. */
  wakeAll() {
    for (const w of this.workers.values()) if (!w.pty && !w.info.remote && !this.asleep?.(w.info)) this.resume(w.info.id);
  }

  /** Keeps a file dropped or pasted into a worker's terminal on this machine; where it is, for the terminal to type. */
  drop(id: string, name: string, type: string, body: Buffer): string | undefined {
    return this.workers.has(id) ? this.drops.save(id, name, type, body) : undefined;
  }

  /** A picture the worker was sent with a prompt, for its Thread; undefined when it's gone or isn't one. */
  dropPicture(id: string, name: string): { body: Buffer; type: string } | undefined {
    return this.workers.has(id) ? this.drops.picture(id, name) : undefined;
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

  /** MCP's opt-in cleanup preflights before dismissing and never forces removal. */
  async dismissTeam(id: string, pruneWorktree: boolean, keepBranch: boolean): Promise<{ note?: string; error?: string }> {
    const w = this.workers.get(id);
    if (!w) return { error: 'Worker is no longer on this floor' };
    if (!pruneWorktree) return this.kill(id, 'keep');
    if (!w.info.worktree) return { error: 'Refusing to prune the main checkout; this worker has no worktree' };
    if (w.info.status === 'working' || w.info.status === 'starting' || w.info.status === 'needs_input') return { error: 'Wait for the worker to finish before pruning its worktree' };
    const trees = this.treesOf(w.info);
    for (const t of trees) {
      const abs = t.ref.path && path.resolve(t.dir, t.ref.path);
      if (!abs || !this.trees.owns(abs)) return { error: 'Refusing to prune a worktree outside the owning office' };
      const state = await t.trees.inspect(t.ref);
      if (!state.exists || state.error || state.dirty) return { error: 'Refusing to prune an unavailable or dirty worktree; commit changes or keep it' };
    }
    if (this.workers.get(id) !== w || ['working', 'starting', 'needs_input'].includes(w.info.status)) return { error: 'Worker changed during cleanup checks; read status before retrying' };
    // Stop the PTY before removal. Keep the existing cleanup path from ever forcing deletion.
    await this.kill(id, 'keep');
    const results = [];
    for (const t of trees) results.push(await t.trees.removeClean(t.ref, keepBranch, this.dir, w.worktreeOwnership?.[t.dir]));
    const errors = results.flatMap((r) => (r.error ? [r.error] : []));
    return errors.length ? { error: `Worker dismissed, but worktree cleanup refused: ${errors.join('; ')}` } : { note: results.map((r) => r.note).join('; ') };
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
    const proc = w.pty;
    w.pty = undefined; // so the exit handler knows this worker is gone and stays quiet
    for (const entry of w.inFlight) clearTimeout(entry.timer);
    w.inFlight.clear();
    clearTimeout(w.outboxTimer);
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
        rmSync(this.spool.file(id), { force: true });
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
    if (!this.plain) {
      const live = readHeadBranch(this.dir);
      if (live.found && live.branch) this.events.checkout?.(live.branch);
    }
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
    return this.delivery.cancelTurn(id);
  }

  /** What a Droid agent's screen shows now: busy on a turn, asking, or at rest. */
  turnScreen(id: string): DroidScreen | undefined {
    return this.delivery.turnScreen(id);
  }

  /** Keystrokes from an attached browser. */
  write(id: string, data: string) {
    const w = this.workers.get(id);
    if (!w?.pty) return false;
    w.pty.write(data);
    if (w.info.kind === 'agent' && w.info.status === 'working') w.queued += countCtrlEnterInputs(data);
    if (isClearQueueInput(data)) {
      w.queued = 0;
      w.sentQueue = [];
    }
    if (isCancelInput(data)) w.cancelAt = Date.now();
    let changed = this.typed(w);
    if (w.info.status === 'needs_input' && w.info.acked === false) {
      w.info.acked = true;
      changed = true;
    }
    if (changed) this.emitUpdate(w);
    return true;
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
    if (this.building && this.buildingIdentity(id)) {
      if (images?.length) return 'Building agents take text, not pictures, from a floor';
      return this.building.agents.tell(id, text, this.building.floor);
    }
    return this.delivery.prompt(id, text, images, queue);
  }

  /** Active blocking tool call on `id` (watch command or tool running >= BLOCKING_TOOL_MS), if any. */
  blockingTool(id: string, now = Date.now()): BlockingToolState | undefined {
    const w = this.workers.get(id);
    return w ? detectBlockingTool(w.info.status, w.activeTool, now) : undefined;
  }

  /** Pending notices and Droid messages, in their delivery order. */
  queueState(id: string, now = Date.now()): WorkerQueueState | undefined {
    return this.delivery.queueState(id, now);
  }

  /** Stops a running turn before delivering a prompt, never answering an interactive dialog. */
  async urgentPrompt(id: string, text: string, images?: readonly string[]): Promise<{ error?: string; interrupted?: boolean }> {
    if (this.building && this.buildingIdentity(id)) return { error: this.prompt(id, text, images, false) };
    return this.delivery.urgentPrompt(id, text, images);
  }

  /** Clears all pending messages, or the single 1-based item. */
  clearQueue(id: string, index?: number) {
    return this.delivery.clearQueue(id, index);
  }

  /** Moves pending messages forward, with rollback if urgent delivery fails. */
  promoteQueue(id: string, opts: { index?: number; all?: boolean; urgent?: boolean } = {}) {
    return this.delivery.promoteQueue(id, opts);
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

  /**
   * A hook from a worker's droid, with the version of the command that sent it (see HOOK_VERSION).
   * Resolves to what the command prints back to Droid ('' for nothing), or undefined when the hook
   * isn't this worker's. It answers at once: Droid waits for each hook before it carries on.
   */
  hookReply(workerId: string, token: string, event: string, payload: unknown, version = 0): string | undefined {
    const w = this.workers.get(workerId);
    if (!w?.pty || !safeEq(token, w.hookToken)) return undefined;
    return this.hooks.accept(w, event, payload, { version });
  }

  /** Every running worker's spooled hooks, replayed. */
  replaySpools() {
    this.spool.replayAll();
  }

  /**
   * Hands an office notice to a worker in the middle of a turn: its droid reads it with the result
   * of its next tool call, or as the reason its turn goes on when it tries to stop. Says whether it
   * took it; a worker at rest, asking, or on a hook command that can't carry it (one its droid
   * started before this office) is typed into by the caller instead, as before. One still waiting
   * when the worker comes to rest is typed in then.
   */
  notice(id: string, text: string, images?: readonly string[]): boolean {
    return this.delivery.notice(id, text, images);
  }

  /**
   * An office message for a worker (a visit, a lead's message, a Whiteboard ping): mid-turn it goes
   * through its hooks (see notice), otherwise it's typed in like a prompt.
   */
  tell(id: string, text: string): string | undefined {
    return this.notice(id, text) ? undefined : this.prompt(id, text);
  }

  /** Holds a notice until the worker can safely receive it. */
  hold(id: string, text: string): string | undefined {
    return this.delivery.hold(id, text);
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

  /**
   * Heals what the hooks missed, as a slow safety net: once the screen has said one thing for
   * SCREEN_SETTLE_MS with no hook in that time, status follows it (see droid-screen.ts). Hooks that
   * fired while the office was down are replayed from the spool, so this should rarely act; each
   * time it does, it says so in the log. Runs every second; `now` is for tests.
   */
  private droidScreen(w: Worker): DroidScreen | undefined {
    const term = w.term;
    if (!term) return undefined;
    if (w.screenParse && w.screenParse.term === term && w.screenParse.seq === w.termSeq) return w.screenParse.state;
    const state = readDroidScreen(screenRows(term));
    w.screenParse = { term, seq: w.termSeq, state };
    return state;
  }

  reconcile(now = Date.now()) {
    for (const w of this.workers.values()) {
      const { info } = w;
      // No SessionStart came for it (the hook can't reach the office), but droid's input box is up.
      if (w.launchPrompt && w.pty && w.term && now - w.launchPrompt.at >= LAUNCH_PROMPT_FALLBACK_MS && this.droidScreen(w) === 'idle') this.delivery.sendLaunchPrompt(w);
      if (info.kind !== 'agent' || !w.pty || !w.term || w.bootBlocked || !info.sessionId || info.status === 'starting') {
        w.screenSeen = undefined;
        continue;
      }
      // A Stop whose grace timer hasn't fired yet (a test's clock, a busy event loop).
      if (w.stopAt !== undefined && now - w.stopAt >= STOP_GRACE_MS) this.hooks.settleStop(w, w.stopAt, now);
      const state = this.droidScreen(w);
      if (!state) {
        w.screenSeen = undefined;
        continue;
      }
      if (w.screenSeen?.state !== state) w.screenSeen = { state, since: now };
      if (now - w.screenSeen.since < SCREEN_SETTLE_MS || now - w.hookAt < SCREEN_SETTLE_MS) continue;
      const next = screenStatus(info.status, state, now - w.outputAt >= SCREEN_SETTLE_MS);
      if (!next) continue;
      console.log(`  🖥️  ${info.name}'s screen corrected its status from ${info.status} to ${next}: no hook said so`);
      if (next === 'needs_input') info.activity = 'Waiting for input';
      this.setStatus(w, next);
    }
  }

  /** Looks up the model and effort droid says the worker's session runs, which no hook reports. */
  private refreshDroidModel(w: Worker) {
    const { sessionId } = w.info;
    if (w.info.kind !== 'agent' || !sessionId) return;
    void this.droidSessions.read(sessionId, this.cwd(w.info), w.transcript).then((seen) => {
      if (!seen || this.workers.get(w.info.id) !== w || w.info.sessionId !== sessionId) return;
      if (seen.model === w.info.activeModel && seen.effort === w.info.activeEffort) return;
      w.info.activeModel = seen.model;
      w.info.activeEffort = seen.effort;
      this.emitUpdate(w);
    });
  }
  /** A local preview needs no inference or API key and never replaces an assigned/generated label. */
  private notePrompt(w: Worker, prompt: string) {
    if (w.info.kind !== 'agent' || w.info.task || prompt === CARRY_ON_PROMPT || !prompt.trim() || prompt.trim().startsWith('/')) return;
    w.info.task = fallbackTask(prompt);
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
    clearTimeout(this.spoolTimer);
    for (const w of this.workers.values()) {
      for (const entry of w.inFlight) clearTimeout(entry.timer);
      w.inFlight.clear();
      clearTimeout(w.outboxTimer);
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
      const system = this.settings.systemPromptFile(info);
      args.unshift('--settings', this.settings.droidSettings(info), ...(system ? ['--append-system-prompt-file', system] : []));
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
    w.currentTool = undefined;
    w.completedTool = undefined;
    w.activeTool.clear();
    for (const entry of w.inFlight) clearTimeout(entry.timer);
    w.inFlight.clear();
    w.asking = undefined;
    w.hookVersion = 0;
    w.outbox = [];
    w.queued = 0;
    w.sentQueue = [];
    delete info.ask;
    const env = childEnv();
    // Shells keep these for worktree setup reporting; the Office MCP refuses any caller that isn't an agent.
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      DROID_OFFICE_WORKER_ID: info.id,
      DROID_OFFICE_HOOK_URL: this.hook.url,
      DROID_OFFICE_HOOK_TOKEN: w.hookToken,
    });
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
    w.outbox = saved.outbox ?? [];
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
      if (saved.status === 'needs_input' && saved.ask) info.ask = saved.ask;
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
    term.onWriteParsed(() => {
      w.termSeq++;
      w.screenDirty = true;
    });
    term.onResize(() => {
      w.termSeq++;
    });
    w.term?.dispose();
    w.term = term;
    w.ser = ser;
    w.snapshot = screenSnapshot(term, ser);
    w.termSeq++;
    w.screenParse = undefined;
    w.lastLines = [];
    w.screenDirty = true;
    w.needsKeyframe = false;
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
    if (!proc.id) {
      setTerminalResponder(term, (reply) => {
        if (w.pty === proc) proc.write(reply);
      });
    }
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
        info.activity = BOOT_BLOCKED;
        this.setStatus(w, 'needs_input');
        this.bootAsk(w);
      } else this.setStatus(w, 'idle');
    };
    setTimeout(check, BOOT_BLOCKED_MS).unref();
  }

  /**
   * Droid stopped to ask something before its session started (Trust this folder?, for a folder it hasn't
   * seen): the menu on its screen becomes the worker's question, so it can be answered without its terminal.
   */
  private bootAsk(w: Worker) {
    if (!w.bootBlocked || w.info.status !== 'needs_input') return;
    const menu = this.screenMenu(w.info.id);
    const question = menu?.question?.trim();
    const ask: WorkerAsk | undefined =
      menu?.choices.length && !menu.multiSelect ? { kind: 'question', questions: [{ question: question || 'Droid asks before it starts', options: menu.choices.map((c) => c.label), multiSelect: false }] } : undefined;
    if (isDeepStrictEqual(ask, w.info.ask)) return;
    if (ask) {
      w.info.ask = ask;
      w.info.activity = question ? `Droid asks: ${truncate(question, 60)}` : 'Droid asks something before it starts';
    } else {
      delete w.info.ask;
      w.info.activity = BOOT_BLOCKED;
    }
    this.emitUpdate(w);
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
    if (status !== 'working') {
      w.stopAt = undefined;
      w.currentTool = undefined;
    }
    if (status !== 'needs_input') {
      w.asking = undefined;
      delete w.info.ask;
    }
    // Done, idle or asleep: it's not acting anything out any more.
    if (status !== 'working' && status !== 'needs_input') {
      w.info.action = undefined;
      w.activeTool.clear();
      w.queued = 0;
      w.sentQueue = [];
    }
    // A finished list stays up for the turn that finished it, not after.
    if ((status === 'done' || status === 'idle') && w.info.todos && todosFinished(w.info.todos)) {
      delete w.info.todos;
      delete w.todoSteps;
    }
    // Nobody is looking at the terminal right now -> raise the flag (the worker jumps).
    if (status === 'done' || status === 'needs_input') {
      w.info.acked = status === 'done' && w.info.open;
      w.info.waitingSince = Date.now();
    } else w.info.acked = true;
    this.emitUpdate(w);
    // What a restarted office picks the worker back up as, should its terminal outlive this one.
    if (w.pty?.id) this.persist();
    // At rest: it may have made a branch of its own this turn, and opened its PR from there.
    if (status === 'done' || status === 'idle') {
      void this.syncBranch(w);
      if (w.outbox.length) this.delivery.flushOutbox(w);
    }
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

  /** Structured runtime telemetry for MCP worker inspection without modifying terminal state. */
  runtime(id: string): WorkerRuntimeSnapshot | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    const rows = w.term ? screenRows(w.term) : undefined;
    const droidQueue = rows ? readDroidQueue(rows) : undefined;
    const queuedMessages = droidQueue?.length ? droidQueue.map((item) => `${item.text}${item.cut ? '…' : ''}${item.more > 0 ? ` (+${item.more} line${item.more === 1 ? '' : 's'})` : ''}`) : undefined;
    return {
      ...(w.todoSteps?.length ? { todoSteps: w.todoSteps.map((s) => ({ ...s })) } : {}),
      ...(w.currentTool ? { currentTool: { ...w.currentTool } } : {}),
      ...(w.completedTool ? { lastTool: { ...w.completedTool } } : {}),
      ...(w.hookAt > 0 ? { lastHookAt: w.hookAt } : {}),
      ...(w.outputAt > 0 ? { lastOutputAt: w.outputAt } : {}),
      ...(queuedMessages ? { queuedMessages } : {}),
      ...(w.outbox.length > 0 ? { queuedNotices: w.outbox.length } : {}),
      ...(rows ? { screenRows: rows.slice(-20) } : {}),
    };
  }

  /** One worker's current visible rows, for revalidating a question without serializing all PTYs. */
  screenLines(id: string): string[] | undefined {
    const term = this.workers.get(id)?.term;
    const frame = term && snapshotScreen(term, []);
    return frame ? Array.from({ length: frame.rows }, (_, row) => (frame.lines[row] ?? []).map((r) => r[0]).join('')) : undefined;
  }

  /** Answering needs Droid's bold keyboard focus, not just which checkboxes are checked. */
  screenMenu(id: string) {
    const term = this.workers.get(id)?.term;
    const frame = term && snapshotScreen(term, []);
    return frame ? readScreenMenu(Array.from({ length: frame.rows }, (_, row) => frame.lines[row] ?? [])) : undefined;
  }

  /** Full screen for one running worker, e.g. when a cross-floor worker needs input. */
  fullScreen(id: string): ScreenFrame | undefined {
    const term = this.workers.get(id)?.term;
    return (term && snapshotScreen(term, [])) || undefined;
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
      // Diffs can be dropped for slow clients, so resend the whole screen after a drop settles.
      if (w.needsKeyframe && now - w.keyframeAt > KEYFRAME_MS) {
        w.keyframeAt = now;
        w.needsKeyframe = false;
        w.lastLines = [];
        w.screenDirty = true;
      }
      if (!w.screenDirty) continue;
      w.screenDirty = false;
      const frame = snapshotScreen(w.term, w.lastLines);
      if (frame) {
        if (frame.full) w.keyframeAt = now;
        if (this.events.screen(w.info.id, frame) === true) w.needsKeyframe = true;
      }
      if (w.bootBlocked) this.bootAsk(w);
    }
  }

  private saveScrollback(w: Worker) {
    if (!w.term || !w.ser) return;
    w.unsaved = false;
    this.scrollback.save(w.info.id, terminalTail(w.term, w.ser, SCROLLBACK));
  }

  private persist(onShutdown = false) {
    this.state.save(this.workers.values(), { closing: this.closing, stopping: this.stopping, onShutdown });
  }
}
// ---------------------------------------------------------------------------

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
  // …and a Linear ticket as: Work on Linear issue DOFF-12: "Title".
  const ticket = linearTaskOf(firstLine);
  const title = truncate(issue?.[2] || ticket?.title || firstLine.replace(/[.:;,]+$/, '') || commits[0]?.replace(/^\S+\s+/, '') || info.worktree?.branch || info.name, PR_TITLE_MAX);
  const closes = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^\n]{0,40}?#(\d+)/i.exec(task)?.[1] ?? issue?.[1];
  const parts: string[] = [];
  if (task) parts.push(`## Task\n\n${task.length > PR_TASK_MAX ? `${task.slice(0, PR_TASK_MAX)}…` : task}`);
  parts.push(`## Commits\n\n${commits.map((c) => `- \`${c.slice(0, c.indexOf(' '))}\` ${c.slice(c.indexOf(' ') + 1)}`).join('\n')}`);
  if (closes && !other) parts.push(`Closes #${closes}`);
  else if (closes && other?.home) parts.push(`Part of ${other.home}#${closes}`);
  // Linear's GitHub and GitLab integrations link the pull request to the ticket on this magic word.
  if (ticket) parts.push(other ? `Part of ${ticket.identifier}` : `Fixes ${ticket.identifier}`);
  parts.push(`_Opened from Droid Office by ${by} · ${info.name} at ${DESK_BY_ID.get(info.deskId)?.label ?? info.deskId}_`);
  return { title, body: parts.join('\n\n') };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
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
