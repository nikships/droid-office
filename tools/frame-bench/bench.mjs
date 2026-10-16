#!/usr/bin/env node
// The frame bench: drives the packaged Mac app (or any Electron build with a DevTools port) on a clone of the owner's office
// through fixed scenarios at each frame rate cap and graphics configuration, and records office.frameStats() for each, plus
// (with --display-trace) what the display itself showed, measured by ScreenCaptureKit.
//
//   node tools/frame-bench/bench.mjs --app "release/mac-arm64/Droid Office.app" --clone /tmp/office-clone-XXXX --out /tmp/bench \
//     [--configs remastered-sdr,remastered-hdr,classic] [--caps 120,60,40] [--scenarios idle,turn,walk,terminal,load] \
//     [--seconds 12] [--repeat 1] [--label baseline] [--display-trace tools/frame-bench/display-trace/display-trace]
//   node tools/frame-bench/bench.mjs --table /tmp/bench/results.jsonl     # the results as Markdown tables
//
// Results are appended to <out>/results.jsonl, one line per scenario run. See tools/frame-bench/README.md.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startResourceSampler } from './resource.mjs';
import { Cdp } from './cdp.mjs';
import { launchApp } from './launch.mjs';
import { CONFIGS, clockOffset, displayPacing, ensureRendering, installPageHooks, loadOffice, machineRecord, SCENARIOS, sleep, spread, startDisplayTrace, storageFor } from './lib.mjs';
import { tables } from './table.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const list = (name, fallback) => String(arg(name, fallback)).split(',').filter(Boolean);

if (arg('table')) {
  console.log(
    tables(
      readFileSync(arg('table'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    ),
  );
  process.exit(0);
}

const app = arg('app');
const clone = arg('clone');
if (!app || !clone) {
  console.error(
    'usage: bench.mjs --app <Droid Office.app> --clone <office clone> --out <dir> [--configs a,b] [--caps 120,60,40] [--scenarios idle,turn,walk,terminal,load] [--seconds 12] [--repeat 1] [--label name] [--display-trace <binary>]',
  );
  process.exit(1);
}
const out = path.resolve(arg('out', '/tmp/frame-bench'));
const configs = list('configs', Object.keys(CONFIGS).join(','));
const caps = list('caps', '120,60,40').map(Number);
const scenarios = list('scenarios', 'idle,turn,walk,terminal,load');
const seconds = Number(arg('seconds', '12'));
const repeat = Number(arg('repeat', '1'));
const label = arg('label', 'run');
const traceBinary = arg('display-trace');
mkdirSync(out, { recursive: true });
const results = path.join(out, 'results.jsonl');
const withTimeout = (promise, ms, why) => Promise.race([promise.then(() => null).catch((err) => err.message), new Promise((resolve) => setTimeout(() => resolve(`${why} within ${ms / 1000} s`), ms))]);
/** A small seeded generator, so a shuffled order can be rerun. */
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = (items, rng) => {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const record = (row) => appendFileSync(results, `${JSON.stringify(row)}\n`);

const running = await launchApp({ app, clone, userData: path.join(out, 'userdata'), debugPort: Number(arg('debug-port', '9333')) });
const cdp = await Cdp.connect(Number(arg('debug-port', '9333')), running.url);
let code = 0;
try {
  await installPageHooks(cdp);
  const machine = machineRecord();
  const page = await cdp.eval('JSON.stringify({ userAgent: navigator.userAgent, dpr: devicePixelRatio, inner: [innerWidth, innerHeight], hdrDisplay: matchMedia("(dynamic-range: high)").matches })').then(JSON.parse);
  writeFileSync(path.join(out, 'machine.json'), `${JSON.stringify({ label, app, machine, page, scenarios, seconds, repeat }, null, 2)}\n`);
  console.log(`bench: ${label} on ${machine.chip}, macOS ${machine.macos}; ${page.inner.join('×')} @${page.dpr}x; HDR display ${page.hdrDisplay}`);

  // Rounds interleave the configurations in a shuffled order each time, so a slow drift in the machine's load does not
  // line up with one configuration. Repeats of a scenario are the rounds.
  const plan = configs.flatMap((config) => caps.map((cap) => ({ config, cap })));
  const rng = seeded(Number(arg('seed', '1')));
  for (let rep = 1; rep <= repeat; rep++) {
    for (const { config, cap } of argv.includes('--ordered') ? plan : shuffle(plan, rng)) {
      const storage = storageFor(clone, { config, cap });
      const load = await loadOffice(cdp, storage);
      const state = JSON.parse(await cdp.eval('JSON.stringify({ stats: office.frameStats() })')).stats;
      console.log(`bench: round ${rep}: ${config} @ ${cap}: ${state.renderer}; refresh ${state.refreshHz.toFixed(1)} Hz; ready ${(load.shownMs / 1000).toFixed(1)} s, warm ${(load.warmMs / 1000).toFixed(1)} s; load ${machineRecord().load}`);
      for (const name of shuffle(
        scenarios.filter((n) => n !== 'load'),
        rng,
      )) {
        const run = SCENARIOS[name];
        if (!run) throw new Error(`unknown scenario ${name}: ${Object.keys(SCENARIOS).join(', ')}, load`);
        await ensureRendering(cdp);
        const trace = traceBinary ? await startDisplayTrace(traceBinary, path.join(out, `trace-${config}-${cap}-${name}-${rep}.json`)) : null;
        const clockBefore = await clockOffset(cdp);
        const sampler = argv.includes('--resources') ? await startResourceSampler(app) : null;
        const failure = await withTimeout(run({ cdp, seconds }), (seconds + 150) * 1000, `${name} did not finish`);
        if (failure) {
          // One stuck scenario must not stall the matrix: note it, put the page back and go on.
          record({ label, config, cap, scenario: name, rep, failed: failure });
          console.log(`bench:   ${name} #${rep}: FAILED ${failure}`);
          await sampler?.stop().catch(() => undefined);
          await trace?.stop().catch(() => undefined);
          await cdp.eval('document.exitPointerLock(); office.closeAll()', { timeout: 20_000 }).catch(() => undefined);
          continue;
        }
        const resources = sampler ? await sampler.stop() : null;
        const clockAfter = await clockOffset(cdp);
        const frames = trace ? await trace.stop() : null;
        await cdp.eval('window.__bench.presenterDone');
        const got = JSON.parse(await cdp.eval('JSON.stringify({ report: window.__bench.report, t0: window.__bench.t0, t1: window.__bench.t1, presenter: window.__bench.presenter })'));
        if (!got.report) throw new Error(`${name} produced no report`);
        const row = {
          label,
          config,
          cap,
          scenario: name,
          rep,
          seconds,
          renderer: got.report.renderer,
          report: got.report,
          ...(got.presenter ? { presenter: got.presenter } : {}),
          ...(resources ? { resources } : {}),
          machine: { load: machineRecord().load },
        };
        if (frames) {
          // The page's window in hrtime, from the clock offset taken before and after the run (their gap bounds the drift).
          const [lo, hi] = [got.t0 * 1e6 + clockBefore.offsetNs, got.t1 * 1e6 + clockAfter.offsetNs];
          row.window = { loNs: lo, hiNs: hi };
          row.clock = { driftUs: (clockAfter.offsetNs - clockBefore.offsetNs) / 1e3, rttUs: Math.max(clockBefore.rtt, clockAfter.rtt) / 1e3 };
          row.display = {
            ...displayPacing(
              frames.filter((f) => f.t >= lo && f.t <= hi),
              { cap, refreshMs: 1000 / 120 },
            ),
            refreshMs: 1000 / 120,
          };
        }
        record(row);
        const t = got.report.frameTime;
        console.log(
          `bench:   ${name} #${rep}: p50 ${t.p50.toFixed(1)} p95 ${t.p95.toFixed(1)} p99 ${t.p99.toFixed(1)} ms, ${got.report.missed} missed, ${got.report.repeated} repeated, gpu ${got.report.gpu.scene?.toFixed(2)}+${got.report.gpu.hands?.toFixed(2)} ms${row.display ? `; display p50 ${row.display.gap.p50.toFixed(1)} p99 ${row.display.gap.p99.toFixed(1)} ${row.display.missed} late` : ''}`,
        );
      }
      // Loading is measured in the first round only: the cold load re-bakes the light, which takes a minute or more.
      if (scenarios.includes('load') && rep === 1) {
        for (const [kind, clearBake] of [
          ['cached', false],
          ['cold', true],
        ]) {
          const loaded = await loadOffice(cdp, null, { clearBake });
          const gaps = await cdp.eval('JSON.stringify(window.__bench.rafGaps())').then(JSON.parse);
          const row = {
            label,
            config,
            cap,
            scenario: `load-${kind}`,
            rep: 1,
            renderer: state.renderer,
            load: loaded,
            raf: { frames: gaps.length, gap: spread(gaps), over: gaps.filter((g) => g > 1000 / cap + 4).length, longest: gaps.length ? Math.max(...gaps) : 0 },
          };
          record(row);
          console.log(
            `bench:   load-${kind}: shown ${(loaded.shownMs / 1000).toFixed(1)} s, warm ${(loaded.warmMs / 1000).toFixed(1)} s; raf p50 ${row.raf.gap.p50.toFixed(1)} p99 ${row.raf.gap.p99.toFixed(1)} ms, ${row.raf.over} slow of ${row.raf.frames}`,
          );
        }
      }
      await sleep(500);
    }
  }
} catch (err) {
  code = 1;
  console.error(`bench: ${err.stack ?? err}`);
} finally {
  cdp.close();
  running.quit();
}
console.log(existsSync(results) ? `bench: results in ${results}` : 'bench: no results');
process.exit(code);
