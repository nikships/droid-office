// The office's management tools as a companion offers them (the web companion's tool rail and the
// Android app's Management view): which there are, what each needs before it can open, the HTTP a
// sealed host may forward for them, and the messages between that host's page and its native side.
// Pure: the client host (src/client/companion-tools.ts) and the tests both load it.

import type { ClientMsg, ServerMsg } from './protocol.js';

export const TOOL_IDS = [
  'issues',
  'pulls',
  'jira',
  'pipelines',
  'ci',
  'changes',
  'docs',
  'wiki',
  'computers',
  'environments',
  'cloud',
  'floors',
  'settings',
  'prompts',
  'subscriptions',
  'host-update',
  'upgrade',
  'welcome',
  'whiteboard',
  'search',
  'hire',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export type ToolGroup = 'Floor' | 'Workers' | 'Factory' | 'Office';
/** What a tool is about: this floor (closes when the floor changes), the whole office, or one worker. */
export type ToolScope = 'floor' | 'office' | 'worker';

export interface ToolDef {
  id: ToolId;
  icon: string;
  label: string;
  group: ToolGroup;
  scope: ToolScope;
  /** Listed in the tool rail. Worker tools open from a worker's actions instead. */
  listed: boolean;
}

export const TOOLS: readonly ToolDef[] = [
  { id: 'issues', icon: '📌', label: 'Issues', group: 'Floor', scope: 'floor', listed: true },
  { id: 'pulls', icon: '🔀', label: 'Pull requests', group: 'Floor', scope: 'floor', listed: true },
  { id: 'jira', icon: '🎫', label: 'Jira', group: 'Floor', scope: 'floor', listed: true },
  { id: 'pipelines', icon: '🚀', label: 'Pipelines', group: 'Floor', scope: 'floor', listed: true },
  { id: 'ci', icon: '🏭', label: 'CI automations', group: 'Factory', scope: 'floor', listed: true },
  { id: 'whiteboard', icon: '🧑‍🎨', label: 'Whiteboard', group: 'Floor', scope: 'floor', listed: true },
  { id: 'docs', icon: '📚', label: 'Docs', group: 'Floor', scope: 'floor', listed: true },
  { id: 'wiki', icon: '📖', label: 'AutoWiki', group: 'Factory', scope: 'floor', listed: true },
  { id: 'search', icon: '🔎', label: 'Search terminals', group: 'Floor', scope: 'floor', listed: true },
  { id: 'hire', icon: '✨', label: 'Hire a worker', group: 'Workers', scope: 'floor', listed: true },
  { id: 'changes', icon: '🌿', label: 'Changes', group: 'Workers', scope: 'worker', listed: false },
  { id: 'cloud', icon: '☁️', label: 'Cloud worker', group: 'Workers', scope: 'worker', listed: false },
  { id: 'computers', icon: '🖥️', label: 'Computers', group: 'Factory', scope: 'office', listed: true },
  { id: 'environments', icon: '⧉', label: 'Environments', group: 'Factory', scope: 'office', listed: true },
  { id: 'floors', icon: '🛗', label: 'Floors', group: 'Office', scope: 'office', listed: true },
  { id: 'settings', icon: '⚙️', label: 'Settings', group: 'Office', scope: 'office', listed: true },
  { id: 'prompts', icon: '📝', label: 'Prompts', group: 'Office', scope: 'office', listed: true },
  { id: 'subscriptions', icon: '💳', label: 'Subscriptions', group: 'Office', scope: 'office', listed: true },
  { id: 'welcome', icon: '👋', label: 'Setup', group: 'Office', scope: 'office', listed: true },
  { id: 'upgrade', icon: '⬆️', label: 'Upgrade the office', group: 'Office', scope: 'office', listed: true },
  { id: 'host-update', icon: '💻', label: 'Host app update', group: 'Office', scope: 'office', listed: true },
];

export const TOOL_BY_ID: ReadonlyMap<ToolId, ToolDef> = new Map(TOOLS.map((t) => [t.id, t]));

export function isToolId(v: unknown): v is ToolId {
  return typeof v === 'string' && (TOOL_IDS as readonly string[]).includes(v);
}

/** Where a tool opens: the worker, card, run or tab to show first. */
export interface ToolArgs {
  workerId?: string;
  repo?: string;
  card?: string;
  pane?: string;
  number?: number;
  runId?: number;
  deskId?: string;
  kind?: 'agent' | 'shell' | 'station';
}

/** Only the fields a ToolArgs can carry, of the right types: what a bridge or a URL handed over. */
export function cleanToolArgs(v: unknown): ToolArgs {
  if (!v || typeof v !== 'object') return {};
  const a = v as Record<string, unknown>;
  const str = (x: unknown, max: number) => (typeof x === 'string' && x && x.length <= max ? x : undefined);
  const int = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) && x > 0 ? x : undefined);
  const out: ToolArgs = {
    workerId: str(a.workerId, 64),
    repo: str(a.repo, 200),
    card: str(a.card, 200),
    pane: str(a.pane, 40),
    number: int(a.number),
    runId: int(a.runId),
    deskId: str(a.deskId, 32),
    kind: a.kind === 'agent' || a.kind === 'shell' || a.kind === 'station' ? a.kind : undefined,
  };
  for (const k of Object.keys(out) as (keyof ToolArgs)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** What availability is judged on: a plain summary of the office as the page knows it. */
export interface ToolContext {
  /** Connected, and the office has said which floor this connection is on. */
  ready: boolean;
  /** The floor this connection is on; null on the roof or before any floor exists. */
  floor: string | null;
  /** The floor's project isn't a git checkout: no boards, pipelines or changes. */
  plainFloor: boolean;
  factoryConnected: boolean;
  /** This floor has a Jira epic. */
  jiraEpic: boolean;
  /** The office can upgrade itself (a source checkout). */
  upgradeAvailable: boolean;
  /** The worker a worker tool is for, as the floor has it. */
  worker?: { kind: 'agent' | 'shell' | 'cloud'; cloud: boolean; guest: boolean; lost: boolean };
}

export type Availability = { available: true } | { available: false; reason: string };

const no = (reason: string): Availability => ({ available: false, reason });
const yes: Availability = { available: true };

/** Whether a tool can open now, and in words why not. */
export function toolAvailability(id: ToolId, ctx: ToolContext, args: ToolArgs = {}): Availability {
  const def = TOOL_BY_ID.get(id);
  if (!def) return no('There is no such tool.');
  if (!ctx.ready) return no('Waiting for the office to connect.');
  if (def.scope !== 'office' && !ctx.floor) return no('Pick a floor first: this works on one floor at a time.');
  switch (id) {
    case 'issues':
    case 'pulls':
    case 'pipelines':
    case 'search':
      return ctx.plainFloor && id !== 'search' ? no('This floor is a plain folder, not a git checkout, so it has no forge boards or pipelines.') : yes;
    case 'jira':
      return ctx.jiraEpic ? yes : no('This floor has no Jira epic. Connect Jira and set the floor’s epic in Settings → Connections.');
    case 'ci':
      if (!ctx.factoryConnected) return no('Connect Factory in Settings → Connections to see CI automations.');
      return ctx.plainFloor ? no('This floor is a plain folder, not a git checkout.') : yes;
    case 'wiki':
      return ctx.factoryConnected ? yes : no('Connect Factory in Settings → Connections to read and write the AutoWiki.');
    case 'environments':
      return ctx.factoryConnected ? yes : no('Connect Factory in Settings → Connections to manage Environments.');
    case 'upgrade':
      return ctx.upgradeAvailable ? yes : no('This office is the Mac app, which updates itself: use Host app update.');
    case 'changes': {
      const w = ctx.worker;
      if (!args.workerId || !w) return no('Pick a worker on this floor.');
      if (w.guest) return no('A guest runs outside the office, so the office has no changes of its to show.');
      if (w.cloud) return no('A cloud worker’s changes are on its Factory computer, not in this office.');
      if (ctx.plainFloor) return no('This floor is a plain folder, not a git checkout, so there are no changes to show.');
      return yes;
    }
    case 'cloud': {
      const w = ctx.worker;
      if (!args.workerId || !w) return no('Pick a worker on this floor.');
      return w.cloud ? yes : no('Only a cloud worker has a cloud window.');
    }
    default:
      return yes;
  }
}

/** What the office offers only on its own computer, or only in the 3D office, and why. Shown, never offered. */
export const NOT_OFFERED: readonly { id: string; label: string; reason: string }[] = [
  { id: 'decor', label: 'Pictures on the walls', reason: 'Hanging a picture is placing it on a wall in the 3D office.' },
  { id: 'jukebox', label: 'Jukebox', reason: 'The jukebox plays in the 3D office, near where it stands.' },
  { id: 'personal', label: 'You, Sound and Display settings', reason: 'Your character, sounds and graphics belong to the 3D office on its own screen.' },
  {
    id: 'pairing',
    label: 'Pairing phones and browsers',
    reason: 'Only the office’s own computer pairs or forgets a device, so a paired one can’t lock you out.',
  },
  { id: 'hot-reload', label: 'Source hot reload', reason: 'It rebuilds the office from source on its own computer.' },
];

// ---- What a worker can have done to it --------------------------------------------------------------

export const WORKER_ACTION_IDS = ['resume', 'fork', 'rebuild', 'send-home', 'pr', 'changes', 'cloud', 'bring-in', 'station-ask'] as const;
export type WorkerActionId = (typeof WORKER_ACTION_IDS)[number];

export interface WorkerActionFacts {
  kind: 'agent' | 'shell' | 'cloud';
  /** Asleep (stopped, its session saved). */
  asleep: boolean;
  /** Mid-turn. */
  busy: boolean;
  cloud: boolean;
  guest: boolean;
  /** The guest can't be brought in, and why. */
  cantBringIn?: string;
  lost: boolean;
  worktree: boolean;
  prOpen: boolean;
  prOpening: boolean;
  /** Works across other floors' repositories too. */
  repos: boolean;
  /** Sits at a board agent's kiosk. */
  station: boolean;
  /** Why a fork is refused, if it is (forkRefusal). */
  forkRefusal?: string;
  plainFloor: boolean;
}

export interface WorkerAction {
  id: WorkerActionId;
  icon: string;
  label: string;
  /** Destructive: the companion asks before it does it. */
  danger?: boolean;
  available: boolean;
  reason?: string;
}

/** The actions a worker offers, in order, with why each one that can't be done now can't. */
export function workerActions(w: WorkerActionFacts): WorkerAction[] {
  const out: WorkerAction[] = [];
  const add = (id: WorkerActionId, icon: string, label: string, reason?: string, danger?: boolean) => out.push({ id, icon, label, available: !reason, ...(reason ? { reason } : {}), ...(danger ? { danger } : {}) });
  if (w.guest) {
    add('bring-in', '🚪', 'Bring into the office', w.cantBringIn);
    return out;
  }
  if (w.station) add('station-ask', '💬', 'Ask the board agent');
  if (w.cloud) add('cloud', '☁️', 'Cloud window');
  else {
    add('resume', '▶️', 'Resume', w.asleep ? undefined : w.lost ? 'Its worktree is missing: rebuild it first' : 'It is awake');
    if (w.kind === 'agent') add('fork', '🍴', 'Fork', w.forkRefusal);
    if (w.worktree) add('rebuild', '🧱', 'Rebuild worktree', w.lost ? undefined : 'Its worktree is there');
    if (w.kind === 'agent' && !w.station) {
      const pr = !w.worktree
        ? 'It works in the main checkout: only a worker with its own worktree opens a pull request'
        : w.lost
          ? 'Its worktree is missing: rebuild it first'
          : w.prOpening
            ? 'Opening its pull request…'
            : !w.prOpen && w.busy
              ? 'It is mid-turn: wait until it is done'
              : undefined;
      add('pr', '🔀', w.prOpen ? (w.repos ? 'Pull requests' : 'Pull request') : 'Open a pull request', pr);
    }
    if (!w.station) add('changes', '🌿', 'Changes', w.plainFloor ? 'This floor is a plain folder, not a git checkout' : w.lost ? 'Its worktree is missing: rebuild it first' : undefined);
  }
  add('send-home', '🏠', 'Send home', undefined, true);
  return out;
}

// ---- The sealed host's HTTP -------------------------------------------------------------------------

/** The most a page may send in one request: pictures and Whiteboard files, or JSON. */
export const TOOL_UPLOAD_MAX = 25 * 1024 * 1024;
export const TOOL_JSON_MAX = 3 * 1024 * 1024;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Paths only the office's own computer uses, refused before the allowlist is asked. */
const REFUSED = [/^\/api\/mobile\//, /^\/api\/hot-reload/, /^\/api\/gpu$/, /^\/api\/haptics$/, /^\/api\/automation$/, /^\/api\/status$/, /^\/api\/term\/drop$/, /^\/api\/decor\//, /^\/api\/jukebox\//];

const ALLOWED: Record<Method, readonly RegExp[]> = {
  GET: [
    /^\/api\/gh\/(pull|issue|labels|pull\/diff)$/,
    /^\/api\/docs(\/file|\/search|\/picture)?$/,
    /^\/api\/search$/,
    /^\/api\/jira\/ticket$/,
    /^\/api\/factory\/[\w./-]+$/,
    /^\/api\/agents\/droid\/(models|commands)$/,
    /^\/api\/host\/update$/,
    /^\/api\/changes\/file$/,
    /^\/api\/whiteboard\/(render|render\/status|file)$/,
  ],
  POST: [/^\/api\/factory\/[\w./-]+$/, /^\/api\/whiteboard\/blob$/, /^\/api\/prompt\/image$/, /^\/api\/host\/update$/],
  PUT: [/^\/api\/docs\/file$/, /^\/api\/factory\/[\w./-]+$/],
  PATCH: [/^\/api\/factory\/[\w./-]+$/],
  DELETE: [/^\/api\/prompt\/image$/, /^\/api\/factory\/[\w./-]+$/],
};

/**
 * Whether a sealed host's native side forwards this request to the office with the device's credential.
 * `path` is the path alone, before any `?`. Anything not listed is refused, as is a path that climbs
 * (`..`), repeats a slash or carries an encoded one.
 */
export function isAllowedToolRequest(method: string, path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.length > 512) return false;
  if (path.includes('..') || path.includes('//') || path.split('/').includes('.') || /%2f|%5c|\\/i.test(path) || /[?#\s]/.test(path)) return false;
  if (REFUSED.some((r) => r.test(path))) return false;
  const rules = Object.hasOwn(ALLOWED, method) ? ALLOWED[method as Method] : undefined;
  return !!rules?.some((r) => r.test(path));
}

/** GET paths a sealed page loads directly (pictures, fonts, card frames), which native serves through itself. */
export const TOOL_PASSTHROUGH_PREFIXES = [
  '/fonts/',
  '/icons/',
  '/factory-glyph.svg',
  '/favicon.svg',
  '/api/docs/picture',
  '/api/changes/file',
  '/api/whiteboard/render',
  '/api/whiteboard/file',
  '/api/factory/wiki/runs/',
  '/whiteboard/c/',
] as const;

// ---- The sealed host's bridge -----------------------------------------------------------------------

/** Page → native, as JSON through `DroidOfficeTools.postMessage`. */
export type ToolsToNative =
  /** The page is listening: send the bootstrap. */
  | { t: 'connect' }
  /** A message for the office's socket. Native sends it now or drops it (and says the socket is down); never queues. */
  | { t: 'send'; msg: ClientMsg }
  /** An HTTP request for the office; native checks isAllowedToolRequest and answers with `http.result`. */
  | { t: 'http'; id: number; method: string; path: string; query?: string; contentType?: string; body?: string; base64?: boolean }
  | { t: 'open-worker'; workerId: string; view: 'thread' | 'tty' }
  | { t: 'switch-floor'; floor: string }
  /** The tool closed itself (its ✕, or it finished). */
  | { t: 'closed' }
  /** A link to open outside the app; https only. */
  | { t: 'external'; url: string };

/** Native → page, through `droidOfficeTools.receive(obj)`. */
export type NativeToTools =
  /** The socket's current state: `messages` is its replay (see StateReplay), `open` the tool to show. */
  | { t: 'bootstrap'; up: boolean; messages: ServerMsg[]; open?: { tool: string; floor: string; args?: ToolArgs } }
  | { t: 'server'; msg: ServerMsg }
  | { t: 'status'; up: boolean }
  | { t: 'open'; tool: string; floor: string; args?: ToolArgs }
  | { t: 'close' }
  | { t: 'http.result'; id: number; status: number; contentType?: string; body?: string; base64?: boolean; error?: string };

/** A NativeToTools from whatever native handed over, or undefined when it isn't one. */
export function parseNativeToTools(v: unknown): NativeToTools | undefined {
  let value = v;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const m = value as Record<string, unknown>;
  const isMsg = (x: unknown): x is ServerMsg => !!x && typeof x === 'object' && typeof (x as { t?: unknown }).t === 'string';
  const open = (x: Record<string, unknown>) => (typeof x.tool === 'string' && typeof x.floor === 'string' ? { tool: x.tool, floor: x.floor, args: cleanToolArgs(x.args) } : undefined);
  switch (m.t) {
    case 'bootstrap': {
      if (typeof m.up !== 'boolean' || !Array.isArray(m.messages)) return undefined;
      const o = m.open && typeof m.open === 'object' ? open(m.open as Record<string, unknown>) : undefined;
      return { t: 'bootstrap', up: m.up, messages: m.messages.filter(isMsg), ...(o ? { open: o } : {}) };
    }
    case 'server':
      return isMsg(m.msg) ? { t: 'server', msg: m.msg } : undefined;
    case 'status':
      return typeof m.up === 'boolean' ? { t: 'status', up: m.up } : undefined;
    case 'open': {
      const o = open(m);
      return o ? { t: 'open', ...o } : undefined;
    }
    case 'close':
      return { t: 'close' };
    case 'http.result':
      if (typeof m.id !== 'number' || typeof m.status !== 'number') return undefined;
      return {
        t: 'http.result',
        id: m.id,
        status: m.status,
        ...(typeof m.contentType === 'string' ? { contentType: m.contentType } : {}),
        ...(typeof m.body === 'string' ? { body: m.body } : {}),
        ...(m.base64 === true ? { base64: true } : {}),
        ...(typeof m.error === 'string' ? { error: m.error } : {}),
      };
    default:
      return undefined;
  }
}

/** Whether a link may leave the app: https, with a host, and no credentials in it. */
export function isExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}
