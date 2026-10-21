import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clonePort } from '../tools/frame-bench/launch.mjs';
import { displayPacing, pct, spread, storageFor } from '../tools/frame-bench/lib.mjs';
import { latencies } from '../tools/frame-bench/latency.mjs';
import { cpuSeconds, parseGpu, parsePs, roleOf, summarize } from '../tools/frame-bench/resource.mjs';
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

test('a configuration is laid over the owner settings, and the office ignores every remaster key but enabled and hdr', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bench-storage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'local-storage.json'),
    JSON.stringify({ 'droid-office.remaster': JSON.stringify({ enabled: false, antiAliasing: 'high', pace: 'adaptive' }), 'droid-office.settings': JSON.stringify({ volume: 1, graphics: { fpsCap: 60, scale: 1 } }), other: 'kept' }),
  );
  const s = storageFor(dir, { config: 'remastered-hdr', cap: 40 });
  assert.deepEqual(JSON.parse(s['droid-office.remaster']), { enabled: true, antiAliasing: 'high', pace: 'adaptive', hdr: true });
  assert.deepEqual(JSON.parse(s['droid-office.settings']), { volume: 1, graphics: { fpsCap: 40, scale: 1, stats: true } });
  assert.equal(s.other, 'kept');
  assert.throws(() => storageFor(dir, { config: 'nope', cap: 60 }), /unknown config/);
  const v = storageFor(dir, { config: 'classic+antiAliasing=medium+resolution=0.8+hdr=false+graphics.scale=0.9', cap: 120 });
  assert.deepEqual(JSON.parse(v['droid-office.remaster']), { enabled: false, antiAliasing: 'medium', pace: 'adaptive', hdr: false, resolution: 0.8 });
  assert.equal(JSON.parse(v['droid-office.settings']).graphics.scale, 0.9);
});

test('the results table takes the median of repeats with their range and keeps a failed run out of it', () => {
  const report = (p50: number, missed: number) => ({ frames: 100, frameTime: { p50, p95: p50 + 1, p99: p50 + 2, max: p50 + 5 }, missed, repeated: missed, cpu: { total: { p50: 6 } }, gpu: { scene: 4, hands: 2 } });
  const text = tables([
    { config: 'remastered-sdr', cap: 120, scenario: 'walk', renderer: 'Remastered', report: report(8, 0) },
    { config: 'remastered-sdr', cap: 120, scenario: 'walk', renderer: 'Remastered', report: report(10, 2) },
    { config: 'remastered-sdr', cap: 120, scenario: 'turn', failed: 'stuck' },
  ]);
  const walk = text.split('\n').filter((l) => l.includes('| walk |'));
  assert.equal(walk.length, 1);
  assert.match(walk[0], /\| 2 \| 100 \| 9\.0 \[8\.0–10\.0\] \| 10\.0 \[9\.0–11\.0\] \| 11\.0 \[10\.0–12\.0\] \| 14\.0 \[13\.0–15\.0\] \| 1 \[0–2\] \| 1 \[0–2\] \|/);
  assert.doesNotMatch(text, /\| turn \|/);
});

test('the table adds the presenter and the resource columns when a run has them', () => {
  const report = { frames: 100, frameTime: { p50: 8, p95: 9, p99: 10, max: 11 }, missed: 0, repeated: 0, cpu: { total: { p50: 6 } }, gpu: { scene: 4, hands: 2 } };
  const presenter = { fps: 119.5, dropped: 3, latency: { p50: 9, p95: 12, p99: 15 }, wait: { p50: 2, p95: 4 }, gpu: { p50: 0.4, p95: 0.6 }, late: 1, early: 0 };
  const resources = { cpuPct: { total: 150, renderer: 100, gpu: 30, main: 20 }, rssMb: { median: 900, max: 950 }, gpu: { device: { median: 40, max: 70 } } };
  const text = tables([{ config: 'remastered-sdr', cap: 120, scenario: 'walk', renderer: 'Remastered', report, presenter, resources }]);
  assert.match(text, /\| remastered-sdr \| 120 \| walk \| 1 \| 119\.5 \| 3 \| 9\.0 \| 12\.0 \| 15\.0 \| 2\.0 \| 4\.0 \| 0\.40 \| 0\.60 \| 1 \| 0 \|/);
  assert.match(text, /\| remastered-sdr \| 120 \| walk \| 1 \| 150 \| 100 \| 30 \| 20 \| 900 \| 950 \| 40 \| 70 \|/);
});

test('app processes, memory and GPU utilization are read from ps and ioreg output, and CPU is the time used over the window', () => {
  assert.equal(cpuSeconds('1:02:03.50'), 3723.5);
  assert.equal(cpuSeconds('2:03.25'), 123.25);
  assert.equal(roleOf('/x/Droid Office.app/Contents/Frameworks/Droid Office Helper (Renderer).app/Contents/MacOS/Droid Office Helper (Renderer)'), 'renderer');
  assert.equal(roleOf('/x/Droid Office.app/Contents/Frameworks/Droid Office Helper (GPU).app/Contents/MacOS/Droid Office Helper (GPU)'), 'gpu');
  assert.equal(roleOf('/x/Droid Office.app/Contents/MacOS/Droid Office --user-data-dir=/y'), 'main');
  const ps = [
    '  10   0:10.00  200000 /private/tmp/Droid Office.app/Contents/Frameworks/Droid Office Helper (Renderer).app/Contents/MacOS/Droid Office Helper (Renderer) --type=renderer',
    '  11   0:02.00  100000 /tmp/Droid Office.app/Contents/MacOS/Droid Office --user-data-dir=/y',
    '  12   0:50.00  999999 /Applications/Other.app/Contents/MacOS/Other',
  ].join('\n');
  const first = parsePs(ps, ['/tmp/Droid Office.app', '/private/tmp/Droid Office.app']);
  assert.deepEqual(
    first.map((p: { pid: number; role: string }) => [p.pid, p.role]),
    [
      [10, 'renderer'],
      [11, 'main'],
    ],
  );
  const last = first.map((p: { pid: number; cpuSec: number }) => ({ ...p, cpuSec: p.cpuSec + (p.pid === 10 ? 10 : 5) }));
  const gpu = parseGpu('"Tiler Utilization %"=12, "Renderer Utilization %"=48, "Device Utilization %"=50, "In use system memory"=1048576');
  assert.deepEqual(gpu, { device: 50, renderer: 48, tiler: 12, memoryMb: 1 });
  const summary = summarize({
    first,
    last,
    seconds: 10,
    samples: [
      { procs: first, gpu },
      { procs: last, gpu: { ...gpu, device: 70 } },
    ],
  });
  assert.equal(summary.cpuPct.renderer, 100);
  assert.equal(summary.cpuPct.main, 50);
  assert.equal(summary.cpuPct.total, 150);
  assert.equal(summary.rssMb.median, 300000 / 1024);
  assert.equal(summary.gpu.device.max, 70);
});
