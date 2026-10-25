#!/usr/bin/env node
// A control for the display-side numbers: a page that does almost nothing (a bar moving a little every animation frame) in
// the same app window, captured the same way. What the display shows for it is the floor that Chromium and the window
// server leave for any page on this display, whatever the office does; the office's late frames only mean something
// against it.
//
//   node tools/frame-bench/control.mjs --app "<Droid Office.app>" --clone <office clone> --display-trace <binary> [--out dir] [--seconds 12]
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Cdp } from './cdp.mjs';
import { launchApp } from './launch.mjs';
import { clockOffset, displayPacing, installPageHooks, sleep, startDisplayTrace } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const app = arg('app');
const clone = arg('clone');
const traceBinary = arg('display-trace');
if (!app || !clone || !traceBinary) {
  console.error('usage: control.mjs --app <Droid Office.app> --clone <office clone> --display-trace <binary> [--out dir] [--seconds 12]');
  process.exit(1);
}
const out = path.resolve(arg('out', '/tmp/frame-bench'));
const seconds = Number(arg('seconds', '12'));
mkdirSync(out, { recursive: true });
const debugPort = Number(arg('debug-port', '9333'));
const running = await launchApp({ app, clone, userData: mkdtempSync(path.join(out, 'userdata-control-')), debugPort });
const cdp = await Cdp.connect(debugPort, running.url);
let code = 0;
try {
  await installPageHooks(cdp);
  const page =
    '<!doctype html><body style="margin:0;background:#101820;overflow:hidden"><div id=b style="position:absolute;top:0;left:0;width:120px;height:100vh;background:#fff;will-change:transform"></div><script>let x=0;function f(){x=(x+9)%(innerWidth-120);b.style.transform="translateX("+x+"px)";requestAnimationFrame(f)}requestAnimationFrame(f)</script>';
  await cdp.send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(page)}` });
  await sleep(3000);
  const trace = await startDisplayTrace(traceBinary, path.join(out, 'trace-control.json'));
  const before = await clockOffset(cdp);
  const t0 = await cdp.eval('performance.now()');
  await sleep(seconds * 1000);
  const t1 = await cdp.eval('performance.now()');
  const after = await clockOffset(cdp);
  const frames = await trace.stop();
  const [lo, hi] = [t0 * 1e6 + before.offsetNs, t1 * 1e6 + after.offsetNs];
  const display = displayPacing(
    frames.filter((f) => f.t >= lo && f.t <= hi),
    { cap: 120, refreshMs: 1000 / 120 },
  );
  const row = { control: 'moving bar, one animation frame per update', seconds, display };
  appendFileSync(path.join(out, 'control.jsonl'), `${JSON.stringify(row)}\n`);
  console.log(
    `control: display ${display.fps.toFixed(1)} fps, gap p50 ${display.gap.p50.toFixed(1)} p95 ${display.gap.p95.toFixed(1)} p99 ${display.gap.p99.toFixed(1)} max ${display.gap.max.toFixed(1)} ms, ${display.missed} late of ${display.frames}`,
  );
} catch (err) {
  code = 1;
  console.error(`control: ${err.stack ?? err}`);
} finally {
  cdp.close();
  running.quit();
}
process.exit(code);
