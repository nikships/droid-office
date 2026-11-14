import type * as THREE from 'three';
import { floorPalette } from '../../shared/floors';
import { SLAB, STOREY, inElevator } from '../../shared/layout';
import { ROOF, ROOF_NAME } from '../../shared/rooftop';
import type { Arrival, Climber, Grip } from '../climb';
import type { Hanger } from '../hanging';
import type { Net } from '../net';
import type { PlayerController } from '../player';
import type { OfficeSound } from '../sound';
import type { Spot, store } from '../state';
import { $, closeAllModals, modalOpen, toast } from '../ui/dom';
import type { buildOffice, Collider } from '../world/office';
import type { Rooftop } from '../world/rooftop';
import type { Sky } from '../world/sky';
import { roofDrop } from '../../shared/layout';

/** Live accessors preserve dependencies that are wired later by the composition root. */
export interface FloorTravelHost {
  store: typeof store;
  player: PlayerController;
  office: ReturnType<typeof buildOffice>;
  camera: THREE.PerspectiveCamera;
  sky: Sky;
  readonly sound: OfficeSound;
  readonly hanger: Hanger;
  readonly climber: Climber;
  readonly roof: Rooftop | null;
  upTop: boolean;
  readonly firstWelcome: boolean;
  readonly walking: boolean;
  far: number;
  builtFloors(): typeof store.floors;
  theRoof(): Rooftop;
  roofFloors(): number;
  placeInCar(at?: { x: number; z: number }): void;
  standUp(): void;
  stopWalking(): void;
  holsterGun(quiet: boolean): void;
  renderWake(): void;
  clearLinkedWorker(): void;
  liftOnto(appeared: Collider[]): void;
  syncVibesWatch(): void;
  invalidateHint(): void;
  renderProject(): void;
  syncStack(): void;
  showElevator(): void;
  lastSpot(): Spot | null;
  rememberSpot(spot: Spot): void;
  net: Net;
}

/** Owns a floor transition from departure through timeout or arrival, and position persistence. */
export function createFloorTravel(host: FloorTravelHost) {
  const { store, player, office, camera, sky, net, builtFloors, placeInCar } = host;
  /** Not a trip of yours: the office put you on another floor (yours went), in its elevator car. Whatever you were doing stops. */
  function takenAway() {
    closeAllModals();
    if (host.hanger.active) host.hanger.cancel();
    if (host.climber.active) host.climber.abort();
    if (host.walking) host.stopWalking();
    placeInCar();
  }

  /** Where you're standing, to come back to (see lastSpot): nowhere while you're between floors, or climbing between them. */
  function spotHere(): Spot | null {
    if (!store.floor || trip || host.climber.active) return null;
    // Sitting, it's where you'd get up to.
    const at = player.standingSpot() ?? player.pos;
    // Under an upstairs floor is not a spot: the street and the garage belong to the ground floor,
    // so a y down there is a fall in progress. Saving it would put you back under the floor on
    // every reload, forever (see standSpot).
    if (store.floor !== ROOF && at.y < -SLAB - 0.05 && builtFloors().findIndex((f) => f.id === store.floor) > 0) return null;
    const name = store.floor === ROOF ? ROOF_NAME : (store.currentFloor()?.name ?? '');
    return { floor: store.floor, name, x: at.x, y: at.y, z: at.z, facing: player.facing };
  }

  /** Where to put you back when the office lets you in: where you are now, or before this page was loaded, where you were last time. */
  function whereNow(): Spot | null {
    return host.firstWelcome ? host.lastSpot() : spotHere();
  }

  let lastSavedSpotKey = '';
  function saveSpot() {
    const s = spotHere();
    if (!s) return;
    const key = `${s.floor}\0${s.name}\0${s.x}\0${s.y}\0${s.z}\0${s.facing}`;
    if (key === lastSavedSpotKey) return;
    lastSavedSpotKey = key;
    host.rememberSpot(s);
  }

  function fade(on: boolean, quick = false) {
    $('fade').classList.toggle('quick', quick);
    $('fade').classList.toggle('on', on);
  }

  /** How you're going to another floor: by elevator, straight there from the floor list, or by the ladder. */
  type TripKind = 'elevator' | 'switch' | Grip;
  /** A trip under way: the lights are down (and by elevator the doors are shut) until the next floor arrives. */
  let trip: { floor: string; how: TripKind; timer: number } | null = null;

  /** The elevator where you are: the office's, or the one up on the host.roof. */
  function lift() {
    return host.upTop && host.roof ? host.roof.elevator : office.elevator;
  }

  /** Rides the elevator to another floor (or up to the host.roof). From outside the car, you step in while the lights are down. */
  function ride(floorId: string) {
    if (trip || floorId === store.floor) return;
    host.holsterGun(true);
    closeAllModals();
    if (host.hanger.active) host.hanger.cancel();
    if (host.climber.active) host.climber.abort();
    const inside = inElevator(player.pos.x, player.pos.z);
    trip = { floor: floorId, how: 'elevator', timer: window.setTimeout(tripFailed, 10_000) };
    player.enabled = false;
    player.clearKeys();
    lift().setOpen(false);
    // Wait for the doors to shut on you, then dim the lights and go.
    setTimeout(
      () => {
        fade(true);
        setTimeout(() => {
          placeInCar(inside ? player.pos : undefined);
          net.send({ t: 'floor.go', floor: floorId });
        }, 320);
      },
      inside ? 650 : 0,
    );
  }

  /** Where you are, to arrive at the same spot on floor `to`. Down on the street (or the steps to it), that's the street there too. */
  function standingAt(to: string): Arrival {
    const floors = builtFloors();
    const from = floors.findIndex((f) => f.id === store.floor);
    const there = floors.findIndex((f) => f.id === to);
    const below = player.pos.y < -SLAB - 0.05 && from >= 0 && there >= 0;
    return { x: player.pos.x, y: below ? player.pos.y + (from - there) * STOREY : player.pos.y, z: player.pos.z, rotY: player.facing };
  }

  /** Straight to another floor in the same spot: a blink from the list, or no fade or delay with Command+number. */
  function switchFloor(floorId: string, instant = false) {
    // The floor list uses the elevator for the roof; a numbered shortcut can leave it immediately.
    if (floorId === ROOF || (host.upTop && !instant)) return ride(floorId);
    if (trip || floorId === store.floor) return;
    host.holsterGun(true);
    closeAllModals();
    if (host.hanger.active) host.hanger.cancel();
    if (host.climber.active) host.climber.abort();
    if (player.seat) host.standUp();
    // The floor list isn't a window, so nothing else stops an errand on this floor.
    if (host.walking) host.stopWalking();
    trip = { floor: floorId, how: 'switch', timer: window.setTimeout(tripFailed, 10_000) };
    player.enabled = false;
    player.clearKeys();
    if (instant) {
      net.send({ t: 'floor.go', floor: floorId, at: standingAt(floorId) });
      host.renderWake();
      return;
    }
    fade(true, true);
    setTimeout(() => net.send({ t: 'floor.go', floor: floorId, at: standingAt(floorId) }), 170);
  }

  /** Through the ceiling up the ladder, or through the floor down one: the lights dip as you pass. */
  function travel(floorId: string, how: Grip, at: Arrival) {
    if (trip) return;
    host.holsterGun(true);
    trip = { floor: floorId, how, timer: window.setTimeout(tripFailed, 10_000) };
    fade(true, true);
    setTimeout(() => net.send({ t: 'floor.go', floor: floorId, at }), 170);
  }

  /** The floor never came (it's gone, or the office is unreachable): back where you were. */
  function tripFailed() {
    const t = trip;
    if (!t) return;
    trip = null;
    // The link asked for a floor that never came: don't open it on some later arrival.
    host.clearLinkedWorker();
    fade(false);
    if (t.how === 'elevator') lift().setOpen(!!store.floor);
    if (t.how === 'ladder') host.climber.abort();
    player.enabled = !modalOpen();
  }

  /** The floor you're on is a plain folder, not a git checkout: no boards, pipelines or CI. */
  function plainFloor(): boolean {
    return !!store.currentFloor()?.plain;
  }

  /** Which of the floor palettes the walls are painted in now. */
  let painted = -1;
  function paintFloor() {
    host.liftOnto(office.setPlain(plainFloor()));
    const p = store.currentFloor()?.palette ?? 0;
    if (p === painted) return;
    painted = p;
    office.setLook(floorPalette(p));
  }

  /**
   * Up on the roof, or back down in the office: shows the one you're in, and walks, sounds, lights and
   * looks as it does there.
   */
  function setPlace() {
    const up = store.floor === ROOF;
    if (up === host.upTop) return;
    host.upTop = up;
    const r = up ? host.theRoof() : host.roof;
    office.group.visible = !up;
    if (r) r.group.visible = up;
    player.colliders = up ? r!.colliders : office.colliders;
    sky.setRoof(up, roofDrop(host.roofFloors()));
    // You can see the whole city from up there (and its clouds); from the top floors, as far as the haze.
    camera.far = up ? 700 : host.far;
    camera.updateProjectionMatrix();
    if (host.hanger.active) host.hanger.cancel();
    host.syncVibesWatch();
    host.invalidateHint();
  }

  /**
   * You're on a floor (or in the building without one): paint it, and open the doors (or carry on down
   * climbing…). `back` is standing in the spot you left from last time, the doors open already.
   */
  function arrive(how: TripKind | 'back' = trip?.how ?? 'elevator') {
    // A menu left open and the laptop you typed into were the last floor's.
    setPlace();
    paintFloor();
    host.renderProject();
    noticeWaiting();
    host.syncStack();
    if (trip) {
      clearTimeout(trip.timer);
      trip = null;
    }
    if (!store.floor) {
      // Nowhere to go yet: the doors stay shut until there's a floor, and the panel says how to add one.
      office.elevator.setOpen(false);
      fade(false);
      player.enabled = !modalOpen();
      host.showElevator();
      return;
    }
    fade(false);
    if (how === 'back') {
      // The doors stand open, the way the last one out left them.
      lift().setOpen(true);
      player.enabled = !modalOpen();
      return;
    }
    if (how !== 'elevator') {
      player.enabled = !modalOpen();
      if (how === 'ladder') host.climber.arrived();
      return;
    }
    setTimeout(() => {
      lift().setOpen(true);
      host.sound.floorChime();
      player.enabled = !modalOpen();
    }, 450);
  }

  /** Workers waiting on someone, per floor, the last time the elevator said so. */
  const waitingOn = new Map<string, number>();
  /** Someone's waiting on another floor: say so, since you can't see or hear it from here. */
  function noticeWaiting() {
    let elsewhere = 0;
    for (const f of store.floors) {
      const before = waitingOn.get(f.id);
      waitingOn.set(f.id, f.waiting);
      if (f.id === store.floor) continue;
      elsewhere += f.waiting;
      if (before !== undefined && f.waiting > before) {
        toast(`🙋 A worker on the ${f.name} floor is waiting on someone — take the elevator up`, 'warn');
        host.sound.ding('needs_input');
      }
    }
    const badge = $('floors-waiting');
    badge.textContent = elsewhere ? String(elsewhere) : '';
    badge.classList.toggle('hidden', !elsewhere);
    $('project').title = elsewhere ? `${elsewhere} worker${elsewhere === 1 ? '' : 's'} on other floors waiting on someone — click to go there` : 'Floors: go to another project';
  }

  return {
    takenAway,
    spotHere,
    whereNow,
    saveSpot,
    fade,
    lift,
    ride,
    standingAt,
    switchFloor,
    travel,
    tripFailed,
    plainFloor,
    paintFloor,
    setPlace,
    arrive,
    noticeWaiting,
    get trip() {
      return trip;
    },
  };
}
