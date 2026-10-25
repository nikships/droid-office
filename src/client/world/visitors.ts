import * as THREE from 'three';
import { visitRoute, visitSpot, type Visit, type VisitPhase } from '../../shared/visits';
import type { VisitPose, Worker } from './character';
import type { DeskView } from './office';
import { pointAlong, routeLength, SEATED, stepProgress, visitProgress, type RoutePoint } from './visit-path';

/** A worker's feet are this far above its origin (as in leaving.ts). */
const FEET = 0.07;
/** How high it hops getting off its chair, over the straight line down. */
const HOP_ARC = 0.35;

/** A worker as it sits at its desk: the model, and where it sits. */
export interface Seated {
  model: Worker;
  desk: DeskView;
}

/** What a visitor is doing, as office.visits() reports it. */
export type VisitStep = 'seated' | 'getting up' | 'walking' | 'at spot' | 'walking back' | 'sitting down';

export interface VisitorInfo {
  visit: string | null;
  host: string | null;
  phase: VisitPhase | null;
  step: VisitStep;
  pose: VisitPose | null;
  x: number;
  z: number;
  /** Which way it faces, by the office's convention (0 faces -z). */
  facing: number;
  lean: number;
}

interface Walker {
  id: string;
  model: Worker;
  desk: DeskView;
  /** The visit it's on, or null once it's over (or gone): it heads back to its seat. */
  visit: Visit | null;
  /** A visit to another desk that came while it was still out: it starts once it's back in its seat. */
  next: Visit | null;
  key: string;
  route: [number, number][];
  length: number;
  /** Facing its first step off the chair, and facing the host's laptop on its spot (model headings, 0 is +z). */
  offHeading: number;
  spotHeading: number;
  /** Where it is (see visit-path.ts): -1 seated, up to `length` on its spot. */
  u: number;
  /**
   * How far along its route it was when told to walk back (its route's length if it was on its spot):
   * one turned back short of the spot walks home from there, rather than on to the spot first.
   */
  backFrom: number | null;
  /** Off its seat, in the scene. */
  out: boolean;
  seat: THREE.Vector3;
  seatHeading: number;
  scale: number;
  heading: number;
  step: VisitStep;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const scratch = new THREE.Vector3();
const at: RoutePoint = { x: 0, z: 0, heading: 0 };

/**
 * Workers away from their desks on visits (shared/visits.ts): each gets up, walks its route over to
 * its spot at the host's desk, stands there (leaning over the laptop while it reads), and walks back
 * and sits down, all on the office's clock so every page shows it at the same place. A visit that
 * ends early, or a host that goes, sends it back the way it came.
 */
export class Visitors {
  private walkers = new Map<string, Walker>();
  private stirring = false;

  constructor(
    private parent: THREE.Object3D,
    /** The top of whatever is underfoot at (x, z) for feet at `y`. */
    private ground: (x: number, z: number, y: number) => number,
    /** A worker on this floor, at its desk. */
    private seatOf: (workerId: string) => Seated | undefined,
    /** The office's clock, ms since 1970. */
    private now: () => number,
  ) {}

  /** Someone walking, or on or off a chair: the scene is moving. */
  get moving(): boolean {
    return this.stirring;
  }

  /** The floor's visits, as the server last sent them. */
  sync(visits: readonly Visit[]) {
    const on = new Set<string>();
    for (const v of visits) {
      const me = this.seatOf(v.visitor);
      if (!me || !this.seatOf(v.host)) continue;
      on.add(v.visitor);
      let w = this.walkers.get(v.visitor);
      // Its model was made again (its view was rebuilt): the old one is someone else's to dispose.
      if (w && w.model !== me.model) {
        this.walkers.delete(v.visitor);
        w = undefined;
      }
      if (!w) {
        w = this.walker(v.visitor, me);
        this.walkers.set(v.visitor, w);
        this.plan(w, v);
        // Seen mid-visit (the page just opened, or you came to this floor): it's already where it would be.
        w.backFrom = w.length;
        w.u = this.target(w);
        if (w.u > SEATED) {
          this.getUp(w);
          // Facing the way it's going, if it's on its way.
          const along = w.u < w.length - 1e-3 ? (v.phase === 'returning' ? 1e-3 : -1e-3) : 0;
          this.pose(w, w.u + along, w.u, 0, true);
        }
        continue;
      }
      if (w.key === this.keyOf(v)) {
        w.visit = v;
        w.next = null;
      } else if (!w.out) this.plan(w, v);
      else {
        // Out on another errand: back to its seat first, then off to this one.
        w.visit = null;
        w.next = v;
      }
    }
    for (const w of this.walkers.values())
      if (!on.has(w.id)) {
        w.visit = null;
        w.next = null;
      }
  }

  update(dt: number) {
    const now = this.now();
    this.stirring = false;
    for (const w of this.walkers.values()) {
      const target = this.target(w, now);
      const before = w.u;
      w.u = stepProgress(w.u, target, dt, w.length);
      if (w.u <= SEATED && target <= SEATED) {
        if (w.out) this.sitDown(w);
        w.step = 'seated';
        if (w.next) {
          const v = w.next;
          w.next = null;
          if (this.seatOf(v.visitor) && this.seatOf(v.host)) this.plan(w, v);
        } else if (!w.visit) this.walkers.delete(w.id);
        continue;
      }
      if (!w.out) this.getUp(w);
      this.pose(w, before, target, dt, false);
    }
  }

  /** The worker is going (sent home, shot, gone from the floor): back on its seat at once, and forgotten. */
  release(workerId: string) {
    const w = this.walkers.get(workerId);
    if (!w) return;
    if (w.out) this.sitDown(w);
    this.walkers.delete(workerId);
  }

  /** Off to another floor: everyone here is back in their seats. */
  clear() {
    for (const id of [...this.walkers.keys()]) this.release(id);
  }

  /** Where a worker is on its visit, for office.visits(); null when it isn't on one. */
  info(workerId: string): VisitorInfo | null {
    const w = this.walkers.get(workerId);
    if (!w) return null;
    const p = w.model.root.getWorldPosition(scratch);
    return {
      visit: w.visit?.id ?? null,
      host: w.visit?.host ?? null,
      phase: w.visit?.phase ?? null,
      step: w.step,
      pose: w.model.visitPose,
      x: p.x,
      z: p.z,
      facing: wrap((w.out ? w.heading : w.seatHeading) - Math.PI),
      lean: w.model.lean,
    };
  }

  private keyOf(v: Visit): string {
    return `${this.seatOf(v.visitor)?.desk.def.id}|${this.seatOf(v.host)?.desk.def.id}|${v.slot}`;
  }

  private walker(id: string, me: Seated): Walker {
    const heading = me.desk.def.rotY + Math.PI;
    return {
      id,
      model: me.model,
      desk: me.desk,
      visit: null,
      next: null,
      key: '',
      route: [],
      length: 0,
      offHeading: heading,
      spotHeading: heading,
      u: SEATED,
      backFrom: null,
      out: false,
      seat: new THREE.Vector3(),
      seatHeading: heading,
      scale: 1,
      heading,
      step: 'seated',
    };
  }

  /** Sets it off on `v`: its route from its own desk to its spot at the host's. */
  private plan(w: Walker, v: Visit) {
    const hostDesk = this.seatOf(v.host)!.desk.def.id;
    const route = visitRoute(w.desk.def.id, hostDesk, v.slot);
    const spot = visitSpot(hostDesk, v.slot);
    w.visit = v;
    w.backFrom = null;
    w.key = this.keyOf(v);
    w.route = route;
    w.length = routeLength(route);
    w.spotHeading = spot.rotY + Math.PI;
    w.offHeading = route.length > 1 ? Math.atan2(route[1][0] - route[0][0], route[1][1] - route[0][1]) : w.spotHeading;
  }

  private target(w: Walker, now = this.now()): number {
    const v = w.visit;
    if (!v) return SEATED;
    if (v.phase !== 'returning') {
      w.backFrom = null;
      return visitProgress(v.phase, now - v.since, w.length);
    }
    w.backFrom ??= Math.min(w.u, w.length);
    return visitProgress('returning', now - v.since, w.backFrom);
  }

  /** Off its chair and into the scene, the same size and facing the way it sat. */
  private getUp(w: Walker) {
    const m = w.model;
    m.stopDancing();
    w.desk.seatAnchor.updateWorldMatrix(true, false);
    w.desk.seatAnchor.getWorldPosition(w.seat);
    w.scale = w.desk.seatAnchor.getWorldScale(scratch).x;
    w.seatHeading = w.desk.def.rotY + Math.PI;
    this.parent.add(m.root);
    m.root.position.copy(w.seat);
    m.root.rotation.set(0, w.seatHeading, 0);
    m.root.scale.setScalar(w.scale);
    w.heading = w.seatHeading;
    w.out = true;
  }

  /** Back on its seat exactly as it sat before. */
  private sitDown(w: Walker) {
    const m = w.model;
    w.desk.seatAnchor.add(m.root);
    m.root.position.set(0, 0, 0);
    m.root.rotation.set(0, 0, 0);
    m.root.scale.setScalar(1);
    m.walking = false;
    m.visitPose = null;
    w.out = false;
  }

  /** Puts it where its progress says, turning toward the way it's going (at once when `snap`). */
  private pose(w: Walker, before: number, target: number, dt: number, snap: boolean) {
    const m = w.model;
    const pos = m.root.position;
    const moved = w.u - before;
    let want = w.heading;
    let walking = false;
    let there = false;
    if (w.u < 0) {
      // On or off the chair in a little arc, beside it.
      const p = w.u - SEATED;
      const [x0, z0] = w.route[0];
      const floor = this.ground(x0, z0, w.seat.y) - FEET;
      pos.set(w.seat.x + (x0 - w.seat.x) * p, w.seat.y + (floor - w.seat.y) * p + Math.sin(p * Math.PI) * HOP_ARC, w.seat.z + (z0 - w.seat.z) * p);
      const up = target > w.u || (moved > 0 && target >= w.u);
      want = up ? w.offHeading : w.seatHeading;
      w.step = up ? 'getting up' : 'sitting down';
      this.stirring = true;
    } else {
      pointAlong(w.route, w.u, at);
      pos.set(at.x, this.ground(at.x, at.z, w.seat.y) - FEET, at.z);
      walking = Math.abs(moved) > 1e-6;
      there = !walking && w.u >= w.length - 1e-3;
      if (walking) want = moved > 0 ? at.heading : at.heading + Math.PI;
      else if (there) want = w.spotHeading;
      w.step = walking ? (moved > 0 ? 'walking' : 'walking back') : there ? 'at spot' : w.step;
      if (walking) this.stirring = true;
    }
    w.heading = snap ? want : w.heading + wrap(want - w.heading) * Math.min(1, dt * 8);
    m.root.rotation.set(0, w.heading, 0);
    m.walking = walking;
    const phase = w.visit?.phase;
    m.visitPose = there && phase === 'reading' ? 'peer' : there && phase === 'talking' ? 'talk' : 'stand';
  }
}
