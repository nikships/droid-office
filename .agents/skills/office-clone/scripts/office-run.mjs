#!/usr/bin/env node
// Drives a clone of the owner's office (clone-office.sh) in one self-contained browser run:
// launches Playwright's headless shell with GPU WebGL, opens the clone as the owner (their
// localStorage, written before the first load), waits for the office to be ready, runs a steps
// file, saves its screenshots and exits. Nothing outlives the run, so nothing can go stale between
// commands the way a long-lived browser session does.
//
//   node .agents/skills/office-clone/scripts/office-run.mjs <clone-dir> [steps.mjs] [--out DIR] [--size 1440x900] [--timeout 120]
//
// A steps file exports a default async function that gets the helpers below:
//
//   export default async ({ page, js, open, click, shot, sleep, waitFor, rig, reload, log }) => {
//     await open('computers');                       // office.open(id)
//     await click('.cmp-tabs button', /Environments/); // the first match whose text fits
//     await shot('environments');                    // <out>/environments.png
//   };
//
// Without a steps file it saves <out>/office.png: a smoke check that the clone renders.
// Exit code 1 when the office never got ready, the page crashed or a step threw.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../../../..');

function parseArgs(argv) {
  const o = { out: undefined, size: '1440x900', timeout: 120, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--size') o.size = argv[++i];
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '-h' || a === '--help') o.help = true;
    else o.positional.push(a);
  }
  return o;
}

/** The headless shell `droid-office browser install` puts in the office's browser cache. */
function headlessShell() {
  const roots = [process.env.DROID_OFFICE_BROWSERS_PATH, path.join(os.homedir(), 'Library/Caches/droid-office/browsers'), path.join(os.homedir(), '.cache/droid-office/browsers')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()) {
      for (const sub of readdirSync(path.join(root, dir))) {
        const exe = path.join(root, dir, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
        if (existsSync(exe)) return exe;
      }
    }
  }
  return undefined;
}

const opts = parseArgs(process.argv.slice(2));
const [cloneDir, stepsFile] = opts.positional;
if (opts.help || !cloneDir) {
  console.log(
    readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n')
      .slice(1, 19)
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n'),
  );
  process.exit(opts.help ? 0 : 1);
}
const clone = path.resolve(cloneDir);
const start = path.join(clone, 'start.sh');
if (!existsSync(start)) {
  console.error(`office-run: ${clone} is not a clone (no start.sh): make one with clone-office.sh`);
  process.exit(1);
}
const port = Number(/--port (\d+)/.exec(readFileSync(start, 'utf8'))?.[1]);
if (!port || port === 4600) {
  console.error(`office-run: refusing port ${port || '?'}: this only drives a clone, never the owner's own office`);
  process.exit(1);
}
const url = `http://127.0.0.1:${port}/`;
const out = path.resolve(opts.out ?? path.join(clone, 'shots'));
mkdirSync(out, { recursive: true });
const [width, height] = opts.size.split('x').map(Number);

const exe = headlessShell();
if (!exe) {
  console.error('office-run: no headless shell found: run `node bin/droid-office.js browser install` from the repository root');
  process.exit(1);
}
try {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (err) {
  console.error(`office-run: nothing answers on ${url} (${err.message}): start the clone with ${start} (fireAndForget) after npm run build`);
  process.exit(1);
}

const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules/playwright-core/index.mjs')).href);
// Software WebGL in a headless browser runs the office at a few frames a second and is what used
// to blank the page; macOS has Metal through ANGLE even headless. Linux (cloud agents) has no GPU.
const gpu = process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ executablePath: exe, headless: true, args: gpu });
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });

const storage = path.join(clone, 'local-storage.json');
if (existsSync(storage)) {
  // Once per tab, before the office's own code: a reload mid-run keeps what the run changed.
  await context.addInitScript(
    (d) => {
      if (sessionStorage.getItem('office-run.loaded')) return;
      for (const [k, v] of Object.entries(d)) localStorage.setItem(k, v);
      sessionStorage.setItem('office-run.loaded', '1');
    },
    JSON.parse(readFileSync(storage, 'utf8')),
  );
} else console.warn('office-run: no local-storage.json in the clone: the office opens on the character picker');

const page = await context.newPage();
const problems = [];
let crashed = false;
page.on('crash', () => {
  crashed = true;
  console.error('office-run: the page crashed');
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`);
});
// A native confirm() or alert() would stall every step after it: accept it and say so.
page.on('dialog', (d) => {
  console.log(`office-run: ${d.type()} "${d.message().slice(0, 160)}" accepted`);
  void d.accept();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = () => page.waitForFunction(() => window.office?.state().floor && !document.getElementById('loading'), undefined, { timeout: opts.timeout * 1000 });
const helpers = {
  page,
  url,
  out,
  sleep,
  log: (...a) => console.log(...a),
  /** Runs a function (or an expression string) in the page and returns its JSON result. */
  js: (fn, arg) => (typeof fn === 'string' ? page.evaluate(fn) : page.evaluate(fn, arg)),
  /** office.open(id): a ☰ menu entry or window by id (office.commands() lists them). */
  open: async (id) => {
    await page.evaluate((x) => window.office.open(x), id);
    await sleep(600);
  },
  /** Clicks the first element matching `selector` whose text matches `text` (a string or RegExp). */
  click: async (selector, text) => {
    const loc = text === undefined ? page.locator(selector).first() : page.locator(selector, { hasText: text }).first();
    await loc.click({ timeout: 10_000 });
    await sleep(400);
  },
  waitFor: (fn, arg, timeoutMs = 30_000) => page.waitForFunction(fn, arg, { timeout: timeoutMs }),
  /** Saves <out>/<name>.png (the page, or one element by selector) and prints its path. */
  shot: async (name, selector) => {
    const file = path.join(out, `${name.replace(/\.png$/, '')}.png`);
    if (selector) await page.locator(selector).first().screenshot({ path: file });
    else await page.screenshot({ path: file });
    console.log(`shot ${file}`);
    return file;
  },
  /** Loads office-choreography's movement rig (__walkTo, __look, __hold, __tap, __pan…) into the page. */
  rig: async () => {
    if (!(await page.evaluate(() => !!window.__pan))) await page.evaluate(readFileSync(path.join(repo, '.agents/skills/office-choreography/scripts/office-rig.js'), 'utf8'));
  },
  /** Reloads and waits for the office again. */
  reload: async () => {
    await page.reload();
    await ready();
  },
};

let code = 0;
try {
  await page.goto(url);
  await ready();
  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2');
    const d = c?.getExtension('WEBGL_debug_renderer_info');
    return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  // The warm-up line (shaders, the bounce-light bake) would sit in every shot: give it time to finish.
  const settled = await page
    .waitForFunction(() => !document.querySelector('#warmup.on'), undefined, { timeout: 90_000 })
    .then(() => true)
    .catch(() => false);
  if (!settled) console.warn('office-run: the warm-up line is still up after 90 s; carrying on');
  const s = await page.evaluate(() => window.office.state());
  console.log(`office-run: ready on ${url} (floor ${s.floor?.name}, ${s.workers.length} workers; WebGL ${gl})`);
  if (stepsFile) {
    const mod = await import(pathToFileURL(path.resolve(stepsFile)).href);
    await mod.default(helpers);
  } else await helpers.shot('office');
} catch (err) {
  code = 1;
  console.error(`office-run: ${crashed ? 'the page crashed' : err.message}`);
  await helpers.shot('failure').catch(() => undefined);
} finally {
  if (problems.length) console.log(`office-run: the page reported:\n  ${[...new Set(problems)].slice(0, 20).join('\n  ')}`);
  await browser.close();
}
process.exit(code);
