import { randomBytes } from 'node:crypto';
import type headless from '@xterm/headless';
import type serialize from '@xterm/addon-serialize';
import type { WorkerAsk, WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import { stripKittyPlaceholders } from '../../shared/kitty.js';
import type { ActiveToolCall, SentPendingMessage } from '../worker-queue.js';
import type { WorktreeOwnership } from '../worktrees.js';
import type { WorkerToolSpan } from '../worker-status.js';
import type { Pty } from '../ptys.js';
import type { DroidScreen } from '../droid-screen.js';
import type { TodoItem } from '../../shared/todos.js';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;

export interface Worker {
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
  needsKeyframe: boolean;
  termSeq: number;
  screenParse?: { term: HeadlessTerminal; seq: number; state: DroidScreen | undefined };
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
  /** The latest tool each session started (PreToolUse), and its input, to know which call a permission prompt is about. */
  lastTool: Map<string, { tool: string; input: unknown }>;
  /** Full bounded TodoWrite plan steps alongside WorkerInfo.todos. */
  todoSteps?: TodoItem[];
  /** Currently executing PreToolUse span, and the latest completed tool span. */
  currentTool?: WorkerToolSpan;
  completedTool?: WorkerToolSpan;
  /** Currently running tool calls per session (set on PreToolUse, cleared on PostToolUse/Stop). */
  activeTool: Map<string, ActiveToolCall>;
  /** Who raised its needs_input from a hook: the session asking, and the tool it asks about. */
  asking?: { session: string; tool?: string };
  /** When its last hook came in, and its terminal last printed something (see reconcile). */
  hookAt: number;
  outputAt: number;
  /** When its own session's Stop came, with no hook since: a finish waiting out STOP_GRACE_MS. */
  stopAt?: number;
  /** The version of the hook command its droid runs (see HOOK_VERSION), as its last hook said. */
  hookVersion: number;
  /** Its session's conversation file, as its hooks name it (transcript_path). */
  transcript?: string;
  /** Office notices for its next tool call or Stop (see notice). */
  outbox: string[];
  /** When the owner (or a visit) last pressed Escape or Ctrl+C in its terminal: a Stop right after is a cancel, never blocked. */
  cancelAt?: number;
  /** Notices left in its outbox when it came to rest wait for the owner to stop typing (see flushOutbox). */
  outboxTimer?: NodeJS.Timeout;
  /** Messages queued with Ctrl+Enter during this turn: each runs after the turn's Stop, as a turn with no UserPromptSubmit. */
  queued: number;
  /** Full texts of messages queued with Ctrl+Enter through the office during this turn. */
  sentQueue: SentPendingMessage[];
  sentQueueSeq: number;
  /** Bracketed-paste prompts whose 120ms submit keystroke has not fired yet. */
  inFlight: Set<{ timer: NodeJS.Timeout; text: string; submit: string; queued: boolean }>;
  /** What its screen has shown since when (see droid-screen.ts). */
  screenSeen?: { state: DroidScreen; since: number };
  /** Test runs and builds that have failed in a row (see FAILS_TO_DESPAIR). */
  failStreak: number;
  /** Bumped by /clear: a new conversation, so a new task. */
  taskEpoch: number;
  /** Its terminal in the host as of the last save, and how it was doing, to pick back up after a restart. */
  saved?: { ptyId: string; status: WorkerStatus; acked: boolean; waitingSince?: number; ask?: WorkerAsk; launchPrompt?: { text: string; at: number }; outbox?: string[] };
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

/** Cut off if it stopped now. A turn that already sent its Stop has finished, even before its screen confirms it. */
export function midTurn({ info, bootBlocked, stopAt }: Pick<Worker, 'info' | 'bootBlocked' | 'stopAt'>): boolean {
  return info.kind === 'agent' && stopAt === undefined && (info.status === 'working' || (info.status === 'needs_input' && !bootBlocked));
}

/** The rows a terminal shows now, its scrollback left out. */
export function screenRows(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) rows.push(stripKittyPlaceholders(buf.getLine(y)?.translateToString(true) ?? '').trimEnd());
  return rows;
}

export function newWorker(info: WorkerInfo, hookToken = randomBytes(16).toString('hex')): Worker {
  return {
    info,
    screenDirty: true,
    lastLines: [],
    leftNeedsInputAt: 0,
    keyframeAt: 0,
    needsKeyframe: false,
    termSeq: 0,
    hookToken,
    failStreak: 0,
    taskEpoch: 0,
    subSessions: new Set(),
    lastTool: new Map(),
    activeTool: new Map(),
    hookAt: 0,
    outputAt: 0,
    hookVersion: 0,
    outbox: [],
    queued: 0,
    sentQueue: [],
    sentQueueSeq: 0,
    inFlight: new Set(),
  };
}
