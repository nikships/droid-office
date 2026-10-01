// Native OpenXR input and locomotion: VRSession's controller rules (vr/session.ts), fed by the
// native app's sampled input packets (native/input.ts) instead of a WebXR session.
//
// Motion controllers are the only native input; tracked hands are ignored. C++ samples the
// controllers and head at the display rate; Java hands every sample to consume() at about 30 Hz,
// and update() replays them in order, so an edge between two JS ticks still counts once.
// Grabs, teleport arcs, turning and collision reuse the desktop/WebXR helpers. Native face buttons
// have fixed left/right jobs; physical.ts owns tracked-grip strikes, climbing and the gun.
// Left Menu owns the workspace. Right Menu belongs to Android XR; grip never navigates menus.
//
// A controller that drops out for less than LOST_MS keeps its held buttons, grab and carried card
// and fires nothing until it returns. A controller that connects (or reconnects after that) with
// the trigger, grip, menu or N button already held treats it as held, so only a fresh press acts.
//
// The rig is VRSession's dolly without a camera under it: world = origin + yaw (+ drunk sway)
// applied to the native LOCAL_FLOOR pose. Native renders each eye from the latest rig matrix and
// its own 90 Hz head pose; the JS camera gets the head's world pose after every update, for
// picking, sprites and sound.

import * as THREE from 'three';
import type { PlayerController } from '../player';
import type { Settings } from '../state';
import type { InteractKind, Interactable } from '../world/office';
import type { BoardSpot } from '../world/board-layout';
import type { CarriedIssue, GhIssue } from '../../shared/protocol';
import { HeldCard } from '../world/card';
import { SOURCE_LAYER } from '../vr/batch';
import { VRGrab, type GrabAim, type GrabHooks } from '../vr/grab';
import { RayAccel } from '../vr/pick';
import { SnapTurn, sampleParabola, xrRayDirection, yawForFacing } from '../vr/session';
import { LOST_MS, MAX_QUEUE, type NativeHand, type NativeInputFrame, type Pose7, SQUEEZE_OFF, SQUEEZE_ON, STALE_MS, TRIGGER_OFF, TRIGGER_ON, pressLatch, readFrame, webStick } from './input';
import { applyGravity, findLanding, placeAvatar, rigFor, snapGround, stepToward } from './locomotion';
import { NativePhysical, type NativePhysicalHooks } from './physical';

/** VRSession's private stick thresholds: a push, and where a pushed stick re-arms. */
const STICK_ON = 0.7;
const STICK_OFF = 0.3;
/** Teleport arc samples (vr/session.ts ARC_STEPS). */
const ARC_STEPS = 24;
/** A head that jumps further than this between samples was recentered by the runtime, not walked. */
const HEAD_JUMP = 1.5;
/** Haptic requests waiting for the next state() pull. */
const MAX_HAPTICS = 16;

/** What the native controls need from main.ts: VRHooks without the WebXR renderer members, plus the native panel. */
export interface NativeHooks {
  player: PlayerController;
  settings: Settings;
  /** E on an Interactable: main.ts's vrUseE, which calls the desktop use(it, 'E', note, spot). */
  useE: (it: Interactable | null, note: GhIssue | null, spot?: BoardSpot | null) => void;
  pickFromRay: (ray: THREE.Raycaster, slack: number) => { it: Interactable; near: boolean; hit: THREE.Intersection } | null;
  noteUnder: (aim: { it: Interactable; hit: THREE.Intersection } | null) => GhIssue | null;
  spotUnder?: (aim: { it: Interactable; hit: THREE.Intersection } | null) => BoardSpot | null;
  nextWaiting: () => void;
  putBack: () => void;
  carrying: () => CarriedIssue | null;
  grab?: GrabHooks;
  modalOpen: () => boolean;
  toast: (text: string, level?: 'info' | 'warn' | 'error') => void;
  hudRefresh: () => void;
  reachOf: (kind: InteractKind) => number;
  reachAnim: () => void;
  onTarget: (it: Interactable | null, note: GhIssue | null, spot?: BoardSpot | null) => void;
  pickRoot?: () => THREE.Object3D | null;
  /** The ☰ menu (VRUiSink.toggleMenu): only the left controller's menu button calls it. */
  togglePanel: () => void;
  panelOpen?: () => boolean;
  openCommands?: () => void;
  toggleKeyboard?: () => void;
  back?: () => void;
  physical?: NativePhysicalHooks;
  /** The issue card in hand, for Home's held-card row (VRUiSink.setCarrying). */
  setCarrying?: (card: CarriedIssue | null) => void;
  /** Virtual moves carry head-placed panels (VRUiSink.carryAlong). */
  carryAlong?: (delta: THREE.Vector3) => void;
  /** A lost controller cancels that controller's panel press (VRUiSink.cancelRay). */
  cancelRay?: (hand: 0 | 1) => void;
}

type Vec3 = [number, number, number];

export interface NativeHandState {
  connected: boolean;
  ui: boolean;
  /** World hit of the ray: a green dot when near (in reach), cyan beyond. */
  hover: { point: Vec3; near: boolean } | null;
  /** This controller owns a grabbed object. */
  holding: boolean;
}

export interface NativeControlsState {
  v: 1;
  /** Changes whenever presentation must jump rather than interpolate through a move. */
  presentationEpoch: number;
  active: boolean;
  origin: Vec3;
  yaw: number;
  sway: [number, number];
  /** World from native LOCAL_FLOOR, column-major, sway included. */
  matrix: number[];
  /** Black overlay opacity, 0..1. */
  fade: number;
  head: { pos: Vec3; dir: Vec3 };
  hands: [NativeHandState, NativeHandState];
  teleport: { hand: 0 | 1; points: number[]; marker: Vec3; valid: boolean } | null;
  carrying: CarriedIssue | null;
  haptics: { hand: 0 | 1; strength: number; ms: number }[];
  stats: { queued: number; dropped: number; rejected: number };
}

interface HandSlot {
  idx: 0 | 1;
  handed: 'left' | 'right';
  connected: boolean;
  /** Sample time (ms) when a connected controller stopped reporting; null while it is tracked. */
  lostAt: number | null;
  gripLostAt: number | null;
  /** Native-space poses as children of the rig: their world matrices are the real device poses. */
  aim: THREE.Group;
  grip: THREE.Group;
  input: NativeHand | null;
  triggerDown: boolean;
  squeezeDown: boolean;
  hover: { it: Interactable; near: boolean; hit: THREE.Intersection } | null;
  hoverFresh: boolean;
  uiConsumed: boolean;
  wasPrimary: boolean;
  wasSecondary: boolean;
  wasClick: boolean;
  wasMenu: boolean;
  teleportReady: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _h = new THREE.Vector3();
const _l = new THREE.Vector3();
const _e = new THREE.Vector3();
const _u = new THREE.Vector3();
const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _p = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);

function setPose(o: THREE.Object3D, p: Pose7): void {
  o.position.set(p[0], p[1], p[2]);
  o.quaternion.set(p[3], p[4], p[5], p[6]);
}

export class NativeControls {
  /** Native input drives the avatar right now. */
  private on = false;
  /** How drunk the rig sways (main.ts feeds player.drunk each frame, as vr.sway). */
  sway = 0;
  /** VRSession's dolly: the native LOCAL_FLOOR space placed in the world. Anchors live under it. */
  readonly rig = new THREE.Group();

  private camera: THREE.PerspectiveCamera;
  private hooks: NativeHooks;
  private origin = new THREE.Vector3();
  private yaw = 0;
  private lastAvatar = new THREE.Vector3();
  private headLocal = new THREE.Vector3(0, 1.6, 0);
  private headQuat = new THREE.Quaternion();
  private headSeen = false;
  private headTracked = false;
  private needsRebase = false;
  private hands: [HandSlot, HandSlot];
  private raycaster = new THREE.Raycaster();
  private fade: 'idle' | 'out' | 'in' = 'idle';
  private fadeT = 0;
  private fadeOpacity = 0;
  private fadeHold = false;
  private pendingTeleport: THREE.Vector3 | null = null;
  private snap = new SnapTurn();
  private stickAiming = false;
  /** The slot whose stick started the current stick aim. */
  private stickSlot: 0 | 1 = 0;
  private glideActive = false;
  private grab: VRGrab | null;
  private physical: NativePhysical | null;
  private rayAccel = new RayAccel();
  private queue: NativeInputFrame[] = [];
  private lastTime = -Infinity;
  private lastInputAt = 0;
  /** The input clock: the latest replayed sample's time (ms). */
  private now = 0;
  private dropped = 0;
  private rejected = 0;
  private haptics: { hand: 0 | 1; strength: number; ms: number }[] = [];
  private arc: { hand: 0 | 1; points: number[]; marker: Vec3; valid: boolean } | null = null;
  private presentationEpoch = 0;
  /** Ray/window pickup uses the original card while physical near grabs keep VRGrab's own view. */
  private carriedRoot = new THREE.Group();
  private carriedView = new HeldCard(this.carriedRoot, 0.28);
  private carriedIssue: CarriedIssue | null = null;
  private carriedOwner: 0 | 1 | null = null;
  private carryPublishedAt = -Infinity;
  private interactionHand: 0 | 1 | null = null;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, hooks: NativeHooks) {
    this.camera = camera;
    this.hooks = hooks;
    this.raycaster.layers.enable(SOURCE_LAYER);
    this.grab = hooks.grab ? new VRGrab(scene, hooks.grab) : null;
    this.hands = [this.slot(0), this.slot(1)];
    this.physical = hooks.physical ? new NativePhysical(scene, [this.hands[0].grip, this.hands[1].grip], hooks.physical, (hand, strength, ms) => this.pulse(hand, strength, ms)) : null;
    this.carriedRoot.name = 'native-carried-issue';
    this.carriedRoot.position.set(0, 0.05, -0.06);
    this.rig.visible = false;
    scene.add(this.rig);
  }

  get active(): boolean {
    return this.on;
  }

  private slot(idx: 0 | 1): HandSlot {
    const s: HandSlot = {
      idx,
      handed: idx === 0 ? 'left' : 'right',
      connected: false,
      lostAt: null,
      gripLostAt: null,
      aim: new THREE.Group(),
      grip: new THREE.Group(),
      input: null,
      triggerDown: false,
      squeezeDown: false,
      hover: null,
      hoverFresh: false,
      uiConsumed: false,
      wasPrimary: false,
      wasSecondary: false,
      wasClick: false,
      wasMenu: false,
      teleportReady: true,
    };
    this.rig.add(s.aim, s.grip);
    return s;
  }

  /** Native input takes the avatar: spawn at its feet, facing the current view (VRSession.enter). */
  start(): void {
    if (this.on) return;
    this.jumpPresentation();
    const { player } = this.hooks;
    const viewFacing = player.view === 'first' ? player.facing : player.camYaw + Math.PI;
    player.facing = viewFacing;
    this.origin.copy(player.pos);
    this.yaw = yawForFacing(viewFacing);
    this.lastAvatar.copy(player.pos);
    this.needsRebase = true;
    this.headSeen = false;
    this.headTracked = false;
    this.queue = [];
    this.lastTime = -Infinity;
    this.lastInputAt = performance.now();
    for (const s of this.hands) this.dropHand(s, false);
    this.rig.position.copy(this.origin);
    this.rig.rotation.set(0, this.yaw, 0);
    this.rig.visible = true;
    this.rig.updateMatrixWorld(true);
    player.unlock();
    player.clearKeys();
    player.enabled = false;
    this.on = true;
    this.hooks.hudRefresh();
  }

  /** Back to the desktop controls, exactly as they were (VRSession.restore). */
  stop(): void {
    if (!this.on) return;
    this.jumpPresentation();
    const { player } = this.hooks;
    this.physical?.reset();
    this.clearGrab();
    this.on = false;
    this.rayAccel.reset();
    this.fade = 'idle';
    this.fadeOpacity = 0;
    this.fadeHold = false;
    this.pendingTeleport = null;
    this.stickAiming = false;
    this.glideActive = false;
    this.sway = 0;
    this.queue = [];
    this.arc = null;
    this.haptics = [];
    this.rig.rotation.set(0, 0, 0);
    this.rig.visible = false;
    player.climbInput = 0;
    for (const s of this.hands) this.dropHand(s, true);
    this.hooks.setCarrying?.(null);
    player.clearKeys();
    player.enabled = !this.hooks.modalOpen();
    player.updateCamera(true);
    this.hooks.hudRefresh();
  }

  /** Session paused or focus lost: forget queued samples and every controller's input, return a ray-picked card, leave the rig where it is. */
  reset(): void {
    this.jumpPresentation();
    this.physical?.reset();
    this.headTracked = false;
    this.clearCarriedIssue(true);
    this.queue = [];
    this.lastInputAt = performance.now();
    for (const s of this.hands) this.dropHand(s, true);
  }

  /** A runtime origin change must rebase against the first pose in the new space. */
  rebase(): void {
    this.reset();
    this.needsRebase = true;
  }

  /** Queues a batch of native samples (validated, in order, bounded). Returns how many were queued. */
  consume(frames: readonly unknown[]): number {
    if (!this.on || !Array.isArray(frames)) return 0;
    let n = 0;
    for (const raw of frames) {
      const f = readFrame(raw);
      if (!f || f.time <= this.lastTime) {
        this.rejected++;
        continue;
      }
      this.lastTime = f.time;
      this.queue.push(f);
      n++;
    }
    if (this.queue.length > MAX_QUEUE) {
      this.dropped += this.queue.length - MAX_QUEUE;
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
    }
    if (n) this.lastInputAt = performance.now();
    return n;
  }

  /** Floor and network transitions cannot leave a controller attached to the old world. */
  clearGrab(): void {
    this.grab?.clear();
    this.clearCarriedIssue(true);
    this.physical?.worldChanged();
  }

  get holdingGun(): boolean {
    return this.physical?.holdingGun === true;
  }

  cancelGun(): void {
    this.physical?.cancelGun();
  }

  /** The original pickUp/putDown/putBack dispatch calls this when its single carry slot changes. */
  syncCarrying(): void {
    const card = this.hooks.carrying();
    this.hooks.setCarrying?.(card);
    if (!this.on || !card || this.grab?.held) {
      this.clearCarriedIssue(false);
      return;
    }
    const changed = this.carriedIssue?.issue !== card.issue;
    if (changed) {
      this.carriedIssue = { issue: card.issue, title: card.title };
      this.carriedView.set(this.carriedIssue);
      this.carryPublishedAt = -Infinity;
      if (this.interactionHand !== null) this.carriedOwner = this.interactionHand;
    }
    if (this.carriedOwner === null) {
      const preferred = this.interactionHand === null ? [1, 0] : [this.interactionHand, 1 - this.interactionHand];
      const owner = preferred.find((i) => this.hands[i].lostAt === null && this.grabAnchor(this.hands[i as 0 | 1]));
      if (owner === undefined) {
        this.carriedRoot.visible = false;
        return;
      }
      this.carriedOwner = owner as 0 | 1;
    }
    const anchor = this.grabAnchor(this.hands[this.carriedOwner]);
    if (!anchor) {
      this.clearCarriedIssue(true);
      return;
    }
    this.carriedRoot.visible = true;
    if (this.carriedRoot.parent !== anchor) {
      anchor.add(this.carriedRoot);
      this.carriedRoot.position.set(0, 0.05, -0.06);
      this.carriedRoot.quaternion.identity();
      this.carryPublishedAt = -Infinity;
    }
    const now = performance.now();
    if (now - this.carryPublishedAt < 50) return;
    this.carryPublishedAt = now;
    // CarryPose is the grip frame; peer HeldObjectView adds the same card offset as this view.
    const position = anchor.getWorldPosition(new THREE.Vector3());
    const quaternion = anchor.getWorldQuaternion(new THREE.Quaternion());
    this.hooks.grab?.changed({ ...card, pose: { hand: this.carriedOwner === 0 ? 'left' : 'right', position: position.toArray(), quaternion: quaternion.toArray() } });
  }

  /** Faces the avatar's heading with the head straight: N and the elevator rebase the rig here. */
  faceAvatar(): void {
    if (!this.on) return;
    this.jumpPresentation();
    this.setYaw(yawForFacing(this.hooks.player.facing));
  }

  /** A yaw step about the head (snap turn's step; also the coordinator's debug hook). */
  turn(dYaw: number): void {
    if (!this.on) return;
    if (dYaw !== 0) this.jumpPresentation();
    this.setYaw(this.yaw + dYaw);
  }

  /** Puts the head over the avatar's feet, looking the avatar's way (after a runtime recenter). */
  recenter(): void {
    if (!this.on) return;
    this.jumpPresentation();
    this.yaw = rigFor(this.headLocal, this.headQuat, this.hooks.player.pos, this.hooks.player.facing, this.origin);
    this.lastAvatar.copy(this.hooks.player.pos);
    this.placeRig();
  }

  fadeOut(): void {
    if (!this.on) return;
    this.pendingTeleport = null;
    this.fade = 'out';
    this.fadeT = 0;
    this.fadeHold = true;
  }

  fadeIn(): void {
    if (!this.on) return;
    this.fadeHold = false;
    if (this.fade === 'out' && this.fadeT >= 1) {
      this.fade = 'in';
      this.fadeT = 0;
    }
  }

  /** Puts the avatar somewhere on this floor, through the fade when it's on (the people view's walk-over). */
  teleportTo(at: THREE.Vector3): void {
    if (!this.on) return;
    if (this.hooks.settings.vr.fade) {
      this.pendingTeleport = at.clone();
      this.fade = 'out';
      this.fadeT = 0;
    } else {
      placeAvatar(this.hooks.player, at);
      this.jumpPresentation();
      this.followHead();
    }
  }

  /** Head look direction in the world, for the ears. */
  lookDir(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.headWorldQuat(_q));
  }

  /** One brain tick, in place of player.update: replay the queued samples, then locomotion. */
  update(dt: number): void {
    if (!this.on) return;
    const { player } = this.hooks;
    // Main's N/Go-to-desk/elevator arrivals can place the body between brain ticks.
    // Internal glide, room scale and gravity happen later, so ordinary motion does not jump.
    if (player.pos.distanceToSquared(this.lastAvatar) > 1e-10) this.jumpPresentation();
    this.rayAccel.update(this.hooks.pickRoot?.() ?? null);
    if (performance.now() - this.lastInputAt > STALE_MS) {
      for (const s of this.hands) if (s.connected) this.disconnect(s);
    }
    // Samples first: at 30 Hz the ladder and the stand-up check should see this tick's sticks, not the last one's.
    this.placeRig();
    // The rig moved since the last tick (glide, teleport, desktop moves): last tick's hover is stale even without new samples.
    for (const s of this.hands) s.hoverFresh = false;
    const frames = this.queue;
    this.queue = [];
    for (const f of frames) this.replay(f);
    const rigged = !!player.rig;
    if (rigged) {
      player.climbInput = 0;
      player.rig?.(dt);
    } else {
      player.climbInput = 0;
      if (!player.seat) applyGravity(player, dt);
    }
    if (player.seat && !rigged && (this.glideIntent() || this.stickAiming)) player.stand();
    const aiming = this.teleportAiming();
    for (const s of this.hands) {
      if (aiming) s.hover = null;
      else this.freshHover(s);
    }
    this.updateTeleport();
    if (this.hooks.settings.vr.turn !== 'snap') this.smoothTurn(dt);
    if (!player.rig) this.updateGlide(dt);
    this.followHead();
    this.rig.updateMatrixWorld(true);
    for (const s of this.hands) {
      if (this.grab?.owns(s.idx) && !this.grabAnchor(s)) this.clearGrab();
    }
    this.headWorld(_h);
    _h.y -= 0.08;
    this.grab?.update(_h, performance.now());
    this.syncCarrying();
    this.physical?.update(dt);
    this.updateFade(dt);
    const aim = this.hands[1].hover ?? this.hands[0].hover ?? null;
    const note = aim?.near ? this.hooks.noteUnder(aim) : null;
    const spot = aim?.near ? (this.hooks.spotUnder?.(aim) ?? null) : null;
    this.hooks.onTarget(aim?.near ? aim.it : null, note, spot);
    this.writeCamera();
  }

  /** The renderer's view of the controls: rig, fade, arc, hover dots and haptics (drained). */
  state(): NativeControlsState {
    this.rig.updateMatrixWorld(true);
    this.headWorldFull(_h);
    this.lookDir(_d);
    const haptics = this.haptics;
    this.haptics = [];
    const hand = (s: HandSlot): NativeHandState => ({
      connected: s.connected,
      ui: s.uiConsumed,
      hover: s.hover ? { point: [s.hover.hit.point.x, s.hover.hit.point.y, s.hover.hit.point.z], near: s.hover.near } : null,
      holding: this.ownsObject(s.idx),
    });
    return {
      v: 1,
      presentationEpoch: this.presentationEpoch,
      active: this.on,
      origin: [this.origin.x, this.origin.y, this.origin.z],
      yaw: this.yaw,
      sway: [this.rig.rotation.x, this.rig.rotation.z],
      matrix: this.rig.matrixWorld.toArray(),
      fade: this.fadeOpacity,
      head: { pos: [_h.x, _h.y, _h.z], dir: [_d.x, _d.y, _d.z] },
      hands: [hand(this.hands[0]), hand(this.hands[1])],
      teleport: this.arc,
      carrying: this.hooks.carrying(),
      haptics,
      stats: { queued: this.queue.length, dropped: this.dropped, rejected: this.rejected },
    };
  }

  /** One native sample: poses in, then every edge VRSession resolves per event or per frame. */
  private replay(f: NativeInputFrame): void {
    this.now = f.time;
    this.headTracked = f.headTracked !== false;
    if (f.headTracked !== false) {
      _e.set(f.head[0], f.head[1], f.head[2]);
      const jumped = this.headSeen && _e.distanceTo(this.headLocal) > HEAD_JUMP;
      this.headLocal.copy(_e);
      this.headQuat.set(f.head[3], f.head[4], f.head[5], f.head[6]);
      if (!this.headSeen || this.needsRebase || jumped) {
        this.headSeen = true;
        this.needsRebase = false;
        this.recenter();
      }
    }
    for (const s of this.hands) this.applyHand(s, f.hands[s.idx]);
    this.rig.updateMatrixWorld(true);
    this.physical?.sample(f, this.headWorldFull(_h), this.headWorldQuat(_q), !this.worldBlocked(), (hand) => this.ownsCarry(hand));
    for (const s of this.hands) this.controllerEdges(s);
    this.pollButtons();
    // A lost turn controller reads as a centered stick, which would re-arm the snap and turn
    // again when it returns still pushed, so the snap only sees tracked sticks.
    const turn = this.turnSlot();
    if (this.hooks.settings.vr.turn === 'snap' && turn && turn.lostAt === null) {
      const dYaw = this.snap.update(this.turnStick().x);
      if (dYaw !== 0) {
        this.jumpPresentation();
        this.setYaw(this.yaw + dYaw);
      }
    }
  }

  /**
   * Connect, loss and poses for one controller slot. A brief loss keeps the slot, its latches,
   * grab and carried card at the last pose; a longer one disconnects. A fresh connect seeds the
   * trigger, grip, menu and N latches from the sample, so a button already held is not a press.
   * A and the sticks are held state (as in VRSession), so holding them resumes aiming or moving.
   */
  private applyHand(s: HandSlot, h: NativeHand): void {
    if (!h.active) {
      if (!s.connected) return;
      if (s.lostAt === null) this.lose(s);
      else if (this.now - s.lostAt >= LOST_MS) this.disconnect(s);
      return;
    }
    if (!s.connected) {
      s.connected = true;
      s.triggerDown = h.trigger >= TRIGGER_OFF;
      s.squeezeDown = h.squeeze >= SQUEEZE_OFF;
      s.wasPrimary = h.a;
      s.wasSecondary = h.b;
      s.wasClick = h.stickClick === true;
      s.wasMenu = h.menu;
      s.teleportReady = h.stick[1] < STICK_ON;
    }
    s.lostAt = null;
    s.input = h;
    setPose(s.aim, h.aim);
    if (h.gripTracked !== false) {
      setPose(s.grip, h.grip);
      s.gripLostAt = null;
    } else {
      s.gripLostAt ??= this.now;
      if (this.now - s.gripLostAt >= LOST_MS) this.cancelCarry(s.idx);
    }
    s.hoverFresh = false;
    // A controller holding an object is never on a panel: its ray aims the card at the world (VRSession skips routeRay).
    s.uiConsumed = h.ui && !this.ownsObject(s.idx);
  }

  /**
   * The controller stopped reporting. Nothing fires from it until it returns; its held buttons
   * and a teleport aim it holds resolve against the returning sample.
   */
  private lose(s: HandSlot): void {
    s.lostAt = this.now;
    s.input = null;
    s.hover = null;
    s.hoverFresh = true;
    s.uiConsumed = false;
    this.hooks.cancelRay?.(s.idx);
  }

  /** Controller trigger down is E at once; squeeze down grabs or returns the card, squeeze up releases (VRSession events). */
  private controllerEdges(s: HandSlot): void {
    const h = s.input;
    if (!s.connected || !h) return;
    const squeeze = pressLatch(s.squeezeDown, h.squeeze, SQUEEZE_ON, SQUEEZE_OFF);
    const was = s.squeezeDown;
    const owned = this.physical?.owns(s.idx) === true;
    s.squeezeDown = squeeze;
    if (squeeze && !was) this.onSqueeze(s);
    else if (!squeeze && was) {
      this.physical?.gripRelease(s.idx);
      if (h.gripTracked === false) this.cancelCarry(s.idx);
      else this.grab?.release(s.idx, this.grabAim(s));
    }
    const trigger = pressLatch(s.triggerDown, h.trigger, TRIGGER_ON, TRIGGER_OFF);
    const pressed = trigger && !s.triggerDown;
    s.triggerDown = trigger;
    if (pressed && !(owned && !squeeze)) {
      this.pulse(s.idx, 0.15, 10);
      this.tapE(s);
    }
  }

  private disconnect(s: HandSlot): void {
    this.physical?.cancelHand(s.idx);
    this.cancelCarry(s.idx);
    this.dropHand(s, true);
  }

  private dropHand(s: HandSlot, cancel: boolean): void {
    s.connected = false;
    s.lostAt = null;
    s.gripLostAt = null;
    s.input = null;
    s.hover = null;
    s.hoverFresh = false;
    s.uiConsumed = false;
    s.triggerDown = false;
    s.squeezeDown = false;
    s.wasPrimary = false;
    s.wasSecondary = false;
    s.wasClick = false;
    s.wasMenu = false;
    s.teleportReady = true;
    if (this.stickAiming && this.stickSlot === s.idx) this.stickAiming = false;
    if (cancel) this.hooks.cancelRay?.(s.idx);
  }

  /** The tap itself: E on whatever that ray hovers, through the shared dispatch (VRSession.tapE). */
  private tapE(s: HandSlot): void {
    if (this.physical?.trigger(s.idx, this.now)) return;
    if (s.uiConsumed || this.worldBlocked()) return;
    if (s.input?.gripTracked === false && this.ownsCarry(s.idx)) return;
    if (this.grab?.use(s.idx, this.grabAim(s))) return;
    const hover = this.freshHover(s);
    if (this.hooks.player.rig) return;
    if (!hover?.near) return;
    if (hover.it.kind === 'gong' || hover.it.kind === 'ladder' || hover.it.kind === 'pole') return;
    this.hooks.reachAnim();
    this.useWithHand(s.idx, hover.it, this.hooks.noteUnder(hover), this.hooks.spotUnder?.(hover) ?? null);
    this.hooks.setCarrying?.(this.hooks.carrying());
    this.pulse(s.idx, 0.4, 25);
  }

  /**
   * Squeeze holds a physical object. Buttons and triggers handle workspace navigation.
   * It never opens, closes or toggles the menu or a window: the left menu button does that.
   */
  private onSqueeze(s: HandSlot): void {
    if (s.uiConsumed || this.worldBlocked() || s.input?.gripTracked === false || this.ownsCarry(s.idx) || this.teleportAiming()) return;
    if (this.physical?.gripPress(s.idx)) return;
    if (this.grab?.held || this.physical?.owns(s.idx)) return;
    if (!this.hooks.player.rig && this.grab?.begin(s.idx, s.handed, s.grip)) {
      this.pulse(s.idx, 0.4, 25);
    }
  }

  private grabAim(s: HandSlot): GrabAim | null {
    const hover = s.uiConsumed ? null : this.freshHover(s);
    return hover?.near ? { it: hover.it, note: this.hooks.noteUnder(hover) } : null;
  }

  /** The controller grip; during a brief loss it stays at the last tracked pose. */
  private grabAnchor(s: HandSlot): THREE.Object3D | null {
    return s.connected ? s.grip : null;
  }

  /** A controller rumble request for native. */
  private pulse(idx: 0 | 1, strength: number, ms: number): void {
    const s = this.hands[idx];
    if (!s.connected || s.lostAt !== null) return;
    if (this.haptics.length >= MAX_HAPTICS) this.haptics.shift();
    this.haptics.push({ hand: idx, strength, ms });
  }

  private ownsCarry(idx: 0 | 1): boolean {
    return !!this.grab?.owns(idx) || (this.carriedIssue !== null && this.carriedOwner === idx);
  }

  private ownsObject(idx: 0 | 1): boolean {
    return this.ownsCarry(idx) || this.physical?.owns(idx) === true;
  }

  private cancelCarry(idx: 0 | 1): void {
    if (this.grab?.owns(idx)) this.grab.clear();
    if (this.carriedOwner === idx) this.clearCarriedIssue(true);
  }

  private worldBlocked(): boolean {
    return !this.headTracked || this.hooks.modalOpen() || this.hooks.panelOpen?.() === true || this.fade !== 'idle';
  }

  private clearCarriedIssue(returnToBoard: boolean): void {
    const hadCard = this.carriedIssue !== null;
    const published = Number.isFinite(this.carryPublishedAt);
    this.carriedIssue = null;
    this.carriedOwner = null;
    this.carryPublishedAt = -Infinity;
    this.carriedView.set(null);
    this.carriedRoot.removeFromParent();
    if (hadCard && published) this.hooks.grab?.changed(null);
    if (hadCard && returnToBoard && this.hooks.carrying()) this.hooks.putBack();
  }

  private useWithHand(idx: 0 | 1, it: Interactable, note: GhIssue | null, spot: BoardSpot | null = null): void {
    this.interactionHand = idx;
    try {
      this.hooks.useE(it, note, spot);
      this.syncCarrying();
    } finally {
      this.interactionHand = null;
    }
  }

  private jumpPresentation(): void {
    this.presentationEpoch = (this.presentationEpoch + 1) >>> 0;
    this.physical?.reanchor();
  }

  /** The ray's world hover for the current sample, raycast once per sample and only when asked. */
  private freshHover(s: HandSlot): HandSlot['hover'] {
    if (s.hoverFresh) return s.hover;
    s.hoverFresh = true;
    if (!s.connected || s.lostAt !== null || s.uiConsumed || this.physical?.owns(s.idx) || this.worldBlocked() || this.teleportAiming()) {
      s.hover = null;
      return null;
    }
    this.rayOut(s);
    this.raycaster.set(_o, _d);
    this.raycaster.camera = this.camera;
    this.raycaster.far = this.hooks.reachOf('tv') + 6;
    s.hover = this.hooks.pickFromRay(this.raycaster, 0);
    return s.hover;
  }

  private rayOut(s: HandSlot): void {
    _o.setFromMatrixPosition(s.aim.matrixWorld);
    xrRayDirection(s.aim, _d);
  }

  /**
   * Fixed left/right roles: X next worker, Y commands, left stick-click sprint; A jump,
   * B back, right stick-click keyboard. Right stick-forward aims and releases a teleport.
   * Left Menu owns the workspace; right Menu is reserved by Android XR.
   */
  private pollButtons(): void {
    for (const s of this.hands) {
      const pad = this.pad(s);
      if (!pad) continue;
      if (s.idx === 0) {
        if (pad.menu && !s.wasMenu) {
          this.hooks.togglePanel();
          this.pulse(s.idx, 0.3, 20);
        }
        s.wasMenu = pad.menu;
        if (pad.a && !s.wasPrimary && !this.hooks.player.rig && !this.hooks.modalOpen() && !this.holdingGun) this.hooks.nextWaiting();
        if (pad.b && !s.wasSecondary) this.hooks.openCommands?.();
      } else {
        if (pad.a && !s.wasPrimary && !s.uiConsumed && !this.worldBlocked() && !this.teleportAiming()) this.hooks.player.jump();
        if (pad.b && !s.wasSecondary) {
          if (this.hooks.panelOpen?.() || this.hooks.modalOpen()) this.hooks.back?.();
          else if (this.hooks.carrying()) {
            this.clearGrab();
            if (this.hooks.carrying()) this.hooks.putBack();
          }
        }
        if (pad.stickClick && !s.wasClick && this.hooks.panelOpen?.()) this.hooks.toggleKeyboard?.();
      }
      s.wasPrimary = pad.a;
      s.wasSecondary = pad.b;
      s.wasClick = pad.stickClick === true;
    }
    const teleport = this.slotFor('right');
    if (teleport && this.pad(teleport)) {
      const y = this.stickOf(teleport).y;
      const allowed = !this.hooks.player.rig && !teleport.uiConsumed && !this.worldBlocked() && !this.ownsObject(1);
      if (!allowed) {
        this.stickAiming = false;
        teleport.teleportReady = y > -STICK_OFF;
      } else if (this.stickAiming && y > -STICK_OFF) {
        this.stickAiming = false;
        teleport.teleportReady = true;
        this.fireTeleport(teleport);
      } else if (!this.stickAiming && teleport.teleportReady && y < -STICK_ON && Math.abs(this.stickOf(teleport).x) < STICK_OFF) {
        this.stickAiming = true;
        this.stickSlot = 1;
      } else if (y > -STICK_OFF) {
        teleport.teleportReady = true;
      }
    } else if (!teleport || teleport.lostAt === null) {
      this.stickAiming = false;
    }
  }

  /** A tracked controller's buttons and stick (vr/session.ts controllerPad); nothing while it is lost. */
  private pad(s: HandSlot): NativeHand | null {
    return s.connected && s.lostAt === null ? s.input : null;
  }

  /** The WebXR-convention stick (forward is -y) of a slot's controller; centered while it is lost. */
  private stickOf(s: HandSlot | undefined): { x: number; y: number } {
    const pad = s ? this.pad(s) : null;
    return pad ? webStick(pad.stick) : { x: 0, y: 0 };
  }

  /** VRSession.rayFor with fixed handedness: native slots are always [left, right]. A briefly lost slot keeps its role. */
  private slotFor(hand: 'left' | 'right'): HandSlot | undefined {
    const s = this.hands[hand === 'left' ? 0 : 1];
    return s.connected ? s : undefined;
  }

  private moveStick(): { x: number; y: number } {
    const slot = this.slotFor('left');
    return slot?.uiConsumed || this.worldBlocked() ? { x: 0, y: 0 } : this.stickOf(slot);
  }

  private turnSlot(): HandSlot | undefined {
    return this.slotFor('right');
  }

  private turnStick(): { x: number; y: number } {
    const slot = this.turnSlot();
    return slot?.uiConsumed || this.worldBlocked() || this.hooks.player.rig || this.stickAiming ? { x: 0, y: 0 } : this.stickOf(slot);
  }

  private glideIntent(): boolean {
    if (!this.hooks.settings.vr.glide) return false;
    const s = this.moveStick();
    return Math.hypot(s.x, s.y) > STICK_ON;
  }

  private teleportAiming(): boolean {
    return this.stickAiming;
  }

  /** The right controller owns teleport even while the other hand is tracking. */
  private aimingSlot(): HandSlot | undefined {
    const stick = this.stickAiming ? this.hands[this.stickSlot] : undefined;
    return stick?.connected ? stick : undefined;
  }

  /** The arc and landing marker for native to draw while a teleport is aimed. */
  private updateTeleport(): void {
    const s = this.teleportAiming() ? this.aimingSlot() : undefined;
    if (!s) {
      this.arc = null;
      return;
    }
    this.rayOut(s);
    const pts = sampleParabola(_o, _d);
    const landing = findLanding(this.hooks.player, pts);
    const at = landing ?? pts[pts.length - 1];
    const points = new Array<number>(ARC_STEPS * 3);
    for (let i = 0; i < ARC_STEPS; i++) {
      points[i * 3] = pts[i].x;
      points[i * 3 + 1] = pts[i].y;
      points[i * 3 + 2] = pts[i].z;
    }
    this.arc = { hand: s.idx, points, marker: [at.x, at.y + 0.02, at.z], valid: !!landing };
  }

  private fireTeleport(from?: HandSlot): void {
    const s = from ?? this.aimingSlot();
    if (!s?.connected) return;
    this.rayOut(s);
    const landing = findLanding(this.hooks.player, sampleParabola(_o, _d));
    if (!landing) return;
    this.pulse(s.idx, 0.5, 30);
    if (this.hooks.settings.vr.fade) {
      this.pendingTeleport = landing;
      this.fade = 'out';
      this.fadeT = 0;
    } else {
      placeAvatar(this.hooks.player, landing);
      this.jumpPresentation();
    }
  }

  private smoothTurn(dt: number): void {
    const x = this.turnStick().x;
    if (Math.abs(x) <= 0.15) return;
    this.setYaw(this.yaw - x * THREE.MathUtils.degToRad(this.hooks.settings.vr.turnSpeed) * dt);
  }

  /** Smooth stick glide relative to the head (VRSession.updateGlide). */
  private updateGlide(dt: number): void {
    this.glideActive = false;
    if (!this.hooks.settings.vr.glide) return;
    const move = this.slotFor('left');
    if (move?.uiConsumed) return;
    const { player } = this.hooks;
    if (player.seat) return;
    const s = this.moveStick();
    if (Math.hypot(s.x, s.y) < 0.15) return;
    _f.set(0, 0, -1).applyQuaternion(this.headWorldQuat(_q));
    _f.y = 0;
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1);
    _f.normalize();
    _l.set(-_f.z, 0, _f.x);
    const speed = (move && this.pad(move)?.stickClick ? 7.5 : 4.6) * player.speedBoost;
    let dx = (_l.x * s.x - _f.x * s.y) * speed * dt;
    let dz = (_l.z * s.x - _f.z * s.y) * speed * dt;
    const staggerT = performance.now() / 1000;
    const stagger = this.sway * (0.4 * Math.sin(staggerT * 1.6) + 0.22 * Math.sin(staggerT * 3.7 + 1));
    if (stagger !== 0) {
      const c = Math.cos(stagger);
      const s2 = Math.sin(stagger);
      const rx = dx * c - dz * s2;
      dz = dx * s2 + dz * c;
      dx = rx;
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.1));
    for (let i = 0; i < steps; i++) player.stepTo(player.pos.x + dx / steps, player.pos.z + dz / steps);
    this.glideActive = true;
    if (player.grounded) snapGround(player);
  }

  /** Room-scale into the avatar, desktop moves into the rig (VRSession.followHead). */
  private followHead(): void {
    const { player } = this.hooks;
    this.headWorld(_h);
    _e.subVectors(player.pos, this.lastAvatar);
    _e.y = 0;
    let roomMoved = false;
    if (_e.length() > 1e-4) {
      this.origin.add(_e);
    } else if (!player.seat && !player.rig && this.headSeen) {
      if (Math.hypot(_h.x - player.pos.x, _h.z - player.pos.z) > 1e-4) {
        roomMoved = true;
        stepToward(player, _h.x, _h.z);
        if (player.grounded) snapGround(player);
      }
    }
    this.origin.y = player.pos.y;
    const t = performance.now() / 1000;
    const d = this.sway;
    this.rig.rotation.z = d > 0 ? d * (0.07 * Math.sin(t * 0.9) + 0.025 * Math.sin(t * 2.3 + 1)) : 0;
    this.rig.rotation.x = d > 0 ? d * 0.03 * Math.sin(t * 0.7 + 2) : 0;
    this.placeRig();
    if (!roomMoved) {
      _u.subVectors(player.pos, this.lastAvatar);
      if (_u.lengthSq() > 1e-10) this.hooks.carryAlong?.(_u.clone());
    }
    const carried = _e.length() > 1e-4;
    this.lastAvatar.copy(player.pos);
    player.moving = this.glideActive || roomMoved || carried || this.fade !== 'idle';
    player.facing = this.headFacing();
    player.camYaw = player.facing - Math.PI;
  }

  private updateFade(dt: number): void {
    if (this.fade === 'idle') {
      this.fadeOpacity = 0;
      return;
    }
    if (this.fade === 'out') {
      this.fadeT += dt / 0.09;
      this.fadeOpacity = Math.min(1, this.fadeT);
      if (this.fadeT >= 1) {
        if (this.pendingTeleport) {
          placeAvatar(this.hooks.player, this.pendingTeleport);
          this.jumpPresentation();
          // The epoch and rig must describe the same full-black packet. Otherwise the
          // next tick would move a tiny teleport after its discontinuity had been consumed.
          this.followHead();
          this.pendingTeleport = null;
        }
        if (this.fadeHold) {
          this.fadeOpacity = 1;
        } else {
          this.fade = 'in';
          this.fadeT = 0;
        }
      }
    } else {
      this.fadeT += dt / 0.14;
      this.fadeOpacity = Math.max(0, 1 - this.fadeT);
      if (this.fadeT >= 1) {
        this.fade = 'idle';
        this.fadeOpacity = 0;
      }
    }
  }

  /** Turns the rig to a yaw around the head, so turning never translates the avatar (VRSession.setYaw). */
  private setYaw(yaw: number): void {
    this.headWorld(_h);
    this.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    _l.set(this.headLocal.x, 0, this.headLocal.z).applyAxisAngle(UP, this.yaw);
    this.origin.set(_h.x - _l.x, this.origin.y, _h.z - _l.z);
    this.placeRig();
  }

  private placeRig(): void {
    this.rig.position.copy(this.origin);
    this.rig.rotation.y = this.yaw;
    this.rig.updateMatrixWorld(true);
  }

  /** The head in the world through origin and yaw only, as VRSession.headWorld (logic ignores the sway). */
  private headWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.headLocal).applyAxisAngle(UP, this.yaw).add(this.origin);
  }

  /** The head in the world through the full rig, sway included: what the eyes see. */
  private headWorldFull(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.headLocal).applyMatrix4(this.rig.matrixWorld);
  }

  private headWorldQuat(out: THREE.Quaternion): THREE.Quaternion {
    return out.copy(this.headQuat).premultiply(this.rig.quaternion);
  }

  private headFacing(): number {
    _f.set(0, 0, -1).applyQuaternion(this.headWorldQuat(_q));
    return Math.atan2(_f.x, _f.z);
  }

  /** The JS camera takes the head's world pose (for picking, sprites and sound), under whatever parent main.ts gave it. */
  private writeCamera(): void {
    this.rig.updateMatrixWorld(true);
    this.headWorldFull(_h);
    this.headWorldQuat(_q);
    _m.compose(_h, _q, _s);
    const cam = this.camera;
    if (cam.parent) {
      cam.parent.updateMatrixWorld(true);
      _m.premultiply(_p.copy(cam.parent.matrixWorld).invert());
    }
    _m.decompose(cam.position, cam.quaternion, _e);
    cam.updateMatrixWorld(true);
  }
}
