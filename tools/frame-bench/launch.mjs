// Starts a packaged Droid Office on its own userData, shown
// against a clone of the owner's office, with a DevTools port to drive it. It never touches the installed app, the
// owner's data or the owner's office on :4600.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getJson } from './cdp.mjs';
import { nativeClonePage } from '../../.agents/skills/office-clone/scripts/office-run-options.mjs';

const OWNER_DATA = path.join(os.homedir(), 'Library/Application Support/com.nikships.droid-office');

const canonicalPath = (input) => {
  const missing = [];
  let parent = path.resolve(input);
  while (!existsSync(parent)) {
    missing.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  return path.join(realpathSync(parent), ...missing);
};

export function isolatedProfile(userData, ownerData = OWNER_DATA) {
  const resolved = path.resolve(userData),
    canonical = canonicalPath(resolved),
    owner = canonicalPath(ownerData);
  if (canonical === owner || canonical.startsWith(`${owner}${path.sep}`)) throw new Error(`refusing the owner's userData ${resolved}`);
  if (existsSync(resolved) && readdirSync(resolved).length) throw new Error(`refusing nonempty userData ${resolved}: choose a fresh profile directory`);
  return resolved;
}

/** The port a clone's start.sh serves on. Refuses anything that is not a clone, and :4600. */
export function clonePort(clone) {
  const start = path.join(clone, 'start.sh');
  if (!existsSync(start)) throw new Error(`${clone} is not an office clone (no start.sh): make one with .agents/skills/office-clone/scripts/clone-office.sh`);
  const port = Number(/--port (\d+)/.exec(readFileSync(start, 'utf8'))?.[1]);
  if (!port || port === 4600) throw new Error(`refusing port ${port || '?'}: this only drives a clone, never the owner's office`);
  return port;
}

export function appCommand({ app, source }) {
  if ((!app && !source) || (app && source)) throw new Error('supply exactly one of app or source');
  const appPath = path.resolve(source ?? app);
  if (appPath.startsWith('/Applications/')) throw new Error(`refusing to run ${appPath}: measure a build, not the installed app`);
  const actual = realpathSync(appPath);
  if (actual.startsWith('/Applications/')) throw new Error(`refusing to run ${actual}: measure a build, not the installed app`);
  if (source) {
    const pkg = JSON.parse(readFileSync(path.join(actual, 'package.json'), 'utf8'));
    if (pkg.name !== 'droid-office' || pkg.main !== 'dist/desktop/main.js' || !existsSync(path.join(actual, pkg.main))) throw new Error('source must be a built Droid Office checkout: run npm run build first');
  }
  const exe = source ? createRequire(path.join(actual, 'package.json'))('electron') : path.join(actual, 'Contents/MacOS/Droid Office');
  if (!existsSync(exe)) throw new Error(`no app at ${exe}`);
  return { exe, prefix: source ? [actual] : [] };
}

export async function launchApp({ app, source, clone, userData, debugPort, log, signal }) {
  signal?.throwIfAborted();
  const port = clonePort(clone);
  const resolved = isolatedProfile(userData);
  const { exe, prefix } = appCommand({ app, source });
  const office = await fetch(`http://127.0.0.1:${port}/`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!office) throw new Error(`the clone is not running on :${port}: start ${path.join(clone, 'start.sh')} first`);
  signal?.throwIfAborted();
  mkdirSync(resolved, { recursive: true });
  writeFileSync(path.join(resolved, 'settings.json'), `${JSON.stringify({ officeDir: path.join(clone, 'office'), port })}\n`);
  const out = log ?? path.join(resolved, 'app.log');
  const logFd = (await import('node:fs')).openSync(out, 'a');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [...prefix, `--user-data-dir=${resolved}`, `--remote-debugging-port=${debugPort}`], { env, stdio: ['ignore', logFd, logFd], detached: true });
  closeSync(logFd);
  const quit = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  };
  let interrupted = false,
    spawnError;
  const interrupt = () => {
    interrupted = true;
    quit();
  };
  child.once('error', (error) => {
    spawnError = error;
  });
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  signal?.addEventListener('abort', interrupt, { once: true });
  const deadline = Date.now() + 60_000;
  try {
    for (;;) {
      if (interrupted || spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error(`the app exited (${spawnError ?? child.exitCode ?? child.signalCode}); see ${out}`);
      try {
        const targets = await getJson(debugPort, '/json');
        if (targets.some((t) => t.type === 'page' && nativeClonePage(t.url, port))) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`the app showed no page on :${port} in time; see ${out}`);
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (error) {
    quit();
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    signal?.removeEventListener('abort', interrupt);
  }
  return {
    port,
    url: `http://localhost:${port}`,
    pid: child.pid,
    quit,
  };
}

// node tools/frame-bench/launch.mjs --app <Droid Office.app> --clone <dir> [--user-data <dir>] [--debug-port 9333]
// Starts the app and keeps it up until this process is stopped, for driving it by hand through the DevTools port.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const app = arg('app');
  const source = arg('source');
  const clone = arg('clone');
  if ((!app && !source) || (app && source) || !clone) {
    console.error('usage: launch.mjs (--app <Droid Office.app> | --source <built checkout>) --clone <office clone> [--user-data <fresh dir>] [--debug-port 9333]');
    process.exit(1);
  }
  const running = await launchApp({ app, source, clone, userData: arg('user-data') ?? mkdtempSync(path.join(os.tmpdir(), 'droid-office-bench-userdata-')), debugPort: Number(arg('debug-port', '9333')) });
  console.log(`running ${running.url} (pid ${running.pid}); stop this process to quit it`);
  const stop = () => {
    running.quit();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
}
