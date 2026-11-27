import assert from 'node:assert/strict';
import type { Locator } from 'playwright-core';
import { companionTheme } from '../src/shared/companion-themes.js';

const { background, foreground } = companionTheme('neo-tokyo').terminal;
export const glassTheme = { background: `${background}00`, foreground };
// One sample per cell: bytes, fractional x/y, then ink coverage or an explicit color.
const samples: [string, number, number, number | string][] = [
  [' ', 0.5, 0.75, 0],
  ['▀', 0.5, 0.75, 0],
  ['░', 0.5, 0.5, 0.25],
  ['▄', 0.5, 0.25, 0],
  ['▌', 0.75, 0.5, 0],
  ['▐', 0.25, 0.5, 0],
  ['▒', 0.5, 0.5, 0.5],
  ['▓', 0.5, 0.5, 0.75],
  ['▁', 0.5, 0.25, 0],
  ['▔', 0.5, 0.75, 0],
  ['▏', 0.75, 0.5, 0],
  ['▕', 0.25, 0.5, 0],
  ['▖', 0.75, 0.25, 0],
  ['▀', 0.5, 0.25, 1],
  ['\x1b[48;2;180;30;90m▀', 0.5, 0.75, '#b41e5a'],
  ['\x1b[0;7m▀', 0.5, 0.25, background],
  ['▀', 0.5, 0.75, 1],
];
export const blockRow = `${samples.map(([bytes]) => bytes).join('')}\x1b[0m\x1b[2 q░\b`;

/** Sample actual device pixels on one row. A flat pane behind the glass lets the blank
 * cell act as the reference for both unpainted regions and fractional shade coverage. */
export async function checkBlockPixels(root: Locator) {
  const row = root.locator('.term-row').filter({ hasText: '▀░▄▌▐' });
  const block = row.locator('.term-block').first();
  await block.waitFor();
  const rect = (await block.boundingBox())!;
  const data = (await root.page().screenshot({ clip: { x: rect.x - rect.width, y: rect.y, width: rect.width * samples.length, height: rect.height } })).toString('base64');
  const pixels = await root.page().evaluate(
    async ({ data, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return points.map(([x, y], col) => [...ctx.getImageData(Math.floor(((col + x) * img.width) / points.length), Math.floor(img.height * y), 1, 1).data.slice(0, 3)]);
    },
    { data, points: samples.map(([, x, y]) => [x, y]) },
  );
  const rgb = (hex: string) =>
    hex
      .slice(1)
      .match(/../g)!
      .map((v) => parseInt(v, 16));
  const ink = rgb(foreground);
  assert.deepEqual(pixels[0], [52, 96, 136]);
  for (const [i, [bytes, , , coverage]] of samples.entries()) {
    const expected = typeof coverage === 'string' ? rgb(coverage) : pixels[0].map((c, j) => Math.round(c * (1 - coverage) + ink[j] * coverage));
    assert.ok(
      pixels[i].every((c, j) => Math.abs(c - expected[j]) <= 1),
      `column ${i} (${bytes.at(-1)}): ${pixels[i]}, expected ${expected}`,
    );
  }
  await root.locator('textarea').focus();
  const cursor = row.locator('.term-block.term-cursor');
  assert.equal(await cursor.textContent(), '░');
  assert.equal(await cursor.evaluate((el) => getComputedStyle(el).color), `rgb(${rgb(background).join(', ')})`);
}
