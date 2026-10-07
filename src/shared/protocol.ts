// Wire protocol between browser and server. Every WebSocket frame is one JSON object.

import type { Look } from './avatar.js';
import type { Forge } from './floors.js';
import type { CabinetFrame, CabinetState, CabinetView } from './cabinet.js';
import type { DecorPlacement, Decoration } from './decor.js';
import type { FactoryFeatureId, FactoryState } from './factory.js';
import type { CloudWorker } from './factory-cloud.js';
import type { JiraBoardState, JiraFloorState } from './jira.js';
import type { JukeboxState } from './jukebox.js';
import type { PromptId } from './prompts.js';

export type WorkerStatus =
  | 'starting' // PTY launched, agent booting
  | 'idle' // waiting for a first prompt
  | 'working' // agent is busy
  | 'needs_input' // permission prompt / question open
  | 'done' // finished its turn
  | 'exited' // process ended (can be resumed if it had a session)
  | 'offline'; // restored from disk after a server restart; resumable

export type WorkerKind = 'agent' | 'shell' | 'cloud';

/**
 * What a working agent's latest tool call looks like from across the room (see shared/actions.ts):
 * reading files, editing them, running tests or a build, on the web, or tests failing again and again.
 */
export type WorkerAction = 'read' | 'edit' | 'test' | 'web' | 'failing';

/** Reasoning effort levels, from fastest/cheapest to most thorough. Droid takes them as `reasoningEffort`. */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const AGENT_EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export function isAgentEffort(value: unknown): value is AgentEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

/** Which Droid model and reasoning effort a worker runs on. */
export interface AgentChoice {
  /** A Droid model id; unset for Droid's own default. */
  model?: string;
  effort?: AgentEffort;
}

/**
 * The prompts the office writes for workers by itself (shared/prompts.ts) and the worker a new one
 * starts on when nobody picks, as set in Settings: the same on every floor.
 */
export interface PromptsState {
  /** Prompts someone rewrote, by id; the rest are the defaults. */
  custom: Partial<Record<PromptId, { text: string; by: string; at: number }>>;
  /**
   * What a worker starts on when whoever starts it picks no model (the Queue agent's tasks, say).
   * Unset: Droid's own default model.
   */
  agent?: AgentChoice & { by: string; at: number };
}

/** What a worker is on, for the card above its head: "Fix Login Redirect" + what it's doing now. */
export interface WorkerTask {
  name: string;
  summary: string;
}

/** How long a shot worker can be revived before dismissal and worktree cleanup. */
export const WORKER_REVIVE_MS = 30_000;

export interface WorkerInfo {
  id: string;
  /** 'agent' runs Droid; 'shell' is a plain shared login shell; 'cloud' runs its Droid session on a Factory computer (see `cloud`). */
  kind: WorkerKind;
  /** Droid model requested for this worker, instead of Droid's own default. */
  model?: string;
  /** Reasoning effort requested for this worker, when one was chosen. */
  effort?: AgentEffort;
  /** The model its session is running now, as the agent reports it (Droid), even when none was requested. Wins over `model` for display. */
  activeModel?: string;
  /** The reasoning effort its session is running now, alongside `activeModel`. */
  activeEffort?: AgentEffort;
  deskId: string;
  name: string;
  color: string;
  status: WorkerStatus;
  /** Shot: the server's revival deadline (ms since epoch); the session runs until then. */
  downedUntil?: number;
  /** True once someone opened the terminal after the last done / needs_input. */
  acked: boolean;
  /** When it last went to done or needs_input (ms), so N goes to whoever has waited longest first. */
  waitingSince?: number;
  createdBy: string;
  createdAt: number;
  prompt?: string;
  /**
   * Set when the worker runs in its own git worktree (path relative to the office dir). `from` is
   * the branch the office was on when the worktree was cut, which its pull request targets.
   * `branch` is the branch the worktree is on: the office's own office/<name>-<id> until the worker
   * switches to one of its own (`git checkout -b fix-x`), which `made` then remembers.
   */
  worktree?: { path: string; branch: string; base: string; from?: string; made?: string };
  /**
   * Set while the folder it works in (its worktree, or its workspace across repositories) is gone:
   * deleted outside the office, so it can't start there until it's rebuilt ('worker.rebuild') or sent
   * home. `branch` says where its branch still is: in the project, only on origin, or nowhere.
   */
  lost?: { branch: LostBranch };
  /**
   * Other floors' repositories this worker works in too, each as its own worktree inside the same
   * workspace folder as `worktree` (see server/workers.ts). Only a worker hired into its own worktree.
   */
  repos?: WorkerRepo[];
  /** The pull request opened from this desk for the worktree branch (see 'worker.pr'). */
  pr?: { number: number; url: string };
  /** True while the branch is being pushed and its pull request opened. */
  prOpening?: boolean;
  title?: string;
  sessionId?: string;
  exitCode?: number;
  cols: number;
  rows: number;
  /** True while any owner connection has its terminal open. */
  open: boolean;
  /** Latest line of meaningful activity (e.g. last prompt or tool). */
  activity?: string;
  /** What its latest tool call is, for the worker to act out while it works. */
  action?: WorkerAction;
  /** Written by a small model from its prompts and recent tool calls (see server/tasks.ts). */
  task?: WorkerTask;
  /** When its terminal last took input (keystrokes or a prompt). */
  lastInputAt?: number;
  /** The meeting it was called to, for a worker at the meeting room's table (see Meeting). */
  meeting?: string;
  /**
   * The worker that hired this one as its subagent with `office-workers hire` (see server/team.ts),
   * while that worker is still on the floor. Subagents report back to it and can't hire their own.
   */
  lead?: string;
  /**
   * How long it has spent working (ms), over the stretches that have ended, and when the one it's in
   * now started (while it's working).
   */
  workedMs?: number;
  workingSince?: number;
  /**
   * Set for a guest: an agent process the office didn't start, running on the office's machine in
   * this floor's checkout (see server/guests.ts). The office only watches it: it has no terminal
   * here, takes no prompts or tasks, and is never stopped by the office.
   */
  guest?: GuestInfo;
  /**
   * Agent processes started by hand inside this worker's own worktree, outside the office (see
   * server/guests.ts): they're this worker's, rather than guests of their own.
   */
  outside?: OutsideProcess[];
  /**
   * Set for a cloud worker (kind 'cloud'): its Droid session (`sessionId`) runs on one of the
   * account's Factory computers, driven through Factory's Sessions API (see server/factory/cloud.ts).
   * It has no terminal, worktree or hooks on this machine.
   */
  cloud?: CloudWorker;
}

/** The agent CLIs whose processes the office recognises as guests. */
export type GuestProvider = 'droid' | 'claude' | 'codex' | 'opencode' | 'grok' | 'muse';

/** An agent process running outside the office: which CLI, and where. */
export interface OutsideProcess {
  pid: number;
  /** Its controlling terminal, like /dev/ttys004. */
  tty: string;
  provider: GuestProvider;
}

/** What the office knows of a guest (see WorkerInfo.guest). */
export interface GuestInfo extends OutsideProcess {
  /** Its working directory, symlinks resolved. */
  cwd: string;
  /** When the process started (ms). */
  startedAt: number;
  /**
   * Where its status comes from: Droid's session transcript (`~/.factory/sessions/`), or only that
   * the process is running, when there's no transcript the office can tie to it.
   */
  seen: 'transcript' | 'process';
  /** When its transcript was last written (ms), when it has one. */
  writtenAt?: number;
  /**
   * Why it can't be brought in as one of the office's own workers right now (see 'guest.bringIn'),
   * or unset when it can: a droid session the office has tied to it, in the floor's checkout, between turns.
   */
  cantBringIn?: string;
}

/** Where the branch of a worker whose worktree was deleted still is (see WorkerInfo.lost). */
export type LostBranch = 'here' | 'origin' | 'gone';

/**
 * One other floor's repository a worker works in (see WorkerInfo.repos): a worktree of that floor's
 * checkout, on the same branch as the worker's own, living in the worker's workspace folder.
 */
export interface WorkerRepo {
  /** The other floor. */
  floor: string;
  /** Its folder in the workspace. */
  name: string;
  /** owner/name on GitHub, or host/group/…/project on GitLab, when known. */
  repo?: string;
  /** That floor's checkout, on the office's machine. */
  dir: string;
  /** The worktree, relative to the worker's own floor (the workspace lives there). */
  path: string;
  branch: string;
  /** The commit it was branched from. */
  base: string;
  /** The branch its pull request targets: the one that floor's checkout was on. */
  from?: string;
  /** Its pull request, once one is open. */
  pr?: { number: number; url: string };
}

/** What becomes of a worker's git worktree when it is sent home. */
export type WorktreeCleanup = 'keep' | 'worktree' | 'all';

/** What a worker's worktree holds, so whoever sends it home knows what deleting it would lose. */
export interface WorktreeState {
  /** The worktree folder is still there. */
  exists: boolean;
  /** Files with uncommitted changes, new ones included. */
  dirty: number;
  /** Commits on its branch since it was made. */
  ahead: number;
  /** Commits only its branch has: on no remote, and not in the office's own checkout. */
  unpushed: number;
  /** Set when git couldn't tell, e.g. the branch is gone. */
  error?: string;
  /**
   * A worker across repositories: each worktree, its own floor's first. The totals above are the sum,
   * and `error` joins each one's. Absent for a worker in one checkout.
   */
  repos?: { name: string; state: WorktreeState }[];
}

/** The issue on a card carried around the floor. */
export interface CarriedIssue {
  issue: number;
  title: string;
}

/** A styled run of text on a terminal row: [text, fg, bg, flags]. */
export type Run = [string, number, number, number];
/** Color encoding: -1 default, 0..255 palette, >= 0x1000000 means 0x1000000 | rgb. */
export const RGB_FLAG = 0x1000000;
export const FLAG_BOLD = 1;
export const FLAG_INVERSE = 2;
export const FLAG_DIM = 4;

/** A GitHub or GitLab label; `color` is a CSS color ("#d73a4a"). */
export interface GhLabel {
  name: string;
  color: string;
  /** What it's for, in the repo's list of labels (the label picker's /api/gh/labels). */
  description?: string;
}

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  labels: GhLabel[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
  comments: number;
}

export interface GhPull {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  author: string;
  labels: GhLabel[];
  reviewDecision: string;
  headRefName: string;
  /** The commit its branch is at on the forge (for a merged PR, the last one merged). */
  headRefOid?: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  checks: 'pass' | 'fail' | 'pending' | 'none';
  body: string;
  /** Issues it closes ("closes #12" in its description), as GitHub links them. */
  closes: number[];
}

export type TaskStatus = 'queued' | 'running' | 'done';

/** A task on the 📋 queue whiteboard: a GitHub issue or free text, seated to a worker by itself. */
export interface QueueTask {
  id: string;
  /** Droid model requested for this task, instead of Droid's own default. */
  model?: string;
  /** Reasoning effort requested for this task, when one was chosen. */
  effort?: AgentEffort;
  /** The GitHub issue it came from, when it did. */
  issue?: number;
  title: string;
  prompt: string;
  addedBy: string;
  addedAt: number;
  status: TaskStatus;
  /** The worker seated for it (it may have gone home since). */
  workerId?: string;
  workerName?: string;
  /** The worker's own branch, when it got a worktree. */
  branch?: string;
  startedAt?: number;
  finishedAt?: number;
  /** How it ended: the worker finished its turn, stopped or fell asleep, was sent home, or never started. */
  outcome?: 'done' | 'exited' | 'killed' | 'failed';
  error?: string;
  /** The pull request that closes the issue, or was opened from the worker's branch. */
  pr?: { number: number; url: string; state: string; title: string };
  /** Ids of the pictures pasted into the task (see ClientMsg `images`), kept until it starts. */
  images?: string[];
}

export interface QueueState {
  tasks: QueueTask[];
  /** How many workers the queue may keep busy at once; 0 pauses it. */
  maxWorkers: number;
}

/** How the workers at the meeting table work together (see shared/meetings.ts). */
export type MeetingPattern = 'debate' | 'lead' | 'mapreduce' | 'redblue' | 'review';

/** A worker's place at a meeting. */
export interface MeetingSeat {
  /** Its part in the meeting, e.g. "Skeptic", "Red team" or "Security". */
  role: string;
  /** Its chair (see MEETING_SEATS in layout). */
  deskId: string;
  workerId?: string;
  workerName?: string;
}

/** One worker's part in a round: what it's doing, and the file that says it has done it. */
export interface MeetingTurn {
  /** Which of the meeting's seats. */
  seat: number;
  /** e.g. "proposing", "critiquing", "writing the decision". */
  doing: string;
  /** Relative to the meeting's checkout. */
  file: string;
  /** waiting: not handed over yet; sent: handed over, not started on; working: on it; done: its file is written. */
  state: 'waiting' | 'sent' | 'working' | 'done';
  sentAt?: number;
  /** It was reminded once already: it ended its turn without writing the file, or never started. */
  retried?: boolean;
}

export type MeetingStatus = 'running' | 'done' | 'stopped';

/**
 * A meeting in the meeting room: 2–5 workers on one question or task, in rounds, following a pattern.
 * It ends when its output file is written, or stops at its round limit and says why.
 */
export interface Meeting {
  id: string;
  pattern: MeetingPattern;
  title: string;
  /** The question or task, as whoever called the meeting put it. */
  prompt: string;
  /** The file the meeting writes, relative to its checkout, declared up front. */
  output: string;
  /** The head of the table first. */
  seats: MeetingSeat[];
  /** Map-reduce: what the task runs over, a part per line. */
  parts?: string[];
  /** Review panel: the pull request under review. */
  pr?: number;
  /** The GitHub issue it's about, when it was called from one. */
  issue?: number;
  model?: string;
  effort?: AgentEffort;
  /** The round limit. */
  rounds: number;
  /** The round it's on (from 1), and the step within it (red / blue take turns inside a round). */
  round: number;
  step: number;
  /** Red / blue: the red team found nothing more in this round, so it's the last. */
  lastRound?: number;
  /** The current step's parts. */
  turns: MeetingTurn[];
  status: MeetingStatus;
  /** Why it stopped short. */
  reason?: string;
  calledBy: string;
  startedAt: number;
  finishedAt?: number;
  /** The meeting's own git worktree, relative to the project, which everyone at the table shares. */
  worktree?: { path: string; branch: string; base: string; from?: string };
  /** Where the round notes go, relative to the checkout. */
  notes: string;
  /** The commit on the meeting's branch that holds the output. */
  commit?: string;
  /** Review panel: the review the office posted on the pull request, or why it couldn't. */
  review?: { url?: string; error?: string };
  /** The start of the output file as it gets written, for the board in the room. */
  preview?: string;
  /** Its workers have gone home and its worktree was tidied away. */
  cleared?: boolean;
}

/** A meeting that's over, in a line. */
export interface MeetingRecord {
  id: string;
  pattern: MeetingPattern;
  title: string;
  status: MeetingStatus;
  /** The line on the room's door: pattern, rounds, and the output (or why it stopped). */
  summary: string;
  calledBy: string;
  finishedAt: number;
  branch?: string;
  output: string;
}

export interface MeetingState {
  /** The meeting in the room: the one running, or the last one until the room is cleared or the next is called. */
  current: Meeting | null;
  /** Earlier meetings on the floor, newest first. */
  past: MeetingRecord[];
}

/** What calling a meeting asks for (see shared/meetings.ts for each pattern's defaults and limits). */
export interface MeetingRequest {
  pattern: MeetingPattern;
  prompt: string;
  title?: string;
  /** The output file, relative to the checkout; the pattern's default when missing. */
  output?: string;
  /** A role per worker, the head of the table first. */
  roles: string[];
  parts?: string[];
  pr?: number;
  issue?: number;
  rounds?: number;
  model?: string;
  effort?: AgentEffort;
  /** Pictures pasted into the dialog, as the ids their upload answered with; every worker at the table is given them. */
  images?: string[];
}

/** Where a team webhook posts: Slack and Discord get their own message format, anything else plain JSON. */
export type WebhookKind = 'slack' | 'discord' | 'other';

/** The office's Slack / Discord webhook, pinged when a worker needs input or finishes (see server/webhook.ts). */
export interface NotifyState {
  /** Never the URL itself (it lets anyone post to the channel): just where it goes. */
  webhook?: { kind: WebhookKind; hint: string; by: string; at: number };
  /** Why the last post failed, until one gets through. */
  error?: string;
  lastSentAt?: number;
}

/**
 * The office's machine (see server/machine.ts): how busy it is, for the wall monitor and a warning
 * before hiring, and the most workers the office runs at once, across every floor.
 */
export interface MachineState {
  /** Percent of every core busy, 0-100, over the last few seconds. */
  cpu: number;
  cores: number;
  /** Memory in use and in all, bytes. */
  memUsed: number;
  memTotal: number;
  /** The last few minutes, oldest first: [cpu %, memory %] a few seconds apart. */
  history: [number, number][];
  /** What makes another worker a strain right now, e.g. "memory is 93% used"; missing when nothing does. */
  pressure?: string;
  /** Workers in the office now: every floor's, shells and board agents too. */
  workers: number;
  /** The most workers the office takes; missing when there's no limit. */
  limit?: number;
  /** --max-workers: the limit can't be set any higher from the office. */
  ceiling?: number;
  /** The limit someone set in ⚙️ Settings, when there is one. */
  set?: { limit: number; by: string; at: number };
}

export interface GhState<T> {
  items: T[];
  error?: string;
  fetchedAt: number;
  loading: boolean;
}

export type GhMergeMethod = 'squash' | 'merge' | 'rebase';

/** Why an issue was closed, as GitHub records it. */
export type GhCloseReason = 'completed' | 'not planned';

/** How the repository lets pull requests be merged. */
export interface GhRepoInfo {
  nameWithOwner: string;
  methods: GhMergeMethod[];
}

/** A comment on an issue or on a PR's conversation, or a submitted review. */
export interface GhComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url?: string;
  /** Reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  state?: string;
}

/** A comment on a line of a PR's diff. */
export interface GhReviewComment {
  id: number;
  /** The first comment of the thread this one answers. */
  replyTo?: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  path: string;
  /** The line it's on now, or null when the code under it changed since (outdated). */
  line: number | null;
  /** LEFT is the old file's line numbers, RIGHT the new file's. */
  side: 'LEFT' | 'RIGHT';
}

export interface GhCheck {
  name: string;
  state: 'pass' | 'fail' | 'pending' | 'skip';
  url?: string;
}

/** Everything the PR window shows beyond the board card: GET /api/gh/pull?number=N */
export interface GhPullDetail {
  number: number;
  body: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string;
  headRefName: string;
  baseRefName: string;
  /** MERGEABLE, CONFLICTING or UNKNOWN (GitHub still working it out). */
  mergeable: string;
  /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT, HAS_HOOKS or UNKNOWN. */
  mergeStateStatus: string;
  /** Why it's BLOCKED, when the review decision and checks don't say (GitLab's merge checks). */
  blocked?: string;
  commits: number;
  comments: GhComment[];
  reviews: GhComment[];
  reviewComments: GhReviewComment[];
  checks: GhCheck[];
  repo: GhRepoInfo;
  /** Who gh is signed in as on the server, and so who comments from the office appear from ('' if unknown). */
  viewer: string;
}

/** GET /api/gh/issue?number=N */
export interface GhIssueDetail {
  number: number;
  /** OPEN or CLOSED. */
  state: string;
  body: string;
  comments: GhComment[];
  /** See GhPullDetail.viewer. */
  viewer: string;
}

/**
 * The `deskId` of a `worker.spawn` that leaves the seat to the office: the first free desk on the
 * sender's floor in DESKS order, else the first free bean bag (nextFreeSeat in layout). With none
 * free, the sender gets a warn toast. Droid Office for Android hires this way.
 */
export const AUTO_DESK = 'auto';

/** GitHub turns away comments longer than this. */
export const GH_COMMENT_MAX = 65536;
/** As long as any label name can be: GitHub stops at 50 characters, GitLab at 255. */
export const GH_LABEL_MAX = 255;

export interface ProjectInfo {
  name: string;
  dir: string;
  branch?: string;
  remote?: string;
  /** Where its repository is hosted, and so which CLI its boards and workers use. */
  forge: Forge;
  agentCmd: string;
}

/**
 * One floor of the building: a project in its own checkout, with its own desks, workers, boards
 * and queue. You go between them in the elevator.
 */
export interface FloorInfo {
  id: string;
  /** The repository's name, or the folder's when it isn't on GitHub or GitLab. */
  name: string;
  /** owner/name on GitHub, or host/group/…/project on GitLab (see normalizeRepo). */
  repo?: string;
  /** Its checkout on the office's machine. */
  dir: string;
  /** The branch that checkout is on ('HEAD' when detached): what a worktree cut from it targets. */
  branch?: string;
  /** Which of FLOOR_PALETTES it's painted in. */
  palette: number;
  /** The project the office was started in (`droid-office <dir>`): the office keeps its own data in its checkout. */
  local?: boolean;
  /** The home folder's floor: always in the building, so it can't be taken off. */
  home?: boolean;
  addedBy: string;
  addedAt: number;
  /**
   * For the elevator panel: what's under way there. `workers` counts the ones hired onto
   * desks, bean bags and the meeting room's table, not the board agents at their kiosks.
   */
  workers: number;
  busy: number;
  /** Workers waiting on someone: a question, a permission, or a finished turn nobody looked at. */
  waiting: number;
}

/** The workspace folder on the office's machine: where the elevator's "add a project" looks for existing checkouts. Nothing is ever cloned. */
export interface ProjectsDirState {
  /** For showing people: under the home folder it's ~/…. */
  dir: string;
  /** Set from ⚙️ Settings or --projects, rather than the office's default (a code folder in the home folder, else the home folder). */
  custom: boolean;
  by?: string;
  at?: number;
}

/** A git checkout found in the workspace folder, for the elevator's "add a project". */
export interface RepoChoice {
  /** owner/name (GitHub) or host/group/…/project (GitLab) from its origin remote, else its folder's name. */
  name: string;
  /** Where it is on the office's machine (absolute). */
  dir: string;
  /** The GitHub or GitLab repository its origin points at, when it has one. */
  repo?: string;
  forge?: Forge;
  /** ISO time it was last touched (committed to, checked out…). */
  activeAt?: string;
}

/** Everything that belongs to the floor you're on: sent when you walk in, and when you change floors. */
export interface FloorView {
  /** The floor you're on; null while the building has none. */
  floor: string | null;
  project: ProjectInfo | null;
  workers: WorkerInfo[];
  issues: GhState<GhIssue>;
  pulls: GhState<GhPull>;
  queue: QueueState;
  /** Pictures on this floor's walls. */
  decor: Decoration[];
  services: ServicesState;
  /** What the lounge jukebox is playing. */
  jukebox: JukeboxState;
  /** Who's at the arcade cabinet, what's on its screen, and the building's high scores. */
  cabinet: CabinetView;
  /** The meeting room: who's meeting about what, and the meetings before. */
  meeting: MeetingState;
  /** The office's Jira connection and this floor's epic. */
  jira: JiraFloorState;
  /** The Jira tab of the issue board; null on a floor without an epic. */
  jiraBoard: JiraBoardState | null;
}

/** A web server a worker started (a dev server, a preview), found by the ports it listens on. */
export interface ServiceInfo {
  port: number;
  /** The address the office reaches it on, on its own machine. */
  host: string;
  pid: number;
  /** Its command line, shortened, e.g. "vite --port 5173". */
  command: string;
  /** The worker whose terminal started it. */
  workerId: string;
  /** Its working directory relative to its floor's checkout ('' is the project root). */
  cwd?: string;
  /** The <title> of its front page. */
  title?: string;
  since: number;
}

export interface ServicesState {
  items: ServiceInfo[];
  /** The office's port on its machine. Service tunnels end there and the office relays them. */
  port: number;
  /** user@host the owner tunnels with (offices deployed with deploy/aws.sh), e.g. ubuntu@203.0.113.7 */
  ssh?: string;
}

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'T' | '?';

/** One file a worker changed, against the base of its branch. */
export interface ChangedFile {
  path: string;
  /** The old path, when the file was renamed. */
  from?: string;
  /** M modified, A added, D deleted, R renamed, T type changed, ? untracked (new, never committed). */
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Not committed yet: staged, unstaged or untracked. */
  uncommitted: boolean;
  /** Fingerprint of the working copy (size and mtime); a new value means the diff changed. */
  sig: string;
}

/** Changed files the Changes window can show as a picture (GET /api/changes/file), by extension. */
const CHANGED_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/** The content type of a changed picture, or undefined when the file isn't one. */
export function changedImageType(filePath: string): string | undefined {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(CHANGED_IMAGE_TYPES, ext) ? CHANGED_IMAGE_TYPES[ext] : undefined;
}

/** What a worker changed in its checkout, against the branch the office was opened on. */
export interface ChangesState {
  workerId: string;
  /** Another floor's repository of a worker across repositories (see WorkerInfo.repos); none for its own. */
  repo?: string;
  /** The checkout, relative to the office dir ('' is the project folder itself, shared by everyone). */
  dir: string;
  /** Current branch of that checkout ('HEAD' when detached). */
  branch?: string;
  /** What the diff is against: the base branch, an upstream, or 'HEAD' (uncommitted changes only). */
  base: string;
  /** Commits on the branch since the base. */
  ahead: number;
  /** Subject of the newest commit, when ahead > 0. */
  subject?: string;
  files: ChangedFile[];
  /** Files left out because there were more than the office lists. */
  more: number;
  /** The branch a pull request would target, when this checkout is on a branch of its own. */
  prBase?: string;
  /** An open pull request for the branch. */
  pr?: { number: number; url: string };
  /** A commit, discard or pull request in progress. */
  busy?: string;
  error?: string;
  at: number;
}

export interface VersionInfo {
  sha: string;
  subject: string;
  /** ISO commit date */
  date: string;
}

/** Self-upgrade of an office installed from git by deploy/aws.sh (see server/upgrade.ts). */
export interface UpgradeState {
  /** False when the office can't upgrade itself (not installed by deploy/aws.sh). */
  available: boolean;
  current?: VersionInfo;
  /** Newest commit upstream, when it differs from current. */
  latest?: VersionInfo;
  /** New commits since current, newest first (at most 15). */
  changes?: { sha: string; subject: string }[];
  /** How many new commits there are in all ("50" means 50 or more). */
  behind?: number;
  checking?: boolean;
  checkedAt?: number;
  phase: 'idle' | 'building' | 'restarting' | 'failed';
  /** Who started the upgrade. */
  by?: string;
  error?: string;
}

export type Weather = 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog';
export const WEATHERS: readonly Weather[] = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'];

/** What it's like outside the windows. The server decides it, so everyone sees the same sky. */
export interface SkyState {
  /** Where the office is, for the sun: a configured city, or a guess from the host's time zone. */
  lat: number;
  lon: number;
  /** The office's clock, in minutes east of UTC. */
  utcOffset: number;
  weather: Weather;
  /** 0–1: a drizzle to a downpour, a few flakes to a blizzard, haze to pea soup. */
  intensity: number;
  /** The city whose live forecast this is. Unset when the weather is made up or pinned. */
  city?: string;
  /** °C, from the forecast. */
  temp?: number;
}

/**
 * Whether a worker whose pull request merged goes home by itself (⚙️ Settings), for every floor:
 * once it's at rest and nobody has its terminal open, it leaves and its worktree and branch are deleted.
 */
export interface LeaveOnMergeState {
  on: boolean;
  /** Who set it, and when. Unset for the default (off). */
  by?: string;
  at?: number;
}

/** What ⚙️ Settings → Subagents sets: how workers hire subagents with office-workers (see server/team.ts). */
export interface SubagentSettings {
  /** Workers may hire subagents at all. Off: `office-workers hire` is refused; a team already working carries on. */
  on: boolean;
  /** Desk workers may hire too, not just the Team lead at its kiosk. */
  deskWorkers: boolean;
  /** Keep the droid-office-subagents skill in ~/.factory/skills, so Droid workers know how to hire. */
  skill: boolean;
  /** What a subagent runs when its lead doesn't pick. Unset: the office's default worker. */
  agent?: AgentChoice;
  /** Each subagent gets its own git worktree unless its lead asks for none. */
  worktree: boolean;
  /** The most subagents one lead has on the floor at once. */
  maxPerLead: number;
  /** A lead at rest is prompted to read what its subagents said once they report or finish. */
  wakeLead: boolean;
}

export const SUBAGENT_DEFAULTS: SubagentSettings = { on: true, deskWorkers: true, skill: true, worktree: true, maxPerLead: 4, wakeLead: true };
export const SUBAGENT_MAX_PER_LEAD = 8;

/** The Subagents settings for every floor, with who set them and where the Droid skill is. */
export interface SubagentsState extends SubagentSettings {
  by?: string;
  at?: number;
  /** The skill's SKILL.md, when it's installed. */
  skillPath?: string;
  /** Why the skill couldn't be written or taken away. */
  skillError?: string;
}

/** A line of a worker's terminal that matched a search. */
export interface TerminalHit {
  workerId: string;
  /** The line, cut down around the match. */
  text: string;
  /** Where it is: its row in the worker's terminal, and how many rows that terminal had. */
  row: number;
  rows: number;
}

/** What GET /api/search answers: matching terminal lines, newest first. */
export interface SearchResults {
  q: string;
  terminals: TerminalHit[];
  /** More lines matched than these. */
  more: boolean;
}

/** Why the gong rang. */
export type GongWhy = 'hit' | 'merged' | 'queue';

export type ClientMsg =
  | { t: 'profile'; name: string; color: string; look: Look }
  /**
   * With `issue`, the worker is there for that GitHub issue: it's assigned on GitHub (so it moves to In progress) and taken off the queue.
   * `deskId` is a seat's id, or AUTO_DESK (`"auto"`) for the first free desk on the sender's floor (then the first free bean bag).
   */
  | { t: 'worker.spawn'; deskId: string; prompt?: string; worktree?: boolean; kind?: WorkerKind; model?: string; effort?: AgentEffort; issue?: number; repos?: string[]; images?: string[] }
  | { t: 'worker.resume'; workerId: string }
  /** `deleteSession`: a cloud worker's Factory session is deleted too, not just left in the Sessions window. */
  | { t: 'worker.kill'; workerId: string; cleanup?: WorktreeCleanup; deleteSession?: boolean }
  /** Drops the worker for 30 seconds; expiry deletes its owned worktrees and branches. */
  | { t: 'worker.shoot'; workerId: string }
  /** Revives a nearby shot worker before its deadline, without restarting its session. */
  | { t: 'worker.revive'; workerId: string }
  /** Asks what the worker's worktree holds; answered with a `worker.worktree` message. */
  | { t: 'worker.worktree'; workerId: string }
  /** Puts a lost worker's worktree back and starts it again (see WorkerInfo.lost); `all`: every lost worker on the floor. */
  | { t: 'worker.rebuild'; workerId: string; all?: boolean }
  | { t: 'worker.attach'; workerId: string }
  | { t: 'worker.detach'; workerId: string }
  /**
   * Makes a guest one of the office's own workers (see GuestInfo.cantBringIn): its process outside
   * the office is asked to quit, and a worker at the same desk, with the same name, resumes its session.
   */
  | { t: 'guest.bringIn'; workerId: string }
  /** With `issue`, the prompt hands the worker that GitHub issue, which is taken as for worker.spawn. */
  | { t: 'worker.prompt'; workerId: string; prompt: string; issue?: number; images?: string[] }
  /**
   * A prompt for the agent standing by a board (`deskId` is its kiosk, see STATIONS in layout). It's
   * typed into its session, which is woken up first if it's asleep, or hired there when nobody is.
   * `model`/`effort` pick its engine when it's hired; an agent that's already there keeps its own.
   */
  | { t: 'station.prompt'; deskId: string; prompt: string; model?: string; effort?: AgentEffort; images?: string[] }
  /** Push a worktree worker's branch and open a pull request for it, drafted from its task. */
  | { t: 'worker.pr'; workerId: string }
  | { t: 'term.input'; workerId: string; data: string }
  | { t: 'term.resize'; workerId: string; cols: number; rows: number }
  | { t: 'gh.refresh' }
  /** Merge a pull request; the answer comes back as gh.merged. */
  | { t: 'gh.merge'; number: number; method: GhMergeMethod; deleteBranch: boolean; auto?: boolean }
  /** Comment on an issue or a PR's conversation, as the server's gh account; answered with gh.commented. */
  | { t: 'gh.comment'; kind: 'issue' | 'pull'; number: number; body: string }
  /** Hit the office gong (E at the gong); everyone on the floor hears it. */
  | { t: 'gong' }
  /** Blow the DJ's air horn on the roof; everyone up there hears it. */
  | { t: 'horn' }
  /** Close an issue, or a pull request without merging it; the answer comes back as gh.closed. */
  | { t: 'gh.close'; kind: 'issue' | 'pull'; number: number; comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }
  /** Put labels on an issue or PR and take others off, as the server's gh or glab account; answered with gh.labeled. */
  | { t: 'gh.labels'; kind: 'issue' | 'pull'; number: number; add: string[]; remove: string[] }
  | { t: 'queue.add'; prompt: string; title?: string; issue?: number; model?: string; effort?: AgentEffort; images?: string[] }
  | { t: 'queue.remove'; taskId: string }
  /** Move a queued task up (-1) or down (+1) the queue. */
  | { t: 'queue.move'; taskId: string; delta: number }
  /** Put a finished task back on the queue. */
  | { t: 'queue.retry'; taskId: string }
  /** Forget the finished tasks. */
  | { t: 'queue.clear' }
  | { t: 'queue.limit'; maxWorkers: number }
  /** Call a meeting: workers sit down round the meeting room's table and work through it in rounds. */
  | ({ t: 'meeting.start' } & MeetingRequest)
  /** Stop the meeting that's running; its workers stay at the table. */
  | { t: 'meeting.stop' }
  /** Send the last meeting's workers home and clear the table. */
  | { t: 'meeting.clear' }
  /** Set the office's Slack / Discord webhook; '' removes it. */
  | { t: 'notify.webhook'; url: string }
  /** Post a test message through the webhook; the outcome comes back as a toast. */
  | { t: 'notify.test' }
  /** The most workers the office runs at once, across every floor; null takes the limit off. */
  | { t: 'machine.limit'; limit: number | null }
  /** Connect the office to Jira Cloud with one account's email and API token (read-only is enough); answered with `jira.setup`. */
  | { t: 'jira.connect'; site: string; email: string; token: string }
  /** Forget the office's Jira connection. */
  | { t: 'jira.disconnect' }
  /** Show a Jira epic on the floor you're on ('' removes it); answered with `jira.setup`. */
  | { t: 'jira.epic'; key: string }
  /** Read the floor's Jira tab again now. */
  | { t: 'jira.refresh' }
  /** Connect the office to Factory with an API key (replacing the one it has); answered with `factory.setup`. */
  | { t: 'factory.connect'; key: string }
  /** Forget the office's Factory key, and everything read with it. */
  | { t: 'factory.disconnect' }
  /** Read one Factory feature again now; without one, check the key again ("Check again") and read them all. */
  | { t: 'factory.refresh'; feature?: FactoryFeatureId }
  /** A board or window of `feature` opened (`on`) or closed in this tab: it polls fast while one is open. */
  | { t: 'factory.watch'; feature: FactoryFeatureId; on: boolean }
  /**
   * Follow what a worker changed (the office polls its checkout while anyone watches). `repo` is another
   * floor's repository of a worker across repositories; none follows its own.
   */
  | { t: 'changes.watch'; workerId: string; repo?: string }
  | { t: 'changes.unwatch'; workerId: string; repo?: string }
  | { t: 'changes.diff'; workerId: string; path: string; repo?: string }
  | { t: 'changes.commit'; workerId: string; message: string; repo?: string }
  /** Without a path, throws away every uncommitted change in that checkout. */
  | { t: 'changes.discard'; workerId: string; path?: string; repo?: string }
  | { t: 'changes.pr'; workerId: string; title: string; body: string; repo?: string }
  | { t: 'upgrade.check' }
  | { t: 'upgrade.start' }
  /** Hang a picture on a wall. */
  | { t: 'decor.add'; decor: DecorPlacement }
  /** Move, resize, re-frame or swap the image of a picture. */
  | { t: 'decor.update'; id: string; decor: Partial<DecorPlacement> }
  | { t: 'decor.remove'; id: string }
  /** Put a tune on the jukebox (a JUKEBOX_TUNES id), or a stream; with neither, turn it back on. */
  | { t: 'jukebox.play'; track?: string; url?: string }
  /** On to the next tune. */
  | { t: 'jukebox.skip' }
  | { t: 'jukebox.stop' }
  /**
   * Step up to the arcade cabinet on your floor to carry on with `game` (one the office started for
   * this connection), or to start a new game, even while you're at it; the office answers with
   * `cabinet`, naming your game. Each connection plays its own game.
   */
  | { t: 'cabinet.play'; game?: string }
  | { t: 'cabinet.leave' }
  /**
   * Your game as it looks now. It's how your score gets on the high-score table: the office follows
   * the game frame by frame.
   */
  | { t: 'cabinet.frame'; frame: CabinetFrame }
  /**
   * Go to another floor; the server answers with `floor.enter`. By elevator you arrive in the car;
   * `at` is where you arrive instead: the same spot on the other floor (switching floors from the
   * floor list), or the ladder or fire pole you came by.
   */
  | { t: 'floor.go'; floor: string; at?: { x: number; y: number; z: number; rotY: number } }
  /** The checkouts in the workspace folder that could become a floor; answered with `floor.repos`. */
  | { t: 'floor.repos'; refresh?: boolean }
  /** Make an existing checkout (its full path, in the workspace folder) a new floor, where it is; answered with `floor.added`. */
  | { t: 'floor.add'; dir: string }
  /** Take a floor off the building. Its checkout stays on disk; everyone on it rides to another floor. */
  | { t: 'floor.remove'; floor: string }
  /** Workers whose pull request merged go home by themselves (true), or wait to be sent home. */
  | { t: 'leaveOnMerge.set'; on: boolean }
  /** How workers hire subagents (⚙️ Settings → Subagents), for every floor. */
  | { t: 'subagents.set'; settings: SubagentSettings }
  /** Where the office looks for checkouts from now on; '' goes back to the default. */
  | { t: 'floor.projectsDir'; dir: string }
  /** Rewrite one of the office's prompts; null puts the default back. */
  | { t: 'prompts.set'; id: PromptId; text: string | null }
  /** Pick the worker a new one starts on when nobody picks; null goes back to the office's --agent. */
  | { t: 'prompts.agent'; choice: AgentChoice | null }
  /** The answer to an `automation.run`: what the command resolved with, or why it rejected. */
  | { t: 'automation.result'; id: string; ok: boolean; value?: unknown; error?: string }
  | { t: 'ping'; at: number };

/**
 * Where the server put this connection: which floor it is on (ROOF, or null out in the empty
 * lobby) and where to stand on it. The client places the owner from this, never from a peer list.
 */
export interface Arrival {
  floor: string | null;
  /** Where to stand, when the requested or saved spot is valid on this floor. */
  at?: { x: number; y: number; z: number; rotY: number };
  /** How the server chose it; the client uses it for fallbacks and notices. */
  via: 'saved' | 'requested' | 'elevator' | 'roof' | 'lobby';
  /** The remembered floor no longer exists. */
  removed?: boolean;
}

export type ServerMsg =
  | ({
      t: 'welcome';
      /** This connection's transport id; never shown, never a player. */
      connection: string;
      /** Where the owner arrives: the floor, the spot, and how the server chose it. */
      arrival: Arrival;
      /** Every floor of the building, for the elevator. */
      floors: FloorInfo[];
      /** Where the office looks for checkouts to add as floors, on the office's machine. */
      projectsDir: ProjectsDirState;
      /** The running server's version; a change after a reconnect means the office was upgraded. */
      version: string;
      upgrade: UpgradeState;
      notify: NotifyState;
      machine: MachineState;
      /** Outside the windows: the same on every floor. */
      sky: SkyState;
      leaveOnMerge: LeaveOnMergeState;
      subagents: SubagentsState;
      /** The office's prompts, and the worker a new one starts on when nobody picks. */
      prompts: PromptsState;
      /** The office's Factory connection and every Factory feature's read state (see docs/factory.md). */
      factory: FactoryState;
    } & FloorView)
  /** You arrived on another floor: everything on it, replacing the last one's. */
  | ({ t: 'floor.enter'; arrival: Arrival } & FloorView)
  | { t: 'floors'; floors: FloorInfo[] }
  /** Sent to whoever asked. */
  | { t: 'floor.repos'; repos: RepoChoice[]; error?: string }
  /** Sent to whoever asked for the floor (or couldn't get it). `dir` is the checkout they asked for. */
  | { t: 'floor.added'; dir: string; floor?: string; error?: string }
  /** The projects folder moved (see floor.projectsDir). */
  | { t: 'projectsDir'; state: ProjectsDirState }
  | { t: 'worker.update'; worker: WorkerInfo }
  | { t: 'worker.remove'; workerId: string }
  | { t: 'worker.worktree'; workerId: string; state: WorktreeState }
  | { t: 'screen'; workerId: string; cols: number; rows: number; lines: Record<number, Run[]>; full: boolean; cursor: [number, number] }
  | { t: 'term.snapshot'; workerId: string; data: string; cols: number; rows: number }
  | { t: 'term.data'; workerId: string; data: string }
  | { t: 'gh.issues'; state: GhState<GhIssue> }
  | { t: 'gh.pulls'; state: GhState<GhPull> }
  /** Sent to whoever asked for the merge. */
  | { t: 'gh.merged'; number: number; error?: string }
  /** Sent to whoever commented: the comment as GitHub saved it, or why it wasn't. */
  | { t: 'gh.commented'; kind: 'issue' | 'pull'; number: number; comment?: GhComment; error?: string }
  /**
   * The gong rings, for everyone on the floor: someone hit it, pull request `pr` merged (confetti
   * over the desk it came from), or the last task on the queue just finished (a bigger party).
   */
  | { t: 'gong'; why: GongWhy; by?: string; pr?: number }
  /** Someone on the roof blew the DJ's air horn (sent to everyone up there, them too). */
  | { t: 'horn'; by: string }
  /** Sent to whoever asked to close it. */
  | { t: 'gh.closed'; kind: 'issue' | 'pull'; number: number; error?: string }
  /** Sent to whoever changed them: the labels it has now, or why they didn't change. */
  | { t: 'gh.labeled'; kind: 'issue' | 'pull'; number: number; labels?: GhLabel[]; error?: string }
  /**
   * A line for the toast stack. `workerId` names the worker it is about, when one is: a client
   * already showing that in its world can leave the text out.
   */
  | { t: 'toast'; text: string; level: 'info' | 'warn' | 'error'; workerId?: string }
  | { t: 'upgrade'; state: UpgradeState }
  | { t: 'services'; state: ServicesState }
  | { t: 'decor'; items: Decoration[] }
  | { t: 'jukebox'; state: JukeboxState }
  /** Your game on the arcade cabinet on your floor now, and the building's high scores. */
  | { t: 'cabinet'; state: CabinetState }
  | { t: 'queue'; state: QueueState }
  | { t: 'meeting'; state: MeetingState }
  | { t: 'notify'; state: NotifyState }
  /** The office's Jira connection or this floor's epic changed. */
  | { t: 'jira'; state: JiraFloorState }
  | { t: 'jira.board'; state: JiraBoardState | null }
  /** To whoever is setting Jira up: done, or why not. */
  | { t: 'jira.setup'; step: 'connect' | 'epic'; ok?: boolean; error?: string }
  /** The Factory connection or a Factory feature's slice changed: all of it, to everyone. */
  | { t: 'factory'; state: FactoryState }
  /** To whoever sent `factory.connect`: connected, or why not. */
  | { t: 'factory.setup'; ok: boolean; error?: string }
  | { t: 'machine'; state: MachineState }
  | { t: 'sky'; state: SkyState }
  | { t: 'leaveOnMerge'; state: LeaveOnMergeState }
  | { t: 'subagents'; state: SubagentsState }
  | { t: 'prompts'; state: PromptsState }
  /** Sent to whoever watches that worker's changes, whenever they change. */
  | { t: 'changes'; state: ChangesState }
  | { t: 'changes.diff'; workerId: string; repo?: string; path: string; diff: string; truncated: boolean; error?: string }
  /**
   * Run a `window.office` command in this tab (POST /api/automation) and answer with
   * `automation.result` under the same id.
   */
  | { t: 'automation.run'; id: string; cmd: string; args: unknown[] }
  /** `now` is the office's clock as it answered, which the jukebox keeps time by. */
  | { t: 'pong'; at: number; now: number };
