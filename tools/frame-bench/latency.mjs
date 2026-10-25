#!/usr/bin/env node
// Input-to-display latency of the app's camera turn, measured against the display, not the page's animation frames.
//
// Each trial sends a mouse move to the page through DevTools (Input.dispatchMouseEvent, on a captured mouse) at a recorded
// process.hrtime, and display-trace (ScreenCaptureKit) says when the display's picture first changed after it. Latency is
// the displayTime of that frame minus the send time. What this includes: DevTools delivery, the browser's input routing,
// the office's mouse handler, the next drawn frame, Chromium's compositing and presentation, and the window server's
// composition for the refresh the frame was shown in. What it excludes: the operating system's own dispatch of a real
// mouse event to the app (CGEventPost needs Accessibility, which this machine has not granted), the mouse sensor, and the
// display's scan-out and pixel response after the refresh starts. The same method runs unchanged on any build the app launcher
// can start, so two builds compare like for like.
//
//   node tools/frame-bench/latency.mjs --app "<Droid Office.app>" --clone <office clone> --out <dir> \
//     --display-trace <binary> [--config remastered-sdr] [--caps 120,60,40] [--trials 80] [--label name]
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Cdp } from './cdp.mjs';
import { launchApp } from './launch.mjs';
import { captureMouse, installPageHooks, loadOffice, mouse, pct, releaseMouse, sleep, spread, START, startDisplayTrace, storageFor } from './lib.mjs';

/** Per-trial latencies in ms from send times and a display trace. Pure, so tests/ can check it. */
export function latencies(sends, frames, { window = 250 } = {}) {
  const noise = [];
  for (const s of sends) for (const f of frames) if (f.t < s.t0 - 20e6 && f.t > s.t0 - 220e6) noise.push(f.d);
  // A scene that is still draws no new frames at all, so noise is usually empty and any changed frame counts.
  const threshold = Math.max(0.3, 5 * pct(noise, 99));
  const out = [];
  for (const s of sends) {
    const frame = frames.find((f) => f.t > s.t0 && f.d > threshold);
    if (!frame || (frame.t - s.t0) / 1e6 > window) {
      out.push({ ok: false });
      continue;
    }
    out.push({ ok: true, ms: (frame.t - s.t0) / 1e6, ackMs: (s.ack - s.t0) / 1e6 });
  }
  return { threshold, trials: out };
}

const nowNs = () => process.hrtime.bigint();

export async function measure({ cdp, trace, trials, w, h }) {
  const sends = [];
  let x = w / 2;
  for (let i = 0; i < trials; i++) {
    await sleep(300 + Math.random() * 300);
    x = x > w / 2 ? w / 2 : w / 2 + 120;
    const t0 = nowNs();
    await mouse(cdp, 'mouseMoved', x, h / 2);
    const ack = nowNs();
    sends.push({ t0: Number(t0), ack: Number(ack) });
  }
  await sleep(400);
  return { sends, frames: await trace.stop() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
  const app = arg('app');
  const clone = arg('clone');
  const traceBinary = arg('display-trace');
  if (!app || !clone || !traceBinary) {
    console.error('usage: latency.mjs --app <Droid Office.app> --clone <office clone> --display-trace <binary> [--out dir] [--config remastered-sdr] [--caps 120,60,40] [--trials 80] [--label name]');
    process.exit(1);
  }
  const out = path.resolve(arg('out', '/tmp/frame-bench'));
  mkdirSync(out, { recursive: true });
  const config = arg('config', 'remastered-sdr');
  const caps = arg('caps', '120,60,40').split(',').map(Number);
  const trials = Number(arg('trials', '80'));
  const label = arg('label', 'latency');
  const debugPort = Number(arg('debug-port', '9333'));
  const running = await launchApp({ app, clone, userData: mkdtempSync(path.join(out, 'userdata-latency-')), debugPort });
  const cdp = await Cdp.connect(debugPort, running.url);
  let code = 0;
  try {
    await installPageHooks(cdp);
    for (const cap of caps) {
      await loadOffice(cdp, storageFor(clone, { config, cap }));
      await cdp.eval(`(async () => { ${START} })()`);
      const { w, h } = await captureMouse(cdp);
      const trace = await startDisplayTrace(traceBinary, path.join(out, `latency-${config}-${cap}.json`));
      const { sends, frames } = await measure({ cdp, trace, trials, w, h });
      await releaseMouse(cdp);
      const { threshold, trials: result } = latencies(sends, frames);
      const ok = result.filter((r) => r.ok);
      const row = {
        label,
        method: 'display-trace (ScreenCaptureKit displayTime) minus DevTools mouse-move send time; OS dispatch excluded',
        config,
        cap,
        trials,
        found: ok.length,
        threshold,
        latencyMs: spread(ok.map((r) => r.ms)),
        ackMs: spread(ok.map((r) => r.ackMs)),
        mean: ok.reduce((a, r) => a + r.ms, 0) / Math.max(1, ok.length),
      };
      appendFileSync(path.join(out, 'latency.jsonl'), `${JSON.stringify(row)}\n`);
      console.log(
        `latency: ${config} @ ${cap}: ${ok.length}/${trials} trials, p50 ${row.latencyMs.p50.toFixed(1)} p95 ${row.latencyMs.p95.toFixed(1)} p99 ${row.latencyMs.p99.toFixed(1)} max ${row.latencyMs.max.toFixed(1)} ms (DevTools ack p50 ${row.ackMs.p50.toFixed(1)} ms)`,
      );
    }
  } catch (err) {
    code = 1;
    console.error(`latency: ${err.stack ?? err}`);
  } finally {
    cdp.close();
    running.quit();
  }
  process.exit(code);
}
