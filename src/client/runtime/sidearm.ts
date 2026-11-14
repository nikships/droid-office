import * as THREE from 'three';
import { FLOOR, LOFT } from '../../shared/layout';
import type { CarriedIssue } from '../../shared/protocol';
import { cloudBadge } from '../../shared/factory-cloud';
import type { Climber } from '../climb';
import type { Hanger } from '../hanging';
import type { Net } from '../net';
import type { PlayerController } from '../player';
import type { OfficeSound } from '../sound';
import type { loadSettings, store } from '../state';
import { h, hintToast, modalOpen, readingNow, toast } from '../ui/dom';
import type { EmoteWheel } from '../ui/emotes';
import { officePrompt } from '../ui/prompts';
import { BloodSpray, gunHit, Puff } from '../world/gun';
import { GunMotion, type GunCue, type GunTrickId } from '../world/gun-motion';
import { type Sidearm, SPELL_CONFETTI, SPELL_SUPER, SPELL_TIP, SpellBolt, SpellImpact, Sparkles, TipTrail } from '../world/wand';
import { WandMotion, type WandCue, type WandSpellId } from '../world/wand-motion';
import { wandShipRequest, wandWorker, WAND_SHIP_COOLDOWN, WAND_SHIP_REACH } from '../wand-actions';
import { SidearmCharge, SHOT_CHARGE_PREVIEW_MS } from '../sidearm-charge';
import { ChargeHaptics } from '../haptics';
import type { Person } from '../world/character';
import type { Hands } from '../world/hands';
import type { Smoke } from '../world/smoke';
import type { Laptop } from '../world/laptop';
import type { Confetti, Area } from '../world/confetti';
import type { buildOffice, Interactable } from '../world/office';
import type { WorkerView } from './worker-scene';

export interface SidearmHost {
  settings: ReturnType<typeof loadSettings>;
  store: typeof store;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  player: PlayerController;
  hands: Hands;
  me: Person;
  sound: OfficeSound;
  smoke: Smoke;
  net: Net;
  office: ReturnType<typeof buildOffice>;
  bossLaptop: Laptop;
  confetti: Confetti;
  workerViews: Map<string, WorkerView>;
  reduceMotion: MediaQueryList;
  readonly climber: Climber;
  readonly hanger: Hanger;
  readonly carrying: CarriedIssue | null;
  readonly emoteWheel: EmoteWheel;
  readonly raycaster: THREE.Raycaster;
  readonly crosshair: THREE.Vector2;
  readonly upTop: boolean;
  readonly confettiDensity: number;
  thud: number;
  invalidateHint(): void;
  openWorkerTerminal(id: string): void;
  openOfficeShell(): void;
  openPane(target: Interactable, runId?: number): boolean;
  runUnder(aim: { it: Interactable; hit: THREE.Intersection } | null): number | undefined;
  danceParty(): void;
  floorArea(area: Area): number;
  ceilingOver(x: number, z: number): number;
}

/** Owns drawn sidearm, charge feedback, cues, spells and the transient effects they create. */
export function createSidearm(host: SidearmHost) {
  const { settings, store, scene, camera, player, hands, me, sound, smoke, net, office, bossLaptop, confetti, workerViews, reduceMotion } = host;
  const wandOut = () => settings.sidearm === 'wand';
  /** The words for what `7` does, by what's in your hand. Only the look and the words differ; what happens to the worker is the same. */
  const arms = () => (wandOut() ? { name: '🪄 Droid wand', fire: 'Open terminal', away: 'Put away', target: 'to enchant' } : { name: '🔫 .44 Magnum', fire: 'Open terminal', away: 'Holster', target: 'to shoot' });
  /** The gun (or the wand) in your right hand (`7` draws and holsters it), mid-draw included, holstering not. */
  let gunOut = false;
  /** Which one is out (or on its way away): settings.sidearm when it was drawn. */
  let drawnArm: Sidearm = settings.sidearm;
  /** The gun's draw, holster and tricks, played on your hands and your character alike. */
  const gunMotion = new GunMotion();
  /** The wand's draw, casts and spells, played on your hands. */
  const wandMotion = new WandMotion();
  const shotCharge = new SidearmCharge();
  /** The same charge, under the finger on the Mac's trackpad; silent where there is none (see haptics.ts). */
  const chargeHaptics = new ChargeHaptics();
  let stopChargeSound: (() => void) | null = null;
  let chargeReady = false;
  const chargeLabel = h('span', {}, 'Charging');
  const chargeHud = h('div.shot-charge.hidden', { role: 'progressbar', 'aria-label': 'Shot charge', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div.shot-charge-ring'), chargeLabel);
  document.body.append(chargeHud);

  function clearChargeFeedback() {
    stopChargeSound?.();
    stopChargeSound = null;
    chargeReady = false;
    chargeHaptics.reset();
    chargeHud.classList.add('hidden');
  }

  function cancelShotCharge() {
    shotCharge.cancel();
    clearChargeFeedback();
    gunMotion.cancelCharge();
    wandMotion.cancelCharge();
  }

  function updateShotCharge(now: number) {
    if (!shotCharge.held) return;
    if (!gunOut || !player.enabled || modalOpen() || host.emoteWheel.isOpen) return cancelShotCharge();
    if (shotCharge.elapsed(now) < SHOT_CHARGE_PREVIEW_MS) return;
    const progress = shotCharge.progress(now);
    chargeHaptics.charge(progress);
    if (!stopChargeSound) stopChargeSound = sound.sidearmCharge(drawnArm === 'wand');
    if (drawnArm === 'wand') wandMotion.charge(progress);
    else gunMotion.charge(progress);
    chargeHud.classList.remove('hidden');
    chargeHud.classList.toggle('charged', progress === 1);
    chargeHud.style.setProperty('--charge-angle', `${progress * 360}deg`);
    chargeHud.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    chargeLabel.textContent = progress === 1 ? 'Charged · release' : 'Charging';
    if (progress === 1 && !chargeReady) {
      chargeReady = true;
      chargeHaptics.charged();
      if (drawnArm === 'wand') sound.wandCue('ready');
      else sound.gunCue('cock');
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelShotCharge();
  });
  /** Lock the intended worker at the start; aim and reach must still agree when the magic lands. */
  let wandRecipient: { spell: 'ship' | 'leviosa'; id: string } | null = null;
  const lastWandShip = new Map<string, number>();
  /** Lumos: the wand's emitter lit, throwing light round you until you put it out (1 again) or away. */
  let lumos = false;
  /**
   * The light Lumos (and a spell leaving the tip) throws on the room, following the tip. Warm-up
   * covers zero through four point lights, so a dark wand can skip point-light shading entirely
   * without compiling a shader when it lights up.
   */
  const wandLight = new THREE.PointLight('#ffc49a', 0, 7, 1.6);
  wandLight.visible = false;
  scene.add(wandLight);
  /** The tip's trail of light through the air. */
  const tipTrail = new TipTrail();
  scene.add(tipTrail.points);
  /** Dust where missed shots cracked into the walls and floor, and the spray where workers were hit. */
  const puffs: { group: THREE.Object3D; update(dt: number): boolean; dispose(): void }[] = [];

  /** `7`: the wand (or the .44 Magnum) out, or back away. Mash it and each press cancels the last, like a yy. */
  function toggleGun() {
    if (gunOut) {
      holsterGun();
      return;
    }
    if (host.climber.active) return toast('Your hands are full: both hands on the climb', 'warn');
    if (host.hanger.active) return toast('Your hands are full: hang the picture first (or F to stop)', 'warn');
    if (host.carrying) return toast(`Your hands are full: put #${host.carrying.issue} down first (Q)`, 'warn');
    if (readingNow()) return toast('Your hands are full: close the book first', 'warn');
    // Drawing one while the other is still on its way away: that one goes at once.
    if (drawnArm !== settings.sidearm) stowArms();
    drawnArm = settings.sidearm;
    gunOut = true;
    if (drawnArm === 'wand') wandMotion.draw();
    else gunMotion.draw();
    host.invalidateHint();
  }

  /** Both straight away, no move: what's in your hand is gone this frame. */
  function stowArms() {
    cancelShotCharge();
    wandRecipient = null;
    gunMotion.stow();
    wandMotion.stow();
    setLumos(false);
  }

  /** The gun back in its holster (the wand put away): with a move, or `quiet`ly straight away when your hands are needed. */
  function holsterGun(quiet = false) {
    cancelShotCharge();
    // Even on its way back in: something else wants your hands now.
    if (quiet) stowArms();
    if (!gunOut) return;
    gunOut = false;
    if (!quiet) {
      if (drawnArm === 'wand') wandMotion.holster();
      else gunMotion.holster();
      setLumos(false);
    }
    host.invalidateHint();
  }

  /** 1–6 with the gun out: a trick in place of an emote; with the wand, a spell. As many as you like, each from the top. */
  function gunTrick(id: GunTrickId) {
    cancelShotCharge();
    if (!gunMotion.trick(id)) return;
    host.invalidateHint();
  }
  function wandSpell(id: WandSpellId) {
    cancelShotCharge();
    if (!wandMotion.spell(id)) return;
    wandRecipient = null;
    if (id === 'ship' || id === 'leviosa') {
      const target = aimedWandWorker(id === 'ship' ? WAND_SHIP_REACH : Infinity);
      if (target) wandRecipient = { spell: id, id: target.id };
    }
    host.invalidateHint();
  }

  /** Only a directly aimed worker body; laptop clicks retain their separate UI-opening behavior. */
  function aimedWandWorker(reach = Infinity): { id: string; point: THREE.Vector3 } | null {
    host.raycaster.setFromCamera(host.crosshair, camera);
    const result = aimedShot();
    const id = wandWorker(result ? { workerId: result.workerId, distance: result.hit.distance } : null, reach);
    return id && result ? { id, point: result.hit.point.clone() } : null;
  }

  /** One close-range confetti pop means one shipping prompt, not a direct publish or merge call. */
  function wandShip() {
    const recipient = wandRecipient;
    wandRecipient = null;
    const target = aimedWandWorker(WAND_SHIP_REACH);
    if (recipient?.spell !== 'ship' || !target || target.id !== recipient.id) return hintToast(`Aim directly at one worker within ${WAND_SHIP_REACH} meters to Ship it`, 'info');
    const now = performance.now();
    if (now - (lastWandShip.get(target.id) ?? -Infinity) < WAND_SHIP_COOLDOWN) return hintToast('That worker just received Ship it', 'info');
    const worker = store.workers.get(target.id);
    const request = wandShipRequest(worker, officePrompt('wand.ship'));
    if (typeof request === 'string') return hintToast(request, 'warn');
    if (!net.send(request)) return hintToast('Reconnect to the office before asking a worker to ship', 'warn');
    lastWandShip.set(target.id, now);
    confetti.spray(target.point, camera.getWorldDirection(blowDir).addScaledVector(UP, 0.35).normalize(), 90, SPELL_CONFETTI);
    addEffect(new Sparkles(target.point, null, { colors: SPELL_TIP, count: 16, speed: 1.1, size: 0.014, seconds: 0.7, lift: 0.3 }));
    hintToast(`${request.queue ? 'Queued Ship it for' : 'Asked to ship:'} ${worker!.name}`, 'info');
  }

  function wandLevitate() {
    const recipient = wandRecipient;
    wandRecipient = null;
    const target = aimedWandWorker();
    if (recipient?.spell !== 'leviosa' || !target || target.id !== recipient.id) return hintToast('Aim directly at a worker to lift it', 'info');
    const view = workerViews.get(target.id);
    if (!view?.model.levitate()) return hintToast('Swish and flick lifts an awake worker resting at its seat', 'info');
    addEffect(new Sparkles(target.point, null, { colors: SPELL_TIP, count: 28, speed: 0.6, size: 0.016, seconds: 2, lift: 1.2 }));
  }

  /** Lumos on or off: the tip lights, and so does the room round you. */
  function setLumos(on: boolean) {
    if (on === lumos) return;
    lumos = on;
    hands.setLumos(on);
    host.invalidateHint();
  }

  /** The gun's muzzle in the world, or null with it away. */
  function muzzleAt(out: THREE.Vector3): THREE.Vector3 | null {
    const tip = hands.muzzleTip(out);
    return tip && camera.localToWorld(tip);
  }

  /** The wand's tip in the world, or null with it away. */
  function wandTipAt(out: THREE.Vector3): THREE.Vector3 | null {
    const tip = hands.wandTip(out);
    return tip && camera.localToWorld(tip);
  }

  /** What the gun's move just did: its sounds, and the smoke blown off the muzzle. */
  function gunCues(cues: readonly GunCue[]) {
    for (const cue of cues) {
      sound.gunCue(cue);
      if (cue !== 'puff') continue;
      const tip = muzzleAt(muzzleWorld);
      if (!tip) continue;
      // Blown away from you, and up.
      const away = camera.getWorldDirection(blowDir).multiplyScalar(0.35);
      for (let i = 0; i < 2; i++) smoke.wisp(tip, away);
    }
    if (cues.length) host.invalidateHint();
  }
  const muzzleWorld = new THREE.Vector3();
  const blowDir = new THREE.Vector3();
  const tipWorld = new THREE.Vector3();
  const tipDir = new THREE.Vector3();

  /** What the wand's move just did: its sounds, and each spell's magic. */
  function wandCues(cues: readonly WandCue[]) {
    for (const cue of cues) {
      sound.wandCue(cue);
      const tip = wandTipAt(tipWorld);
      switch (cue) {
        case 'release':
        case 'superRelease':
          if (tip) castBolt(tip, cue === 'superRelease');
          break;
        case 'lumos':
          setLumos(!lumos);
          if (tip) addEffect(new Sparkles(tip, null, { colors: SPELL_TIP, count: 14, speed: 0.5, size: 0.012, seconds: 0.7, lift: 0.2 }));
          break;
        case 'flick':
          wandLevitate();
          // Swish and flick: sparks lifting off the tip and floating up, light as a feather.
          if (tip) {
            addEffect(new Sparkles(tip, camera.getWorldDirection(blowDir), { colors: SPELL_TIP, count: 26, speed: 0.9, size: 0.016, seconds: 1.6, lift: 1.6 }));
            addEffect(new SpellImpact(tip.clone().addScaledVector(blowDir, 0.25), blowDir.clone().negate(), false));
          }
          break;
        case 'spark':
          // A sparkler's spit: sparks flung every way that fall away as they fade.
          if (tip) addEffect(new Sparkles(tip, null, { colors: SPELL_TIP, count: 7, speed: 1.3, size: 0.011, seconds: 0.55, lift: -2.2 }));
          break;
        case 'party':
          host.danceParty();
          confetti.rain(FLOOR, host.floorArea(FLOOR) * host.confettiDensity, 3, host.ceilingOver);
          confetti.rain(LOFT, host.floorArea(LOFT) * host.confettiDensity, 3, () => LOFT.y + LOFT.height - 0.1);
          break;
        case 'confetti':
          wandShip();
          break;
        case 'done':
          if (tip) addEffect(new Sparkles(tip, null, { colors: SPELL_TIP, count: 10, speed: 0.4, size: 0.01, seconds: 0.6, lift: 0.3 }));
          break;
      }
    }
    if (cues.length) host.invalidateHint();
  }

  /** A spark, puff, spray or streak in the scene until it has faded. */
  function addEffect(effect: (typeof puffs)[number]) {
    scene.add(effect.group);
    puffs.push(effect);
  }

  /** A click with the gun (or the wand) out: fire at what's under the crosshair, or flick the wand at it. */
  function fireGun(superShot = false) {
    chargeHaptics.release(superShot);
    if (drawnArm === 'wand') {
      // The bolt leaves on the gesture's release cue (see wandCues).
      if (wandMotion.cast(superShot)) {
        wandRecipient = null;
        host.invalidateHint();
      }
      return;
    }
    gunMotion.fire(superShot);
    hands.fireGun(superShot);
    me.fire(superShot);
    sound.gunshot(superShot);
    // One shell of kick up the camera.
    if (!reduceMotion.matches) host.thud = Math.max(host.thud, superShot ? 0.72 : 0.4);
    // Smoke curling off the muzzle.
    const tip = muzzleAt(new THREE.Vector3());
    if (tip) {
      const at = tip.clone();
      if (superShot) addEffect(new Sparkles(tip, camera.getWorldDirection(blowDir), { colors: ['#fff3d8', '#ffc16b', '#ff8533'], count: 12, speed: 2.2, size: 0.009, seconds: 0.3, lift: -1.8 }));
      for (let i = 0; i < (superShot ? 6 : 2); i++) {
        at.x += (Math.random() - 0.5) * 0.05;
        at.y += Math.random() * 0.04;
        at.z += (Math.random() - 0.5) * 0.05;
        smoke.wisp(at);
      }
    }
    host.raycaster.setFromCamera(host.crosshair, camera);
    const result = aimedShot();
    landShot(result, host.raycaster.ray.direction.clone(), superShot);
  }

  /**
   * The flick's release: a bolt from the tip to whatever is under the crosshair now, landing when it
   * gets there (BOLT_SPEED), where it does what a shot does (landShot). A miss off into the distance
   * just flies out of sight.
   */
  function castBolt(tip: THREE.Vector3, superShot: boolean) {
    if (host.upTop) return;
    host.raycaster.setFromCamera(host.crosshair, camera);
    const result = aimedShot();
    const direction = host.raycaster.ray.direction.clone();
    const to = result?.hit.point.clone() ?? host.raycaster.ray.at(40, new THREE.Vector3());
    addEffect(new SpellBolt(tip, to, () => result && landShot(result, direction, superShot), superShot));
    addEffect(new Sparkles(tip, direction, { colors: superShot ? SPELL_SUPER : SPELL_TIP, count: superShot ? 24 : 9, speed: superShot ? 1.1 : 0.6, size: superShot ? 0.018 : 0.012, seconds: superShot ? 0.65 : 0.45, lift: 0.2 }));
    // A spell barely nudges the camera.
    if (!reduceMotion.matches) host.thud = Math.max(host.thud, superShot ? 0.2 : 0.08);
  }

  const UP = new THREE.Vector3(0, 1, 0);

  /** What a shot along `host.raycaster` would strike first: an interactive surface, worker, other solid, or nothing. */
  function aimedShot(): ReturnType<typeof gunHit> {
    if (host.upTop) return null;
    const byRoot = new Map<THREE.Object3D, string>();
    const screens = new Map<THREE.Object3D, string>();
    for (const [id, v] of workerViews) {
      byRoot.set(v.model.root, id);
      screens.set(v.laptop.screen, id);
    }
    // Workers sit inside the office; ones still walking in are out in the scene. Players are never targets.
    return gunHit(host.raycaster, office.group, byRoot, screens);
  }

  /** Where a shot strikes something that isn't a worker: dust and a crack, or a spell's mark fizzling out. */
  function missAt(hit: THREE.Intersection, superShot: boolean) {
    const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? null;
    if (wandOut()) {
      addEffect(new SpellImpact(hit.point, normal, false, superShot));
      sound.fizzle(hit.point, superShot);
      return;
    }
    addEffect(new Puff(hit.point, normal));
    if (superShot) addEffect(new Sparkles(hit.point, normal, { colors: ['#ffd497', '#ff8533'], count: 15, speed: 2, size: 0.012, seconds: 0.4, lift: -2 }));
    sound.impact(hit.point);
  }

  /**
   * Normal hits open the worker's terminal without changing its session or pose. Fully charged
   * shots dismiss local workers. Interactive surfaces keep their usual UI-opening behavior.
   */
  function landShot(result: ReturnType<typeof gunHit>, direction: THREE.Vector3, superShot: boolean) {
    if (result?.laptopWorkerId) return host.openWorkerTerminal(result.laptopWorkerId);
    if (result?.hit.object === bossLaptop.screen) return host.openOfficeShell();
    if (result?.interactable && host.openPane(result.interactable, host.runUnder({ it: result.interactable, hit: result.hit }))) return;
    const hit = result?.hit;
    const workerId = result?.workerId ?? null;
    if (!hit || workerId === null) {
      if (hit) missAt(hit, superShot);
      return;
    }
    if (!superShot) return host.openWorkerTerminal(workerId);
    // Cloud workers aren't local processes the office can dismiss with a charged shot.
    const target = store.workers.get(workerId);
    if (target?.cloud) {
      missAt(hit, superShot);
      hintToast(`${target.name} works on ${cloudBadge(target.cloud)}: there's nobody really at this desk ${arms().target}`, 'info');
      return;
    }
    const out = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : direction.clone().negate();
    if (wandOut()) {
      addEffect(new SpellImpact(hit.point, out, true, superShot));
      sound.spellHit(hit.point, superShot);
    } else {
      addEffect(new BloodSpray(hit.point, out, direction));
      sound.hit(hit.point);
    }
    net.send({ t: 'worker.shoot', workerId, superShot: true });
  }

  return {
    clearChargeFeedback,
    wandOut,
    arms,
    gunMotion,
    wandMotion,
    shotCharge,
    lastWandShip,
    wandLight,
    tipTrail,
    puffs,
    tipWorld,
    tipDir,
    cancelShotCharge,
    updateShotCharge,
    toggleGun,
    holsterGun,
    gunTrick,
    wandSpell,
    wandTipAt,
    gunCues,
    wandCues,
    addEffect,
    fireGun,
    get gunOut() {
      return gunOut;
    },
    get drawnArm() {
      return drawnArm;
    },
    get lumos() {
      return lumos;
    },
  };
}
