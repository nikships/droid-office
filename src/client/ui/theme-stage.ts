// The moving layer of a companion theme's backdrop: one full-window WebGL2 canvas running the
// theme's shader (aurora, nebula, embers…). A `scene` paints the whole backdrop; an `overlay` paints
// light on transparency over the artwork. Drawn at the display's full pixel ratio and frame rate;
// it stops only while the page is hidden, or when motion is off (then it holds one still frame).

import { parseHex, type ThemeShader, type ThemeStageSpec } from '../../shared/companion-themes';
import { THEME_FRAGMENT_SHADERS, THEME_VERTEX_SHADER } from './theme-shaders';

export interface ThemeStage {
  /** Shows `spec` (null clears to transparent), animating while `animate` and the page is visible; a still stage draws one frame. */
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
  aurora: 14,
  nebula: 20,
  silk: 9,
  grid: 6,
  synthwave: 4,
  starfield: 11,
  fireflies: 18,
  embers: 16,
  caustics: 7,
  petals: 13,
  rain: 5,
};

/** The fragment source `shader` compiles from on `layer` (overlays get `#define OVERLAY`, so a shader can serve both). */
export function fragmentSource(shader: ThemeShader, layer: ThemeStageSpec['layer']): string {
  const src = THEME_FRAGMENT_SHADERS[shader];
  if (layer !== 'overlay') return src;
  const end = src.indexOf('\n');
  return `${src.slice(0, end + 1)}#define OVERLAY 1\n${src.slice(end + 1)}`;
}

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
  /** Linked programs by shader and layer; null marks one that failed to build, so it isn't retried every frame. */
  const programs = new Map<string, Program | null>();
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

  function programFor(s: ThemeStageSpec): Program | null {
    const key = `${s.shader}|${s.layer}`;
    if (programs.has(key)) return programs.get(key) ?? null;
    let built: Program | null = null;
    const frag = vertex && compile(gl.FRAGMENT_SHADER, fragmentSource(s.shader, s.layer), `${s.shader} (${s.layer})`);
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
        if (!gl.isContextLost()) console.error(`theme-stage: ${s.shader} (${s.layer}) failed to link\n${gl.getProgramInfoLog(program) ?? ''}`);
        gl.deleteProgram(program);
      }
    }
    if (frag) gl.deleteShader(frag);
    programs.set(key, built);
    return built;
  }

  function clear() {
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function draw() {
    if (lost || destroyed) return;
    if (!spec) {
      clear();
      return;
    }
    const p = programFor(spec);
    if (!p) {
      clear();
      return;
    }
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    gl.useProgram(p.program);
    gl.uniform2f(p.uRes, w, h);
    gl.uniform1f(p.uTime, time);
    gl.uniform3fv(p.uColors, colors);
    gl.uniform1i(p.uColorCount, count);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const running = () => animate && !!spec && !lost && !destroyed && !document.hidden;

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
    // A resized canvas comes back blank; a still one needs its frame again, a moving one gets it next frame.
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

  const onVisibility = () => {
    if (document.hidden) stop();
    else sync();
  };
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    stop();
    programs.clear();
    vao = null;
    vertex = null;
  };
  const onRestored = () => {
    lost = false;
    setup();
    sync();
  };
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  setup();

  return {
    show(next, nextAnimate) {
      if (destroyed) return;
      const key = next ? `${next.shader}|${next.layer}|${next.colors.join(',')}|${next.speed}` : '';
      if (key === specKey && nextAnimate === animate) {
        if (!running() && !raf) draw();
        return;
      }
      if (!next || !spec || next.shader !== spec.shader) time = next ? STILL_TIMES[next.shader] : 0;
      if (next && key !== specKey) {
        colors = colorUniforms(next.colors);
        count = colorCount(next.colors);
      }
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
      document.removeEventListener('visibilitychange', onVisibility);
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
