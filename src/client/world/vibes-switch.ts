import * as THREE from 'three';
import type { VibesSwitchState } from '../../shared/gemini-vibes';
import { CEILING_GLYPH, VIBES_SWITCH } from '../../shared/layout';
import { glyphFlat } from './glyph3d';
import type { Collider, Interactable } from './office';
import { mergeByMaterial, mesh, toon, toonUnique } from './toon';

// The Living 3D reactions & mood lighting pedestal switch: a circular pushbutton atop a thin
// dark-steel column rising to the player character's abdomen, centered directly beneath the
// spinning Factory ceiling glyph on every indoor floor.

export interface VibesSwitchPalette {
  cap: string;
  capEmissive: string;
  capIntensity: number;
  ring: string;
  floorRing: string;
  emblem: string;
  latchedDrop: number;
  spin: boolean;
}

export const VIBES_SWITCH_PALETTE: Record<VibesSwitchState, VibesSwitchPalette> = {
  on: {
    cap: '#22c55e',
    capEmissive: '#16a34a',
    capIntensity: 0.85,
    ring: '#34d399',
    floorRing: '#22c55e',
    emblem: '#ecfdf5',
    latchedDrop: 0.005,
    spin: true,
  },
  off: {
    cap: '#ef4444',
    capEmissive: '#dc2626',
    capIntensity: 0.8,
    ring: '#f87171',
    floorRing: '#ef4444',
    emblem: '#fee2e2',
    latchedDrop: 0,
    spin: false,
  },
  disconnected: {
    cap: '#27272a',
    capEmissive: '#000000',
    capIntensity: 0,
    ring: '#52525b',
    floorRing: '#3f3f46',
    emblem: '#71717a',
    latchedDrop: 0,
    spin: false,
  },
  rejected: {
    cap: '#27272a',
    capEmissive: '#3b2006',
    capIntensity: 0.25,
    ring: '#f59e0b',
    floorRing: '#d97706',
    emblem: '#fbbf24',
    latchedDrop: 0,
    spin: false,
  },
  airgapped: {
    cap: '#1f2024',
    capEmissive: '#000000',
    capIntensity: 0,
    ring: '#3a3a40',
    floorRing: '#2e2e34',
    emblem: '#52525b',
    latchedDrop: 0,
    spin: false,
  },
};

const RIPPLE_COLORS: Record<'on' | 'off' | 'blocked', string> = {
  on: '#34d399',
  off: '#f87171',
  blocked: '#a1a1aa',
};

export interface VibesSwitch {
  group: THREE.Group;
  collider: Collider;
  interactable: Interactable;
  /** Dynamic illuminated parts hidden during Remastered GI probe baking so neutral bakes never tint green or red. */
  bakeHidden: THREE.Object3D[];
  readonly state: VibesSwitchState;
  /** Current applied colors and plunger travel, exposed for deterministic scene assertions. */
  inspect(): { state: VibesSwitchState; capHex: string; ringHex: string; emblemHex: string; emissiveIntensity: number; plungerY: number; rippleVisible: boolean };
  setState(next: VibesSwitchState): void;
  /** Depresses the button cap mechanically without claiming a state change yet. */
  depress(): void;
  /** Emits a radial confirmation or blocked ripple around the bezel. */
  ripple(feedback: 'on' | 'off' | 'blocked'): void;
  /** Depresses the button cap and emits a radial ripple in one step. */
  press(feedback: 'on' | 'off' | 'blocked'): void;
  update(t: number, dt: number): void;
}

export function buildVibesSwitch(): VibesSwitch {
  const { x, z, height, columnRadius, buttonRadius, baseRadius, colliderRadius } = VIBES_SWITCH;
  const group = new THREE.Group();
  group.name = 'vibes-switch';
  group.position.set(x, 0, z);

  const darkSteel = toon('#26282e', { finish: 'metal' });
  const bezelMetal = toon('#16171b', { finish: 'metal' });
  const brushed = toon('#52545c', { finish: 'metal' });

  // Static structural column: floor base plate, machined collar, thin vertical stem, and top bezel cup.
  const baseH = 0.026;
  const lowerCollarH = 0.034;
  const bezelH = 0.052;
  const capH = 0.032;
  const crownH = 0.006;
  const bezelCenterY = height - capH - crownH - bezelH / 2 + 0.012;
  const stemBottomY = baseH + lowerCollarH * 0.7;
  const stemTopY = bezelCenterY - bezelH / 2 + 0.008;
  const stemH = stemTopY - stemBottomY;

  const statics = new THREE.Group();
  statics.add(mesh(new THREE.CylinderGeometry(baseRadius * 0.9, baseRadius, baseH, 32), bezelMetal, 0, baseH / 2, 0));
  statics.add(mesh(new THREE.CylinderGeometry(columnRadius * 1.55, columnRadius * 1.95, lowerCollarH, 24), darkSteel, 0, baseH + lowerCollarH / 2 - 0.004, 0));
  statics.add(mesh(new THREE.CylinderGeometry(columnRadius, columnRadius * 1.08, stemH, 20), darkSteel, 0, stemBottomY + stemH / 2, 0));
  statics.add(mesh(new THREE.CylinderGeometry(columnRadius * 1.32, columnRadius * 1.05, 0.026, 24), brushed, 0, stemTopY - 0.024, 0));
  // Circular housing cup cradling the pushbutton.
  const outerBezelR = buttonRadius + 0.028;
  statics.add(mesh(new THREE.CylinderGeometry(outerBezelR, outerBezelR * 0.82, bezelH, 36), bezelMetal, 0, bezelCenterY, 0));
  // Recessed dark well inside the bezel so plunger travel reads cleanly.
  statics.add(mesh(new THREE.CylinderGeometry(buttonRadius + 0.008, buttonRadius + 0.008, 0.01, 32), toon('#09090b'), 0, bezelCenterY + bezelH / 2 - 0.003, 0));
  group.add(mergeByMaterial(statics));

  // Flush floor status ring around the base plate, echoing the overhead glyph's alignment on the slab.
  const floorRingMat = toonUnique('#3f3f46');
  floorRingMat.emissive.set('#000000');
  floorRingMat.polygonOffset = true;
  floorRingMat.polygonOffsetFactor = -2;
  floorRingMat.polygonOffsetUnits = -2;
  floorRingMat.userData.outlineParameters = { visible: false };
  const floorRingGeo = new THREE.RingGeometry(baseRadius + 0.025, baseRadius + 0.055, 48);
  floorRingGeo.rotateX(-Math.PI / 2);
  const floorRing = mesh(floorRingGeo, floorRingMat, 0, 0.014, 0);
  floorRing.renderOrder = 1;
  group.add(floorRing);

  // 360-degree status collar just below the bezel + luminous halo ring on the bezel rim.
  const ringMat = new THREE.MeshBasicMaterial({ color: '#52525b' });
  ringMat.userData.outlineParameters = { visible: false };
  const stemCollar = mesh(new THREE.CylinderGeometry(columnRadius * 1.24, columnRadius * 1.24, 0.018, 24), ringMat, 0, stemTopY - 0.046, 0);
  const bezelHaloGeo = new THREE.TorusGeometry(buttonRadius + 0.017, 0.0085, 8, 48);
  bezelHaloGeo.rotateX(Math.PI / 2);
  const bezelHalo = mesh(bezelHaloGeo, ringMat, 0, bezelCenterY + bezelH / 2 + 0.002, 0);
  group.add(stemCollar, bezelHalo);

  // Moving circular button plunger + top Factory pinwheel emblem.
  const plungerRestY = bezelCenterY + bezelH / 2 + 0.002;
  const plunger = new THREE.Group();
  plunger.name = 'vibes-switch-plunger';
  plunger.position.y = plungerRestY;
  group.add(plunger);

  const capMat = toonUnique('#27272a', 'paint');
  capMat.emissive.set('#000000');
  capMat.emissiveIntensity = 0;
  const capBody = mesh(new THREE.CylinderGeometry(buttonRadius * 0.96, buttonRadius, capH, 36), capMat, 0, capH / 2, 0);
  const capCrown = mesh(new THREE.CylinderGeometry(buttonRadius * 0.84, buttonRadius * 0.96, crownH, 36), capMat, 0, capH + crownH / 2, 0);
  plunger.add(capBody, capCrown);

  const emblemMat = new THREE.MeshBasicMaterial({ color: '#71717a' });
  emblemMat.polygonOffset = true;
  emblemMat.polygonOffsetFactor = -2;
  emblemMat.polygonOffsetUnits = -2;
  emblemMat.userData.outlineParameters = { visible: false };
  const emblemGeo = glyphFlat(buttonRadius * 0.95, 5);
  emblemGeo.rotateX(-Math.PI / 2);
  const emblem = mesh(emblemGeo, emblemMat, 0, capH + crownH + 0.0015, 0);
  plunger.add(emblem);

  // Expanding horizontal pulse ring when pressed (shares gong.ts's warmed transparent ring shader).
  const rippleMat = new THREE.MeshBasicMaterial({
    color: '#34d399',
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  rippleMat.userData.outlineParameters = { visible: false };
  const rippleGeo = new THREE.RingGeometry(outerBezelR * 0.98, outerBezelR * 1.16, 48);
  rippleGeo.rotateX(-Math.PI / 2);
  const ripple = mesh(rippleGeo, rippleMat, 0, bezelCenterY + bezelH / 2 + 0.004, 0);
  ripple.visible = false;
  group.add(ripple);

  const collider: Collider = {
    minX: x - colliderRadius,
    maxX: x + colliderRadius,
    minZ: z - colliderRadius,
    maxZ: z + colliderRadius,
    top: height,
  };
  const interactable: Interactable = {
    kind: 'vibes',
    x,
    z: z + 1.1,
    radius: 1.6,
  };
  group.userData.interact = interactable;

  let current: VibesSwitchState = 'disconnected';
  let pressDepth = 0;
  let rippleT = Infinity;

  const applyPalette = (next: VibesSwitchState) => {
    current = next;
    const p = VIBES_SWITCH_PALETTE[next];
    capMat.color.set(p.cap);
    capMat.emissive.set(p.capEmissive);
    capMat.emissiveIntensity = p.capIntensity;
    ringMat.color.set(p.ring);
    floorRingMat.color.set(p.floorRing);
    floorRingMat.emissive.set(p.capIntensity > 0 ? p.floorRing : '#000000');
    floorRingMat.emissiveIntensity = p.capIntensity > 0 ? 0.35 : 0;
    emblemMat.color.set(p.emblem);
    plunger.position.y = plungerRestY - p.latchedDrop - pressDepth;
  };
  applyPalette('disconnected');

  return {
    group,
    collider,
    interactable,
    bakeHidden: [floorRing, stemCollar, bezelHalo, plunger, ripple],
    get state() {
      return current;
    },
    inspect() {
      return {
        state: current,
        capHex: `#${capMat.color.getHexString()}`,
        ringHex: `#${ringMat.color.getHexString()}`,
        emblemHex: `#${emblemMat.color.getHexString()}`,
        emissiveIntensity: capMat.emissiveIntensity,
        plungerY: plunger.position.y,
        rippleVisible: ripple.visible,
      };
    },
    setState(next) {
      if (next === current) return;
      applyPalette(next);
    },
    depress() {
      pressDepth = 0.022;
      plunger.position.y = plungerRestY - VIBES_SWITCH_PALETTE[current].latchedDrop - pressDepth;
    },
    ripple(feedback) {
      rippleT = 0;
      rippleMat.color.set(RIPPLE_COLORS[feedback]);
      ripple.visible = true;
      ripple.scale.setScalar(1);
      rippleMat.opacity = feedback === 'blocked' ? 0.42 : 0.72;
    },
    press(feedback) {
      this.depress();
      this.ripple(feedback);
    },
    update(t, dt) {
      const p = VIBES_SWITCH_PALETTE[current];
      if (p.spin) {
        emblem.rotation.y = t * CEILING_GLYPH.spin;
      }
      if (pressDepth > 1e-4) {
        pressDepth *= Math.exp(-dt * 14);
        if (pressDepth <= 1e-4) pressDepth = 0;
      }
      plunger.position.y = plungerRestY - p.latchedDrop - pressDepth;
      if (rippleT < 0.55) {
        rippleT += dt;
        if (rippleT >= 0.55) {
          ripple.visible = false;
          rippleMat.opacity = 0;
        } else {
          const u = rippleT / 0.55;
          ripple.visible = true;
          ripple.scale.setScalar(1 + u * 1.45);
          rippleMat.opacity = 0.7 * (1 - u) * (1 - u);
        }
      }
    },
  };
}
