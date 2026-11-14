import * as THREE from 'three';
import type { VibesSwitchState } from '../../shared/gemini-vibes';
import { CEILING_GLYPH, VIBES_SWITCH } from '../../shared/layout';
import { glyphFlat } from './glyph3d';
import type { Collider, Interactable } from './office';
import { mergeByMaterial, mesh, toon, toonUnique } from './toon';

// The Living 3D reactions & mood lighting pedestal switch: a circular pushbutton atop a thin
// dark-steel column rising to waist height, centered directly beneath the spinning Factory
// ceiling glyph on every indoor floor.

export interface VibesSwitchPalette {
  cap: string;
  capEmissive: string;
  capIntensity: number;
  ring: string;
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
    emblem: '#ecfdf5',
    latchedDrop: 0.005,
    spin: true,
  },
  off: {
    cap: '#ef4444',
    capEmissive: '#dc2626',
    capIntensity: 0.8,
    ring: '#f87171',
    emblem: '#fee2e2',
    latchedDrop: 0,
    spin: false,
  },
  disconnected: {
    cap: '#27272a',
    capEmissive: '#000000',
    capIntensity: 0,
    ring: '#52525b',
    emblem: '#71717a',
    latchedDrop: 0,
    spin: false,
  },
  rejected: {
    cap: '#27272a',
    capEmissive: '#3b2006',
    capIntensity: 0.25,
    ring: '#f59e0b',
    emblem: '#fbbf24',
    latchedDrop: 0,
    spin: false,
  },
  airgapped: {
    cap: '#1f2024',
    capEmissive: '#000000',
    capIntensity: 0,
    ring: '#3a3a40',
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

  // Soft radial bezel bloom when pressed, feathered to zero at both inner and outer edges.
  const rippleInnerR = outerBezelR * 0.84;
  const rippleOuterR = outerBezelR * 1.52;
  const rippleGeo = new THREE.RingGeometry(rippleInnerR, rippleOuterR, 48, 6);
  rippleGeo.rotateX(-Math.PI / 2);
  const ripplePos = rippleGeo.getAttribute('position') as THREE.BufferAttribute;
  const rippleCol = new Float32Array(ripplePos.count * 3);
  for (let i = 0; i < ripplePos.count; i++) {
    const r = Math.hypot(ripplePos.getX(i), ripplePos.getZ(i));
    const u = THREE.MathUtils.clamp((r - rippleInnerR) / (rippleOuterR - rippleInnerR), 0, 1);
    const w = Math.sin(u * Math.PI) ** 2.2;
    rippleCol[i * 3] = rippleCol[i * 3 + 1] = rippleCol[i * 3 + 2] = w;
  }
  rippleGeo.setAttribute('color', new THREE.BufferAttribute(rippleCol, 3));
  const rippleMat = new THREE.MeshBasicMaterial({
    color: '#34d399',
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  rippleMat.userData.outlineParameters = { visible: false };
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
  let ripplePeak = 0.36;

  const applyPalette = (next: VibesSwitchState) => {
    current = next;
    const p = VIBES_SWITCH_PALETTE[next];
    capMat.color.set(p.cap);
    capMat.emissive.set(p.capEmissive);
    capMat.emissiveIntensity = p.capIntensity;
    ringMat.color.set(p.ring);
    emblemMat.color.set(p.emblem);
    plunger.position.y = plungerRestY - p.latchedDrop - pressDepth;
  };
  applyPalette('disconnected');

  return {
    group,
    collider,
    interactable,
    bakeHidden: [stemCollar, bezelHalo, plunger, ripple],
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
      ripplePeak = feedback === 'blocked' ? 0.22 : 0.36;
      rippleMat.color.set(RIPPLE_COLORS[feedback]);
      ripple.visible = true;
      ripple.scale.setScalar(0.96);
      rippleMat.opacity = ripplePeak;
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
          ripple.scale.setScalar(0.96 + u * 0.2);
          rippleMat.opacity = ripplePeak * (1 - u) * (1 - u);
        }
      }
    },
  };
}
