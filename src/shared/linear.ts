// The office's Linear workspace (see server/linear.ts): the shapes the office, the browser and the
// Office MCP share, and the pure logic behind them, from the board's columns to what autopilot picks.

/** Linear's own buckets for a workflow state, whatever the team calls it. */
export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate';

export const LINEAR_STATE_TYPES: readonly LinearStateType[] = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'];

export interface LinearState {
  id: string;
  name: string;
  type: LinearStateType;
  color: string;
  position: number;
}

export interface LinearLabel {
  name: string;
  color: string;
}

/** Who on a floor works a ticket: a worker the office linked to it (by hand, autopilot or linear_start). */
export interface LinearWorkerRef {
  id: string;
  name: string;
}

/** A ticket on the Linear tab: one of the floor's team's open (or recently done) issues. */
export interface LinearTicket {
  id: string;
  /** DOFF-12 */
  identifier: string;
  title: string;
  url: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  priorityLabel: string;
  state: Omit<LinearState, 'position'>;
  /** Display name; missing when nobody is assigned. */
  assignee?: string;
  labels: LinearLabel[];
  project?: string;
  estimate?: number;
  /** ISO times. */
  createdAt: string;
  updatedAt: string;
  /** Linear's manual order within a state. */
  sortOrder: number;
  /** The worker on this floor the office linked to it, while it's at a desk. */
  worker?: LinearWorkerRef;
}

/** The Linear tab of a floor's issue board. */
export interface LinearBoardState {
  /** The team's key, e.g. DOFF. */
  team: string;
  /** The project it's narrowed to, by name. */
  project?: string;
  items: LinearTicket[];
  fetchedAt: number;
  loading: boolean;
  error?: string;
}

export interface LinearComment {
  id: string;
  author: string;
  /** Markdown, as Linear keeps it. */
  body: string;
  createdAt: string;
}

/** Everything the ticket window shows beyond the card: GET /api/linear/issue?id=… */
export interface LinearTicketDetail extends LinearTicket {
  description: string;
  creator?: string;
  /** Linear's suggested git branch name. */
  branchName: string;
  team: { id: string; key: string; name: string };
  parent?: { identifier: string; title: string };
  children: { identifier: string; title: string; state: string }[];
  attachments: { title: string; url: string }[];
  comments: LinearComment[];
}

export interface LinearProjectRef {
  id: string;
  name: string;
}

/** A team of the workspace, for the floor's team picker. */
export interface LinearTeamRef {
  id: string;
  key: string;
  name: string;
  /** What a new issue starts in when nobody picks a state. */
  defaultState?: LinearStateType;
  projects: LinearProjectRef[];
}

/** Who the office works Linear as. Never the key. */
export interface LinearConnection {
  /** The workspace's name and its url key (linear.app/<urlKey>). */
  workspace: string;
  urlKey: string;
  /** The account the key belongs to. */
  name: string;
  email: string;
  teams: LinearTeamRef[];
  by: string;
  at: number;
}

/** The team (and optionally project) a floor's Linear tab shows and its workers take tickets from. */
export interface LinearFloorSetup {
  team: { id: string; key: string; name: string };
  project?: LinearProjectRef;
  by: string;
  at: number;
}

/** Which tickets autopilot picks up: the ones waiting in these states. */
export type LinearPickup = 'triage' | 'backlog' | 'unstarted';
export const LINEAR_PICKUPS: readonly LinearPickup[] = ['triage', 'backlog', 'unstarted'];

/**
 * A floor's Linear autopilot: every ticket that lands in one of `pickup`'s states gets a worker of its
 * own, `max` at a time, so the owner's only job is writing tickets.
 */
export interface LinearAutopilot {
  on: boolean;
  pickup: LinearPickup[];
  /** Most autopilot workers on the floor at once. */
  max: number;
  /** Also tickets made before autopilot was turned on; otherwise only those made since `since`. */
  existing: boolean;
  /** When it was last turned on (ms). */
  since: number;
  /** The model autopilot workers run; the office default when unset. */
  model?: string;
  by: string;
  at: number;
}

export const AUTOPILOT_MAX = 8;

export const DEFAULT_AUTOPILOT: LinearAutopilot = { on: false, pickup: ['unstarted'], max: 2, existing: false, since: 0, by: '', at: 0 };

/** Linear on the floor you're on: the office's connection, this floor's team and its autopilot. */
export interface LinearFloorState {
  connection?: LinearConnection;
  setup?: LinearFloorSetup;
  autopilot: LinearAutopilot;
  /** Autopilot workers on this floor now, counted against its max. */
  working: number;
}

/** A link from Linear that is safe to open (http or https), else undefined. */
export function linkUrl(url: string): string | undefined {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined;
}

// ---- Keys --------------------------------------------------------------------------------------------

const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,9}-[1-9]\d{0,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An issue as Linear's API takes it: DOFF-12 in capitals (from "doff-12" or the issue's linear.app
 * URL), or an issue's UUID. Undefined for anything else.
 */
export function linearIssueRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || raw.length > 300) return undefined;
  if (UUID.test(raw)) return raw.toLowerCase();
  const fromUrl = /linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)/i.exec(raw)?.[1];
  const id = (fromUrl ?? raw).toUpperCase();
  return IDENTIFIER.test(id) ? id : undefined;
}

/** A Linear API key as Settings takes it; undefined when it can't be one. */
export function linearKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const k = value.trim();
  return /^lin_(api|oauth)_[A-Za-z0-9]{20,200}$/.test(k) ? k : undefined;
}

// ---- Priorities ------------------------------------------------------------------------------------

export const PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const;

/** Urgent first, then high, medium, low, and no priority last. */
export function priorityOrder(p: number): number {
  return p >= 1 && p <= 4 ? p : 5;
}

/** 0–4 from a number or a name ("urgent", "high", "p1", "none"…); undefined when it isn't one. */
export function linearPriority(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 4 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (/^[0-4]$/.test(v)) return Number(v);
  const p = /^p([1-4])$/.exec(v);
  if (p) return Number(p[1]);
  const i = ['none', 'urgent', 'high', 'medium', 'low'].indexOf(v === 'no priority' ? 'none' : v);
  return i >= 0 ? i : undefined;
}

// ---- The board ---------------------------------------------------------------------------------------

/** The Linear tab's columns, by state type, as Linear's own board groups them. Canceled and duplicate tickets aren't shown. */
export const LINEAR_COLUMNS: { name: string; types: LinearStateType[] }[] = [
  { name: 'Backlog', types: ['triage', 'backlog'] },
  { name: 'Todo', types: ['unstarted'] },
  { name: 'In Progress', types: ['started'] },
  { name: 'Done', types: ['completed'] },
];

/** Most urgent first; within a priority, Linear's own order. */
export function compareTickets(a: LinearTicket, b: LinearTicket): number {
  return priorityOrder(a.priority) - priorityOrder(b.priority) || a.sortOrder - b.sortOrder;
}

/** The tickets in each of the Linear tab's columns. Done is newest first; the rest most urgent first. */
export function linearColumns(items: LinearTicket[]): { name: string; items: LinearTicket[] }[] {
  return LINEAR_COLUMNS.map((c) => {
    const col = items.filter((t) => c.types.includes(t.state.type));
    col.sort(c.types.includes('completed') ? (a, b) => b.updatedAt.localeCompare(a.updatedAt) : compareTickets);
    return { name: c.name, items: col };
  });
}

// ---- Workflow ------------------------------------------------------------------------------------

export type LinearStage = 'started' | 'review' | 'completed';

/**
 * The state a ticket moves to at a stage of a worker's work: its first started state (In Progress),
 * a started state that says review (In Review), or its first completed state (Done). Review falls back
 * to undefined when the team has no such state, so the ticket stays where it is.
 */
export function stateForStage(states: LinearState[], stage: LinearStage): LinearState | undefined {
  const sorted = [...states].sort((a, b) => a.position - b.position);
  if (stage === 'completed') return sorted.find((s) => s.type === 'completed');
  const started = sorted.filter((s) => s.type === 'started');
  if (stage === 'review') return started.find((s) => /review/i.test(s.name));
  return started.find((s) => !/review/i.test(s.name)) ?? started[0];
}

/** A state by its name or its type ("In Review", "done", "started"…), in the team's own states. */
export function findState(states: LinearState[], want: string): LinearState | undefined {
  const w = want.trim().toLowerCase();
  if (!w) return undefined;
  const byName = states.find((s) => s.name.toLowerCase() === w);
  if (byName) return byName;
  const alias: Record<string, LinearStateType> = { todo: 'unstarted', 'to do': 'unstarted', 'in progress': 'started', progress: 'started', done: 'completed', complete: 'completed', closed: 'completed', cancelled: 'canceled' };
  const type = (LINEAR_STATE_TYPES as readonly string[]).includes(w) ? (w as LinearStateType) : alias[w];
  if (!type) return undefined;
  if (type === 'started' || type === 'completed') return stateForStage(states, type === 'started' ? 'started' : 'completed');
  return [...states].sort((a, b) => a.position - b.position).find((s) => s.type === type);
}

/**
 * The tickets autopilot hands out next, at most `room`: waiting in a picked-up state, not already
 * linked to a worker, assigned to nobody or to the office's own account, and made since autopilot was
 * turned on unless it takes existing tickets too. Most urgent first, then oldest.
 */
export function autopilotPicks(items: LinearTicket[], pilot: LinearAutopilot, linked: ReadonlySet<string>, room: number, self?: string): LinearTicket[] {
  if (!pilot.on || room <= 0) return [];
  return items
    .filter((t) => (pilot.pickup as string[]).includes(t.state.type))
    .filter((t) => !linked.has(t.id) && !t.worker)
    .filter((t) => !t.assignee || t.assignee === self)
    .filter((t) => pilot.existing || Date.parse(t.createdAt) >= pilot.since)
    .sort((a, b) => priorityOrder(a.priority) - priorityOrder(b.priority) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, room);
}

/** Lowercase letters and digits only, for matching a floor to a team by name. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The team a floor goes with when nobody picked one: the one whose name or key matches the floor's
 * name or its repository's. Never just the workspace's only team, which would put the same tickets
 * (and autopilot's pickings) on every floor of the building.
 */
export function guessTeam(teams: LinearTeamRef[], names: (string | undefined)[]): LinearTeamRef | undefined {
  const wanted = names.filter((n): n is string => !!n).flatMap((n) => [squash(n), squash(n.split('/').pop() ?? '')]);
  const hits = teams.filter((t) => wanted.includes(squash(t.name)) || wanted.includes(squash(t.key)));
  return hits.length === 1 ? hits[0] : undefined;
}

/** The first line a ticket's task starts with, which the office reads back to title its pull request. */
export function linearTaskLine(t: { identifier: string; title: string }): string {
  return `Work on Linear issue ${t.identifier}: "${t.title}".`;
}

/** DOFF-12 and its title from a task's first line, as linearTaskLine wrote it. */
export function linearTaskOf(firstLine: string): { identifier: string; title: string } | undefined {
  const m = /\bLinear issue ([A-Z][A-Z0-9_]*-\d+):\s*["“](.+?)["”]\.?\s*$/.exec(firstLine);
  return m ? { identifier: m[1], title: m[2] } : undefined;
}

/** What the "Linear ticket" prompt fills in. */
export function linearPromptVars(t: { identifier: string; title: string; url: string; description?: string; branchName?: string }, started?: string) {
  return {
    task: linearTaskLine(t),
    identifier: t.identifier,
    title: t.title,
    url: t.url,
    description: (t.description ?? '').trim() || '(No description.)',
    branchHint: t.branchName ? ` (Linear suggests \`${t.branchName}\`)` : '',
    started: started ?? 'In Progress',
  };
}
