/**
 * The headset app's only two menus, as the owner decided (no workspace in VR):
 *
 * - **Settings**, from the left controller's Menu button: your height and the floor calibration,
 *   world detail, foveation, sharp screens and the FPS counter. It opens a little below your eyes,
 *   an arm's length ahead along your heading, and stays there: it never follows your head.
 * - **Hire**, from the trigger at an empty desk: it opens at that desk, over the floating "+", facing
 *   you, and hires through the office's own worker.spawn (main.ts hire / openShell).
 *
 * Both are world-anchored objects (native/menu-panel.ts) sized for a controller ray, with one way
 * out each: the ✕, the button that opened them, B, or walking away. The native controls route a
 * ray to an open menu before the world (NativeMenuInput), so a trigger on a menu never also uses
 * whatever is behind it.
 */

import * as THREE from 'three';
import { MIN_NATIVE_RENDER_SCALE, nativeWorldResolution, type NativeFoveation, type NativeGraphicsSettings } from './graphics-settings';
import { VrMenu, menuHeight, type MenuModel, type MenuRow } from './menu-panel';
import { nativeFpsCounter } from './performance';

export interface NativeSettingsHooks {
  heightCm(): number;
  setHeightCm(cm: number): void;
  /** Takes the head's height now as standing up straight; false while the head is untracked. */
  calibrate(): boolean;
  /** Back to the headset's own floor. */
  resetFloor(): void;
  /** Eyes above the corrected floor now, or null while untracked. */
  eyes(): number | null;
  /** Metres the headset's floor is corrected by. */
  floorOffset(): number;
  graphics(): NativeGraphicsSettings;
  setGraphics(patch: Partial<NativeGraphicsSettings>): void;
  /** The latest native measurements. */
  metrics(): unknown;
}

export interface NativeHireHooks {
  /** An empty desk you can hire at: its label and the "+" floating over it; null for anything else (taken, a kiosk, the meeting table). */
  desk(deskId: string): { label: string; marker: THREE.Object3D } | null;
  /** The engines this project offers, and the remembered one for this desk. */
  engines(deskId: string): { id: string; label: string }[];
  engine(deskId: string): string;
  setEngine(deskId: string, engine: string): void;
  /** Whether a worker can get a worktree of its own here, and whether the last hire chose one. */
  worktree(): { offered: boolean; on: boolean };
  setWorktree(on: boolean): void;
  /** Why nobody can be hired right now (the office is full, the budget is spent), or null. */
  blocked(): string | null;
  /** How loaded the machine is, when that's worth saying, or null. */
  pressure(): string | null;
  hire(deskId: string, engine: string, worktree: boolean): void;
  shell(deskId: string): void;
}

export interface NativeMenuHooks {
  settings: NativeSettingsHooks;
  hire: NativeHireHooks;
  /** The eyes in the world and where they look, or null while the head is untracked. */
  head(): { pos: THREE.Vector3; dir: THREE.Vector3 } | null;
  /**
   * How far a ray from `origin` along `dir` goes before it meets a wall or furniture that is drawn
   * (metres), or null when nothing is within `far`: a menu never opens inside one.
   */
  obstacle?(origin: THREE.Vector3, dir: THREE.Vector3, far: number): number | null;
  /** A menu opened, closed or took a press: for its sound. */
  feedback?(kind: 'open' | 'close' | 'press'): void;
}

/** How the native controls hand a controller ray to the menus (native/controls.ts NativeHooks.menus). */
export interface NativeMenuInput {
  /** Where this hand's ray meets an open menu and the target under it; null when it misses or none is open. */
  aim(hand: 0 | 1, ray: THREE.Ray | null): { point: THREE.Vector3; target: string | null } | null;
  /** The trigger went down (true) or up (false) for a hand that aimed at a menu. */
  press(hand: 0 | 1, down: boolean): void;
  /** That hand's press ends without a click (tracking loss, disconnect). */
  cancel(hand: 0 | 1): void;
  /** B: closes the open menu; false when none is open. */
  back(): boolean;
}

export type NativeMenuKind = 'settings' | 'hire';

const SETTINGS_W = 0.46;
const HIRE_W = 0.5;
/** The hire menu reads from across a desk: the same layout, this much bigger in the world. */
const HIRE_SCALE = 1.4;
/** Settings: this far ahead of the eyes along the heading, and this far below them. */
const SETTINGS_AHEAD = 0.62;
const SETTINGS_DROP = 0.14;
/** Nearest a menu opens to the eyes, in front of a wall or a desk that's closer than that. */
const MIN_AHEAD = 0.34;
/** The hire menu sits this far in front of the desk's "+" (toward you), hiding it. */
const HIRE_FORWARD = 0.14;
/** Walk this much further from a menu than where you opened it and it folds away. */
const LEAVE_SLACK = 1.4;
const LEAVE_MIN = 2.2;

const FOVEATIONS: readonly NativeFoveation[] = ['off', 'performance', 'balanced', 'clarity'];
export const FOVEATION_LABEL: Record<NativeFoveation, string> = { off: 'Off', performance: 'More headroom', balanced: 'Balanced', clarity: 'Wider sharp area' };

const SETTINGS_ROWS: MenuRow['kind'][] = ['value', 'buttons', 'note', 'value', 'value', 'toggle', 'toggle', 'note'];
const HIRE_ROWS: MenuRow['kind'][] = ['value', 'toggle', 'note', 'buttons'];

/** World detail steps in 5% stops, to the exact runtime limit at the top. */
export function stepWorldDetail(scale: number, direction: -1 | 1, maxScale: number): number {
  const stop = direction > 0 ? Math.floor(scale * 20 + 1e-6) + 1 : Math.ceil(scale * 20 - 1e-6) - 1;
  const next = stop / 20;
  if (direction > 0 && next > maxScale - 1e-6) return maxScale;
  return Math.max(MIN_NATIVE_RENDER_SCALE, Math.min(maxScale, next));
}

/** The settings menu's rows, from the current settings and measurements. */
export function settingsModel(h: NativeSettingsHooks): MenuModel {
  const cm = h.heightCm();
  const eyes = h.eyes();
  const offset = h.floorOffset();
  const g = h.graphics();
  const m = h.metrics();
  const supported = m && typeof m === 'object' ? (m as Record<string, unknown>).foveationSupported : undefined;
  const resolution = nativeWorldResolution(m, g.renderScale);
  const scale = resolution.selectedScale;
  const foveations = supported === false ? (['off'] as const) : FOVEATIONS;
  const at = Math.max(0, foveations.indexOf(g.foveation));
  const cycle = (d: number) => (foveations.length > 1 ? () => h.setGraphics({ foveation: foveations[(at + d + foveations.length) % foveations.length] }) : null);
  const corrected = Math.abs(offset) >= 0.01 ? ` · floor corrected ${offset.toFixed(2)} m` : '';
  const counter = nativeFpsCounter(m);
  return {
    title: 'Settings',
    rows: [
      { kind: 'value', id: 'height', label: 'Your height', value: `${cm} cm`, dec: cm > 120 ? () => h.setHeightCm(cm - 1) : null, inc: cm < 220 ? () => h.setHeightCm(cm + 1) : null, repeat: true },
      {
        kind: 'buttons',
        id: 'floor',
        buttons: [
          { id: 'calibrate', label: 'Calibrate', run: () => h.calibrate(), primary: true, disabled: eyes === null },
          { id: 'reset', label: 'Headset floor', run: () => h.resetFloor(), disabled: Math.abs(offset) < 0.01 },
        ],
      },
      { kind: 'note', id: 'eyes', text: eyes === null ? 'Your eyes are not tracked right now' : `Stand up straight to calibrate · eyes ${eyes.toFixed(2)} m above the floor${corrected}` },
      {
        kind: 'value',
        id: 'detail',
        label: 'World detail',
        value: `${Math.round(scale * 100)}%`,
        dec: scale > MIN_NATIVE_RENDER_SCALE + 1e-6 ? () => h.setGraphics({ renderScale: stepWorldDetail(scale, -1, resolution.maxScale) }) : null,
        inc: scale < resolution.maxScale - 1e-6 ? () => h.setGraphics({ renderScale: stepWorldDetail(scale, 1, resolution.maxScale) }) : null,
        repeat: true,
      },
      { kind: 'value', id: 'foveation', label: 'Foveation', value: FOVEATION_LABEL[foveations[at] ?? 'off'], dec: cycle(-1), inc: cycle(1) },
      { kind: 'toggle', id: 'sharp', label: 'Sharp screens', on: g.sharpScreens, toggle: () => h.setGraphics({ sharpScreens: !g.sharpScreens }) },
      { kind: 'toggle', id: 'fps', label: 'FPS counter', on: g.fps, toggle: () => h.setGraphics({ fps: !g.fps }) },
      { kind: 'note', id: 'perf', text: [counter.text, resolution.applied ? `${resolution.applied.width} × ${resolution.applied.height} per eye` : ''].filter(Boolean).join(' · '), tone: counter.warning ? 'warn' : undefined },
    ],
  };
}

/** The hire menu's rows at `deskId`. */
export function hireModel(h: NativeHireHooks, deskId: string, label: string, done: () => void): MenuModel {
  const engines = h.engines(deskId);
  const current = h.engine(deskId);
  const at = Math.max(
    0,
    engines.findIndex((e) => e.id === current),
  );
  const engine = engines[at];
  const cycle = (d: number) => (engines.length > 1 ? () => h.setEngine(deskId, engines[(at + d + engines.length) % engines.length].id) : null);
  const wt = h.worktree();
  const blocked = h.blocked();
  const note = blocked ?? h.pressure() ?? (wt.offered ? 'Starts with no task: hand it an issue card for work' : 'Workers here share the main checkout');
  return {
    title: `Hire at ${label}`,
    rows: [
      { kind: 'value', id: 'engine', label: 'Engine', value: engine?.label ?? 'Worker', dec: cycle(-1), inc: cycle(1), wide: true },
      { kind: 'toggle', id: 'worktree', label: 'Own worktree', on: wt.offered && wt.on, toggle: wt.offered ? () => h.setWorktree(!wt.on) : null },
      { kind: 'note', id: 'note', text: note, tone: blocked ? 'warn' : undefined },
      {
        kind: 'buttons',
        id: 'go',
        buttons: [
          {
            id: 'hire',
            label: 'Hire',
            primary: true,
            disabled: !!blocked || !engine,
            run: () => {
              h.hire(deskId, engine.id, wt.offered && wt.on);
              done();
            },
          },
          {
            id: 'shell',
            label: 'Shell',
            disabled: !!blocked,
            run: () => {
              h.shell(deskId);
              done();
            },
          },
        ],
      },
    ],
  };
}

interface RayState {
  uv: { u: number; v: number } | null;
  target: string | null;
  pressing: boolean;
}

const _fwd = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

export class NativeMenus implements NativeMenuInput {
  readonly settings: VrMenu;
  readonly hire: VrMenu;
  private hooks: NativeMenuHooks;
  private kind: NativeMenuKind | null = null;
  private hireDesk: string | null = null;
  private leaveAt = Infinity;
  private rays: [RayState, RayState] = [
    { uv: null, target: null, pressing: false },
    { uv: null, target: null, pressing: false },
  ];
  private raycaster = new THREE.Raycaster();
  private refreshAt = 0;

  constructor(scene: THREE.Object3D, hooks: NativeMenuHooks) {
    this.hooks = hooks;
    const press = () => hooks.feedback?.('press');
    this.settings = new VrMenu({
      width: SETTINGS_W,
      height: menuHeight(SETTINGS_ROWS),
      theme: { accent: '#f2b950', ink: '#14110a' },
      build: () => settingsModel(hooks.settings),
      onClose: () => this.close(),
      onPress: press,
    });
    this.settings.root.name = 'native-settings-menu';
    this.hire = new VrMenu({
      width: HIRE_W,
      height: menuHeight(HIRE_ROWS),
      theme: { accent: '#7cf29a', ink: '#0b1a10' },
      build: () => (this.hireDesk ? hireModel(hooks.hire, this.hireDesk, hooks.hire.desk(this.hireDesk)?.label ?? 'this desk', () => this.close()) : { title: 'Hire', rows: [] }),
      onClose: () => this.close(),
      onPress: press,
    });
    this.hire.root.name = 'native-hire-menu';
    this.hire.root.scale.setScalar(HIRE_SCALE);
    scene.add(this.settings.root, this.hire.root);
  }

  /** Which menu is open, if any. */
  get open(): NativeMenuKind | null {
    return this.kind;
  }

  /** The desk the hire menu is open at. */
  get desk(): string | null {
    return this.kind === 'hire' ? this.hireDesk : null;
  }

  /** The left Menu button: opens settings where you are looking, or puts away whichever menu is open. */
  toggleSettings(): boolean {
    if (this.kind) {
      this.close();
      return false;
    }
    return this.openSettings();
  }

  openSettings(): boolean {
    const head = this.hooks.head();
    if (!head) return false;
    this.close(true);
    _fwd.set(head.dir.x, 0, head.dir.z);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const ahead = this.clearAhead(head.pos, _fwd, SETTINGS_AHEAD);
    _p.copy(head.pos).addScaledVector(_fwd, ahead);
    _p.y -= SETTINGS_DROP;
    this.place(this.settings, _p, head.pos);
    this.show('settings', this.settings, head.pos.distanceTo(_p));
    return true;
  }

  /** The trigger at an empty desk: its hire menu, floating at the desk. False when that desk can't be hired at. */
  openHire(deskId: string): boolean {
    const desk = this.hooks.hire.desk(deskId);
    const head = this.hooks.head();
    if (!desk || !head) return false;
    if (this.kind === 'hire' && this.hireDesk === deskId) return true;
    this.close(true);
    this.hireDesk = deskId;
    desk.marker.updateMatrixWorld(true);
    desk.marker.getWorldPosition(_p);
    _q.set(head.pos.x - _p.x, 0, head.pos.z - _p.z);
    if (_q.lengthSq() > 1e-6) _p.addScaledVector(_q.normalize(), HIRE_FORWARD);
    this.place(this.hire, _p, head.pos);
    this.show('hire', this.hire, Math.hypot(head.pos.x - _p.x, head.pos.z - _p.z));
    return true;
  }

  /** Puts away the open menu. */
  close(quiet = false) {
    if (!this.kind) return;
    for (const r of this.rays) {
      r.uv = null;
      r.target = null;
      r.pressing = false;
    }
    this.settings.setVisible(false);
    this.hire.setVisible(false);
    this.kind = null;
    this.hireDesk = null;
    this.leaveAt = Infinity;
    if (!quiet) this.hooks.feedback?.('close');
  }

  /** Moves the open menu up or down by `dy` with you: a floor correction just moved you that much in the world. */
  shift(dy: number) {
    const menu = this.current();
    if (!menu || !Number.isFinite(dy) || Math.abs(dy) < 1e-6) return;
    menu.root.position.y += dy;
    menu.root.updateMatrixWorld(true);
  }

  back(): boolean {
    if (!this.kind) return false;
    this.close();
    return true;
  }

  aim(hand: 0 | 1, ray: THREE.Ray | null): { point: THREE.Vector3; target: string | null } | null {
    const r = this.rays[hand];
    const menu = this.current();
    if (!menu || !ray) {
      if (r.uv && menu) menu.panel.pointerMove(hand, null);
      r.uv = null;
      r.target = null;
      return null;
    }
    this.raycaster.set(ray.origin, ray.direction);
    this.raycaster.far = 8;
    const hit = menu.hit(this.raycaster);
    if (!hit) {
      if (r.uv) menu.panel.pointerMove(hand, null);
      r.uv = null;
      r.target = null;
      return null;
    }
    r.uv = hit.uv;
    r.target = menu.panel.pointerMove(hand, hit.uv)?.id ?? null;
    return { point: hit.point.clone(), target: r.target };
  }

  press(hand: 0 | 1, down: boolean): void {
    const r = this.rays[hand];
    const menu = this.current();
    if (!menu) {
      r.pressing = false;
      return;
    }
    if (down) {
      if (!r.uv) return;
      r.pressing = menu.panel.pointerDown(hand, r.uv);
      const id = menu.panel.buttonAt(r.uv)?.id;
      if (r.pressing && id) menu.pressStarted(id, performance.now() / 1000);
      return;
    }
    if (!r.pressing) return;
    r.pressing = false;
    menu.panel.pointerUp(hand, r.uv);
  }

  cancel(hand: 0 | 1): void {
    const r = this.rays[hand];
    this.current()?.panel.pointerCancel(hand);
    r.uv = null;
    r.target = null;
    r.pressing = false;
  }

  /** Each frame: what the menu shows, held steppers, and walking away from it. */
  update(dt: number) {
    const menu = this.current();
    if (!menu) return;
    const now = performance.now() / 1000;
    if (this.kind === 'hire' && (!this.hireDesk || !this.hooks.hire.desk(this.hireDesk))) {
      this.close();
      return;
    }
    const head = this.hooks.head();
    if (head) {
      menu.root.getWorldPosition(_p);
      if (Math.hypot(head.pos.x - _p.x, head.pos.z - _p.z) > this.leaveAt) {
        this.close();
        return;
      }
    }
    if (now >= this.refreshAt) {
      this.refreshAt = now + 0.25;
      menu.refresh();
    }
    menu.update(dt, now);
  }

  /** Debug and harness hook: what's open and what can be pressed. */
  state(): { open: NativeMenuKind | null; desk: string | null; targets: string[]; position: number[] | null } {
    const menu = this.current();
    return { open: this.kind, desk: this.desk, targets: menu?.targetIds() ?? [], position: menu ? menu.root.getWorldPosition(new THREE.Vector3()).toArray() : null };
  }

  /** Presses a target of the open menu by id, as a ray and trigger would. */
  pressTarget(id: string): boolean {
    return this.current()?.press(id) ?? false;
  }

  /** The world point at the middle of a target of the open menu, to aim a ray at (captures, tests). */
  targetPoint(id: string): [number, number, number] | null {
    const menu = this.current();
    const rect = menu?.targetRect(id);
    if (!menu || !rect) return null;
    const at = new THREE.Vector3((rect.x + rect.w / 2 - 0.5) * menu.panel.width, (0.5 - (rect.y + rect.h / 2)) * menu.panel.height, 0);
    menu.panel.mesh.updateMatrixWorld(true);
    return menu.panel.mesh.localToWorld(at).toArray() as [number, number, number];
  }

  private current(): VrMenu | null {
    return this.kind === 'settings' ? this.settings : this.kind === 'hire' ? this.hire : null;
  }

  private show(kind: NativeMenuKind, menu: VrMenu, distance: number) {
    this.kind = kind;
    this.leaveAt = Math.max(LEAVE_MIN, distance + LEAVE_SLACK);
    this.refreshAt = 0;
    menu.setVisible(true);
    this.hooks.feedback?.('open');
  }

  /** Stands the menu at `at`, its face toward the eyes. It stays there: nothing moves it after this. */
  private place(menu: VrMenu, at: THREE.Vector3, eye: THREE.Vector3) {
    menu.root.position.copy(at);
    menu.root.lookAt(eye);
    menu.root.updateMatrixWorld(true);
  }

  /** How far ahead a menu can open before it would sink into a wall or a desk. */
  private clearAhead(eye: THREE.Vector3, dir: THREE.Vector3, want: number): number {
    const hit = this.hooks.obstacle?.(_q.copy(eye).setY(eye.y - SETTINGS_DROP), dir, want + 0.1) ?? null;
    return hit === null ? want : Math.max(MIN_AHEAD, Math.min(want, hit - 0.1));
  }
}
