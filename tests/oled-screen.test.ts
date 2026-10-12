import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FLAG_INVERSE, RGB_FLAG } from '../src/shared/protocol.js';
import { paintScreen, TERM_THEME, type ScreenState } from '../src/client/world/laptop.js';
import { SCREEN_BLACK, screenMaterial } from '../src/client/world/screen.js';
import { paintScreen as paintBlocks } from '../src/client/ui/blocks.js';
import { Minesweeper } from '../src/client/ui/minesweeper.js';

test('OLED displays are opaque, unlit, unfogged and black before content arrives', () => {
  const mat = screenMaterial();
  assert.ok(mat.isMeshBasicMaterial);
  assert.equal(mat.color.getHex(), 0);
  assert.equal(mat.fog, false);
  assert.equal(mat.toneMapped, false);
  assert.equal(mat.transparent, false);
  assert.equal(mat.opacity, 1);
  mat.dispose();
});

test('screen textures and brightness survive the OLED material treatment', () => {
  const map = new THREE.Texture();
  const mat = screenMaterial({ map, color: new THREE.Color().setScalar(0.62), fog: true, toneMapped: true });
  assert.equal(mat.map, map);
  assert.equal(mat.color.r, 0.62);
  assert.equal(mat.fog, false);
  assert.equal(mat.toneMapped, false);
  const white = screenMaterial({ map });
  assert.equal(white.color.getHex(), 0xffffff, 'content is not multiplied by the off-screen black');
  mat.dispose();
  white.dispose();
  map.dispose();
});

test('OLED cover glass is glossy without a room environment map or a full-screen reflection', (t) => {
  const environment = new THREE.CubeTexture();
  const mat = screenMaterial({ envMap: environment });
  const inherited = THREE.Material.prototype.onBeforeCompile;
  let inheritedCalls = 0;
  THREE.Material.prototype.onBeforeCompile = (shader) => {
    inheritedCalls++;
    shader.uniforms.officeGlow = { value: 1 };
  };
  t.after(() => {
    THREE.Material.prototype.onBeforeCompile = inherited;
    mat.dispose();
    environment.dispose();
  });
  const shader = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  assert.equal(mat.envMap, null, 'no room reflections can wash out the OLED black');
  assert.equal(inheritedCalls, 1, 'the office glow and GI-bake hooks are retained');
  assert.equal(shader.uniforms.officeGlow.value, 1);
  assert.match(shader.vertexShader, /vScreenView = vec3/);
  assert.match(shader.fragmentShader, /screenSheenAt.*screenView\.x.*screenView\.y/);
  assert.match(shader.fragmentShader, /screenSheen = 1\.0 - smoothstep/);
  assert.match(shader.fragmentShader, /screenEdge = 1\.0 - smoothstep/);
  assert.match(shader.fragmentShader, /outgoingLight \+=.*screenSheen.*screenEdge/);
});

function painter() {
  const fills: { color: unknown; args: number[] }[] = [];
  const text: { color: unknown; label: string }[] = [];
  const ctx = new Proxy(
    {
      fillStyle: '',
      fillRect(...args: number[]) {
        fills.push({ color: this.fillStyle, args });
      },
      fillText(label: string) {
        text.push({ color: this.fillStyle, label });
      },
      measureText: () => ({ width: 10 }),
    },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, fills, text };
}

test('laptop standby, terminal backgrounds and the opened terminal theme are true black', () => {
  for (const state of [undefined, { cols: 80, rows: 24, lines: [], cursor: [0, 0], version: 1 } as ScreenState]) {
    const { ctx, fills } = painter();
    paintScreen(ctx, 1024, 680, state);
    assert.deepEqual(fills[0], { color: SCREEN_BLACK, args: [0, 0, 1024, 680] });
  }
  assert.equal(TERM_THEME.background, SCREEN_BLACK);
});

test('OLED terminals preserve explicit ANSI backgrounds and use black for inverse default text', () => {
  const { ctx, fills, text } = painter();
  paintScreen(ctx, 1024, 680, {
    cols: 80,
    rows: 24,
    lines: [
      [
        ['styled', -1, RGB_FLAG | 0x123456, 0],
        ['inverse', -1, -1, FLAG_INVERSE],
      ],
    ],
    cursor: [0, 0],
    version: 1,
  });
  assert.equal(fills[0].color, SCREEN_BLACK);
  assert.equal(fills[1].color, 'rgb(18,52,86)');
  assert.equal(fills[2].color, TERM_THEME.foreground);
  assert.deepEqual(text, [
    { color: TERM_THEME.foreground, label: 'styled' },
    { color: SCREEN_BLACK, label: 'inverse' },
  ]);
});

test('both arcade games paint OLED-black backgrounds, without CRT scan lines', () => {
  const blocks = painter();
  paintBlocks(blocks.ctx, { frame: null, scores: [], t: 0 });
  assert.equal(blocks.fills[0].color, SCREEN_BLACK);
  assert.ok(!blocks.fills.some((f) => f.args[2] === 800 && f.args[3] === 1.5), 'no full-width CRT scan lines');
  const mines = painter();
  new Minesweeper().paint(mines.ctx, true);
  assert.equal(mines.fills[0].color, SCREEN_BLACK);
});
