// window.office: a small, promise-based automation API for agents and browser tests, so a check
// of a client change can put you at a desk or a board and use it without steering by hand.
// Everything the scene does comes in through AutomationHost (main.ts); this module only resolves
// targets, picks where to stand, waits for things to finish and builds the state snapshot. It stays
// loadable in Node (tests/automation.test.ts): no window, document or WebGL at import time.

import { DESK_BY_ID, deskSeat, STATION_AGENT, type DeskDef } from '../shared/layout';
import type { FloorInfo, WorkerInfo } from '../shared/protocol';
import { ROOF, ROOF_NAME } from '../shared/rooftop';
import { waitingOnSomeone } from './notify';
import type { InteractKind, Interactable } from './world/office';

/** The keys that use what you stand at (see DESK_KEYS in main.ts). */
export const AUTOMATION_KEYS = ['E', 'P', 'R', 'X', 'B', 'C', 'O'] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

/** Fixed camera angles, relative to the way you face, so screenshots line up between runs. */
export const CAMERA_PRESETS = ['first'] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

/** The commands `window.office` answers, and the only ones the server relay may call. */
export const AUTOMATION_COMMANDS = ['goTo', 'interact', 'open', 'closeAll', 'ride', 'camera', 'state', 'list', 'commands'] as const;
export type AutomationCommand = (typeof AUTOMATION_COMMANDS)[number];

/** The boards on the wall, which `goTo` lists as kind 'board'. */
const BOARD_KINDS = new Set<InteractKind>(['issues', 'pulls', 'services', 'queue', 'ci', 'computers']);
/** Interactables that aren't a place to go to by name: there are many of them, or they move. */
const UNNAMED_KINDS = new Set<InteractKind>(['desk', 'station', 'seat', 'decor', 'pole']);

const PLACE_LABEL: Partial<Record<InteractKind, string>> = {
  issues: 'Issues board',
  pulls: 'Pull request board',
  services: 'Services board',
  queue: 'Task queue board',
  ci: 'CI automations board',
  computers: 'Compute wall',
  tv: 'Office TV',
  coffee: 'Coffee machine',
  elevator: 'Elevator',
  gong: 'Merge gong',
  jukebox: 'Jukebox',
  cabinet: 'Arcade cabinet',
  ladder: 'Ladder',
  meeting: 'Meeting room',
  bar: 'Sky Bar',
  dj: 'DJ booth',
  bookshelf: 'Bookshelf',
};

export type TargetKind = 'desk' | 'kiosk' | 'board' | 'place' | 'floor';

/** Something `goTo` can take you to, as `list()` reports it. */
export interface TargetInfo {
  /** What to pass to goTo. */
  id: string;
  kind: TargetKind;
  label: string;
  deskId?: string;
  worker?: { id: string; name: string; status: string };
  /** For a floor: the one you're on now. */
  here?: boolean;
}

/** What the office looks like to target resolution: who sits where, and what you can use on this floor. */
export interface TargetContext {
  workers: Pick<WorkerInfo, 'id' | 'name' | 'deskId' | 'status'>[];
  /** What you can use where you are (main.ts usable()), put-away ones included. */
  spots: Interactable[];
  floors: Pick<FloorInfo, 'id' | 'name'>[];
  /** The floor you're on, ROOF up on the roof, or null in the lobby. */
  floor: string | null;
}

export interface ResolvedTarget extends TargetInfo {
  /** The interactable to use there (absent for a floor). */
  spot?: Interactable;
}

type Point = { x: number; z: number };
type Point3 = { x: number; y: number; z: number };

const deskKind = (d: DeskDef): TargetKind => (d.station ? 'kiosk' : 'desk');
const deskSpotOf = (spots: Interactable[], deskId: string) => spots.find((s) => s.deskId === deskId && !s.off);

/** Everything `goTo` can take you to from here: the desks with a worker or a free seat, the boards, the places, and the floors. */
export function listTargets(ctx: TargetContext): TargetInfo[] {
  const out: TargetInfo[] = [];
  const byDesk = new Map(ctx.workers.map((w) => [w.deskId, w]));
  const seen = new Set<string>();
  for (const spot of ctx.spots) {
    if (spot.off || !spot.deskId || seen.has(spot.deskId)) continue;
    const desk = DESK_BY_ID.get(spot.deskId);
    if (!desk) continue;
    const w = byDesk.get(desk.id);
    // An empty meeting chair isn't anywhere to go: a meeting seats its own workers there.
    if (desk.room && !w) continue;
    seen.add(desk.id);
    out.push({ id: desk.id, kind: deskKind(desk), label: desk.label, deskId: desk.id, ...(w ? { worker: { id: w.id, name: w.name, status: w.status } } : {}) });
  }
  const kinds = new Set<InteractKind>();
  for (const spot of ctx.spots) {
    if (spot.off || UNNAMED_KINDS.has(spot.kind) || kinds.has(spot.kind)) continue;
    kinds.add(spot.kind);
    out.push({ id: spot.kind, kind: BOARD_KINDS.has(spot.kind) ? 'board' : 'place', label: PLACE_LABEL[spot.kind] ?? spot.kind });
  }
  for (const f of ctx.floors) out.push({ id: f.id, kind: 'floor', label: f.name, ...(f.id === ctx.floor ? { here: true } : {}) });
  if (ctx.floors.length) out.push({ id: ROOF, kind: 'floor', label: ROOF_NAME, ...(ctx.floor === ROOF ? { here: true } : {}) });
  return out;
}

/**
 * The target a `goTo` query names: an id from `list()` (a desk id, a board or place kind, a floor
 * id), a worker's id or name, a desk's label, a board agent's name or a floor's name. Case doesn't
 * matter past an exact id. 'roof' is the rooftop bar.
 */
export function resolveTarget(query: string, ctx: TargetContext): { ok: true; target: ResolvedTarget } | { ok: false; error: string } {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return { ok: false, error: 'goTo needs a target: a desk id, a worker name, a board or a place (see office.list())' };
  const targets = listTargets(ctx);
  const done = (t: TargetInfo) => ({ ok: true as const, target: withSpot(t, ctx.spots) });
  const exact = targets.find((t) => t.id === q) ?? targets.find((t) => t.worker?.id === q);
  if (exact) return done(exact);
  const low = q.toLowerCase();
  if (low === 'roof') {
    const roof = targets.find((t) => t.id === ROOF);
    return roof ? done(roof) : { ok: false, error: 'There is no roof yet: the building has no floors' };
  }
  const names = (t: TargetInfo) => {
    const desk = t.deskId ? DESK_BY_ID.get(t.deskId) : undefined;
    return [t.id, t.label, t.worker?.name, desk?.station && STATION_AGENT[desk.station].name].filter((n): n is string => !!n).map((n) => n.toLowerCase());
  };
  const hits = targets.filter((t) => names(t).includes(low));
  if (hits.length === 1) return done(hits[0]);
  if (hits.length > 1) return { ok: false, error: `"${q}" could be ${hits.map((t) => `${t.label} (${t.id})`).join(' or ')}: use the id` };
  const desk = DESK_BY_ID.get(q) ?? [...DESK_BY_ID.values()].find((d) => d.label.toLowerCase() === low);
  if (desk) return { ok: false, error: `${desk.label} isn't somewhere to go on this floor right now${ctx.floor === ROOF ? ' (you are up on the roof)' : ''}` };
  return { ok: false, error: `No such target "${q}": see office.list() for desks, workers, boards, places and floors` };
}

function withSpot(t: TargetInfo, spots: Interactable[]): ResolvedTarget {
  if (t.kind === 'floor') return t;
  const spot = t.deskId ? deskSpotOf(spots, t.deskId) : spots.find((s) => s.kind === t.id && !s.off);
  return spot ? { ...t, spot } : t;
}

/**
 * Where to stand for a target, and what to look at: behind a worker looking over its shoulder at
 * the laptop, in front of a kiosk, or (anywhere else) on the interactable's spot, stepping out
 * from it when something stands there. `center` is the thing itself, when the scene knows it.
 */
export function standFor(t: ResolvedTarget, blocked: (x: number, z: number, y: number) => boolean, center?: Point3 | null): { at: Point3; face: Point3 } | null {
  const desk = t.deskId ? DESK_BY_ID.get(t.deskId) : undefined;
  if (desk && !desk.room) {
    // The same spot goToDesk and the N key stand you on (main.ts standAt).
    const s = deskSeat(desk, desk.station ? -1.6 : desk.beanbag ? 1.6 : 2.4);
    return { at: { x: s.x, y: 0, z: s.z }, face: center ?? { x: desk.x, y: 0.9, z: desk.z } };
  }
  const spot = t.spot;
  if (!spot) return null;
  const y = spot.y ?? 0;
  const at = freeSpotNear({ x: spot.x, z: spot.z }, y, Math.max(0.6, spot.radius - 0.2), blocked);
  if (!at) return null;
  const face = desk ? { x: desk.x, y: y + 0.9, z: desk.z } : (center ?? { x: spot.x, y: y + 1.2, z: spot.z });
  return { at: { x: at.x, y, z: at.z }, face };
}

/** The free spot to stand on nearest `p`, no further than `radius` from it, or null. */
export function freeSpotNear(p: Point, y: number, radius: number, blocked: (x: number, z: number, y: number) => boolean): Point | null {
  if (!blocked(p.x, p.z, y)) return { x: p.x, z: p.z };
  for (let r = 0.3; r <= radius + 1e-9; r += 0.3) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = p.x + Math.sin(a) * r;
      const z = p.z + Math.cos(a) * r;
      if (!blocked(x, z, y)) return { x, z };
    }
  }
  return null;
}

/** The heading (PlayerController.facing) from `from` toward `to`: 0 faces +z. */
export function facingToward(from: Point, to: Point): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** How far up (positive) or down to look from `eye` to see `to`, within what first person allows. */
export function pitchToward(eye: Point3, to: Point3): number {
  const flat = Math.hypot(to.x - eye.x, to.z - eye.z);
  return Math.max(-1.2, Math.min(1.2, Math.atan2(to.y - eye.y, flat)));
}

export interface CameraPose {
  camYaw: number;
  lookPitch: number;
}

/** A preset's camera for someone facing `facing`: looking straight ahead, level. */
export function cameraPose(_preset: CameraPreset, facing: number): CameraPose {
  return { camYaw: facing - Math.PI, lookPitch: -0.08 };
}

/** What main.ts knows at the moment of a snapshot, before rounding and naming. */
export interface RawState {
  floor: string | null;
  floors: Pick<FloorInfo, 'id' | 'name' | 'waiting'>[];
  /** On the way to another floor (the elevator, the ladder, a pole). */
  riding: boolean;
  player: { x: number; y: number; z: number; facing: number; lookPitch: number; seat: string | null; enabled: boolean; walking: boolean; climbing: boolean };
  camera: { x: number; y: number; z: number };
  /** What E would use where you stand. */
  using: Interactable | null;
  modals: { label: string; doing?: string }[];
  /** The worker whose terminal is open, if one is. */
  terminal: string | null;
  workers: WorkerInfo[];
  carrying: number | null;
  hanging: boolean;
  gun: boolean;
  /** What the gun is doing: drawing, holstering, a trick (world/gun-motion.ts), or null at the ready or away. */
  gunMove: string | null;
  /** What `7` puts in your hand (Settings → You). */
  sidearm: 'wand' | 'magnum';
}

export interface Snapshot {
  floor: { id: string; name: string } | null;
  onRoof: boolean;
  riding: boolean;
  player: {
    x: number;
    y: number;
    z: number;
    facing: number;
    lookPitch: number;
    seat: string | null;
    controls: boolean;
    walking: boolean;
    climbing: boolean;
    carrying: number | null;
    hanging: boolean;
    gun: boolean;
    gunMove: string | null;
    sidearm: 'wand' | 'magnum';
  };
  camera: { x: number; y: number; z: number };
  /** What E would use where you stand: the target id goTo takes, or the kind of thing it is. */
  using: { kind: InteractKind; id: string; label: string } | null;
  /** Open windows, bottom to top, by their aria-label. */
  modals: { label: string; doing?: string }[];
  /** The worker whose terminal is open, if one is. */
  terminal: { workerId: string; name: string } | null;
  workers: { id: string; name: string; kind: string; deskId: string; desk: string; status: string; waiting: boolean; task?: string }[];
  floors: { id: string; name: string; waiting: number; here: boolean }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const angle = (a: number) => r2(Math.atan2(Math.sin(a), Math.cos(a)));

/** The JSON `office.state()` answers with: rounded to centimetres and hundredths of a radian, so it compares between runs. */
export function buildSnapshot(raw: RawState): Snapshot {
  const floorName = (id: string) => (id === ROOF ? ROOF_NAME : (raw.floors.find((f) => f.id === id)?.name ?? id));
  const p = raw.player;
  const u = raw.using;
  const usingId = u ? (u.deskId ?? (UNNAMED_KINDS.has(u.kind) ? (u.seatId ?? u.decorId ?? u.kind) : u.kind)) : '';
  const term = raw.terminal ? raw.workers.find((w) => w.id === raw.terminal) : undefined;
  return {
    floor: raw.floor ? { id: raw.floor, name: floorName(raw.floor) } : null,
    onRoof: raw.floor === ROOF,
    riding: raw.riding,
    player: {
      x: r2(p.x),
      y: r2(p.y),
      z: r2(p.z),
      facing: angle(p.facing),
      lookPitch: r2(p.lookPitch),
      seat: p.seat,
      controls: p.enabled,
      walking: p.walking,
      climbing: p.climbing,
      carrying: raw.carrying,
      hanging: raw.hanging,
      gun: raw.gun,
      gunMove: raw.gunMove,
      sidearm: raw.sidearm,
    },
    camera: { x: r2(raw.camera.x), y: r2(raw.camera.y), z: r2(raw.camera.z) },
    using: u ? { kind: u.kind, id: usingId, label: (u.deskId && DESK_BY_ID.get(u.deskId)?.label) || PLACE_LABEL[u.kind] || u.kind } : null,
    modals: raw.modals.map((m) => (m.doing ? { label: m.label, doing: m.doing } : { label: m.label })),
    terminal: raw.terminal ? { workerId: raw.terminal, name: term?.name ?? raw.terminal } : null,
    workers: raw.workers.map((w) => ({
      id: w.id,
      name: w.name,
      kind: w.kind,
      deskId: w.deskId,
      desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId,
      status: w.status,
      waiting: waitingOnSomeone(w),
      ...(w.task?.name ? { task: w.task.name } : {}),
    })),
    floors: raw.floors.map((f) => ({ id: f.id, name: f.name, waiting: f.waiting, here: f.id === raw.floor })),
  };
}

/** A command on the ☰ menu (main.ts's HUD actions), as `office.commands()` lists it. */
export interface CommandInfo {
  id: string;
  label: string;
  /** Offered where you are now (the ☰ menu shows it). */
  shown: boolean;
  /** Why it can't be used now, if it can't. */
  blocked?: string;
}

/** What `window.office` needs from main.ts: the scene's own functions, nothing reimplemented. */
export interface AutomationHost {
  context(): TargetContext;
  raw(): RawState;
  /** Why you can't be moved right now ("riding the elevator"), or null. */
  busy(): string | null;
  blocked(x: number, z: number, y: number): boolean;
  /** The middle of the thing an interactable is for (a board, a machine), from the scene. */
  centerOf(spot: Interactable): Point3 | null;
  /** On your feet at `at`, facing and looking at `face`, with whatever you were doing stopped. */
  place(at: Point3, face: Point3): void;
  /** Faces and looks at `face` from where you stand. */
  aim(face: Point3): void;
  /** Walks you to `at` the way the palette's Shift+Enter does; `done` says how it ended. */
  walk(at: Point3, label: string, done: (why: 'arrived' | 'cancelled' | 'stuck') => void): void;
  /** What E would use where you stand, by distance (no crosshair involved). */
  near(): Interactable | null;
  /** Presses `key` at `spot`, as if you were facing it. */
  use(spot: Interactable, key: AutomationKey): void;
  commands(): CommandInfo[];
  run(id: string): void;
  closeAll(): void;
  ride(floor: string): void;
  setCamera(pose: CameraPose): void;
  /** Frames drawn so far. */
  frames(): number;
  wait(ms: number): Promise<void>;
}

export interface GoToOptions {
  /** Walk there along the office's paths instead of being put there. */
  walk?: boolean;
  /** How long a walk or a ride may take before the command gives up (ms). */
  timeout?: number;
}

export interface OfficeAutomation {
  /** Goes to a desk, a worker, a board, a place, a floor or the roof, and resolves once you're there. */
  goTo(target: string, opts?: GoToOptions): Promise<Snapshot>;
  /** Presses a key (E by default) at what you went to, or else at what's nearest, as if you faced it. */
  interact(key?: AutomationKey): Promise<Snapshot>;
  /** Runs a ☰ menu command by id (see commands()). */
  open(id: string): Promise<Snapshot>;
  /** Closes every open window. */
  closeAll(): Promise<Snapshot>;
  /** Rides the elevator to a floor (id or name) or the roof, and resolves once its doors open there. */
  ride(floor: string, opts?: { timeout?: number }): Promise<Snapshot>;
  /** Puts the camera at one of the fixed presets. */
  camera(preset: CameraPreset): Promise<Snapshot>;
  state(): Snapshot;
  list(): TargetInfo[];
  commands(): CommandInfo[];
}

/** Frames to let go by after a command, so the scene, the hint and the windows have caught up. */
const SETTLE_FRAMES = 2;

export function createAutomation(host: AutomationHost): OfficeAutomation {
  /** Where the last goTo put you, and what's there, while you're still standing there. */
  let at: { id: string; spot?: Interactable; x: number; z: number } | null = null;

  const here = () => {
    const p = host.raw().player;
    return at && Math.hypot(p.x - at.x, p.z - at.z) < 0.5 ? at : null;
  };
  const using = (): Interactable | null => here()?.spot ?? host.near();
  const state = (): Snapshot => buildSnapshot({ ...host.raw(), using: using() });

  async function until(done: () => boolean, ms: number, fail?: () => string | null): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (done()) return true;
      const why = fail?.();
      if (why) throw new Error(why);
      await host.wait(30);
    }
    return done();
  }
  /** A couple of frames, or a second if the tab isn't drawing (hidden): either way, carry on. */
  async function settle(): Promise<Snapshot> {
    const from = host.frames();
    await until(() => host.frames() >= from + SETTLE_FRAMES, 1000);
    return state();
  }

  async function ride(query: string, opts: { timeout?: number } = {}): Promise<Snapshot> {
    const ctx = host.context();
    const q = typeof query === 'string' ? query.trim() : '';
    const low = q.toLowerCase();
    const floor = low === 'roof' || q === ROOF ? (ctx.floors.length ? ROOF : undefined) : (ctx.floors.find((f) => f.id === q) ?? ctx.floors.find((f) => f.name.toLowerCase() === low))?.id;
    if (!floor) throw new Error(`No such floor "${q}": one of ${[...ctx.floors.map((f) => `${f.name} (${f.id})`), ...(ctx.floors.length ? ['roof'] : [])].join(', ') || 'none yet'}`);
    if (floor === ctx.floor) return settle();
    const busy = host.busy();
    if (busy) throw new Error(`Can't ride now: ${busy}`);
    at = null;
    host.ride(floor);
    return arrive(floor, opts.timeout);
  }

  /** Waits out a trip under way: the floor comes and you have the controls back (the doors are open). */
  async function arrive(floor: string | null, timeout = 20_000): Promise<Snapshot> {
    const there = () => {
      const r = host.raw();
      return !r.riding && (floor === null || r.floor === floor) && (r.player.enabled || r.modals.length > 0);
    };
    const failed = () => {
      const r = host.raw();
      return !r.riding && floor !== null && r.floor !== floor ? `The ride to ${floor} didn't get there: you're on ${r.floor ?? 'no floor'}` : null;
    };
    if (!(await until(there, timeout, failed))) throw new Error(`Still riding after ${Math.round(timeout / 1000)}s`);
    return settle();
  }

  async function goTo(query: string, opts: GoToOptions = {}): Promise<Snapshot> {
    const ctx = host.context();
    const found = resolveTarget(query, ctx);
    if (!found.ok) throw new Error(found.error);
    const t = found.target;
    if (t.kind === 'floor') return ride(t.id, opts);
    const busy = host.busy();
    if (busy) throw new Error(`Can't go to ${t.label} now: ${busy}`);
    const spot = t.spot;
    const stand = standFor(t, host.blocked, spot && !t.deskId ? host.centerOf(spot) : null);
    if (!stand) throw new Error(`Nowhere free to stand at ${t.label}`);
    if (!opts.walk) {
      host.place(stand.at, stand.face);
      at = { id: t.id, spot, x: stand.at.x, z: stand.at.z };
      return settle();
    }
    if (ctx.floor === ROOF) throw new Error('Walking needs an office floor: leave out { walk: true } up on the roof');
    const timeout = opts.timeout ?? 60_000;
    await new Promise<void>((resolve, reject) => {
      let over = false;
      const timer = setTimeout(() => {
        over = true;
        reject(new Error(`Still walking to ${t.label} after ${Math.round(timeout / 1000)}s`));
      }, timeout);
      host.walk(stand.at, t.label, (why) => {
        if (over) return;
        clearTimeout(timer);
        if (why === 'arrived') resolve();
        else reject(new Error(why === 'stuck' ? `Stuck on the way to ${t.label}` : `The walk to ${t.label} was cancelled`));
      });
    });
    host.aim(stand.face);
    const p = host.raw().player;
    at = { id: t.id, spot, x: p.x, z: p.z };
    return settle();
  }

  async function interact(key: AutomationKey = 'E'): Promise<Snapshot> {
    if (!AUTOMATION_KEYS.includes(key)) throw new Error(`interact takes one of ${AUTOMATION_KEYS.join(' ')}, not "${key}"`);
    const busy = host.busy();
    if (busy) throw new Error(`Can't use anything now: ${busy}`);
    const spot = using();
    if (!spot) throw new Error('Nothing to use here: goTo a desk, a board or a place first');
    host.use(spot, key);
    const s = await settle();
    // E at the elevator panel's roof button, or anything else that sets off a ride: wait it out.
    return host.raw().riding ? arrive(null) : s;
  }

  async function open(id: string): Promise<Snapshot> {
    const all = host.commands();
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error(`No command "${id}": one of ${all.map((x) => x.id).join(', ')}`);
    if (!c.shown) throw new Error(`"${id}" isn't offered here right now`);
    if (c.blocked) throw new Error(`"${id}" can't be used now: ${c.blocked}`);
    if (id === 'roof') return ride('roof');
    host.run(id);
    const s = await settle();
    return host.raw().riding ? arrive(null) : s;
  }

  async function closeAll(): Promise<Snapshot> {
    host.closeAll();
    return settle();
  }

  async function camera(preset: CameraPreset): Promise<Snapshot> {
    if (!CAMERA_PRESETS.includes(preset)) throw new Error(`camera takes one of ${CAMERA_PRESETS.join(', ')}, not "${preset}"`);
    host.setCamera(cameraPose(preset, host.raw().player.facing));
    return settle();
  }

  return {
    goTo,
    interact,
    open,
    closeAll,
    ride,
    camera,
    state,
    list: () => listTargets(host.context()),
    commands: () => host.commands(),
  };
}

/**
 * Runs one relayed command (see the server's /api/automation): only the commands `window.office`
 * answers, with JSON arguments, and the answer as JSON.
 */
export async function runCommand(office: OfficeAutomation, cmd: string, args: unknown[]): Promise<unknown> {
  if (!(AUTOMATION_COMMANDS as readonly string[]).includes(cmd)) throw new Error(`No command "${cmd}": one of ${AUTOMATION_COMMANDS.join(', ')}`);
  const fn = office[cmd as AutomationCommand] as (...a: unknown[]) => unknown;
  return await fn(...(Array.isArray(args) ? args : []));
}
