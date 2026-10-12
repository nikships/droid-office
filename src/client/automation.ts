// window.office: a small, promise-based automation API for agents and browser tests, so a check
// of a client change can put you at a desk or a board and use it without steering by hand.
// Everything the scene does comes in through AutomationHost (main.ts); this module only resolves
// targets, picks where to stand, waits for things to finish and builds the state snapshot. It stays
// loadable in Node (tests/automation.test.ts): no window, document or WebGL at import time.

import { DESK_BY_ID, STATION_AGENT, type DeskDef } from '../shared/layout';
import type { FloorInfo, WorkerInfo } from '../shared/protocol';
import { ROOF, ROOF_NAME } from '../shared/rooftop';
import { deskApproach, type ApproachPose } from './approach';
import { waitingOnSomeone } from './notify';
import { EYE_HEIGHT } from './player';
import type { InteractKind, Interactable } from './world/office';

/** The keys that use what you stand at (see DESK_KEYS in main.ts). */
export const AUTOMATION_KEYS = ['E', 'P', 'R', 'X', 'B', 'C', 'O'] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

/** Fixed camera angles, relative to the way you face, so screenshots line up between runs. */
export const CAMERA_PRESETS = ['first'] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

/** The commands `window.office` answers, and the only ones the server relay may call. */
export const AUTOMATION_COMMANDS = ['goTo', 'interact', 'open', 'closeAll', 'ride', 'camera', 'height', 'state', 'list', 'commands'] as const;
export type AutomationCommand = (typeof AUTOMATION_COMMANDS)[number];

/** The boards on the wall, which `goTo` lists as kind 'board'. */
const BOARD_KINDS = new Set<InteractKind>(['issues', 'pulls', 'actions', 'ci', 'whiteboard', 'computers']);
/** Interactables that aren't a place to go to by name: there are many of them, or they move. */
const UNNAMED_KINDS = new Set<InteractKind>(['desk', 'station', 'seat', 'decor', 'pole']);

const PLACE_LABEL: Partial<Record<InteractKind, string>> = {
  issues: 'Issues board',
  pulls: 'Pull request board',
  actions: 'Pipelines board',
  ci: 'CI automations board',
  whiteboard: 'Whiteboard',
  computers: 'Compute wall',
  coffee: 'Coffee machine',
  elevator: 'Elevator',
  gong: 'Merge gong',
  jukebox: 'Jukebox',
  ladder: 'Ladder',
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
 * matter past an exact id. 'roof' is the roof.
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
 * Where to stand for a target, which way to face, and the pitch: behind a worker (the desk pose),
 * in front of a kiosk, or (anywhere else) on the interactable's spot, stepping out from it when
 * something stands there. `center` is the thing itself, when the scene knows it. A desk's pitch is
 * fixed; anything else is pitchToward its face from eye height.
 */
export function standFor(t: ResolvedTarget, blocked: (x: number, z: number, y: number) => boolean, center?: Point3 | null): ApproachPose | null {
  const desk = t.deskId ? DESK_BY_ID.get(t.deskId) : undefined;
  if (desk) {
    const pose = deskApproach(desk);
    // The same pose N and go-to-desk use. A later aim must not pitchToward over it.
    if (!center) return pose;
    return { ...pose, face: center, facing: facingToward(pose.at, center) };
  }
  const spot = t.spot;
  if (!spot) return null;
  const y = spot.y ?? 0;
  const free = freeSpotNear({ x: spot.x, z: spot.z }, y, Math.max(0.6, spot.radius - 0.2), blocked);
  if (!free) return null;
  const at = { x: free.x, y, z: free.z };
  const face = center ?? { x: spot.x, y: y + 1.2, z: spot.z };
  return { at, facing: facingToward(at, face), lookPitch: pitchToward({ x: at.x, y: at.y + EYE_HEIGHT, z: at.z }, face), face, pitchFixed: false };
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
  player: { x: number; y: number; z: number; eyeHeight: number; facing: number; lookPitch: number; seat: string | null; enabled: boolean; walking: boolean; climbing: boolean };
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
    eyeHeight: number;
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
      eyeHeight: r2(p.eyeHeight),
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
  /** On your feet at the pose, with whatever you were doing stopped. A desk keeps the pose's pitch. */
  place(pose: ApproachPose): void;
  /** Faces the pose from where you stand. A desk keeps its pitch; anything else uses pitchToward. */
  aim(pose: ApproachPose): void;
  /** Walks you to `at` the way the palette's Shift+Enter does; `done` says how it ended. */
  walk(at: Point3, label: string, done: (why: 'arrived' | 'cancelled' | 'stuck') => void): void;
  /** What E would use where you stand, by distance (no crosshair involved). */
  near(): Interactable | null;
  /** Presses `key` at `spot`, as if you were facing it. */
  use(spot: Interactable, key: AutomationKey): void;
  /** E on the ladder: gets off it the way the key does. Null once you're getting off, else why you can't. */
  letGo(): string | null;
  commands(): CommandInfo[];
  run(id: string): void;
  closeAll(): void;
  ride(floor: string): void;
  setCamera(pose: CameraPose): void;
  setHeight(scale: number): void;
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
  /** Smoothly changes eye height to 1–3 times the default, resolving once it settles. */
  height(scale: number): Promise<Snapshot>;
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
      host.place(stand);
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
    host.aim(stand);
    const p = host.raw().player;
    at = { id: t.id, spot, x: p.x, z: p.z };
    return settle();
  }

  async function interact(key: AutomationKey = 'E'): Promise<Snapshot> {
    if (!AUTOMATION_KEYS.includes(key)) throw new Error(`interact takes one of ${AUTOMATION_KEYS.join(' ')}, not "${key}"`);
    const r = host.raw();
    // On the ladder E is the one key that does anything: it gets you off, as the keyboard's does.
    if (key === 'E' && r.player.climbing && !r.riding) {
      const why = host.letGo();
      if (why) throw new Error(`Can't get off now: ${why}`);
      const off = () => {
        const p = host.raw().player;
        return !p.climbing && p.y <= 0.01;
      };
      if (!(await until(off, 5000))) throw new Error('Still on the ladder after 5s');
      return settle();
    }
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

  async function height(scale: number): Promise<Snapshot> {
    if (!Number.isFinite(scale) || scale < 1 || scale > 3) throw new Error('Height takes a scale from 1 to 3');
    if (!host.raw().player.enabled) throw new Error('Height needs the player controls');
    host.setHeight(scale);
    if (!(await until(() => Math.abs(host.raw().player.eyeHeight - scale * EYE_HEIGHT) < 0.0001, 5000))) throw new Error('Height did not settle');
    return settle();
  }

  return {
    goTo,
    interact,
    open,
    closeAll,
    ride,
    camera,
    height,
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
