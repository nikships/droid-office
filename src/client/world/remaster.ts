import * as THREE from 'three';
import { LightProbeGridWebGL } from 'three/examples/jsm/lighting/LightProbeGridWebGL.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FLOOR, WALL_HEIGHT } from '../../shared/layout';
import { probeCount, type RenderParams, type ToneMap, whiteBalance } from '../remaster-settings';
import { HdrPresenter } from './hdr-present';
import { CLEAR_NIGHT, remasterUniforms } from './sky';
import { setToonRamp } from './toon';

/*
 * The Remastered renderer: the office drawn at a share of the screen's resolution (0.5× to 1.5×) into a float (HDR,
 * linear) target, with 2× or 4× MSAA when it's on, then exposure, white balance, contrast, saturation and tone mapping
 * to the display's range (up to the HDR peak on an EDR display), then contrast-adaptive sharpening on the way to the
 * screen's resolution. Global illumination is a light-probe grid over the floor that three.js's own lighting reads
 * (see the probe lines in world/sky.ts). With the renderer off, none of this runs and the office draws as it always has.
 */

export interface RemasterLights {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/** three.js's tone-mapping curves, with its renderer-wide exposure taken out: this pipeline applies its own. */
const TONEMAP_GLSL = THREE.ShaderChunk.tonemapping_pars_fragment.replace('uniform float toneMappingExposure;', '').replaceAll('toneMappingExposure', '1.0');

const COMMON = /* glsl */ `
float srgb1( float x ) { return x <= 0.0031308 ? 12.92 * x : 1.055 * pow( x, 1.0 / 2.4 ) - 0.055; }
// The sRGB curve carried on past 1: what an extended-range canvas reads.
vec3 srgb( vec3 c ) { c = max( c, 0.0 ); return vec3( srgb1( c.r ), srgb1( c.g ), srgb1( c.b ) ); }
float hash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
`;

const GRADE = /* glsl */ `
#include <common>
${TONEMAP_GLSL}
${COMMON}
uniform sampler2D tColor;
uniform float exposure;
uniform vec3 balance;
uniform float contrast;
uniform float saturation;
uniform float vibrance;
uniform float peak;
uniform int toneMap;
uniform int view;
uniform float dither;
varying vec2 vUv;

vec3 curve( vec3 c ) {
  // AgX's log floor is slightly above zero. A switched-off OLED pixel stays switched off.
  if ( max( c.r, max( c.g, c.b ) ) <= 0.0 ) return vec3( 0.0 );
  if ( toneMap == 0 ) return NeutralToneMapping( c );
  if ( toneMap == 1 ) return AgXToneMapping( c );
  if ( toneMap == 2 ) return ACESFilmicToneMapping( c );
  if ( toneMap == 3 ) return ReinhardToneMapping( c );
  if ( toneMap == 4 ) return CineonToneMapping( c );
  return clamp( c, 0.0, 1.0 );
}

// Grey up to white, then blue, green, yellow and red at 1×, 2×, 4× and 8× white.
vec3 heat( float l ) {
  if ( l <= 1.0 ) return vec3( l * 0.4 );
  float t = clamp( log2( l ) / 3.0, 0.0, 1.0 );
  if ( t < 0.333 ) return mix( vec3( 0.1, 0.3, 1.0 ), vec3( 0.1, 1.0, 0.4 ), t * 3.0 );
  if ( t < 0.666 ) return mix( vec3( 0.1, 1.0, 0.4 ), vec3( 1.0, 0.9, 0.1 ), ( t - 0.333 ) * 3.0 );
  return mix( vec3( 1.0, 0.9, 0.1 ), vec3( 1.0, 0.1, 0.1 ), ( t - 0.666 ) * 3.0 );
}

void main() {
  vec3 c = texture2D( tColor, vUv ).rgb;
  c *= exposure * balance;
  // Contrast around middle grey, in log space, so highlights are treated the same in SDR and HDR.
  c = 0.18 * pow( max( c, 0.0 ) / 0.18, vec3( contrast ) );
  float luma = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  float hi = max( c.r, max( c.g, c.b ) );
  float lo = min( c.r, min( c.g, c.b ) );
  float chroma = hi > 0.0 ? ( hi - lo ) / hi : 0.0;
  c = max( mix( vec3( luma ), c, saturation * ( 1.0 + vibrance * ( 1.0 - chroma ) ) ), 0.0 );
  // Up to the display's peak: 1 in SDR, the HDR peak on an EDR display.
  c = peak * curve( c / peak );
  if ( view == 1 ) {
    gl_FragColor = vec4( srgb( heat( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ) ), 1.0 );
    return;
  }
  c = srgb( c );
  // Half a step of 8-bit noise, so the dark night sky doesn't band on an 8-bit canvas. Not grain: too faint to see.
  if ( dither > 0.0 && max( c.r, max( c.g, c.b ) ) > 0.0 ) c += ( hash( gl_FragCoord.xy ) - 0.5 ) / 255.0;
  gl_FragColor = vec4( c, 1.0 );
}
`;

/** Contrast-adaptive sharpening (after AMD's CAS) on the graded image. */
const PRESENT = /* glsl */ `
${COMMON}
uniform sampler2D tColor;
uniform vec2 texel;
uniform float sharpness;
uniform float dither;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tColor, vUv ).rgb;
  if ( sharpness > 0.0 ) {
    vec3 n = texture2D( tColor, vUv + vec2( 0.0, texel.y ) ).rgb;
    vec3 s = texture2D( tColor, vUv - vec2( 0.0, texel.y ) ).rgb;
    vec3 e = texture2D( tColor, vUv + vec2( texel.x, 0.0 ) ).rgb;
    vec3 w = texture2D( tColor, vUv - vec2( texel.x, 0.0 ) ).rgb;
    vec3 lo = min( c, min( min( n, s ), min( e, w ) ) );
    vec3 hi = max( c, max( max( n, s ), max( e, w ) ) );
    // Normalized to the brightest neighbor, so HDR highlights past 1 sharpen like the rest.
    vec3 top = max( hi, vec3( 1.0 ) );
    vec3 amp = sqrt( clamp( min( lo / top, 1.0 - hi / top ) / max( hi / top, vec3( 1e-4 ) ), 0.0, 1.0 ) );
    vec3 k = -amp / mix( 8.0, 5.0, sharpness );
    c = ( c + ( n + s + e + w ) * k ) / ( 1.0 + 4.0 * k );
  }
  if ( dither > 0.0 && max( c.r, max( c.g, c.b ) ) > 0.0 ) c += ( hash( gl_FragCoord.xy ) - 0.5 ) / 255.0;
  gl_FragColor = vec4( max( c, 0.0 ), 1.0 );
}
`;

const TONE_INDEX: Record<ToneMap, number> = { neutral: 0, agx: 1, aces: 2, reinhard: 3, cineon: 4, linear: 5 };
const VIEW_INDEX: Record<RenderParams['debug'], number> = { final: 0, gi: 0, hdr: 1 };
/** three.js's own tone mapping for what draws straight to the screen after the pipeline (your hands). */
const THREE_TONE: Record<ToneMap, THREE.ToneMapping> = {
  neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  linear: THREE.LinearToneMapping,
};

function shader(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
}

/** How long a full bake may take of each frame, in ms of the main thread. */
const BAKE_BUDGET_MS = 14;
/** How each probe sees the room. */
const CAPTURE = { cubemapSize: 16, near: 0.05, far: 60 } as const;
/** The probe grid's box: the floor, a little in from the walls, from just over the floor to just under the ceiling. */
const GI_BOX = { minX: FLOOR.minX + 0.3, maxX: FLOOR.maxX - 0.3, minZ: FLOOR.minZ + 0.3, maxZ: FLOOR.maxZ - 0.3, minY: 0.2, maxY: WALL_HEIGHT - 0.6 };

/** A finished bake read back from the GPU: the probe grid's atlas texture, and the bake inputs (`bakeKey`) it came from. */
export interface SavedBake {
  key: string;
  width: number;
  height: number;
  depth: number;
  data: Float32Array;
}

/** Where a finished bake is kept between launches (`gi-cache.ts`). */
export interface BakeStore {
  load(key: string): Promise<SavedBake | null>;
  save(bake: SavedBake): Promise<void>;
}

/**
 * The bounce light: a light-probe grid over the floor, baked in slices over a few frames. Every floor has the same
 * room, desks and lamps, so the bake leaves out whatever shows who is on this floor (`hideWhileBaking`) and one bake
 * fits them all. A finished bake is saved, and loaded back instead of baking again while its inputs are the same.
 */
export class ProbeGI {
  grid: LightProbeGridWebGL | null = null;
  /** 0–1 through the current full bake; 1 once it's done. */
  progress = 0;
  /** The grid holds a finished bake, baked here or loaded. */
  baked = false;
  /** Paused while you're up on the roof, where the floor's probes don't matter. */
  paused = false;
  /** What changes from one floor to the next: hidden while the probes are baked. */
  hideWhileBaking: () => THREE.Object3D[] = () => [];
  private spacing: number | null = null;
  private cursor = 0;
  private pass = 0;
  private passes = 1;
  private full = false;
  private msPerProbe = 2;
  /** The bake inputs the grid's light is from, or is being baked or loaded for; '' for none yet. */
  private key = '';
  /** Bumped by each new key and each rebake, so a load that lands after either is dropped. */
  private ticket = 0;
  private restoring: SavedBake | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly store: BakeStore | null,
  ) {}

  get probes(): number {
    const r = this.grid?.resolution;
    return r ? r.x * r.y * r.z : 0;
  }

  get baking(): boolean {
    return this.full;
  }

  /** `spacing` is the meters between probes. */
  configure(on: boolean, spacing: number, bounces: number) {
    if (!on) {
      this.drop();
      return;
    }
    this.passes = 1 + bounces;
    if (spacing === this.spacing && this.grid) return;
    this.drop();
    const w = GI_BOX.maxX - GI_BOX.minX;
    const h = GI_BOX.maxY - GI_BOX.minY;
    const d = GI_BOX.maxZ - GI_BOX.minZ;
    const grid = new LightProbeGridWebGL(w, h, d, probeCount(w, spacing), probeCount(h, spacing), probeCount(d, spacing));
    grid.position.set((GI_BOX.minX + GI_BOX.maxX) / 2, (GI_BOX.minY + GI_BOX.maxY) / 2, (GI_BOX.minZ + GI_BOX.maxZ) / 2);
    grid.updateBoundingBox();
    this.scene.add(grid);
    this.grid = grid;
    this.spacing = spacing;
  }

  /**
   * What the light depends on (`bakeKey`). A new key loads the bake saved for it, or bakes the grid again when there
   * is none; the old light stays up meanwhile. '' waits.
   */
  setKey(key: string) {
    if (!this.grid || !key || key === this.key) return;
    this.key = key;
    if (!this.store) {
      this.rebake();
      return;
    }
    const ticket = ++this.ticket;
    this.full = false;
    this.store.load(key).then(
      (saved) => {
        if (ticket !== this.ticket) return;
        if (saved) this.restoring = saved;
        else this.rebake();
      },
      () => ticket === this.ticket && this.rebake(),
    );
  }

  /** Bakes the whole grid again over the next frames, and saves it once done; the old light stays up until each probe is redone. */
  rebake() {
    this.ticket++;
    this.restoring = null;
    this.cursor = 0;
    this.pass = 0;
    this.full = true;
    this.progress = 0;
  }

  /** Puts a loaded bake on the GPU or bakes this frame's share of probes, as many as fit the budget. */
  step(renderer: THREE.WebGLRenderer) {
    const grid = this.grid;
    if (!grid || this.paused) return;
    if (this.restoring) {
      const saved = this.restoring;
      this.restoring = null;
      if (this.restore(renderer, grid, saved)) {
        this.baked = true;
        this.progress = 1;
      } else this.rebake();
      return;
    }
    if (!this.full) return;
    const total = this.probes;
    const count = Math.min(Math.max(1, Math.floor(BAKE_BUDGET_MS / this.msPerProbe)), total - this.cursor, 96);
    const t0 = performance.now();
    this.hidden(() => grid.bake(renderer, this.scene, { start: this.cursor, count, pass: this.pass, ...CAPTURE }));
    this.msPerProbe = THREE.MathUtils.lerp(this.msPerProbe, Math.max(0.05, (performance.now() - t0) / count), 0.3);
    this.cursor += count;
    if (this.cursor >= total) {
      this.cursor = 0;
      this.pass++;
      if (this.pass >= this.passes) {
        this.full = false;
        this.baked = true;
        this.save(renderer, grid);
      }
    }
    this.progress = this.full ? (this.pass * total + this.cursor) / (this.passes * total) : 1;
  }

  /** Runs `bake` with everything `hideWhileBaking` lists out of sight, then shows it again as it was. */
  private hidden(bake: () => void) {
    const hide = this.hideWhileBaking();
    const was = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    try {
      bake();
    } finally {
      hide.forEach((o, i) => {
        o.visible = was[i];
      });
    }
  }

  /** Copies a saved atlas into the grid's. False when it doesn't fit this grid, and it has to be baked instead. */
  private restore(renderer: THREE.WebGLRenderer, grid: LightProbeGridWebGL, saved: SavedBake): boolean {
    // three.js makes the grid's atlas on its first bake: one probe makes it, and the copy covers that probe too.
    if (!grid.texture?.isRenderTargetTexture) this.hidden(() => grid.bake(renderer, this.scene, { start: 0, count: 1, ...CAPTURE }));
    const atlas = grid.texture;
    const { width, height, depth } = atlas?.image ?? {};
    if (!atlas || width !== saved.width || height !== saved.height || depth !== saved.depth || saved.data.length !== width * height * depth * 4) return false;
    const src = new THREE.Data3DTexture(saved.data, width, height, depth);
    src.format = THREE.RGBAFormat;
    src.type = THREE.FloatType;
    renderer.copyTextureToTexture(src, atlas);
    src.dispose();
    return true;
  }

  /** Reads the finished atlas back from the GPU, one layer at a time, and saves it under the key it was baked for. */
  private save(renderer: THREE.WebGLRenderer, grid: LightProbeGridWebGL) {
    const atlas = grid.texture;
    if (!this.store || !atlas) return;
    const { width, height, depth } = atlas.image;
    // three.js only reads pixels from a render target it owns, so the atlas is copied into one first.
    const copy = new THREE.WebGL3DRenderTarget(width, height, depth, { format: THREE.RGBAFormat, type: THREE.FloatType, depthBuffer: false });
    const was = renderer.getRenderTarget();
    const data = new Float32Array(width * height * depth * 4);
    const layer = width * height * 4;
    try {
      renderer.initRenderTarget(copy);
      renderer.copyTextureToTexture(atlas, copy.texture);
      for (let z = 0; z < depth; z++) {
        renderer.setRenderTarget(copy, z);
        renderer.readRenderTargetPixels(copy, 0, 0, width, height, data.subarray(z * layer, (z + 1) * layer));
      }
    } finally {
      renderer.setRenderTarget(was);
      copy.dispose();
    }
    void this.store.save({ key: this.key, width, height, depth, data }).catch(() => {});
  }

  private drop() {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
    }
    this.grid = null;
    this.spacing = null;
    this.baked = false;
    this.full = false;
    this.progress = 0;
    this.key = '';
    this.ticket++;
    this.restoring = null;
  }
}

export class Remaster {
  settings: RenderParams;
  readonly hdr: HdrPresenter;
  readonly gi: ProbeGI;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private graded: THREE.WebGLRenderTarget | null = null;
  private readonly quad = new FullScreenQuad();
  private readonly outputSize = new THREE.Vector2();
  private ramp = '';
  private readonly grade = shader(GRADE, {
    tColor: { value: null },
    exposure: { value: 1 },
    balance: { value: new THREE.Vector3(1, 1, 1) },
    contrast: { value: 1 },
    saturation: { value: 1 },
    vibrance: { value: 0 },
    peak: { value: 1 },
    toneMap: { value: 0 },
    view: { value: 0 },
    dither: { value: 0 },
  });
  private readonly present = shader(PRESENT, {
    tColor: { value: null },
    texel: { value: new THREE.Vector2() },
    sharpness: { value: 0 },
    dither: { value: 1 },
  });

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private readonly lights: RemasterLights,
    settings: RenderParams,
    onHdr: () => void,
    bakes: BakeStore | null,
  ) {
    this.settings = settings;
    this.hdr = new HdrPresenter(renderer.getContext() as WebGL2RenderingContext, renderer.domElement, onHdr);
    this.gi = new ProbeGI(scene, bakes);
  }

  get active(): boolean {
    return this.settings.enabled;
  }

  /** What the scene is drawn at and what it is shown at, in device pixels: the output at the resolution scale, within the GPU's texture limit. */
  sizes(resolution = this.settings.resolution): { render: { width: number; height: number }; output: { width: number; height: number } } {
    this.renderer.getDrawingBufferSize(this.outputSize);
    const output = { width: this.outputSize.x, height: this.outputSize.y };
    const longest = Math.max(output.width, output.height) * resolution;
    const scale = Math.min(resolution, (resolution * this.renderer.capabilities.maxTextureSize) / Math.max(1, longest));
    return { render: { width: Math.max(1, Math.round(output.width * scale)), height: Math.max(1, Math.round(output.height * scale)) }, output };
  }

  /** The peak the image is tone mapped to: the HDR peak once HDR is on screen, else white. */
  get peak(): number {
    return this.active && this.settings.hdr && this.hdr.active ? this.settings.hdrPeak : 1;
  }

  /** The corner readout's pipeline line. */
  describe(): string {
    const s = this.settings;
    const aa = s.msaa ? `${s.msaa}× MSAA` : 'no AA';
    const hdr = s.hdr ? (this.hdr.active ? `HDR ${s.hdrPeak}×` : this.hdr.state === 'starting' ? 'HDR starting' : 'SDR (HDR unavailable)') : 'SDR';
    const gi = s.gi ? (this.gi.baking ? ` · GI ${Math.round(this.gi.progress * 100)}%` : ' · GI') : '';
    return `Remastered · ${aa} · ${hdr}${gi}`;
  }

  /** Applies settings: the shader dials, the toon ramp, GI, HDR. Cheap to call again with the same ones. */
  configure(s: RenderParams) {
    this.settings = s;
    const on = s.enabled;
    const u = remasterUniforms;
    u.glow.value = on ? s.screenGlow : 1;
    u.emissive.value = on ? s.emissive : 1;
    u.screens.value = on ? s.screenLight : 1;
    u.fill.value = on ? s.officeFill : 1;
    u.lamps.value = on ? s.lampLight : 1;
    u.gi.value = on && s.gi ? s.giIntensity : 0;
    u.giOnly.value = on && s.gi && s.debug === 'gi' ? 1 : 0;
    this.gi.configure(on && s.gi, s.giSpacing, s.giBounces);
    this.hdr.set(on && s.hdr);
    const ramp = on ? s.toonRamp : 'classic';
    if (ramp !== this.ramp) {
      this.ramp = ramp;
      setToonRamp(ramp);
    }
    // What draws straight to the screen after the pipeline (your hands) is tone mapped to match.
    this.renderer.toneMapping = on ? THREE_TONE[s.toneMap] : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = on ? s.exposure : 1;
    if (!on) this.disposeTargets();
    else if (this.sceneRT && this.sceneRT.samples !== this.msaaSamples()) this.disposeTargets();
  }

  private msaaSamples(): number {
    return this.settings.msaa;
  }

  /** After the canvas changes size. */
  resized() {
    this.hdr.resized();
  }

  private ensure(render: { width: number; height: number }) {
    const { width: w, height: h } = render;
    if (this.sceneRT && this.sceneRT.width === w && this.sceneRT.height === h) return;
    this.disposeTargets();
    const hdr = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter } as const;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, { ...hdr, depthBuffer: true, samples: this.msaaSamples() });
    this.graded = new THREE.WebGLRenderTarget(w, h, { ...hdr, depthBuffer: false });
  }

  /** Draws the frame `drawScene` renders with the camera to the canvas, through the whole pipeline. */
  draw(drawScene: () => void) {
    const s = this.settings;
    const r = this.renderer;
    const { render } = this.sizes();
    this.ensure(render);
    const sceneRT = this.sceneRT!;
    const { sun, hemi, ambient } = this.lights;
    const lit = [sun.intensity, hemi.intensity, ambient.intensity] as const;
    sun.intensity *= s.moon;
    hemi.intensity *= s.skyFill;
    ambient.intensity *= s.ambientFill;
    try {
      if (s.gi) {
        const u = remasterUniforms;
        const glow = [u.bakeGlow.value, u.emissive.value] as const;
        const now = [sun.intensity, hemi.intensity, ambient.intensity] as const;
        u.bakeGlow.value = s.giGlow;
        u.emissive.value *= s.giGlow;
        // Baked under a clear night's moon and sky, so the weather and a lightning flash never end up in a saved bake.
        sun.intensity = CLEAR_NIGHT.moon * s.moon;
        hemi.intensity = CLEAR_NIGHT.hemi * s.skyFill;
        ambient.intensity = CLEAR_NIGHT.ambient * s.ambientFill;
        try {
          this.gi.step(r);
        } finally {
          [u.bakeGlow.value, u.emissive.value] = glow;
          [sun.intensity, hemi.intensity, ambient.intensity] = now;
        }
      }
      r.setRenderTarget(sceneRT);
      drawScene();
    } finally {
      // A throw mid-draw must not leave the lights turned up for the next frame.
      [sun.intensity, hemi.intensity, ambient.intensity] = lit;
      r.setRenderTarget(null);
    }

    const g = this.grade.uniforms;
    g.tColor.value = sceneRT.texture;
    g.exposure.value = s.exposure * (this.peak > 1 ? s.paperWhite : 1);
    // Paper white only counts once HDR is on screen, which configure() can't know, so your hands get it here.
    r.toneMappingExposure = g.exposure.value;
    g.balance.value.set(...whiteBalance(s.temperature, s.tint));
    g.contrast.value = s.contrast;
    g.saturation.value = s.saturation;
    g.vibrance.value = s.vibrance;
    g.peak.value = this.peak;
    g.toneMap.value = TONE_INDEX[s.toneMap];
    g.view.value = VIEW_INDEX[s.debug];
    // A float16 canvas has no 8-bit steps to hide.
    const dither = this.hdr.active ? 0 : 1;
    // Without sharpening or a resize, the grade is the last pass and draws straight to the canvas.
    const direct = s.sharpen === 0 && render.width === this.outputSize.x && render.height === this.outputSize.y;
    g.dither.value = direct ? dither : 0;
    this.blit(this.grade, direct ? null : this.graded);
    if (direct) return;

    const p = this.present.uniforms;
    p.tColor.value = this.graded!.texture;
    p.texel.value.set(1 / render.width, 1 / render.height);
    p.sharpness.value = s.sharpen;
    p.dither.value = dither;
    this.blit(this.present, null);
  }

  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  /** Once everything is drawn: the frame onto the HDR canvas, when that's on. */
  finishFrame() {
    this.hdr.present();
  }

  private disposeTargets() {
    this.sceneRT?.dispose();
    this.graded?.dispose();
    this.sceneRT = this.graded = null;
  }
}
