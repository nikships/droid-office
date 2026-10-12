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

test('laptop standby and terminal backgrounds are true black without changing the window theme', () => {
  for (const state of [undefined, { cols: 80, rows: 24, lines: [], cursor: [0, 0], version: 1 } as ScreenState]) {
    const { ctx, fills } = painter();
    paintScreen(ctx, 1024, 680, state);
    assert.deepEqual(fills[0], { color: SCREEN_BLACK, args: [0, 0, 1024, 680] });
  }
  assert.equal(TERM_THEME.background, '#0a0a0a');
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
