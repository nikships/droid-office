import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clonePort } from '../tools/frame-bench/launch.mjs';
import { displayPacing, pct, spread, storageFor } from '../tools/frame-bench/lib.mjs';
import { latencies } from '../tools/frame-bench/latency.mjs';
import { tables } from '../tools/frame-bench/table.mjs';

const MS = 1e6;

test('latency is the first changed display frame after the send, minus the send', () => {
  const frames = [
    { t: 100 * MS, d: 0 },
    { t: 108.3 * MS, d: 0.01 },
    { t: 125 * MS, d: 4 },
    { t: 133.3 * MS, d: 5 },
  ];
  const { trials } = latencies([{ t0: 110 * MS, ack: 111 * MS }], frames);
  assert.equal(trials[0].ok, true);
  assert.ok(Math.abs(trials[0].ms - 15) < 1e-9);
  assert.ok(Math.abs(trials[0].ackMs - 1) < 1e-9);
});

test('a trial with no changed frame inside the window is reported as not found', () => {
  const frames = [{ t: 500 * MS, d: 3 }];
  assert.equal(latencies([{ t0: 100 * MS, ack: 101 * MS }], frames).trials[0].ok, false);
  assert.equal(latencies([{ t0: 100 * MS, ack: 101 * MS }], []).trials[0].ok, false);
});

test('the change threshold rises above the noise the display shows when nothing is sent', () => {
  const frames = [
    { t: 40 * MS, d: 0.9 },
    { t: 60 * MS, d: 1.0 },
    { t: 120 * MS, d: 1.5 },
    { t: 140 * MS, d: 20 },
  ];
  const { threshold, trials } = latencies([{ t0: 100 * MS, ack: 101 * MS }], frames);
  assert.ok(threshold >= 5);
  assert.ok(Math.abs(trials[0].ms - 40) < 1e-9);
});

test('display pacing counts frames that came a refresh late against the cap', () => {
  const refresh = 1000 / 120;
  const at = (n: number) => ({ t: Math.round(n * refresh * MS) });
  const steady = [0, 1, 2, 3, 4].map(at);
  const p = displayPacing(steady, { cap: 120, refreshMs: refresh });
  assert.equal(p.missed, 0);
  assert.equal(p.frames, 4);
  const late = [0, 1, 3, 4].map(at);
  const q = displayPacing(late, { cap: 120, refreshMs: refresh });
  assert.equal(q.missed, 1);
  assert.equal(q.repeated, 1);
  // Under a 60 FPS cap, every second refresh is the plan, not a miss.
  const sixty = [0, 2, 4, 6].map(at);
  assert.equal(displayPacing(sixty, { cap: 60, refreshMs: refresh }).missed, 0);
});

test('percentiles use the nearest rank', () => {
  assert.equal(pct([], 50), 0);
  assert.equal(pct([5, 1, 3], 50), 3);
  assert.deepEqual(spread([1, 2, 3, 4]), { p50: 2, p95: 4, p99: 4, max: 4 });
});

test('the clone must be a clone and never serve the default port', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bench-clone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => clonePort(dir), /not an office clone/);
  writeFileSync(path.join(dir, 'start.sh'), 'exec node bin/droid-office.js --port 4600 --host 127.0.0.1\n');
  assert.throws(() => clonePort(dir), /refusing port 4600/);
  writeFileSync(path.join(dir, 'start.sh'), 'exec node bin/droid-office.js --home x --port 4677 --host 127.0.0.1\n');
  assert.equal(clonePort(dir), 4677);
});

test('a configuration is laid over the owner settings and always runs at full render pace', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bench-storage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'local-storage.json'),
    JSON.stringify({ 'droid-office.remaster': JSON.stringify({ enabled: false, antiAliasing: 'high', pace: 'adaptive' }), 'droid-office.settings': JSON.stringify({ volume: 1, graphics: { fpsCap: 60, scale: 1 } }), other: 'kept' }),
  );
  const s = storageFor(dir, { config: 'remastered-hdr', cap: 40 });
  assert.deepEqual(JSON.parse(s['droid-office.remaster']), { enabled: true, antiAliasing: 'high', pace: 'full', hdr: true });
  assert.deepEqual(JSON.parse(s['droid-office.settings']), { volume: 1, graphics: { fpsCap: 40, scale: 1, stats: true } });
  assert.equal(s.other, 'kept');
  assert.throws(() => storageFor(dir, { config: 'nope', cap: 60 }), /unknown config/);
  const v = storageFor(dir, { config: 'classic+antiAliasing=medium+resolution=0.8+hdr=false+graphics.scale=0.9', cap: 120 });
  assert.deepEqual(JSON.parse(v['droid-office.remaster']), { enabled: false, antiAliasing: 'medium', pace: 'full', hdr: false, resolution: 0.8 });
  assert.equal(JSON.parse(v['droid-office.settings']).graphics.scale, 0.9);
});

test('the results table averages repeats and keeps a failed run out of it', () => {
  const report = (p50: number, missed: number) => ({ frames: 100, frameTime: { p50, p95: p50 + 1, p99: p50 + 2, max: p50 + 5 }, missed, repeated: missed, cpu: { total: { p50: 6 } }, gpu: { scene: 4, hands: 2 } });
  const text = tables([
    { config: 'remastered-sdr', cap: 120, scenario: 'walk', renderer: 'Remastered', report: report(8, 0) },
    { config: 'remastered-sdr', cap: 120, scenario: 'walk', renderer: 'Remastered', report: report(10, 2) },
    { config: 'remastered-sdr', cap: 120, scenario: 'turn', failed: 'stuck' },
  ]);
  const walk = text.split('\n').filter((l) => l.includes('| walk |'));
  assert.equal(walk.length, 1);
  assert.match(walk[0], /\| 9\.0 \| 10\.0 \| 11\.0 \| 14\.0 \| 1 \| 1 \|/);
  assert.doesNotMatch(text, /\| turn \|/);
});
