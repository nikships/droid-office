// Starts a packaged Droid Office on its own userData, shown
// against a clone of the owner's office, with a DevTools port to drive it. It never touches the installed app, the
// owner's data or the owner's office on :4600.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getJson } from './cdp.mjs';

const OWNER_DATA = path.join(os.homedir(), 'Library/Application Support/com.nikships.droid-office');

/** The port a clone's start.sh serves on. Refuses anything that is not a clone, and :4600. */
export function clonePort(clone) {
  const start = path.join(clone, 'start.sh');
  if (!existsSync(start)) throw new Error(`${clone} is not an office clone (no start.sh): make one with .agents/skills/office-clone/scripts/clone-office.sh`);
  const port = Number(/--port (\d+)/.exec(readFileSync(start, 'utf8'))?.[1]);
  if (!port || port === 4600) throw new Error(`refusing port ${port || '?'}: this only drives a clone, never the owner's office`);
  return port;
}

export async function launchApp({ app, clone, userData, debugPort, log }) {
  const port = clonePort(clone);
  const resolved = path.resolve(userData);
  if (resolved === OWNER_DATA || resolved.startsWith(`${OWNER_DATA}${path.sep}`)) throw new Error(`refusing the owner's userData ${resolved}`);
  const appPath = path.resolve(app);
  if (appPath.startsWith('/Applications/')) throw new Error(`refusing to run ${appPath}: measure a build, not the installed app`);
  const exe = path.join(appPath, 'Contents/MacOS/Droid Office');
  if (!existsSync(exe)) throw new Error(`no app at ${exe}`);
  const office = await fetch(`http://127.0.0.1:${port}/`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!office) throw new Error(`the clone is not running on :${port}: start ${path.join(clone, 'start.sh')} first`);
  rmSync(resolved, { recursive: true, force: true });
  mkdirSync(resolved, { recursive: true });
  writeFileSync(path.join(resolved, 'settings.json'), `${JSON.stringify({ officeDir: path.join(clone, 'office'), port })}\n`);
  const out = log ?? path.join(resolved, 'app.log');
  const logFd = (await import('node:fs')).openSync(out, 'a');
  const child = spawn(exe, [`--user-data-dir=${resolved}`, `--remote-debugging-port=${debugPort}`], { env: process.env, stdio: ['ignore', logFd, logFd], detached: true });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the app exited (${child.exitCode}); see ${out}`);
    try {
      const targets = await getJson(debugPort, '/json');
      if (targets.some((t) => t.type === 'page' && t.url.startsWith(`http://localhost:${port}`))) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`the app showed no page on :${port} in time; see ${out}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  return {
    port,
    url: `http://localhost:${port}`,
    pid: child.pid,
    quit() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    },
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
  const clone = arg('clone');
  if (!app || !clone) {
    console.error('usage: launch.mjs --app <Droid Office.app> --clone <office clone> [--user-data <dir>] [--debug-port 9333]');
    process.exit(1);
  }
  const running = await launchApp({ app, clone, userData: arg('user-data', path.join(os.tmpdir(), 'droid-office-bench-userdata')), debugPort: Number(arg('debug-port', '9333')) });
  console.log(`running ${running.url} (pid ${running.pid}); stop this process to quit it`);
  const stop = () => {
    running.quit();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
}
