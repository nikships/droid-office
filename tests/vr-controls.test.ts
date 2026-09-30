import test from 'node:test';
import assert from 'node:assert/strict';
import { DISMISS, DOES_DROP, DOES_FONT, FOOT_FONT, FOOT_Y, GESTURE_FONT, ROW_PITCH, ROW_TOP, ROWS_MAX } from '../src/client/vr/controls.js';

// Text is drawn middle-aligned, so a line spans its y ± half its font size (the card's height is 1).
const span = (y: number, font: number) => [y - font / 2, y + font / 2] as const;

test('controls card rows never overlap each other, the footnotes or the button', () => {
  const lines: (readonly [number, number])[] = [];
  for (let i = 0; i < ROWS_MAX; i++) {
    const y = ROW_TOP + i * ROW_PITCH;
    lines.push(span(y, GESTURE_FONT), span(y + DOES_DROP, DOES_FONT));
  }
  lines.push(span(FOOT_Y[0], FOOT_FONT), span(FOOT_Y[1], FOOT_FONT));
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i][0] >= lines[i - 1][1], `line ${i} starts at ${lines[i][0].toFixed(3)} above line ${i - 1}'s end ${lines[i - 1][1].toFixed(3)}`);
  assert.ok(lines[lines.length - 1][1] <= DISMISS.y, 'footnotes end above the GOT IT button');
  // The column titles sit at 0.245 with a 0.034 font.
  assert.ok(lines[0][0] >= 0.245 + 0.034 / 2);
});
