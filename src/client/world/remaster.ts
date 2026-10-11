import * as THREE from 'three';
import { LightProbeGridWebGL } from 'three/examples/jsm/lighting/LightProbeGridWebGL.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FLOOR, WALL_HEIGHT } from '../../shared/layout';
import { renderSize } from '../graphics';
import { GI_SPACING, type GiDensity, probeCount, type RemasterSettings, type ToneMap, whiteBalance } from '../remaster-settings';
import { HdrPresenter } from './hdr-present';
import { remasterUniforms } from './sky';
import { setToonRamp } from './toon';

/*
 * The Remastered renderer: the office drawn into a float (HDR, linear) target, then ambient occlusion, bloom and
 * moonlight shafts in that light, then exposure, white balance, contrast, saturation and tone mapping to the
 * display's range (up to the HDR peak on an EDR display), then SMAA or FXAA, then contrast-adaptive sharpening as it
 * is brought up (or down) to the screen's resolution. Global illumination is a light-probe grid over the floor that
 * three.js's own lighting reads (see the probe lines in world/sky.ts). With the renderer off, none of this runs and
 * the office draws as it always has.
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
uniform float cameraNear;
uniform float cameraFar;
float viewZ( float d ) { return ( cameraNear * cameraFar ) / ( cameraFar - d * ( cameraFar - cameraNear ) ); }
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
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform sampler2D tShafts;
uniform float shafts;
uniform float aoBlend;
uniform sampler2D tBloom0;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform sampler2D tBloom3;
uniform sampler2D tBloom4;
uniform float bloomW[5];
uniform float exposure;
uniform vec3 balance;
uniform float contrast;
uniform float saturation;
uniform float vibrance;
uniform float peak;
uniform int toneMap;
uniform int view;
varying vec2 vUv;

vec3 curve( vec3 c ) {
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
  if ( view == 1 ) {
    gl_FragColor = vec4( srgb( vec3( texture2D( tAO, vUv ).r ) ), 1.0 );
    return;
  }
  if ( view == 3 ) {
    float z = viewZ( texture2D( tDepth, vUv ).x );
    gl_FragColor = vec4( vec3( 1.0 - clamp( log2( max( z, 1.0 ) ) / log2( cameraFar ), 0.0, 1.0 ) ), 1.0 );
    return;
  }
  vec3 c = texture2D( tColor, vUv ).rgb;
  if ( aoBlend > 0.0 ) c *= mix( 1.0, texture2D( tAO, vUv ).r, aoBlend );
  if ( bloomW[0] > 0.0 ) c += bloomW[0] * texture2D( tBloom0, vUv ).rgb;
  if ( bloomW[1] > 0.0 ) c += bloomW[1] * texture2D( tBloom1, vUv ).rgb;
  if ( bloomW[2] > 0.0 ) c += bloomW[2] * texture2D( tBloom2, vUv ).rgb;
  if ( bloomW[3] > 0.0 ) c += bloomW[3] * texture2D( tBloom3, vUv ).rgb;
  if ( bloomW[4] > 0.0 ) c += bloomW[4] * texture2D( tBloom4, vUv ).rgb;
  if ( shafts > 0.0 ) c += texture2D( tShafts, vUv ).rgb * shafts;
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
  if ( view == 4 ) {
    gl_FragColor = vec4( srgb( heat( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ) ), 1.0 );
    return;
  }
  gl_FragColor = vec4( srgb( c ), 1.0 );
}
`;

const SHAFT_STEPS = 48;
const SHAFTS = /* glsl */ `
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 moonUv;
uniform float aspect;
uniform float decay;
uniform float reach;
uniform float visible;
uniform vec3 moonColor;
varying vec2 vUv;
void main() {
  vec2 delta = ( vUv - moonUv ) * reach / float( ${SHAFT_STEPS} );
  // Each pixel starts a fraction of a step along, so the steps don't show as bands.
  vec2 uv = vUv - delta * hash( gl_FragCoord.xy );
  float lit = 1.0;
  vec3 sum = vec3( 0.0 );
  for ( int i = 0; i < ${SHAFT_STEPS}; i ++ ) {
    float sky = smoothstep( cameraFar * 0.5, cameraFar * 0.9, viewZ( texture2D( tDepth, uv ).x ) );
    vec2 d = ( uv - moonUv ) * vec2( aspect, 1.0 );
    float halo = exp( - dot( d, d ) * 14.0 );
    sum += sky * ( halo * moonColor + 0.2 * texture2D( tColor, uv ).rgb ) * lit;
    lit *= decay;
    uv -= delta;
  }
  gl_FragColor = vec4( sum * visible * ( 4.0 / float( ${SHAFT_STEPS} ) ), 1.0 );
}
`;

/** Contrast-adaptive sharpening (after AMD's CAS) as the image is brought to the screen's size. */
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
  // Half a step of 8-bit noise, so the dark night sky doesn't band on an 8-bit canvas. Not grain: too faint to see.
  if ( dither > 0.0 ) c += ( hash( gl_FragCoord.xy ) - 0.5 ) / 255.0;
  gl_FragColor = vec4( max( c, 0.0 ), 1.0 );
}
`;

const BLUR_X = new THREE.Vector2(1, 0);
const BLUR_Y = new THREE.Vector2(0, 1);
const TONE_INDEX: Record<ToneMap, number> = { neutral: 0, agx: 1, aces: 2, reinhard: 3, cineon: 4, linear: 5 };
const VIEW_INDEX: Record<RemasterSettings['debug'], number> = { final: 0, ao: 1, gi: 0, depth: 3, hdr: 4 };
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
/** The probe grid's box: the floor, a little in from the walls, from just over the floor to just under the ceiling. */
const GI_BOX = { minX: FLOOR.minX + 0.3, maxX: FLOOR.maxX - 0.3, minZ: FLOOR.minZ + 0.3, maxZ: FLOOR.maxZ - 0.3, minY: 0.2, maxY: WALL_HEIGHT - 0.6 };

/** The bounce light: a light-probe grid over the floor, baked in slices over a few frames, then kept fresh a few probes at a time. */
export class ProbeGI {
  grid: LightProbeGridWebGL | null = null;
  /** 0–1 through the current full bake; 1 once it's done. */
  progress = 0;
  /** At least one full bake has finished. */
  baked = false;
  /** Paused while you're up on the roof, where the floor's probes don't matter. */
  paused = false;
  private density: GiDensity | null = null;
  private cursor = 0;
  private pass = 0;
  private passes = 1;
  private full = false;
  private floor = '';
  private msPerProbe = 2;

  constructor(private readonly scene: THREE.Scene) {}

  get probes(): number {
    const r = this.grid?.resolution;
    return r ? r.x * r.y * r.z : 0;
  }

  get baking(): boolean {
    return this.full;
  }

  configure(on: boolean, density: GiDensity, bounces: number) {
    if (!on) {
      this.drop();
      return;
    }
    const passes = 1 + bounces;
    if (density !== this.density || !this.grid) {
      this.drop();
      const spacing = GI_SPACING[density];
      const w = GI_BOX.maxX - GI_BOX.minX;
      const h = GI_BOX.maxY - GI_BOX.minY;
      const d = GI_BOX.maxZ - GI_BOX.minZ;
      const grid = new LightProbeGridWebGL(w, h, d, probeCount(w, spacing), probeCount(h, spacing), probeCount(d, spacing));
      grid.position.set((GI_BOX.minX + GI_BOX.maxX) / 2, (GI_BOX.minY + GI_BOX.maxY) / 2, (GI_BOX.minZ + GI_BOX.maxZ) / 2);
      grid.updateBoundingBox();
      this.scene.add(grid);
      this.grid = grid;
      this.density = density;
      this.passes = passes;
      this.rebake();
    } else if (passes !== this.passes) {
      this.passes = passes;
      this.rebake();
    }
  }

  /** Bakes the whole grid again over the next frames; the old light stays up until each probe is redone. */
  rebake() {
    this.cursor = 0;
    this.pass = 0;
    this.full = true;
    this.progress = 0;
  }

  /** A different floor (other desks, other people) is a full rebake. */
  setFloor(key: string) {
    if (key === this.floor) return;
    this.floor = key;
    if (this.grid) this.rebake();
  }

  /** Bakes this frame's share: as many as fit the budget during a full bake, else `live` probes (0 for none). */
  step(renderer: THREE.WebGLRenderer, live: number) {
    const grid = this.grid;
    if (!grid || this.paused) return;
    const total = this.probes;
    const want = this.full ? Math.max(1, Math.floor(BAKE_BUDGET_MS / this.msPerProbe)) : live;
    if (want <= 0) return;
    const count = Math.min(want, total - this.cursor, 96);
    const t0 = performance.now();
    grid.bake(renderer, this.scene, { start: this.cursor, count, pass: this.pass, cubemapSize: 16, near: 0.05, far: 60 });
    this.msPerProbe = THREE.MathUtils.lerp(this.msPerProbe, Math.max(0.05, (performance.now() - t0) / count), 0.3);
    this.cursor += count;
    if (this.cursor >= total) {
      this.cursor = 0;
      if (this.full) {
        this.pass++;
        if (this.pass >= this.passes) {
          this.full = false;
          this.baked = true;
          // Kept fresh on the last pass, which reads the light already there: each sweep adds a bounce.
          this.pass = this.passes - 1;
        }
      }
    }
    this.progress = this.full ? (this.pass * total + this.cursor) / (this.passes * total) : 1;
  }

  private drop() {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
    }
    this.grid = null;
    this.density = null;
    this.baked = false;
    this.full = false;
    this.progress = 0;
  }
}

export class Remaster {
  settings: RemasterSettings;
  readonly hdr: HdrPresenter;
  readonly gi: ProbeGI;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private shaftsRT: THREE.WebGLRenderTarget | null = null;
  private ldr: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private gtao: GTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private smaa: SMAAPass | null = null;
  private fxaa: FXAAPass | null = null;
  private readonly quad = new FullScreenQuad();
  private readonly outputSize = new THREE.Vector2();
  private readonly moonDir = new THREE.Vector3();
  private readonly moonAt = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private shadow = { type: -1 as number, size: 0, radius: -1 };
  private ramp = '';
  private aoSize = '';
  private lastDraw = 0;
  private giGlow = -1;
  private liveDue = 0;
  private readonly grade = shader(GRADE, {
    tColor: { value: null },
    tDepth: { value: null },
    tAO: { value: null },
    tShafts: { value: null },
    shafts: { value: 0 },
    aoBlend: { value: 0 },
    tBloom0: { value: null },
    tBloom1: { value: null },
    tBloom2: { value: null },
    tBloom3: { value: null },
    tBloom4: { value: null },
    bloomW: { value: [0, 0, 0, 0, 0] },
    exposure: { value: 1 },
    balance: { value: new THREE.Vector3(1, 1, 1) },
    contrast: { value: 1 },
    saturation: { value: 1 },
    vibrance: { value: 0 },
    peak: { value: 1 },
    toneMap: { value: 0 },
    view: { value: 0 },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 100 },
  });
  private readonly shafts = shader(SHAFTS, {
    tColor: { value: null },
    tDepth: { value: null },
    moonUv: { value: new THREE.Vector2() },
    aspect: { value: 1 },
    decay: { value: 0.96 },
    reach: { value: 0.75 },
    visible: { value: 0 },
    moonColor: { value: new THREE.Color() },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 100 },
  });
  private readonly present = shader(PRESENT, {
    tColor: { value: null },
    texel: { value: new THREE.Vector2() },
    sharpness: { value: 0 },
    dither: { value: 1 },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 100 },
  });

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly lights: RemasterLights,
    /** Scenes besides the office whose materials need rebuilding when the shadow filter changes (your hands). */
    private readonly others: THREE.Object3D[],
    settings: RemasterSettings,
    onHdr: () => void,
  ) {
    this.settings = settings;
    this.hdr = new HdrPresenter(renderer.getContext() as WebGL2RenderingContext, renderer.domElement, onHdr);
    this.gi = new ProbeGI(scene);
  }

  get active(): boolean {
    return this.settings.enabled;
  }

  /** What the scene is drawn at and what it is shown at, in device pixels. */
  sizes(): { render: { width: number; height: number }; output: { width: number; height: number } } {
    this.renderer.getDrawingBufferSize(this.outputSize);
    const output = { width: this.outputSize.x, height: this.outputSize.y };
    const max = this.renderer.capabilities.maxTextureSize;
    const r = renderSize(output.width, output.height, this.settings.renderScale);
    const fit = Math.min(1, max / Math.max(r.width, r.height));
    return { render: { width: Math.max(1, Math.floor(r.width * fit)), height: Math.max(1, Math.floor(r.height * fit)) }, output };
  }

  /** The peak the image is tone mapped to: the HDR peak once HDR is on screen, else white. */
  get peak(): number {
    return this.active && this.settings.hdr && this.hdr.active ? this.settings.hdrPeak : 1;
  }

  /** The corner readout's pipeline line. */
  describe(): string {
    const s = this.settings;
    const aa = { msaa: 'MSAA', 'msaa-smaa': 'MSAA+SMAA', smaa: 'SMAA', fxaa: 'FXAA', off: 'no AA' }[s.aa];
    const hdr = s.hdr ? (this.hdr.active ? `HDR ${s.hdrPeak}×` : this.hdr.state === 'starting' ? 'HDR starting' : 'SDR (HDR unavailable)') : 'SDR';
    const fx = [s.bloom && 'bloom', s.ao && 'AO', s.gi && (this.gi.baking ? `GI ${Math.round(this.gi.progress * 100)}%` : 'GI'), s.shafts && 'shafts'].filter(Boolean).join('+');
    return `Remastered · ${aa} · ${hdr}${fx ? ` · ${fx}` : ''}`;
  }

  /** Applies settings: the shader dials, shadows, the toon ramp, GI, HDR. Cheap to call again with the same ones. */
  configure(s: RemasterSettings) {
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
    this.gi.configure(on && s.gi, s.giDensity, s.giBounces);
    // How much glowing surfaces light the room is baked into the probes.
    if (s.giGlow !== this.giGlow) {
      if (this.giGlow >= 0 && this.gi.grid) this.gi.rebake();
      this.giGlow = s.giGlow;
    }
    this.hdr.set(on && s.hdr);
    this.applyShadows(on ? (s.shadowFilter === 'vsm' ? THREE.VSMShadowMap : THREE.PCFShadowMap) : THREE.PCFShadowMap, on ? Number(s.shadowMapSize) : 2048, on ? s.shadowSoftness : 1);
    const ramp = on ? s.toonRamp : 'classic';
    if (ramp !== this.ramp) {
      this.ramp = ramp;
      setToonRamp(ramp);
    }
    // What draws straight to the screen after the pipeline (your hands) is tone mapped to match.
    this.renderer.toneMapping = on ? THREE_TONE[s.toneMap] : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = on ? s.exposure : 1;
    if (this.gtao) {
      this.tuneAO(this.gtao);
      if (this.sceneRT && this.aoSize !== s.aoResolution) this.sizeAO(this.sceneRT.width, this.sceneRT.height);
    }
    if (!on) this.disposeTargets();
    else if (this.sceneRT && this.sceneRT.samples !== this.msaaSamples()) this.disposeTargets();
  }

  private msaaSamples(): number {
    return this.settings.aa === 'msaa' || this.settings.aa === 'msaa-smaa' ? 4 : 0;
  }

  private applyShadows(type: THREE.ShadowMapType, size: number, radius: number) {
    const sm = this.renderer.shadowMap;
    const sun = this.lights.sun;
    if (type !== this.shadow.type) {
      sm.type = type;
      // Which filter the shadows use is compiled into every lit material.
      for (const root of [this.scene, ...this.others])
        root.traverse((o) => {
          const m = (o as THREE.Mesh).material;
          if (!m) return;
          for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
        });
    }
    if (size !== this.shadow.size || type !== this.shadow.type) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    sun.shadow.radius = radius;
    sun.shadow.blurSamples = Math.max(4, Math.round(radius * 4));
    this.shadow = { type, size, radius };
    sm.needsUpdate = true;
  }

  private tuneAO(gtao: GTAOPass) {
    const s = this.settings;
    gtao.updateGtaoMaterial({ radius: s.aoRadius, thickness: s.aoThickness, scale: s.aoIntensity, samples: Number(s.aoSamples), distanceExponent: 1, distanceFallOff: 1 });
  }

  /** The AO is worked out at half or full resolution, and scaled up as it is blended in. */
  private sizeAO(w: number, h: number) {
    const half = this.settings.aoResolution === 'half';
    const aw = half ? Math.max(1, w >> 1) : w;
    const ah = half ? Math.max(1, h >> 1) : h;
    this.aoSize = this.settings.aoResolution;
    if (this.gtao && (this.gtao.width !== aw || this.gtao.height !== ah)) this.gtao.setSize(aw, ah);
  }

  /** After the canvas changes size. */
  resized() {
    this.hdr.resized();
  }

  private ensure(render: { width: number; height: number }) {
    const { width: w, height: h } = render;
    if (this.sceneRT && this.sceneRT.width === w && this.sceneRT.height === h) return;
    this.disposeTargets();
    const hdr = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false } as const;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, { ...hdr, depthBuffer: true, samples: this.msaaSamples(), depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType) });
    this.shaftsRT = new THREE.WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), hdr);
    this.ldr = [new THREE.WebGLRenderTarget(w, h, hdr), new THREE.WebGLRenderTarget(w, h, hdr)];
    if (!this.gtao) {
      this.gtao = new GTAOPass(this.scene, this.camera, w, h);
      // Only the AO is worked out here; the grade pass multiplies it in, which saves a full-size copy and blend.
      this.gtao.output = GTAOPass.OUTPUT.Off;
    }
    this.sizeAO(w, h);
    // AO from the depth this frame was drawn with: glass (which writes no depth) is seen through, and no second scene pass.
    this.gtao.setGBuffer(this.sceneRT.depthTexture ?? undefined);
    this.tuneAO(this.gtao);
    this.bloom ??= new UnrealBloomPass(new THREE.Vector2(w, h), 1, 0.4, 1);
    // From a half-size source (the pass halves it again): the glow is a blur, so it looks the same for a quarter of the work.
    this.bloom.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.smaa ??= new SMAAPass();
    this.smaa.setSize(w, h);
    this.fxaa ??= new FXAAPass();
    this.fxaa.setSize(w, h);
  }

  /** Draws the frame `drawScene` renders with the camera to the canvas, through the whole pipeline. */
  draw(drawScene: () => void) {
    const s = this.settings;
    const r = this.renderer;
    const { render } = this.sizes();
    this.ensure(render);
    const sceneRT = this.sceneRT!;
    const camera = this.camera;
    const { sun, hemi, ambient } = this.lights;
    const lit = [sun.intensity, hemi.intensity, ambient.intensity] as const;
    sun.intensity *= s.moon;
    hemi.intensity *= s.skyFill;
    ambient.intensity *= s.ambientFill;
    try {
      if (s.gi) {
        // Live probes come out of a per-second budget, so the cost doesn't climb with the frame rate.
        const now = performance.now();
        const dt = Math.min(0.25, (now - this.lastDraw) / 1000);
        this.liveDue = s.giRolling ? Math.min(this.liveDue + s.giSpeed * dt, 16) : 0;
        const live = Math.floor(this.liveDue);
        this.liveDue -= live;
        const u = remasterUniforms;
        const glow = [u.bakeGlow.value, u.emissive.value] as const;
        u.bakeGlow.value = s.giGlow;
        u.emissive.value *= s.giGlow;
        try {
          this.gi.step(r, live);
        } finally {
          [u.bakeGlow.value, u.emissive.value] = glow;
        }
      }
      this.lastDraw = performance.now();
      r.setRenderTarget(sceneRT);
      drawScene();
    } finally {
      // A throw mid-draw must not leave the lights turned up for the next frame.
      [sun.intensity, hemi.intensity, ambient.intensity] = lit;
      r.setRenderTarget(null);
    }

    const color = sceneRT;
    const ao = s.ao && !!this.gtao;
    if (ao) this.gtao!.render(r, sceneRT, sceneRT, 0, false);
    const bloomLevels = s.bloom && this.bloom ? this.drawBloom(this.bloom, color.texture) : 0;

    const near = camera.near;
    const far = camera.far;
    let shafts = 0;
    if (s.shafts) shafts = this.drawShafts(color, sceneRT.depthTexture!) ? s.shaftsIntensity : 0;

    const g = this.grade.uniforms;
    g.tColor.value = color.texture;
    g.tDepth.value = sceneRT.depthTexture;
    g.tAO.value = this.gtao?.pdRenderTarget.texture ?? null;
    g.tShafts.value = this.shaftsRT!.texture;
    g.shafts.value = shafts;
    g.aoBlend.value = ao ? s.aoBlend : 0;
    this.bloomWeights(g, bloomLevels);
    g.exposure.value = s.exposure * (this.peak > 1 ? s.paperWhite : 1);
    g.balance.value.set(...whiteBalance(s.temperature, s.tint));
    g.contrast.value = s.contrast;
    g.saturation.value = s.saturation;
    g.vibrance.value = s.vibrance;
    g.peak.value = this.peak;
    g.toneMap.value = TONE_INDEX[s.toneMap];
    g.view.value = s.debug === 'ao' && !s.ao ? 0 : VIEW_INDEX[s.debug];
    g.cameraNear.value = near;
    g.cameraFar.value = far;
    const [a, b] = this.ldr!;
    const smaa = (s.aa === 'smaa' || s.aa === 'msaa-smaa') && this.smaa;
    const fxaa = s.aa === 'fxaa' && this.fxaa;
    // The present pass would only copy (no sharpening, no resize, no dither on a float16 canvas): the last pass draws
    // straight to the canvas instead. Each pass dropped is worth about a millisecond on Apple GPUs at 120 Hz.
    const direct = s.sharpen === 0 && this.hdr.active && render.width === this.outputSize.x && render.height === this.outputSize.y;
    this.blit(this.grade, direct && !smaa && !fxaa ? null : a);

    let out = a;
    if (smaa) {
      smaa.renderToScreen = direct;
      smaa.render(r, b, a, 0, false);
      out = b;
    } else if (fxaa) {
      fxaa.renderToScreen = direct;
      fxaa.render(r, b, a, 0, false);
      out = b;
    }
    if (direct) return;

    const p = this.present.uniforms;
    p.tColor.value = out.texture;
    p.texel.value.set(1 / render.width, 1 / render.height);
    p.sharpness.value = s.sharpen;
    // A float16 canvas has no 8-bit steps to hide.
    p.dither.value = this.hdr.active ? 0 : 1;
    this.blit(this.present, null);
  }

  /**
   * UnrealBloomPass's bright pass and blurred mips, without its composite and its blend back into the scene target:
   * the grade pass samples the mips itself (see bloomWeights), which saves two passes. Only `bloomLevels` of its five
   * blur levels are drawn: on Apple GPUs each small level past the second costs about 1.3 ms of GPU time, however few
   * pixels it has. Returns how many levels were drawn.
   */
  private drawBloom(pass: UnrealBloomPass, input: THREE.Texture): number {
    const s = this.settings;
    const levels = Math.max(1, Math.min(pass.nMips, Math.round(s.bloomLevels)));
    const high = pass.highPassUniforms as Record<string, THREE.IUniform>;
    high.tDiffuse.value = input;
    high.luminosityThreshold.value = s.bloomThreshold;
    this.blit(pass.materialHighPassFilter, pass.renderTargetBright);
    let from = pass.renderTargetBright;
    for (let i = 0; i < levels; i++) {
      const blur = pass.separableBlurMaterials[i];
      blur.uniforms.colorTexture.value = from.texture;
      blur.uniforms.direction.value = BLUR_X;
      this.blit(blur, pass.renderTargetsHorizontal[i]);
      blur.uniforms.colorTexture.value = pass.renderTargetsHorizontal[i].texture;
      blur.uniforms.direction.value = BLUR_Y;
      this.blit(blur, pass.renderTargetsVertical[i]);
      from = pass.renderTargetsVertical[i];
    }
    return levels;
  }

  /** The grade pass's share of each bloom level: UnrealBloomPass's composite weights, 0 for levels not drawn this frame. */
  private bloomWeights(g: Record<string, THREE.IUniform>, levels: number) {
    const s = this.settings;
    const w = g.bloomW.value as number[];
    for (let i = 0; i < 5; i++) {
      const factor = 1 - i * 0.2;
      w[i] = i < levels ? s.bloomStrength * THREE.MathUtils.lerp(factor, 1.2 - factor, s.bloomRadius) : 0;
      g[`tBloom${i}`].value = i < levels && this.bloom ? this.bloom.renderTargetsVertical[i].texture : null;
    }
  }

  /** The moon's rays into shaftsRT. False when the moon is behind you or off screen. */
  private drawShafts(color: THREE.WebGLRenderTarget, depth: THREE.DepthTexture): boolean {
    const { sun } = this.lights;
    const camera = this.camera;
    this.moonDir.copy(sun.position).sub(sun.target.position).normalize();
    camera.getWorldDirection(this.camDir);
    const facing = this.camDir.dot(this.moonDir);
    if (facing <= 0.05) return false;
    this.moonAt
      .copy(camera.position)
      .addScaledVector(this.moonDir, camera.far * 0.8)
      .project(camera);
    const u = this.shafts.uniforms;
    u.moonUv.value.set(this.moonAt.x * 0.5 + 0.5, this.moonAt.y * 0.5 + 0.5);
    u.visible.value = THREE.MathUtils.smoothstep(facing, 0.05, 0.45);
    u.aspect.value = camera.aspect;
    u.decay.value = this.settings.shaftsDecay;
    u.reach.value = this.settings.shaftsLength;
    u.moonColor.value.copy(sun.color).multiplyScalar(0.35);
    u.tColor.value = color.texture;
    u.tDepth.value = depth;
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    this.blit(this.shafts, this.shaftsRT);
    return true;
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
    this.sceneRT?.depthTexture?.dispose();
    this.sceneRT?.dispose();
    this.shaftsRT?.dispose();
    for (const t of this.ldr ?? []) t.dispose();
    this.sceneRT = this.shaftsRT = null;
    this.ldr = null;
  }
}
