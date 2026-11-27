// What a guest connection (a share link, see guest-links.ts) may send and receive on the WebSocket. Pure
// tables and checks shared by the server's gate and its tests: every ClientMsg type is read, write or
// never, every ServerMsg type is passed in scope, redacted or dropped, and a message type nobody has
// classified fails typecheck here. Default deny: anything outside the link's scope is never sent, and
// anything a guest sends outside its scope or permission is refused without saying whether it exists.

import type { ClientMsg, FloorInfo, FloorRoster, FloorView, GhIssue, GhPull, GhState, ServerMsg, WorkerInfo, WorkerKind } from './protocol.js';
import { GUEST_PRESET_INFO, type GuestAuditAction, type GuestPreset } from './guest-links.js';
import { ORCHESTRATOR_ID, type MissionControlState } from './mission-control.js';
import { OFFICE_SHELL_ID } from './office-shell.js';
import { ROOF } from './rooftop.js';
import { NO_PIPELINES } from './pipelines.js';
import { DEFAULT_AUTOPILOT } from './linear.js';

/** The part of a share link's grant that decides scope. */
export interface GuestScopeGrant {
  preset: GuestPreset;
  /** The scoped floor (view-floor, edit-floor, view-worker). */
  floorId?: string;
  /** The scoped worker (view-worker). */
  workerId?: string;
}

/** What the office looks like right now, as far as scope checks need to know. */
export interface GuestWorld {
  /** The open floor a desk or cloud worker sits on; undefined when no open floor has it. */
  floorOf(workerId: string): string | undefined;
  /** Whether a floor is open in the building. */
  isOpen(floorId: string): boolean;
  /** The other floors a worker works in too (its `repos`), when it has any. */
  reposOf(workerId: string): readonly string[] | undefined;
  /** What kind of worker a desk or cloud worker on an open floor is. */
  kindOf(workerId: string): WorkerKind | undefined;
  /** The visiting worker and the one it visits, for a visit still on its way, at a desk or just over. */
  visitOf(visitId: string): { visitor: string; host: string } | undefined;
}

/** The other floors a worker's `repos` name. */
export const repoFloors = (w: Pick<WorkerInfo, 'repos'>): string[] | undefined => w.repos?.map((r) => r.floor);

/** The text every refused guest request gets, whatever the reason: it never says whether a target exists. */
export const GUEST_REFUSED = 'This share link doesn’t allow that.';

/** Why the Orchestrator can't start, to a guest: what blocks it is the owner's setup, never shown to guests. */
export const GUEST_ORCHESTRATOR_BLOCKED = 'Not available right now';

const officeWide = (g: GuestScopeGrant) => GUEST_PRESET_INFO[g.preset].scope === 'office';
const canWrite = (g: GuestScopeGrant) => GUEST_PRESET_INFO[g.preset].write;

/**
 * Whether a worker (or the Orchestrator) is inside a grant's scope. `floorId` is the floor it sits on, when
 * known, and `repos` the other floors it works in. A worker across repositories reaches every one of them
 * (their changes, pull requests and its terminal's workspace), so a floor link leaves out a worker that
 * works in any other floor. A single-worker link keeps the worker the owner picked, without those floors.
 * A plain shell is never in scope: guests have no terminals, and a shell has nothing else to show.
 */
export function guestSeesWorker(g: GuestScopeGrant, workerId: string, floorId: string | undefined, repos: readonly string[] | undefined, kind: WorkerKind | undefined): boolean {
  if (!workerId || workerId === OFFICE_SHELL_ID || kind === 'shell') return false;
  if (workerId === ORCHESTRATOR_ID) return officeWide(g);
  const scope = GUEST_PRESET_INFO[g.preset].scope;
  if (scope === 'worker') return workerId === g.workerId && (floorId === undefined || floorId === g.floorId);
  if (floorId === undefined || floorId === ROOF) return false;
  return scope === 'office' || (floorId === g.floorId && !repos?.some((r) => r !== g.floorId));
}

/** A worker's card as a guest receives it: without its repositories on floors the link doesn't reach. */
export function guestWorkerInfo(w: WorkerInfo, g: GuestScopeGrant): WorkerInfo {
  if (!w.repos || officeWide(g)) return w;
  const { repos, ...rest } = w;
  const kept = repos.filter((r) => r.floor === g.floorId);
  return kept.length ? { ...rest, repos: kept } : rest;
}

/** Whether a worker a message is about is in scope: where it sits now (else `floorId`), and every floor it works in. */
function seesNamed(g: GuestScopeGrant, world: GuestWorld, w: GuestNamed, floorId: string | undefined): boolean {
  return guestSeesWorker(g, w.id, world.floorOf(w.id) ?? floorId, [...(repoFloors(w) ?? []), ...(world.reposOf(w.id) ?? [])], w.kind ?? world.kindOf(w.id));
}

/** The worker a message carries, as guest `g` may receive it, or undefined when it is out of scope. */
function scopedWorker(w: WorkerInfo, g: GuestScopeGrant, floorId: string | undefined, world: GuestWorld): WorkerInfo | undefined {
  const repos = [...(repoFloors(w) ?? []), ...(world.reposOf(w.id) ?? [])];
  return guestSeesWorker(g, w.id, floorId, repos, w.kind ?? world.kindOf(w.id)) ? guestWorkerInfo(w, g) : undefined;
}

/** Whether a floor's own content (boards, pipelines, Whiteboard, visits) is in scope. A single-worker link sees none. */
export function guestSeesFloor(g: GuestScopeGrant, floorId: string | null | undefined): boolean {
  if (!floorId || floorId === ROOF) return false;
  const scope = GUEST_PRESET_INFO[g.preset].scope;
  return scope === 'office' || (scope === 'floor' && floorId === g.floorId);
}

/** Whether a floor appears to the guest at all (its name and its in-scope workers). */
function guestListsFloor(g: GuestScopeGrant, floorId: string): boolean {
  if (floorId === ROOF) return false;
  return officeWide(g) || floorId === g.floorId;
}

// --- Inbound ------------------------------------------------------------------------------------

type Msg<K extends ClientMsg['t']> = Extract<ClientMsg, { t: K }>;

/** What a message is about: a worker (or the Orchestrator) by id, a floor by id, the guest's own floor, Mission Control, or nothing. */
export type GuestTarget<M> = { kind: 'worker'; id: (m: M) => unknown } | { kind: 'floor'; id: (m: M) => unknown } | { kind: 'here' } | { kind: 'mission' } | { kind: 'none' };

export type GuestInbound<M> =
  /** Owner-only for every preset. */
  | { access: 'never' }
  /** Any preset, in scope. `move` (floor.go): office-wide presets go to any open floor, the rest only back to their own. */
  | { access: 'read'; target: GuestTarget<M>; move?: true }
  /** Write presets only, in scope, and audited as `audit` (null: changes nothing worth an entry, like a terminal's size). */
  | { access: 'write'; target: GuestTarget<M>; audit: GuestAuditAction | null };

const NEVER = { access: 'never' } as const;
const WORKER: GuestTarget<{ workerId: string }> = { kind: 'worker', id: (m) => m.workerId };
const FLOOR: GuestTarget<{ floor: string }> = { kind: 'floor', id: (m) => m.floor };
const HERE = { kind: 'here' } as const;
const MISSION = { kind: 'mission' } as const;
const read = <M>(target: GuestTarget<M>): GuestInbound<M> => ({ access: 'read', target });
const write = <M>(target: GuestTarget<M>, audit: GuestAuditAction | null): GuestInbound<M> => ({ access: 'write', target, audit });

/** Every message a client can send, classified for guests. */
export const GUEST_INBOUND: { readonly [K in ClientMsg['t']]: GuestInbound<Msg<K>> } = {
  profile: NEVER,
  'worker.spawn': write(HERE, 'hire'),
  'worker.resume': write(WORKER, 'worker'),
  'worker.interrupt': write(WORKER, 'interrupt'),
  'worker.fork': write(WORKER, 'hire'),
  'worker.kill': write(WORKER, 'dismiss'),
  'worker.shoot': write(WORKER, 'dismiss'),
  'worker.worktree': read(WORKER),
  'worker.rebuild': write(WORKER, 'worker'),
  'worker.attach': read(WORKER),
  'worker.detach': read(WORKER),
  'worker.prompt': write(WORKER, 'prompt'),
  'worker.answer': write(WORKER, 'answer'),
  'worker.pr': write(WORKER, 'git'),
  'term.input': write(WORKER, 'tty'),
  'thread.read': read(WORKER),
  'thread.watch': read(WORKER),
  'worker.queue': write(WORKER, 'worker'),
  'worker.rewind': write(WORKER, 'worker'),
  'worker.setting': write(WORKER, 'worker'),
  'worker.side': write(WORKER, 'worker'),
  // Guests have no terminal: a terminal's size is the owner's alone.
  'term.resize': NEVER,
  'shell.attach': NEVER,
  'shell.detach': NEVER,
  'shell.input': NEVER,
  'shell.resize': NEVER,
  'gh.refresh': read(HERE),
  'gh.merge': write(HERE, 'git'),
  'gh.comment': write(HERE, 'git'),
  gong: NEVER,
  'gh.close': write(HERE, 'git'),
  'gh.labels': write(HERE, 'git'),
  'pipelines.refresh': read(HERE),
  'pipelines.detail': read(HERE),
  'pipelines.rerun': write(HERE, 'git'),
  'pipelines.cancel': write(HERE, 'git'),
  'pipelines.run': write(HERE, 'git'),
  'machine.limit': NEVER,
  'jira.connect': NEVER,
  'jira.disconnect': NEVER,
  'jira.epic': NEVER,
  'jira.refresh': NEVER,
  'linear.connect': NEVER,
  'linear.disconnect': NEVER,
  'linear.team': NEVER,
  'linear.autopilot': NEVER,
  'linear.refresh': NEVER,
  'linear.create': NEVER,
  'factory.connect': NEVER,
  'factory.disconnect': NEVER,
  'factory.refresh': NEVER,
  'factory.watch': NEVER,
  'gemini.connect': NEVER,
  'gemini.disconnect': NEVER,
  'gemini.check': NEVER,
  'gemini.vibes': NEVER,
  'gemini.wakeFilter': NEVER,
  'benchmarks.connect': NEVER,
  'benchmarks.disconnect': NEVER,
  'benchmarks.refresh': NEVER,
  'vibes.watch': NEVER,
  'setup.check': NEVER,
  'setup.airgapped': NEVER,
  'setup.droid.install': NEVER,
  'setup.droid.signIn': NEVER,
  'setup.droid.signInCancel': NEVER,
  'setup.onboarded': NEVER,
  'subscriptions.proxy': NEVER,
  'subscriptions.connect': NEVER,
  'subscriptions.connectCancel': NEVER,
  'subscriptions.disconnect': NEVER,
  'subscriptions.provider': NEVER,
  'subscriptions.models': NEVER,
  'subscriptions.refresh': NEVER,
  // A worker's changed files and their text (untracked files whole) are file reads: write links only, and not audited.
  'changes.watch': write(WORKER, null),
  'changes.unwatch': write(WORKER, null),
  'changes.diff': write(WORKER, null),
  'changes.commit': write(WORKER, 'git'),
  'changes.discard': write(WORKER, 'git'),
  'changes.pr': write(WORKER, 'git'),
  'upgrade.check': NEVER,
  'upgrade.start': NEVER,
  'decor.add': NEVER,
  'decor.update': NEVER,
  'decor.remove': NEVER,
  'jukebox.play': NEVER,
  'jukebox.skip': NEVER,
  'jukebox.stop': NEVER,
  'floor.go': { access: 'read', target: FLOOR, move: true },
  'floor.reorder': NEVER,
  'floor.branches': NEVER,
  'floor.branch': NEVER,
  'floor.repos': NEVER,
  'floor.folders': NEVER,
  'floor.add': NEVER,
  'floor.remove': NEVER,
  'leaveOnMerge.set': NEVER,
  'freshMain.set': NEVER,
  'shellIntegration.set': NEVER,
  'subagents.set': NEVER,
  'bundledSkills.set': NEVER,
  'models.hide': NEVER,
  'models.hideNative': NEVER,
  'workerLabels.set': NEVER,
  'workerLabels.test': NEVER,
  'floor.projectsDir': NEVER,
  'prompts.set': NEVER,
  'prompts.agent': NEVER,
  'worktreeSetup.get': NEVER,
  'worktreeSetup.set': NEVER,
  'whiteboard.apply': write(FLOOR, 'whiteboard'),
  'whiteboard.sync': read(FLOOR),
  'whiteboard.ping': write({ kind: 'worker', id: (m) => m.worker }, 'whiteboard'),
  'automation.result': NEVER,
  'orchestrator.prompt': write(MISSION, 'prompt'),
  'orchestrator.interrupt': write(MISSION, 'interrupt'),
  'orchestrator.reset': write(MISSION, 'mission'),
  'orchestrator.set': NEVER,
  ping: read({ kind: 'none' }),
};

/** What an admitted guest message is about, resolved against the office now. */
export type GuestTargetRef = { kind: 'worker'; workerId: string; floorId: string } | { kind: 'missionControl' } | { kind: 'floor'; floorId: string } | { kind: 'none' };

export interface GuestAdmitted {
  write: boolean;
  /** The audit action for an accepted write; null for reads and unaudited writes. */
  audit: GuestAuditAction | null;
  target: GuestTargetRef;
}

const idOf = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : undefined);

/**
 * Whether a guest may send `msg` from floor `here`, and what it is about. Undefined refuses it: an
 * unknown or owner-only type, a write from a view-only link, or a target outside the link's scope
 * (or one that doesn't exist, which looks the same).
 */
export function guestAdmit(g: GuestScopeGrant, msg: unknown, here: string | null, world: GuestWorld): GuestAdmitted | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const t = (msg as { t?: unknown }).t;
  if (typeof t !== 'string' || !Object.hasOwn(GUEST_INBOUND, t)) return undefined;
  const rule = GUEST_INBOUND[t as ClientMsg['t']] as GuestInbound<Record<string, unknown>>;
  if (rule.access === 'never') return undefined;
  const isWrite = rule.access === 'write';
  if (isWrite && !canWrite(g)) return undefined;
  const audit = rule.access === 'write' ? rule.audit : null;
  const m = msg as Record<string, unknown>;
  // Guests have no Linear board: a ticket handed over with a hire or prompt moves on the owner's Linear account.
  if ((t === 'worker.spawn' || t === 'worker.prompt') && m.linear !== undefined) return undefined;
  // A shell is all terminal, and guests have none.
  if (t === 'worker.spawn' && m.kind === 'shell') return undefined;
  const ok = (target: GuestTargetRef): GuestAdmitted => ({ write: isWrite, audit, target });
  const target = rule.target;
  switch (target.kind) {
    case 'none':
      return ok({ kind: 'none' });
    case 'mission':
      return officeWide(g) ? ok({ kind: 'missionControl' }) : undefined;
    case 'worker': {
      const id = idOf(target.id(m));
      if (!id) return undefined;
      if (id === ORCHESTRATOR_ID) return officeWide(g) ? ok({ kind: 'missionControl' }) : undefined;
      const floorId = world.floorOf(id);
      if (!floorId || !world.isOpen(floorId) || !guestSeesWorker(g, id, floorId, world.reposOf(id), world.kindOf(id))) return undefined;
      return ok({ kind: 'worker', workerId: id, floorId });
    }
    case 'floor': {
      const id = idOf(target.id(m));
      if (!id || id === ROOF || !world.isOpen(id)) return undefined;
      const allowed = rule.access === 'read' && rule.move ? officeWide(g) || id === g.floorId : guestSeesFloor(g, id);
      if (!allowed) return undefined;
      return ok({ kind: 'floor', floorId: id });
    }
    case 'here': {
      if (!here || !world.isOpen(here) || !guestSeesFloor(g, here)) return undefined;
      // A hire's other projects must be floors the link reaches too.
      if (t === 'worker.spawn' && m.repos !== undefined) {
        if (!Array.isArray(m.repos) || m.repos.some((r) => typeof r !== 'string' || !world.isOpen(r) || !guestSeesFloor(g, r))) return undefined;
      }
      return ok({ kind: 'floor', floorId: here });
    }
  }
}

// --- Outbound -----------------------------------------------------------------------------------

type Out<K extends ServerMsg['t']> = Extract<ServerMsg, { t: K }>;
type WelcomeMsg = Out<'welcome'>;

/** The welcome a guest connection gets: in-scope floors, workers, Whiteboard and Mission Control, and its session. */
export type GuestWelcome = Pick<WelcomeMsg, 't' | 'connection' | 'arrival' | 'floors' | 'version' | 'workerAnswerMultiSelect' | 'threadActions' | 'missionControl' | 'building' | 'guest'> & FloorView;

/** What a guest connection can receive. */
export type GuestServerMsg = Exclude<ServerMsg, { t: 'welcome' }> | GuestWelcome;

/** How a message is going out, so the filter knows what it is about. */
export interface GuestSendContext {
  /** To this connection alone (a reply), to everyone on one floor, or to every connection. */
  via: 'direct' | 'floor' | 'all';
  /** The floor a floor-wide (or off-floor screen) send is about. */
  floor?: string;
  /** The floor this guest is on. */
  here: string | null;
  /**
   * Workers a message names (a toast's text, a worker that has just left): each must be in scope too.
   * `repos` keeps the floors one worked in after it has left the roster.
   */
  about?: readonly GuestNamed[];
}

/** A worker a message names, with its repositories and kind when it may have left already. */
export type GuestNamed = Pick<WorkerInfo, 'id'> & Partial<Pick<WorkerInfo, 'repos' | 'kind'>>;

interface GuestView {
  grant: GuestScopeGrant;
  world: GuestWorld;
  ctx: GuestSendContext;
}

export type GuestOutbound<M> =
  /** Never reaches a guest. */
  | { pass: 'drop' }
  /** Reaches every guest it is sent to (replies with no office data). */
  | { pass: 'always' }
  /** About one worker (or the Orchestrator): reaches guests whose scope holds it (`write`: write links only). `floor` names its floor when the message says. */
  | { pass: 'worker'; worker: (m: M) => string; floor?: (m: M) => string; write?: true }
  /** About a floor's own content: reaches guests whose scope holds that floor's content (never single-worker links). */
  | { pass: 'floor'; floor?: (m: M) => string }
  /** Rewritten for the guest's scope, or dropped (undefined). */
  | { pass: 'redact'; redact: (m: M, v: GuestView) => GuestServerMsg | undefined };

const DROP = { pass: 'drop' } as const;
const ALWAYS = { pass: 'always' } as const;
const ABOUT_WORKER: GuestOutbound<{ workerId: string }> = { pass: 'worker', worker: (m) => m.workerId };
const FLOOR_CONTENT = { pass: 'floor' } as const;
const ON_FLOOR: GuestOutbound<{ floor: string }> = { pass: 'floor', floor: (m) => m.floor };
const redact = <M>(fn: (m: M, v: GuestView) => GuestServerMsg | undefined): GuestOutbound<M> => ({ pass: 'redact', redact: fn });

const EMPTY_GH = { items: [], fetchedAt: 0, loading: false };

/** A floor's view as a guest may see it: nothing outside scope, no host paths, connections or decor. */
export function guestFloorView(view: FloorView, g: GuestScopeGrant, world: GuestWorld): FloorView {
  const id = view.floor;
  const empty: FloorView = {
    floor: null,
    project: null,
    workers: [],
    issues: EMPTY_GH as GhState<GhIssue>,
    pulls: EMPTY_GH as GhState<GhPull>,
    pipelines: NO_PIPELINES,
    decor: [],
    jira: {},
    jiraBoard: null,
    linear: { autopilot: DEFAULT_AUTOPILOT, working: 0 },
    linearBoard: null,
  };
  if (!id || !world.isOpen(id) || !guestListsFloor(g, id)) return empty;
  const content = guestSeesFloor(g, id);
  const p = view.project;
  return {
    ...empty,
    floor: id,
    project: p && { name: p.name, forge: p.forge, ...(p.branch ? { branch: p.branch } : {}), dir: '', agentCmd: '' },
    workers: view.workers.flatMap((w) => scopedWorker(w, g, id, world) ?? []),
    ...(content ? { issues: view.issues, pulls: view.pulls, pipelines: view.pipelines } : {}),
  };
}

/** The floor list a guest sees: in-scope floors only, without their checkout paths (and, for one worker, without the floor's counts). */
export function guestFloors(floors: readonly FloorInfo[], g: GuestScopeGrant): FloorInfo[] {
  const single = GUEST_PRESET_INFO[g.preset].scope === 'worker';
  return floors
    .filter((f) => guestListsFloor(g, f.id))
    .map((f) => {
      const { lastVisitedAt: _visited, lastWorkerAt: _worked, hires: _hires, ...rest } = f;
      return single ? { ...rest, dir: '', workers: 0, busy: 0, waiting: 0 } : { ...rest, dir: '' };
    });
}

/** The building roster a guest sees. */
export function guestBuilding(roster: readonly FloorRoster[], g: GuestScopeGrant, world: GuestWorld): FloorRoster[] {
  return roster.filter((r) => guestListsFloor(g, r.floor)).map((r) => ({ floor: r.floor, workers: r.workers.flatMap((w) => scopedWorker(w, g, r.floor, world) ?? []), pulls: guestSeesFloor(g, r.floor) ? r.pulls : [] }));
}

/** Mission Control for office-wide links: the Orchestrator, without its saved settings beyond whether it's on, and without external bots. */
export function guestMission(state: MissionControlState, g: GuestScopeGrant): MissionControlState | undefined {
  if (!officeWide(g)) return undefined;
  // What blocks it (Droid signed out, its model's subscription) is the owner's setup: guests get one fixed line and no Settings pane.
  const { blocked, blockedPane: _pane, settings, ...rest } = state.orchestrator;
  return { orchestrator: { ...rest, settings: { on: settings.on }, ...(blocked ? { blocked: GUEST_ORCHESTRATOR_BLOCKED } : {}) }, bots: [] };
}

/**
 * A floor's visits as a guest sees them: on a floor whose content it sees, between two workers it sees.
 * A floor link needs both still on the roster: one sent home mid-visit took the floors it worked in with it.
 */
function seesVisit(g: GuestScopeGrant, world: GuestWorld, ctx: GuestSendContext, v: { visitor: string; host: string } | undefined): boolean {
  const floor = ctx.floor ?? ctx.here ?? undefined;
  if (!v || !floor || !world.isOpen(floor) || !guestSeesFloor(g, floor)) return false;
  const sees = (id: string) => (officeWide(g) || world.floorOf(id) !== undefined) && seesNamed(g, world, { id }, floor);
  return sees(v.visitor) && sees(v.host);
}

const arrivalFor = (arrival: WelcomeMsg['arrival'], view: FloorView): WelcomeMsg['arrival'] => (arrival.floor === view.floor ? arrival : { floor: null, via: 'lobby' });

/** Every message the office sends, classified for guests. */
export const GUEST_OUTBOUND: { readonly [K in ServerMsg['t']]: GuestOutbound<Out<K>> } = {
  'thread.snapshot': ABOUT_WORKER,
  'thread.live': ABOUT_WORKER,
  'worker.rewound': ABOUT_WORKER,
  'action.result': ALWAYS,
  welcome: redact((m, { grant, world }) => {
    const view = guestFloorView(m, grant, world);
    const mission = m.missionControl && guestMission(m.missionControl, grant);
    const welcome: GuestWelcome = {
      t: 'welcome',
      connection: m.connection,
      arrival: arrivalFor(m.arrival, view),
      floors: guestFloors(m.floors, grant),
      version: m.version,
      ...(m.workerAnswerMultiSelect !== undefined ? { workerAnswerMultiSelect: m.workerAnswerMultiSelect } : {}),
      ...(m.threadActions !== undefined ? { threadActions: m.threadActions } : {}),
      ...(mission ? { missionControl: mission } : {}),
      ...(m.building ? { building: guestBuilding(m.building, grant, world) } : {}),
      ...(m.guest ? { guest: m.guest } : {}),
      ...view,
    };
    return welcome;
  }),
  'floor.enter': redact((m, { grant, world }) => {
    const view = guestFloorView(m, grant, world);
    return { t: 'floor.enter', arrival: arrivalFor(m.arrival, view), ...view };
  }),
  floors: redact((m, { grant }) => ({ t: 'floors', floors: guestFloors(m.floors, grant) })),
  missionControl: redact((m, { grant }) => {
    const state = guestMission(m.state, grant);
    return state && { t: 'missionControl', state };
  }),
  'guestLinks.changed': DROP,
  'building.worker': redact((m, { grant, world }) => {
    const worker = scopedWorker(m.worker, grant, m.floor, world);
    return worker && { ...m, worker };
  }),
  'building.remove': { pass: 'worker', worker: (m) => m.workerId, floor: (m) => m.floor },
  'building.pulls': ON_FLOOR,
  'floor.branches': DROP,
  'floor.repos': DROP,
  'floor.folders': DROP,
  'floor.added': DROP,
  projectsDir: DROP,
  'worker.update': redact((m, { grant, world, ctx }) => {
    const worker = scopedWorker(m.worker, grant, world.floorOf(m.worker.id) ?? ctx.floor, world);
    return worker && { ...m, worker };
  }),
  'worker.remove': ABOUT_WORKER,
  'worker.open': ABOUT_WORKER,
  'worker.worktree': ABOUT_WORKER,
  screen: ABOUT_WORKER,
  // Guests read a worker through its Thread: a terminal's screen is laid out for the owner's window.
  'term.snapshot': DROP,
  'term.data': DROP,
  'gh.issues': FLOOR_CONTENT,
  'gh.pulls': FLOOR_CONTENT,
  'gh.merged': FLOOR_CONTENT,
  'gh.commented': FLOOR_CONTENT,
  gong: DROP,
  'gh.closed': FLOOR_CONTENT,
  'gh.labeled': FLOOR_CONTENT,
  // About a worker: when it is in scope. Otherwise a reply to this guest, or news of its own floor; never office-wide news.
  toast: redact((m, { grant, world, ctx }) => {
    if (ctx.about?.some((w) => !seesNamed(grant, world, w, ctx.floor))) return undefined;
    if (m.workerId !== undefined) return seesNamed(grant, world, { id: m.workerId }, ctx.floor) ? m : undefined;
    if (ctx.via === 'direct') return m;
    return ctx.via === 'floor' && guestSeesFloor(grant, ctx.floor) ? m : undefined;
  }),
  upgrade: DROP,
  decor: DROP,
  jukebox: DROP,
  pipelines: FLOOR_CONTENT,
  'pipelines.detail': FLOOR_CONTENT,
  'pipelines.done': FLOOR_CONTENT,
  jira: DROP,
  'jira.board': DROP,
  'jira.setup': DROP,
  linear: DROP,
  'linear.board': DROP,
  'linear.setup': DROP,
  factory: DROP,
  'factory.setup': DROP,
  gemini: DROP,
  'gemini.setup': DROP,
  benchmarks: DROP,
  'benchmarks.setup': DROP,
  vibes: DROP,
  setup: DROP,
  subscriptions: DROP,
  machine: DROP,
  sky: DROP,
  leaveOnMerge: DROP,
  freshMain: DROP,
  shellIntegration: DROP,
  subagents: DROP,
  bundledSkills: DROP,
  'models.hidden': DROP,
  workerLabels: DROP,
  visits: redact((m, { grant, world, ctx }) => {
    const floor = ctx.floor ?? ctx.here ?? undefined;
    if (!floor || !world.isOpen(floor) || !guestSeesFloor(grant, floor)) return undefined;
    return { ...m, visits: m.visits.filter((v) => seesVisit(grant, world, ctx, v)) };
  }),
  visit_say: redact((m, { grant, world, ctx }) => (seesVisit(grant, world, ctx, world.visitOf(m.visit)) ? m : undefined)),
  whiteboard: ON_FLOOR,
  'whiteboard.rendered': ON_FLOOR,
  'whiteboard.renderer': FLOOR_CONTENT,
  'whiteboard.pinged': { pass: 'worker', worker: (m) => m.worker },
  prompts: DROP,
  worktreeSetup: DROP,
  changes: { pass: 'worker', worker: (m) => m.state.workerId, write: true },
  'changes.diff': { pass: 'worker', worker: (m) => m.workerId, write: true },
  'automation.run': DROP,
  pong: ALWAYS,
};

/** `msg` as guest `g` may receive it, or undefined when it must not reach them. */
export function guestOutbound(g: GuestScopeGrant, msg: ServerMsg, ctx: GuestSendContext, world: GuestWorld): GuestServerMsg | undefined {
  if (!Object.hasOwn(GUEST_OUTBOUND, msg.t)) return undefined;
  const rule = GUEST_OUTBOUND[msg.t] as GuestOutbound<ServerMsg>;
  switch (rule.pass) {
    case 'drop':
      return undefined;
    case 'always':
      return msg as GuestServerMsg;
    case 'worker': {
      const id = rule.worker(msg);
      if (typeof id !== 'string' || (rule.write && !canWrite(g))) return undefined;
      const floor = rule.floor?.(msg) ?? world.floorOf(id) ?? ctx.floor;
      if (ctx.about?.some((w) => !seesNamed(g, world, w, floor))) return undefined;
      return guestSeesWorker(g, id, floor, world.reposOf(id), world.kindOf(id)) ? (msg as GuestServerMsg) : undefined;
    }
    case 'floor': {
      const floor = rule.floor?.(msg) ?? ctx.floor ?? ctx.here ?? undefined;
      return floor && world.isOpen(floor) && guestSeesFloor(g, floor) ? (msg as GuestServerMsg) : undefined;
    }
    case 'redact':
      return rule.redact(msg, { grant: g, world, ctx });
  }
}
