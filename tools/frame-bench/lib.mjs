// Shared pieces of the frame bench: opening the office page in the app under test with a given graphics configuration,
// the fixed scenarios, the machine record, and the statistics both bench.mjs and latency.mjs report.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The graphics configurations the bench knows by name. Each is applied on top of the owner's own saved settings. */
export const CONFIGS = {
  'remastered-sdr': { remaster: { enabled: true, hdr: false } },
  'remastered-hdr': { remaster: { enabled: true, hdr: true } },
  classic: { remaster: { enabled: false, hdr: false } },
};

const OWNER_SETTINGS_KEY = 'droid-office.settings';
const OWNER_REMASTER_KEY = 'droid-office.remaster';

/** The owner's saved browser settings in the clone (clone-office.sh writes them), with the bench's configuration on top. */
export function storageFor(clone, { config, cap, remaster = {}, graphics = {} }) {
  const saved = JSON.parse(readFileSync(path.join(clone, 'local-storage.json'), 'utf8'));
  // `classic+graphics.scale=0.9`, or `remastered-hdr+hdr=false`. Remastered picture keys (anti-aliasing, resolution, pace) are saved and ignored.
  const [name, ...changes] = config.split('+');
  const base = CONFIGS[name];
  if (!base) throw new Error(`unknown config ${config}: ${Object.keys(CONFIGS).join(', ')}`);
  for (const change of changes) {
    const [key, raw] = change.split('=');
    const value = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    if (key.startsWith('graphics.')) graphics = { ...graphics, [key.slice(9)]: value };
    else remaster = { ...remaster, [key]: value };
  }
  const ownerRemaster = JSON.parse(saved[OWNER_REMASTER_KEY] ?? '{}');
  const ownerSettings = JSON.parse(saved[OWNER_SETTINGS_KEY] ?? '{}');
  // The office only reads `enabled` and `hdr`. Extra keys stay in the blob and are ignored. A still measurement
  // stays at full pace because loadOffice opens the page with `?pace=full`, not because of a saved setting.
  saved[OWNER_REMASTER_KEY] = JSON.stringify({ ...ownerRemaster, ...base.remaster, ...remaster });
  saved[OWNER_SETTINGS_KEY] = JSON.stringify({ ...ownerSettings, graphics: { ...ownerSettings.graphics, fpsCap: cap, stats: true, ...graphics } });
  return saved;
}

/** Stops the office's "Leave the office?" guard from asking, in every page this connection loads. */
const GUARD = "window.addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true);";
/** Logs every animation frame's timestamp from the first one on, for the loading scenario. */
const RAF_LOG = `(() => { const log = (window.__raf = []); const tick = (t) => { log.push(t); requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();`;

export async function installPageHooks(cdp) {
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `${GUARD}${RAF_LOG}${PAGE_LIB}` });
}

export const pageReady = "typeof window.office === 'object' && !document.getElementById('loading')";
const warmupDone = "!document.querySelector('#warmup.on')";

export async function waitFor(cdp, expression, { timeout = 240_000, every = 500 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const ok = await cdp.eval(expression, { timeout: 10_000 }).catch(() => false);
    if (ok) return;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${expression}`);
    await sleep(every);
  }
}

/** Reloads the office page and waits for it to be up and its shader and light warm-up to finish. Returns the load timeline. */
export async function loadOffice(cdp, storage, { clearBake = false } = {}) {
  const t0 = Date.now();
  await cdp.eval(
    `(async () => { ${storage ? `for (const [k, v] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(k, v);` : ''}
      ${clearBake ? "await new Promise((r) => { const q = indexedDB.deleteDatabase('droid-office-gi'); q.onsuccess = q.onerror = q.onblocked = () => r(); });" : ''}
      setTimeout(() => { const url = new URL(location.href); url.searchParams.set('pace', 'full'); location.assign(url.toString()); }, 30); return 1; })()`,
  );
  await sleep(1500);
  await waitFor(cdp, pageReady);
  const shown = Date.now() - t0;
  await waitFor(cdp, warmupDone, { timeout: 600_000, every: 1000 });
  const warm = Date.now() - t0;
  // HDR starts asynchronously (a WebGPU device) and the loop needs a few seconds to settle after the warm-up.
  await sleep(4000);
  await ensureRendering(cdp);
  return { shownMs: shown, warmMs: warm };
}

/**
 * Chromium stops animation frames for a window another app covers or the user switched away from, and every number after
 * that is zeros or stalls. Brings the page forward and waits until it draws; throws when it never does.
 */
export async function ensureRendering(cdp) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await cdp.send('Page.bringToFront').catch(() => undefined);
    const before = await cdp.eval('window.__raf.length');
    await sleep(600);
    const after = await cdp.eval('window.__raf.length');
    // Animation frames flowing is the test: a presenter build keeps its page in a hidden window, whose visibility is not.
    if (after - before >= 20) return;
    await sleep(2000);
  }
  throw new Error('the page is not drawing (hidden or covered by another window)');
}

/**
 * How the page's performance.now() (ms) lines up with process.hrtime (ns, CLOCK_MONOTONIC_RAW) right now: the sample with the
 * shortest DevTools round trip, taking the page's clock at the middle of it. hrtime = pageMs * 1e6 + offsetNs.
 */
export async function clockOffset(cdp) {
  let best;
  for (let i = 0; i < 9; i++) {
    const before = process.hrtime.bigint();
    const page = await cdp.eval('performance.now()');
    const after = process.hrtime.bigint();
    const rtt = Number(after - before);
    if (!best || rtt < best.rtt) best = { rtt, offsetNs: Number((before + after) / 2n) - page * 1e6 };
  }
  return best;
}

/** Page-side helpers, injected once per load. */
export const PAGE_LIB = `(() => {
  if (window.__bench) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const epoch = () => performance.now();
  window.__bench = {
    sleep,
    // A measurement is the frames between begin() and end(); end() keeps the page's own report of them.
    // The Mac app's native presenter (a build that has it) keeps its own counters, reset and read the same way; null elsewhere.
    begin: () => { office.frameStats({ reset: true }); if (typeof office.presenterStats === 'function') office.presenterStats({ reset: true }).catch(() => {}); window.__bench.t0 = epoch(); window.__bench.report = null; },
    end: () => {
      window.__bench.t1 = epoch();
      window.__bench.report = office.frameStats();
      window.__bench.presenter = null;
      window.__bench.presenterDone = typeof office.presenterStats === 'function' ? office.presenterStats().then((s) => { window.__bench.presenter = s; }, () => {}) : Promise.resolve();
    },
    rafGaps: () => { const a = window.__raf; const g = []; for (let i = 1; i < a.length; i++) g.push(a[i] - a[i - 1]); return g; },
  };
})();`;

/** Stands at the jukebox looking straight ahead: the fixed start of every scenario. */
export const START = `await office.closeAll(); await office.goTo('jukebox'); await office.camera('first'); await window.__bench.sleep(1500);`;

export async function mouse(cdp, type, x, y, extra = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, ...extra });
}

/** Clicks the middle of the page, which takes pointer lock, the way a player captures the mouse. */
export async function captureMouse(cdp) {
  const [w, h] = await cdp.eval('[innerWidth, innerHeight]');
  await mouse(cdp, 'mouseMoved', w / 2, h / 2);
  await mouse(cdp, 'mousePressed', w / 2, h / 2, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse(cdp, 'mouseReleased', w / 2, h / 2, { button: 'left', clickCount: 1 });
  await sleep(500);
  return { w, h };
}

export const releaseMouse = (cdp) => cdp.eval('document.exitPointerLock()');

/** The scenarios. Each leaves the office as it found it and resolves once its frames are recorded. */
export const SCENARIOS = {
  idle: async ({ cdp, seconds }) => {
    await cdp.eval(`(async () => { ${START} window.__bench.begin(); await window.__bench.sleep(${seconds * 1000}); window.__bench.end(); })()`);
  },
  // Turning at 2 rad/s, reversing every second, with mouse deltas as a mouse sends them (every 8 ms) on a captured mouse.
  turn: async ({ cdp, seconds }) => {
    await cdp.eval(`(async () => { ${START} })()`);
    const { w, h } = await captureMouse(cdp);
    await cdp.eval('window.__bench.begin()');
    const step = 7;
    let x = w / 2;
    let dir = 1;
    const start = Date.now();
    let next = start;
    let lastFlip = start;
    while (Date.now() - start < seconds * 1000) {
      next += 8;
      if (Date.now() - lastFlip > 1000) {
        dir = -dir;
        lastFlip = Date.now();
      }
      x += dir * step;
      await mouse(cdp, 'mouseMoved', x, h / 2);
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
    }
    await cdp.eval('window.__bench.end()');
    await releaseMouse(cdp);
  },
  // Jukebox to elevator and back along the office's paths, the walk the Phase 1 pull request measured.
  walk: async ({ cdp, seconds }) => {
    await cdp.eval(`(async () => { ${START} window.__bench.begin();
      const end = performance.now() + ${seconds * 1000}; let to = 'elevator';
      while (performance.now() < end) { await office.goTo(to, { walk: true, timeout: 40000 }); to = to === 'elevator' ? 'jukebox' : 'elevator'; }
      window.__bench.end(); })()`);
  },
  // A shell's terminal open over the office, output scrolling through it.
  terminal: async ({ cdp, seconds }) => {
    await cdp.eval(`(async () => { ${START}
      if (!office.state().workers.some((w) => w.deskId === 'desk-1')) { await office.goTo('desk-1'); await office.interact('B'); await window.__bench.sleep(3000); }
      await office.goTo('desk-1'); await office.interact('E'); await window.__bench.sleep(2000); })()`);
    const type = (text) => cdp.send('Input.insertText', { text });
    const key = (k, code, modifiers = 0) => cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: k === 'Enter' ? 13 : k.toUpperCase().charCodeAt(0), modifiers });
    await type('while :; do seq 1 60; sleep 0.03; done');
    await key('Enter', 'Enter');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(2000);
    await cdp.eval('window.__bench.begin()');
    await sleep(seconds * 1000);
    await cdp.eval('window.__bench.end()');
    await key('c', 'KeyC', 2);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers: 2 });
    await sleep(500);
    await cdp.eval('office.closeAll()');
  },
};

/** Percentile of an unsorted list, nearest rank. */
export function pct(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export const spread = (values) => ({ p50: pct(values, 50), p95: pct(values, 95), p99: pct(values, 99), max: values.length ? Math.max(...values) : 0 });

/**
 * Display-side pacing from a display-trace file: the gaps between the display's changed frames, and how many of them were
 * late against what the frame rate cap plans, the same rule as the page's own count (src/client/frame-stats.ts).
 */
export function displayPacing(frames, { cap, refreshMs }) {
  // frames: { t } in ns
  const interval = 1000 / cap;
  const planned = Math.max(1, Math.ceil(interval / refreshMs - 1e-6));
  const gaps = [];
  let missed = 0;
  let repeated = 0;
  for (let i = 1; i < frames.length; i++) {
    const gap = (frames[i].t - frames[i - 1].t) / 1e6;
    gaps.push(gap);
    const extra = Math.max(0, Math.round(gap / refreshMs) - planned);
    if (extra > 0) missed++;
    repeated += extra;
  }
  const span = gaps.reduce((a, b) => a + b, 0);
  return { frames: gaps.length, fps: span > 0 ? (gaps.length * 1000) / span : 0, gap: spread(gaps), missed, repeated };
}

/** Starts display-trace and resolves once frames are flowing. `stop()` ends it and returns the parsed trace. */
export async function startDisplayTrace(binary, file, { seconds = 600, region } = {}) {
  const args = ['--out', file, '--seconds', String(seconds)];
  if (region) args.push('--region', region);
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let ready;
  const up = new Promise((resolve, reject) => {
    ready = resolve;
    child.once('exit', (code) => reject(new Error(`display-trace exited (${code}) before frames flowed`)));
  });
  child.stdout.on('data', (d) => String(d).includes('ready') && ready());
  await up;
  return {
    stop: () =>
      new Promise((resolve) => {
        child.removeAllListeners('exit');
        child.once('exit', () => {
          const trace = JSON.parse(readFileSync(file, 'utf8'));
          // A recorder built before the clock fix writes CLOCK_MONOTONIC, which is seconds off process.hrtime.
          if (!String(trace.clock).includes('MONOTONIC_RAW')) throw new Error(`display-trace wrote ${trace.clock}: rebuild it`);
          resolve(trace.frames);
        });
        child.kill('SIGINT');
      }),
  };
}

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch {
    return '';
  }
};

/** What the machine is doing and what it is, written beside every result so two runs can be compared honestly. */
export function machineRecord() {
  const display = (() => {
    try {
      const d = JSON.parse(run('system_profiler', ['SPDisplaysDataType', '-json'])).SPDisplaysDataType?.[0]?.spdisplays_ndrvs ?? [];
      return d.map((x) => ({ name: x._name, resolution: x._spdisplays_resolution, pixels: x._spdisplays_pixels, main: x.spdisplays_main }));
    } catch {
      return [];
    }
  })();
  const busy = run('ps', ['-Ao', 'pcpu,comm', '-r'])
    .split('\n')
    .slice(1, 7)
    .map((l) => l.trim());
  return {
    when: new Date().toISOString(),
    macos: run('sw_vers', ['-productVersion']),
    build: run('sw_vers', ['-buildVersion']),
    chip: run('sysctl', ['-n', 'machdep.cpu.brand_string']),
    display,
    power: run('pmset', ['-g', 'batt']).split('\n')[0],
    lowPower: /lowpowermode\s+1/.test(run('pmset', ['-g'])),
    thermal: run('pmset', ['-g', 'therm']).replace(/\s+/g, ' '),
    load: run('uptime')
      .replace(/.*load averages?:/, '')
      .trim(),
    busiestProcesses: busy,
  };
}
