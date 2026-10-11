import test from 'node:test';
import assert from 'node:assert/strict';
import { paintScreen } from '../src/client/ui/blocks.js';
import { SCORES_KEPT, WELL_COLS, WELL_ROWS, type CabinetFrame, type HighScore } from '../src/shared/cabinet.js';

type Text = { text: string; left: number; right: number; top: number; bottom: number; color: string | CanvasGradient | CanvasPattern };

function canvasSpy() {
  const texts: Text[] = [];
  const noop = () => {};
  const ctx = {
    font: '',
    textAlign: 'left',
    fillStyle: '',
    createLinearGradient: () => ({ addColorStop: noop }),
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    roundRect: noop,
    fill: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    measureText(text: string) {
      return { width: [...text].length * Number.parseFloat(ctx.font.split(' ')[1]) * 0.6 };
    },
    fillText(text: string, x: number, y: number) {
      const size = Number.parseFloat(ctx.font.split(' ')[1]);
      const width = ctx.measureText(text).width;
      const left = ctx.textAlign === 'right' ? x - width : ctx.textAlign === 'center' ? x - width / 2 : x;
      texts.push({ text, left, right: left + width, top: y - size / 2, bottom: y + size / 2, color: ctx.fillStyle });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

const dates = ['Oct 9', 'Dec 31', 'Jan 1'];
const timestamps = [new Date(2025, 9, 9, 12).getTime(), new Date(2025, 11, 31, 12).getTime(), new Date(2026, 0, 1, 12).getTime()];
const scores: HighScore[] = Array.from({ length: SCORES_KEPT }, (_, i) => ({
  game: `game${i}`,
  name: 'A very long player name',
  color: '#ef476f',
  score: 99_999_999 - i,
  lines: 1,
  level: 1,
  at: timestamps[i % timestamps.length],
}));
const frame: CabinetFrame = { cells: '0'.repeat(WELL_COLS * WELL_ROWS), next: 1, hold: 0, score: 0, lines: 0, level: 1, pieces: 0, state: 'play' };

for (const state of [null, 'play', 'paused', 'over'] as const) {
  test(`the ${state ?? 'idle'} high-score table shows saved dates without overlapping names or scores`, () => {
    const { ctx, texts } = canvasSpy();
    paintScreen(ctx, { frame: state ? { ...frame, state } : null, scores, mine: scores[0].game, t: 0 });
    const dateTexts = texts.filter((t) => dates.includes(t.text));
    const names = texts.filter((t) => t.color === scores[0].color && t.text.length > 1);
    assert.deepEqual(
      dateTexts.map((t) => t.text),
      scores.map((_, i) => dates[i % dates.length]),
    );
    assert.equal(names.length, SCORES_KEPT);
    const compact = state !== null;
    for (let i = 0; i < SCORES_KEPT; i++) {
      const date = dateTexts[i];
      const name = names[i];
      const score = texts.find((t) => t.text === scores[i].score.toLocaleString('en-US'))!;
      assert.ok(score, 'the full score is still visible');
      assert.ok(name.text.endsWith('…'), 'long names still fit their column');
      assert.ok(name.right < score.left, 'the name does not overlap the score');
      if (compact) {
        assert.equal(date.left, name.left);
        assert.ok(date.top > name.bottom, 'the date is below the name');
        if (i + 1 < SCORES_KEPT) assert.ok(date.bottom < names[i + 1].top, 'the date stays within its row');
      } else {
        assert.equal(date.top + date.bottom, name.top + name.bottom, 'the date is on the same row');
        assert.ok(name.right < date.left, 'the name does not overlap the date');
        assert.ok(date.right < score.left, 'the date does not overlap the score');
      }
    }
  });
}

test('an empty high-score table has no dates and still invites the first player', () => {
  for (const f of [null, frame]) {
    const { ctx, texts } = canvasSpy();
    paintScreen(ctx, { frame: f, scores: [], t: 0 });
    assert.ok(texts.some((t) => /Be the first!/.test(t.text)));
    assert.ok(!texts.some((t) => dates.includes(t.text)));
  }
});
