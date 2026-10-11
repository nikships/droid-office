import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { jitterAt, renderSize, type GraphicsSettings } from '../graphics';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/**
 * Temporal upscaling: this frame's jittered, low-resolution samples are filtered onto the output grid and blended
 * into last frame's output, reprojected by the camera's motion through the depth buffer. History that no longer
 * matches what this frame sees around the pixel is clipped to that neighbourhood's colour range, which is what keeps
 * moving workers from leaving trails.
 */
const RESOLVE = /* glsl */ `
uniform sampler2D tCurrent;
uniform sampler2D tDepth;
uniform sampler2D tHistory;
uniform vec2 inputSize;
uniform vec2 outputSize;
uniform vec2 jitter;
uniform mat4 invViewProj;
uniform mat4 prevViewProj;
uniform float historyValid;
varying vec2 vUv;

vec3 toYCoCg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }

// Catmull-Rom in five bilinear taps: bilinear history alone blurs a little more every frame it is resampled.
vec3 sampleHistory(vec2 uv) {
  vec2 pos = uv * outputSize;
  vec2 c = floor(pos - 0.5) + 0.5;
  vec2 f = pos - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (c - 1.0) / outputSize;
  vec2 t3 = (c + 2.0) / outputSize;
  vec2 t12 = (c + w2 / w12) / outputSize;
  vec3 r = texture2D(tHistory, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
    + texture2D(tHistory, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
    + texture2D(tHistory, t12).rgb * (w12.x * w12.y)
    + texture2D(tHistory, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
    + texture2D(tHistory, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / ws, 0.0);
}

vec3 clipToBox(vec3 lo, vec3 hi, vec3 h) {
  vec3 mid = 0.5 * (hi + lo);
  vec3 ext = 0.5 * (hi - lo) + 1e-4;
  vec3 v = h - mid;
  vec3 a = abs(v / ext);
  float m = max(a.x, max(a.y, a.z));
  return m > 1.0 ? mid + v / m : h;
}

void main() {
  // This output pixel's centre in the jittered input, in input texels (texel k's centre is at k).
  vec2 inPos = vUv * inputSize + jitter - 0.5;
  ivec2 base = ivec2(floor(inPos + 0.5));
  ivec2 maxI = ivec2(inputSize) - 1;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 lo = vec3(1e9);
  vec3 hi = vec3(-1e9);
  float closest = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 p = clamp(base + ivec2(x, y), ivec2(0), maxI);
      vec3 c = toYCoCg(texelFetch(tCurrent, p, 0).rgb);
      vec2 d = vec2(base + ivec2(x, y)) - inPos;
      float w = exp(-2.29 * dot(d, d));
      sum += c * w;
      wsum += w;
      m1 += c;
      m2 += c * c;
      lo = min(lo, c);
      hi = max(hi, c);
      // The centre and the corners are enough to find a foreground edge.
      if (x * y != 0 || x == y) closest = min(closest, texelFetch(tDepth, p, 0).r);
    }
  }
  vec3 smoothed = sum / wsum;
  vec3 nearest = toYCoCg(texelFetch(tCurrent, clamp(base, ivec2(0), maxI), 0).rgb);
  // How squarely this frame's nearest sample landed on this output pixel: 1 dead centre, ~0 a pixel away.
  vec2 dOut = (vec2(base) - inPos) * (outputSize / inputSize);
  float hit = exp(-2.0 * dot(dOut, dOut));
  vec3 current = mix(smoothed, nearest, hit);

  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, 0.0));

  // The closest depth around the pixel, so a foreground edge carries its own motion rather than the wall's behind it.
  vec4 world = invViewProj * vec4(vUv * 2.0 - 1.0, closest * 2.0 - 1.0, 1.0);
  world /= world.w;
  vec4 prev = prevViewProj * world;
  vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
  vec2 moved = (vUv - prevUv) * outputSize;

  float alpha = clamp(0.04 + 0.12 * hit + length(moved) * 0.003, 0.04, 0.3);
  bool offscreen = any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)));
  if (historyValid < 0.5 || offscreen) alpha = 1.0;
  // A still pixel keeps history anywhere in its neighbourhood's range: the detail between this frame's coarse samples
  // (small text, thin lines) is only in the history. A moving one is held to a tight variance box against trails.
  float still = 1.0 - clamp(length(moved) * 2.0, 0.0, 1.0);
  float gamma = mix(1.0, 3.0, still);
  vec3 history = clipToBox(max(lo, mean - gamma * sigma), min(hi, mean + gamma * sigma), toYCoCg(sampleHistory(prevUv)));
  gl_FragColor = vec4(fromYCoCg(mix(history, current, alpha)), 1.0);
}`;

/** AMD's contrast-adaptive sharpening on the way to the screen: it sharpens flat areas more than edges, so they don't ring. */
const OUTPUT = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 texel;
uniform float sharpness;
varying vec2 vUv;

void main() {
  vec3 e = texture2D(tColor, vUv).rgb;
  if (sharpness <= 0.0) {
    gl_FragColor = vec4(e, 1.0);
    return;
  }
  vec3 b = texture2D(tColor, vUv + vec2(0.0, texel.y)).rgb;
  vec3 d = texture2D(tColor, vUv - vec2(texel.x, 0.0)).rgb;
  vec3 f = texture2D(tColor, vUv + vec2(texel.x, 0.0)).rgb;
  vec3 h = texture2D(tColor, vUv - vec2(0.0, texel.y)).rgb;
  vec3 lo = min(e, min(min(b, d), min(f, h)));
  vec3 hi = max(e, max(max(b, d), max(f, h)));
  vec3 amp = sqrt(clamp(min(lo, 2.0 - hi) / max(hi, vec3(1e-4)), 0.0, 1.0));
  vec3 w = amp * (-1.0 / mix(8.0, 5.0, sharpness));
  gl_FragColor = vec4(clamp((e + (b + d + f + h) * w) / (1.0 + 4.0 * w), 0.0, 1.0), 1.0);
}`;

const screenMaterial = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });

/**
 * Draws the scene at a share of the screen's resolution and brings it up to the screen: with temporal anti-aliasing
 * (TAA, or TAAU below full resolution), or with a bilinear stretch and sharpening. At full resolution without TAA it
 * stays out of the way and the scene draws straight to the canvas with its MSAA, as it always has.
 */
export class Upscaler {
  private settings: Pick<GraphicsSettings, 'scale' | 'taa' | 'sharpen'> = { scale: 1, taa: false, sharpen: 0.5 };
  private target: THREE.WebGLRenderTarget | null = null;
  private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private read = 0;
  private frame = 0;
  private historyValid = false;
  private readonly output = new THREE.Vector2();
  private readonly viewProj = new THREE.Matrix4();
  private readonly prevViewProj = new THREE.Matrix4();
  private readonly savedProjection = new THREE.Matrix4();
  private readonly savedProjectionInverse = new THREE.Matrix4();
  private readonly resolve = screenMaterial(RESOLVE, {
    tCurrent: { value: null },
    tDepth: { value: null },
    tHistory: { value: null },
    inputSize: { value: new THREE.Vector2() },
    outputSize: { value: new THREE.Vector2() },
    jitter: { value: new THREE.Vector2() },
    invViewProj: { value: new THREE.Matrix4() },
    prevViewProj: { value: new THREE.Matrix4() },
    historyValid: { value: 0 },
  });
  private readonly present = screenMaterial(OUTPUT, { tColor: { value: null }, texel: { value: new THREE.Vector2() }, sharpness: { value: 0 } });
  private readonly resolveQuad = new FullScreenQuad(this.resolve);
  private readonly presentQuad = new FullScreenQuad(this.present);

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  /** Off at full resolution without TAA: the scene draws straight to the canvas. */
  get active(): boolean {
    return this.settings.taa || this.settings.scale < 1;
  }

  configure(g: Pick<GraphicsSettings, 'scale' | 'taa' | 'sharpen'>) {
    const rebuild = g.scale !== this.settings.scale || g.taa !== this.settings.taa;
    this.settings = { scale: g.scale, taa: g.taa, sharpen: g.sharpen };
    if (rebuild) this.disposeTargets();
  }

  /** Forget the history: the next frame starts fresh. For a cut (a teleport, a floor change), not ordinary motion. */
  reset() {
    this.historyValid = false;
  }

  /** What the scene is drawn at and what it is shown at, in device pixels. */
  sizes(): { render: { width: number; height: number }; output: { width: number; height: number } } {
    this.renderer.getDrawingBufferSize(this.output);
    const output = { width: this.output.x, height: this.output.y };
    return { render: this.active ? renderSize(output.width, output.height, this.settings.scale) : output, output };
  }

  /** Draws the frame `drawScene` renders with `camera` to the canvas, through the render target when upscaling or TAA is on. */
  draw(camera: THREE.PerspectiveCamera, drawScene: () => void) {
    if (!this.active) {
      drawScene();
      return;
    }
    const { render, output } = this.sizes();
    const target = this.ensureTargets(render, output);
    const taa = this.settings.taa;

    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const jitter = taa ? jitterAt(this.frame, this.settings.scale) : { x: 0, y: 0 };
    if (taa) {
      this.savedProjection.copy(camera.projectionMatrix);
      this.savedProjectionInverse.copy(camera.projectionMatrixInverse);
      // Shifts the whole image by `jitter` input pixels: content meant for uv lands at uv + jitter / size.
      camera.projectionMatrix.elements[8] -= (2 * jitter.x) / render.width;
      camera.projectionMatrix.elements[9] -= (2 * jitter.y) / render.height;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
    this.renderer.setRenderTarget(target);
    drawScene();
    if (taa) {
      camera.projectionMatrix.copy(this.savedProjection);
      camera.projectionMatrixInverse.copy(this.savedProjectionInverse);
    }

    let shown = target.texture;
    if (taa && this.history) {
      const write = this.history[1 - this.read];
      const u = this.resolve.uniforms;
      u.tCurrent.value = target.texture;
      u.tDepth.value = target.depthTexture;
      u.tHistory.value = this.history[this.read].texture;
      u.inputSize.value.set(render.width, render.height);
      u.outputSize.value.set(output.width, output.height);
      u.jitter.value.set(jitter.x, jitter.y);
      u.invViewProj.value.copy(this.viewProj).invert();
      u.prevViewProj.value.copy(this.prevViewProj);
      u.historyValid.value = this.historyValid ? 1 : 0;
      this.renderer.setRenderTarget(write);
      this.resolveQuad.render(this.renderer);
      shown = write.texture;
      this.read = 1 - this.read;
      this.prevViewProj.copy(this.viewProj);
      this.historyValid = true;
      this.frame++;
    }

    const p = this.present.uniforms;
    p.tColor.value = shown;
    p.texel.value.set(1 / output.width, 1 / output.height);
    p.sharpness.value = this.settings.sharpen;
    this.renderer.setRenderTarget(null);
    this.presentQuad.render(this.renderer);
  }

  dispose() {
    this.disposeTargets();
    this.resolve.dispose();
    this.present.dispose();
    this.resolveQuad.dispose();
    this.presentQuad.dispose();
  }

  private ensureTargets(render: { width: number; height: number }, output: { width: number; height: number }): THREE.WebGLRenderTarget {
    const stale = this.target && (this.target.width !== render.width || this.target.height !== render.height);
    const historyStale = this.history && (this.history[0].width !== output.width || this.history[0].height !== output.height);
    if (stale || historyStale) this.disposeTargets();
    if (!this.target) {
      const taa = this.settings.taa;
      const target = new THREE.WebGLRenderTarget(render.width, render.height, {
        // Eight bits are enough for what the canvas itself would hold: the colour arrives here already sRGB-encoded.
        // RGBA8 named outright, or three.js would pick SRGB8_ALPHA8 for an sRGB texture and encode it a second time.
        type: THREE.UnsignedByteType,
        internalFormat: 'RGBA8',
        colorSpace: THREE.SRGBColorSpace,
        // TAA reads single samples and depth; the plain stretch keeps the canvas's 4× MSAA instead.
        samples: taa ? 0 : 4,
        // three.js's depthTexture setter throws on undefined, so the key is only there with TAA.
        ...(taa ? { depthTexture: new THREE.DepthTexture(render.width, render.height, THREE.FloatType) } : {}),
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      // three.js writes linear light to a render target and sRGB only to the canvas (and to XR targets). Marked as
      // one, this target gets the canvas's sRGB-encoded output, so transparent glass, smoke and glows blend exactly
      // as they do drawn straight to the canvas.
      (target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
      this.target = target;
    }
    if (this.settings.taa && !this.history) {
      const make = () => new THREE.WebGLRenderTarget(output.width, output.height, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.history = [make(), make()];
      this.historyValid = false;
    }
    return this.target;
  }

  private disposeTargets() {
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.target = null;
    for (const h of this.history ?? []) h.dispose();
    this.history = null;
    this.historyValid = false;
  }
}
