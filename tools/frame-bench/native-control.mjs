#!/usr/bin/env node
// The native control: display-trace records a full-screen Metal window (display-trace/native-control.swift, no browser) at
// the display's refresh. What the display shows for it is the floor of the capture tool and the window server, so a
// late-frame count in the office or the browser control only means something against it.
//
//   node tools/frame-bench/native-control.mjs --native-control <binary> --display-trace <binary> [--out dir] [--seconds 12] [--fps 120]
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { displayPacing, sleep, startDisplayTrace } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const nativeBinary = arg('native-control');
const traceBinary = arg('display-trace');
if (!nativeBinary || !traceBinary) {
  console.error('usage: native-control.mjs --native-control <binary> --display-trace <binary> [--out dir] [--seconds 12] [--fps 120]');
  process.exit(1);
}
const out = path.resolve(arg('out', '/tmp/frame-bench'));
const seconds = Number(arg('seconds', '12'));
const fps = Number(arg('fps', '120'));
mkdirSync(out, { recursive: true });
const ticksFile = path.join(out, 'native-control-ticks.json');

const native = spawn(nativeBinary, ['--seconds', String(seconds + 4), '--fps', String(fps), '--out', ticksFile], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
const exited = new Promise((resolve) => native.on('exit', resolve));
await new Promise((resolve, reject) => {
  native.stdout.on('data', (chunk) => String(chunk).includes('ready') && resolve());
  native.on('exit', () => reject(new Error('native-control exited before drawing')));
});
let code = 0;
try {
  await sleep(1500);
  const trace = await startDisplayTrace(traceBinary, path.join(out, 'trace-native-control.json'));
  const start = process.hrtime.bigint();
  await sleep(seconds * 1000);
  const end = process.hrtime.bigint();
  const frames = await trace.stop();
  const display = displayPacing(
    frames.filter((f) => f.t >= Number(start) && f.t <= Number(end)),
    { cap: fps, refreshMs: 1000 / 120 },
  );
  await exited;
  const ticks = JSON.parse(readFileSync(ticksFile, 'utf8')).ticksNs.filter((t) => t >= Number(start) && t <= Number(end));
  const gaps = ticks.slice(1).map((t, i) => (t - ticks[i]) / 1e6);
  const link = { ticks: ticks.length, fps: ticks.length / seconds, gapMaxMs: Math.max(...gaps) };
  const row = { control: 'native Metal window, one display link tick per update', seconds, fps, link, display };
  appendFileSync(path.join(out, 'control.jsonl'), `${JSON.stringify(row)}\n`);
  console.log(
    `native control: display link ${link.fps.toFixed(1)} ticks/s (max gap ${link.gapMaxMs.toFixed(1)} ms); display ${display.fps.toFixed(1)} fps, gap p50 ${display.gap.p50.toFixed(1)} p95 ${display.gap.p95.toFixed(1)} p99 ${display.gap.p99.toFixed(1)} max ${display.gap.max.toFixed(1)} ms, ${display.missed} late of ${display.frames}`,
  );
} catch (err) {
  code = 1;
  console.error(`native-control: ${err.stack ?? err}`);
  try {
    process.kill(-native.pid, 'SIGTERM');
  } catch {}
}
process.exit(code);
