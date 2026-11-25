import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPANION_THEMES, THEME_SHADERS, type ThemeStageSpec } from '../src/shared/companion-themes.js';
import { THEME_FRAGMENT_SHADERS, THEME_VERTEX_SHADER } from '../src/client/ui/theme-shaders.js';
import { STILL_TIMES, colorCount, colorUniforms, createThemeStage, fragmentSource, stageSize } from '../src/client/ui/theme-stage.js';

const close = (actual: ArrayLike<number>, expected: number[]) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `index ${i}: ${actual[i]} != ${expected[i]}`);
};

test('colorUniforms turns #rrggbb into four 0–1 triples, repeating the last color', () => {
  close(colorUniforms(['#ff0000', '#00ff80']), [1, 0, 0, 0, 1, 128 / 255, 0, 1, 128 / 255, 0, 1, 128 / 255]);
  close(
    colorUniforms(['#102030', '#405060', '#708090', '#a0b0c0', '#ffffff']),
    [16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192].map((n) => n / 255),
  );
  close(colorUniforms([]), new Array(12).fill(0));
  assert.equal(colorCount([]), 1);
  assert.equal(colorCount(['#000000', '#111111', '#222222']), 3);
  assert.equal(colorCount(['#000000', '#111111', '#222222', '#333333', '#444444']), 4);
});

test('stageSize covers every device pixel', () => {
  assert.deepEqual(stageSize(1440, 900, 2), { width: 2880, height: 1800 });
  assert.deepEqual(stageSize(1279.5, 719.25, 1.5), { width: 1919, height: 1079 });
  assert.deepEqual(stageSize(2560, 1440, 2), { width: 5120, height: 2880 });
  assert.deepEqual(stageSize(0, 0, 2), { width: 1, height: 1 });
  assert.deepEqual(stageSize(800, 600, Number.NaN), { width: 800, height: 600 });
});

test('every shader has a GLSL ES 3.00 source with the stage contract', () => {
  assert.deepEqual(Object.keys(THEME_FRAGMENT_SHADERS).sort(), [...THEME_SHADERS].sort());
  assert.match(THEME_VERTEX_SHADER, /^#version 300 es\n/);
  for (const name of THEME_SHADERS) {
    for (const layer of ['scene', 'overlay'] as const) {
      const src = fragmentSource(name, layer);
      assert.match(src, /^#version 300 es\n/, name);
      assert.equal(src.includes('#define OVERLAY 1'), layer === 'overlay', `${name} ${layer}`);
      for (const decl of ['precision highp float;', 'uniform vec2 uRes;', 'uniform float uTime;', 'uniform vec3 uColors[4];', 'uniform int uColorCount;', 'out vec4 outColor;', 'void main()']) {
        assert.ok(src.includes(decl), `${name} lacks ${decl}`);
      }
    }
    assert.ok(Number.isFinite(STILL_TIMES[name]) && STILL_TIMES[name] > 0, name);
  }
});

test('every theme stage names a shader with a source and colors the uniforms accept', () => {
  for (const theme of COMPANION_THEMES) {
    const stage = (theme.backdrop as { stage?: ThemeStageSpec }).stage;
    if (!stage) continue;
    assert.ok(THEME_FRAGMENT_SHADERS[stage.shader], theme.id);
    assert.ok(stage.colors.length >= 1 && stage.colors.length <= 4, theme.id);
    assert.equal(colorUniforms(stage.colors).length, 12);
  }
});

// ---- The stage against a recording WebGL2 stand-in --------------------------------------------------

interface Rig {
  canvas: HTMLCanvasElement & EventTarget;
  draws: { program: string; time: number; colors: number[]; count: number }[];
  clears: number;
  deleted: string[];
  lost: boolean;
  compiled: string[];
  frames: Map<number, (now: number) => void>;
  resize(width: number, height: number): void;
  tick(now: number): void;
  setHidden(hidden: boolean): void;
}

function rig(t: { after(fn: () => void): void }, { webgl = true } = {}): Rig {
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    raf: Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'),
    caf: Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'),
    ro: Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'),
  };
  t.after(() => {
    for (const [key, desc] of Object.entries({ document: saved.document, window: saved.window, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf, ResizeObserver: saved.ro })) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const frames = new Map<number, (now: number) => void>();
  let nextFrame = 1;
  let observer: ((entries: unknown[]) => void) | undefined;
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('document', doc);
  define('window', { devicePixelRatio: 2 });
  define('requestAnimationFrame', (fn: (now: number) => void) => {
    frames.set(nextFrame, fn);
    return nextFrame++;
  });
  define('cancelAnimationFrame', (id: number) => frames.delete(id));
  define(
    'ResizeObserver',
    class {
      constructor(fn: (entries: unknown[]) => void) {
        observer = fn;
      }
      observe() {}
      disconnect() {
        observer = undefined;
      }
    },
  );

  const r = { draws: [], clears: 0, deleted: [], lost: false, compiled: [], frames } as unknown as Rig;
  const canvas = Object.assign(new EventTarget(), { width: 300, height: 150 }) as unknown as HTMLCanvasElement & EventTarget;
  let current = '';
  let time = 0;
  let colors: number[] = [];
  let count = 0;
  let programs = 0;
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    COLOR_BUFFER_BIT: 5,
    TRIANGLES: 6,
    get drawingBufferWidth() {
      return canvas.width;
    },
    get drawingBufferHeight() {
      return canvas.height;
    },
    createShader: (type: number) => ({ type, src: '' }),
    shaderSource: (sh: { src: string }, src: string) => {
      sh.src = src;
    },
    compileShader: (sh: { type: number; src: string }) => {
      if (sh.type === 2) r.compiled.push(sh.src);
    },
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({ name: `p${++programs}` }),
    attachShader: () => {},
    detachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: (p: { name: string }) => r.deleted.push(p.name),
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    useProgram: (p: { name: string }) => {
      current = p.name;
    },
    uniform2f: () => {},
    uniform1f: (_l: unknown, v: number) => {
      time = v;
    },
    uniform3fv: (_l: unknown, v: Float32Array) => {
      colors = [...v];
    },
    uniform1i: (_l: unknown, v: number) => {
      count = v;
    },
    createVertexArray: () => ({}),
    bindVertexArray: () => {},
    deleteVertexArray: () => r.deleted.push('vao'),
    drawArrays: () => r.draws.push({ program: current, time, colors, count }),
    viewport: () => {},
    clearColor: () => {},
    clear: () => {
      r.clears++;
    },
    isContextLost: () => r.lost,
    getExtension: () => ({ loseContext: () => r.deleted.push('context') }),
  };
  (canvas as unknown as { getContext: () => unknown }).getContext = () => (webgl ? gl : null);
  r.canvas = canvas;
  r.resize = (width, height) => observer?.([{ devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }] }]);
  r.tick = (now) => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, fn] of pending) fn(now);
  };
  r.setHidden = (hidden) => {
    doc.hidden = hidden;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  return r;
}

const AURORA: ThemeStageSpec = { shader: 'aurora', layer: 'scene', colors: ['#47f0b0', '#2fb8ff'], speed: 0.5, opacity: 1, blend: 'normal' };
const EMBERS: ThemeStageSpec = { shader: 'embers', layer: 'overlay', colors: ['#ff7a2b'], speed: 2, opacity: 0.7, blend: 'screen' };

test('createThemeStage is null without WebGL2', (t) => {
  const r = rig(t, { webgl: false });
  assert.equal(createThemeStage(r.canvas), null);
});

test('a moving stage advances by real time times speed and keeps its clock across repeated shows', (t) => {
  const r = rig(t);
  const stage = createThemeStage(r.canvas);
  assert.ok(stage);
  r.resize(2880, 1800);
  assert.deepEqual([r.canvas.width, r.canvas.height], [2880, 1800]);
  stage.show(AURORA, true);
  assert.equal(r.frames.size, 1);
  r.tick(1000);
  r.tick(1080);
  const at = r.draws.at(-1)!;
  assert.ok(Math.abs(at.time - (STILL_TIMES.aurora + 0.04)) < 1e-9, String(at.time));
  assert.equal(at.count, 2);
  close(at.colors, [...colorUniforms(AURORA.colors)]);
  stage.show({ ...AURORA }, true);
  stage.show({ ...AURORA }, true);
  assert.equal(r.frames.size, 1, 'repeated shows keep one loop');
  r.tick(1100);
  assert.ok(Math.abs(r.draws.at(-1)!.time - (STILL_TIMES.aurora + 0.05)) < 1e-9, 'the clock did not restart');
  r.tick(4100);
  assert.ok(Math.abs(r.draws.at(-1)!.time - (STILL_TIMES.aurora + 0.1)) < 1e-9, 'a stalled frame advances at most 0.1 s');
  assert.equal(r.compiled.length, 1);
  stage.destroy();
});

test('a hidden page pauses the stage and resumes without a time jump', (t) => {
  const r = rig(t);
  const stage = createThemeStage(r.canvas)!;
  r.resize(100, 100);
  stage.show(EMBERS, true);
  r.tick(0);
  r.tick(50);
  const before = r.draws.at(-1)!.time;
  r.setHidden(true);
  assert.equal(r.frames.size, 0);
  r.setHidden(false);
  r.tick(60_000);
  r.tick(60_016);
  const after = r.draws.at(-1)!.time;
  assert.ok(Math.abs(after - before - 0.016 * EMBERS.speed) < 1e-9, `${before} -> ${after}`);
  stage.destroy();
});

test('a still stage draws one frame at its composed moment and stops', (t) => {
  const r = rig(t);
  const stage = createThemeStage(r.canvas)!;
  r.resize(100, 100);
  stage.show(AURORA, true);
  r.tick(0);
  r.tick(5000);
  const drawn = r.draws.length;
  stage.show(AURORA, false);
  assert.equal(r.frames.size, 0);
  assert.equal(r.draws.length, drawn + 1);
  assert.equal(r.draws.at(-1)!.time, STILL_TIMES.aurora);
  r.resize(200, 100);
  assert.equal(r.draws.length, drawn + 2, 'a resized still stage redraws');
  stage.destroy();
});

test('switching shaders swaps cached programs, and null clears to transparent', (t) => {
  const r = rig(t);
  const stage = createThemeStage(r.canvas)!;
  r.resize(100, 100);
  stage.show(AURORA, false);
  stage.show(EMBERS, false);
  stage.show(AURORA, false);
  assert.deepEqual(
    r.draws.map((d) => d.program),
    ['p1', 'p2', 'p1'],
  );
  assert.equal(r.compiled.length, 2);
  assert.ok(r.compiled[1].includes('#define OVERLAY 1'));
  assert.equal(r.draws.at(-1)!.time, STILL_TIMES.aurora);
  const clears = r.clears;
  stage.show(null, false);
  assert.equal(r.clears, clears + 1);
  stage.destroy();
  assert.deepEqual(r.deleted.sort(), ['context', 'p1', 'p2', 'vao']);
});

test('a lost context stops drawing until it is restored, then rebuilds', (t) => {
  const r = rig(t);
  const stage = createThemeStage(r.canvas)!;
  r.resize(100, 100);
  stage.show(AURORA, true);
  r.tick(0);
  const lost = new Event('webglcontextlost', { cancelable: true });
  r.lost = true;
  r.canvas.dispatchEvent(lost);
  assert.equal(lost.defaultPrevented, true);
  assert.equal(r.frames.size, 0);
  r.lost = false;
  r.canvas.dispatchEvent(new Event('webglcontextrestored'));
  r.tick(100);
  assert.equal(r.compiled.length, 2, 'the program was rebuilt');
  stage.destroy();
});
