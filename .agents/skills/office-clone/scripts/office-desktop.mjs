// Native accessibility alongside window.office, scoped to the runner's own Electron PID.
// No app-name guessing, physical input, automatic retries or app lifecycle commands.
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function desktopCommand(args, env = process.env) {
  let stdout;
  try {
    ({ stdout } = await exec('agent-desktop', args, { env, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    if (!error.stdout) throw error;
    stdout = error.stdout;
  }
  const result = JSON.parse(stdout);
  if (!result.ok) {
    const error = new Error(`agent-desktop ${args[0]}: ${result.error.code}: ${result.error.message}`);
    Object.assign(error, result.error);
    throw error;
  }
  return result.data;
}

export async function checkDesktop(run = desktopCommand) {
  const status = await run(['status']);
  if (status.platform !== 'macos') throw new Error('--desktop currently requires macOS');
  if (status.permissions?.accessibility?.state !== 'granted') throw new Error('agent-desktop needs Accessibility permission; run agent-desktop permissions --guide');
  return status;
}

export function desktopWindow(windows, pid, windowId) {
  const matches = windows.filter((w) => w.pid === pid && w.visible && (!windowId || w.id === windowId));
  if (matches.length !== 1) throw new Error(`expected one window for clone PID ${pid}, got ${matches.length}; use desktop.windows() and pass windowId explicitly`);
  return matches[0];
}

function observationTimeout(value = 3000) {
  if (!Number.isFinite(value) || value <= 0) throw new Error('timeoutMs must be positive milliseconds');
  return String(value);
}

/** All returned refs live in a fresh session; callers must observe again after a UI change. */
export async function createDesktop({ pid, out, run = desktopCommand }) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('desktop requires the launched clone PID');
  const stateRoot = mkdtempSync(path.join(out, 'desktop-'));
  const env = { ...process.env, AGENT_DESKTOP_HOME: stateRoot };
  // Never inherit another worker's session, trace or agent identity.
  delete env.AGENT_DESKTOP_SESSION;
  delete env.AGENT_DESKTOP_AGENT_ID;
  const session = await run(['session', 'start', '--name', `office-clone-${pid}`], env);
  const call = (args) => run(['--session', session.session_id, ...args], env);
  const refs = new Set();
  const remember = (data) => {
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.ref_id === 'string') refs.add(value.ref_id);
      for (const child of Object.values(value)) visit(child);
    };
    visit(data);
    return data;
  };
  const ownRef = (ref) => {
    if (!refs.has(ref)) throw new Error('use a ref returned by this desktop session');
    return ref;
  };
  const windows = async () => (await call(['list-windows'])).filter((w) => w.pid === pid);
  const scope = async ({ windowId, surface, root } = {}) => {
    if (root) {
      if (surface || windowId) throw new Error('root cannot combine with surface or windowId');
      return ['--root', ownRef(root)];
    }
    const window = desktopWindow(await windows(), pid, windowId);
    return ['--window-id', window.id, ...(surface ? ['--surface', surface] : [])];
  };
  return {
    pid,
    stateRoot,
    session: session.session_id,
    windows,
    snapshot: async (options = {}) => {
      const args = ['snapshot', ...(await scope(options)), '-i', '--compact', '--timeout-ms', observationTimeout(options.timeoutMs)];
      // Menus and sheets are already small, focused surfaces, never skeleton them.
      if (options.skeleton && !options.surface) args.push('--skeleton');
      return remember(await call(args));
    },
    find: async (options = {}) => {
      const args = ['find', ...(await scope(options)), '--limit', '2', '--timeout-ms', observationTimeout(options.timeoutMs ?? 5000)];
      for (const key of ['role', 'name', 'value', 'text']) if (options[key] !== undefined) args.push(`--${key}`, String(options[key]));
      if (options.exact) args.push('--exact');
      return remember(await call(args));
    },
    get: (ref, property = 'text') => call(['get', ownRef(ref), '--property', property]),
    is: (ref, property = 'visible') => call(['is', ownRef(ref), '--property', property]),
    click: (ref) => call(['click', ownRef(ref)]),
    select: (ref, value) => call(['select', ownRef(ref), '--', String(value)]),
    setValue: (ref, value) => call(['set-value', ownRef(ref), '--', String(value)]),
    shot: async (name, windowId) => {
      const file = path.resolve(out, `${String(name).replace(/\.png$/, '')}.png`);
      if (!file.startsWith(path.resolve(out) + path.sep)) throw new Error('desktop screenshot must stay inside the output folder');
      const window = desktopWindow(await windows(), pid, windowId);
      return call(['screenshot', '--window-id', window.id, file]);
    },
    close: async () => {
      try {
        await call(['trace', 'export', '--out', path.join(stateRoot, 'trace.html')]);
      } finally {
        await call(['session', 'end', session.session_id]);
      }
    },
  };
}
