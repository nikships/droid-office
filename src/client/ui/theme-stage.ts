// The moving layer of a companion theme's backdrop: one full-window WebGL2 canvas running the
// theme's ambient light shader over the artwork. Drawn at the display's full pixel ratio and frame rate;
// Live holds the last frame while the page is hidden or unfocused. Still holds a composed frame.

import { parseHex, type ThemeShader, type ThemeStageSpec } from '../../shared/companion-themes';
import { THEME_FRAGMENT_SHADERS, THEME_VERTEX_SHADER } from './theme-shaders';

export interface ThemeStage {
  /** Shows `spec` (null clears to transparent), animating while `animate` and the page is visible and focused. */
  show(spec: ThemeStageSpec | null, animate: boolean): void;
  /** Stops drawing and releases the GL context. */
  destroy(): void;
}

/** `uColors` for `colors`: four RGB triples in 0–1, the last color repeated to fill four. */
export function colorUniforms(colors: readonly string[]): Float32Array {
  const list = colors.length ? colors.slice(0, 4) : ['#000000'];
  const out = new Float32Array(12);
  for (let i = 0; i < 4; i++) {
    const { r, g, b } = parseHex(list[Math.min(i, list.length - 1)]);
    out[i * 3] = r / 255;
    out[i * 3 + 1] = g / 255;
    out[i * 3 + 2] = b / 255;
  }
  return out;
}

/** `uColorCount` for `colors`, 1–4. */
export const colorCount = (colors: readonly string[]): number => Math.min(4, Math.max(1, colors.length));

/** The drawing buffer for a canvas of `cssW` × `cssH` CSS pixels at `dpr`: every device pixel, never fewer. */
export function stageSize(cssW: number, cssH: number, dpr: number): { width: number; height: number } {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { width: Math.max(1, Math.round(cssW * ratio)), height: Math.max(1, Math.round(cssH * ratio)) };
}

/**
 * The drawing buffer from a ResizeObserver entry's sizes: the device-pixel box where the browser
 * reports one that matches the pixel ratio (it is exact where CSS × ratio rounds), else CSS × ratio.
 * Chromium's device-scale emulation reports CSS pixels as the device box.
 */
export function observedSize(device: { inlineSize: number; blockSize: number } | undefined, cssW: number, cssH: number, dpr: number): { width: number; height: number } {
  const scaled = stageSize(cssW, cssH, dpr);
  if (device && Math.abs(device.inlineSize - scaled.width) <= 1 && Math.abs(device.blockSize - scaled.height) <= 1) return { width: Math.max(1, device.inlineSize), height: Math.max(1, device.blockSize) };
  return scaled;
}

/** The moment (shader seconds) a still stage holds, and where a moving one starts: each shader's best-composed frame. */
export const STILL_TIMES: Record<ThemeShader, number> = {
  nebula: 20,
  starfield: 11,
  fireflies: 18,
  embers: 16,
  caustics: 7,
  petals: 13,
  rain: 5,
};

/** The longest gap one frame advances the clock by, so a stalled tab never jumps the picture. */
const MAX_STEP = 0.1;

interface Program {
  program: WebGLProgram;
  uRes: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uColors: WebGLUniformLocation | null;
  uColorCount: WebGLUniformLocation | null;
}

/** A stage on `canvas`, or null where WebGL2 isn't available (the gradient and artwork still show). */
export function createThemeStage(canvas: HTMLCanvasElement): ThemeStage | null {
  const attrs: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  };
  const maybeGl = canvas.getContext('webgl2', attrs);
  if (!maybeGl) return null;
  const gl: WebGL2RenderingContext = maybeGl;

  let vao: WebGLVertexArrayObject | null = null;
  let vertex: WebGLShader | null = null;
  /** Linked programs by shader; null marks one that failed to build, so it isn't retried every frame. */
  const programs = new Map<ThemeShader, Program | null>();
  // Only time changes every frame. Rebind and upload the other state after a spec or buffer change.
  let bound: Program | null = null;
  let spec: ThemeStageSpec | null = null;
  let specKey = '';
  let colors: Float32Array = new Float32Array(12);
  let count = 1;
  let animate = false;
  let time = 0;
  let last: number | null = null;
  let raf = 0;
  let lost = false;
  let destroyed = false;

  function compile(type: number, source: string, label: string): WebGLShader | null {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      console.error(`theme-stage: ${label} failed to compile\n${gl.getShaderInfoLog(sh) ?? ''}`);
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function setup() {
    vao = gl.createVertexArray();
    vertex = compile(gl.VERTEX_SHADER, THEME_VERTEX_SHADER, 'vertex shader');
  }

  function programFor(shader: ThemeShader): Program | null {
    if (programs.has(shader)) return programs.get(shader) ?? null;
    let built: Program | null = null;
    const frag = vertex && compile(gl.FRAGMENT_SHADER, THEME_FRAGMENT_SHADERS[shader], shader);
    const program = frag && gl.createProgram();
    if (vertex && frag && program) {
      gl.attachShader(program, vertex);
      gl.attachShader(program, frag);
      gl.linkProgram(program);
      gl.detachShader(program, vertex);
      gl.detachShader(program, frag);
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        built = {
          program,
          uRes: gl.getUniformLocation(program, 'uRes'),
          uTime: gl.getUniformLocation(program, 'uTime'),
          uColors: gl.getUniformLocation(program, 'uColors'),
          uColorCount: gl.getUniformLocation(program, 'uColorCount'),
        };
      } else {
        if (!gl.isContextLost()) console.error(`theme-stage: ${shader} failed to link\n${gl.getProgramInfoLog(program) ?? ''}`);
        gl.deleteProgram(program);
      }
    }
    if (frag) gl.deleteShader(frag);
    programs.set(shader, built);
    return built;
  }

  function clear() {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function draw() {
    if (lost || destroyed) return;
    const p = bound ?? (spec && programFor(spec.shader));
    if (!p) {
      clear();
      return;
    }
    if (!bound) {
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      gl.viewport(0, 0, w, h);
      gl.useProgram(p.program);
      gl.uniform2f(p.uRes, w, h);
      gl.uniform3fv(p.uColors, colors);
      gl.uniform1i(p.uColorCount, count);
      gl.bindVertexArray(vao);
      bound = p;
    }
    gl.uniform1f(p.uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const running = () => animate && !!spec && !lost && !destroyed && !document.hidden && document.hasFocus();

  function frame(now: number) {
    raf = 0;
    if (!running() || !spec) return;
    if (last !== null) time += Math.min(MAX_STEP, Math.max(0, (now - last) / 1000)) * spec.speed;
    last = now;
    draw();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = null;
  }

  /** Starts the loop when it should run, or draws the one frame a still stage holds. */
  function sync() {
    if (running()) {
      if (!raf) raf = requestAnimationFrame(frame);
      return;
    }
    stop();
    draw();
  }

  function resize(width: number, height: number) {
    if (!width || !height) return;
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    bound = null;
    // A resized canvas comes back blank; repaint the held frame if the loop isn't scheduled.
    if (!raf) draw();
  }

  const observer = new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    const box = e.contentBoxSize?.[0];
    const cssW = box ? box.inlineSize : e.contentRect.width;
    const cssH = box ? box.blockSize : e.contentRect.height;
    // A hidden canvas measures 0 × 0; keep the buffer it had.
    if (!cssW || !cssH) return;
    const size = observedSize(e.devicePixelContentBoxSize?.[0], cssW, cssH, window.devicePixelRatio);
    resize(size.width, size.height);
  });
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas);
  }

  const onActivity = () => {
    if (!running()) stop();
    else if (!raf) raf = requestAnimationFrame(frame);
  };
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    stop();
    programs.clear();
    bound = null;
    vao = null;
    vertex = null;
  };
  const onRestored = () => {
    lost = false;
    setup();
    sync();
  };
  document.addEventListener('visibilitychange', onActivity);
  window.addEventListener('focus', onActivity);
  window.addEventListener('blur', onActivity);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  setup();

  return {
    show(next, nextAnimate) {
      if (destroyed) return;
      const key = next ? `${next.shader}|${next.colors.join(',')}|${next.speed}` : '';
      if (key === specKey && nextAnimate === animate) {
        if (!running() && !raf) draw();
        return;
      }
      if (!next || !spec || next.shader !== spec.shader) time = next ? STILL_TIMES[next.shader] : 0;
      if (next && key !== specKey) {
        colors = colorUniforms(next.colors);
        count = colorCount(next.colors);
      }
      if (key !== specKey) bound = null;
      // A still stage holds its composed moment rather than wherever the clock last stopped.
      if (next && !nextAnimate) time = STILL_TIMES[next.shader];
      spec = next;
      specKey = key;
      animate = nextAnimate;
      sync();
    },
    destroy() {
      if (destroyed) return;
      stop();
      destroyed = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', onActivity);
      window.removeEventListener('focus', onActivity);
      window.removeEventListener('blur', onActivity);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (!gl.isContextLost()) {
        for (const p of programs.values()) if (p) gl.deleteProgram(p.program);
        if (vertex) gl.deleteShader(vertex);
        if (vao) gl.deleteVertexArray(vao);
      }
      programs.clear();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
