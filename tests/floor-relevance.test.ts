import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { type FloorSignals, fitTabs, floorRelevance, rankFloors } from '../src/shared/floor-relevance.js';

const HOUR = 3_600_000;
const NOW = 1_763_000_000_000;
const quiet: FloorSignals = { needsInput: 0, unackedDone: 0, busy: 0, totalWorkers: 0 };

interface Golden {
  now: number;
  floors: ({ id: string } & FloorSignals)[];
  scores: { id: string; score: number }[];
  ranked: string[];
  fit: { name: string; widths: { id: string; width: number }[]; ranked: string[]; current: string | null; available: number; more: number; expected: { shown: string[]; hidden: string[] } }[];
}
const golden = JSON.parse(readFileSync(new URL('../android/app/src/test/resources/floor-relevance-golden.json', import.meta.url), 'utf8')) as Golden;

test('the golden fixture Android also checks matches the shared scoring, ranking and fitting', () => {
  for (const f of golden.floors) assert.equal(floorRelevance(f, golden.now), golden.scores.find((s) => s.id === f.id)?.score, f.id);
  assert.deepEqual(rankFloors(golden.floors, golden.now), golden.ranked);
  for (const c of golden.fit) assert.deepEqual(fitTabs(c), c.expected, c.name);
});

test('owner attention outranks activity, activity outranks staffing, staffing outranks history', () => {
  const ranked = rankFloors(
    [
      { id: 'history', ...quiet, lastVisitedAt: NOW - HOUR, lastWorkerAt: NOW - HOUR, hires: 50 },
      { id: 'staffed', ...quiet, totalWorkers: 1 },
      { id: 'working', ...quiet, totalWorkers: 1, busy: 1 },
      { id: 'done', ...quiet, totalWorkers: 1, unackedDone: 1 },
      { id: 'needs', ...quiet, totalWorkers: 1, needsInput: 1 },
    ],
    NOW,
  );
  assert.deepEqual(ranked, ['needs', 'done', 'working', 'staffed', 'history']);
});

test('among empty floors a recent visit beats an old one, and a recent worker beats none', () => {
  const ranked = rankFloors(
    [
      { id: 'never', ...quiet },
      { id: 'visited-last-month', ...quiet, lastVisitedAt: NOW - 30 * 24 * HOUR },
      { id: 'worker-yesterday', ...quiet, lastWorkerAt: NOW - 24 * HOUR },
      { id: 'visited-just-now', ...quiet, lastVisitedAt: NOW - 60_000 },
    ],
    NOW,
  );
  assert.deepEqual(ranked, ['visited-just-now', 'worker-yesterday', 'visited-last-month', 'never']);
});

test('more lifetime hires break a tie between otherwise equal floors, and equal scores keep building order', () => {
  assert.deepEqual(
    rankFloors(
      [
        { id: 'a', ...quiet, hires: 1 },
        { id: 'b', ...quiet, hires: 20 },
      ],
      NOW,
    ),
    ['b', 'a'],
  );
  assert.deepEqual(
    rankFloors(
      [
        { id: 'a', ...quiet },
        { id: 'b', ...quiet },
        { id: 'c', ...quiet },
      ],
      NOW,
    ),
    ['a', 'b', 'c'],
  );
});

test('scores ignore junk counts and cap runaway ones', () => {
  assert.equal(floorRelevance({ needsInput: -3, unackedDone: Number.NaN, busy: Number.POSITIVE_INFINITY, totalWorkers: -1, lastVisitedAt: -5, hires: -2 }, NOW), 0);
  assert.equal(floorRelevance({ ...quiet, needsInput: 50 }, NOW), floorRelevance({ ...quiet, needsInput: 5 }, NOW));
});

test('fitTabs fills by relevance, stops at the first tab that would not fit, and keeps building order on screen', () => {
  const widths = [
    { id: 'a', width: 100 },
    { id: 'b', width: 100 },
    { id: 'c', width: 300 },
    { id: 'd', width: 100 },
  ];
  // 600 holds every tab: no "+N more" button and nothing hidden.
  assert.deepEqual(fitTabs({ widths, ranked: ['d', 'c', 'b', 'a'], current: 'a', available: 600, more: 80 }), { shown: ['a', 'b', 'c', 'd'], hidden: [] });
  // 599 doesn't: 80px go to the button, leaving 519. a (current) + d = 200; c would make 500; b would make 600 and stops it.
  assert.deepEqual(fitTabs({ widths, ranked: ['d', 'c', 'b', 'a'], current: 'a', available: 599, more: 80 }), { shown: ['a', 'c', 'd'], hidden: ['b'] });
  // c doesn't fit beside a and d, so filling stops there even though b would.
  assert.deepEqual(fitTabs({ widths, ranked: ['d', 'c', 'b'], current: 'a', available: 400, more: 80 }), { shown: ['a', 'd'], hidden: ['c', 'b'] });
});
