import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright-core';
import { runAsNode } from './workers.js';

/**
 * The browser behind the Whiteboard's renderer: a headless Chromium driven by playwright-core,
 * installed into one folder that every install and launch shares. Nothing here is needed to start
 * the office. A missing download, missing libraries or a blocked sandbox are reported as status
 * and as errors that say how to fix them.
 */

/** playwright-core's own name for what the office runs: the headless build of Chromium. */
const SHELL = 'chromium-headless-shell';
/** The install command's arguments. `--only-shell` skips the full Chrome for Testing, which the renderer never starts. */
const INSTALL_ARGS = ['install', '--only-shell', 'chromium'];
/** A download that has not finished by then is stuck. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL = 4000;

export interface BrowsersPathEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * The one folder the office, its installers and the Mac app download Chromium into and launch it from
 * (PLAYWRIGHT_BROWSERS_PATH, for the commands the office runs). Dedicated to the office, so that
 * Playwright's own cleanup of old revisions never touches a browser someone else installed.
 * DROID_OFFICE_BROWSERS_PATH moves it. The installers don't repeat this logic: they run
 * `droid-office browser install`, which resolves it here.
 */
export function browsersPath({ platform = process.platform, env = process.env, home = os.homedir() }: BrowsersPathEnv = {}): string {
  const override = env.DROID_OFFICE_BROWSERS_PATH?.trim();
  if (override) return path.resolve(override.startsWith('~') ? path.join(home, override.slice(1)) : override);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(local, 'droid-office', 'browsers');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Caches', 'droid-office', 'browsers');
  const xdg = env.XDG_CACHE_HOME?.trim();
  return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, '.cache'), 'droid-office', 'browsers');
}

const require = createRequire(import.meta.url);
const packageDir = () => path.dirname(require.resolve('playwright-core/package.json'));
/** playwright-core's bundled command line: the one that downloads this release's browser. */
export const playwrightCli = () => path.join(packageDir(), 'cli.js');

export interface Pinned {
  /** playwright-core's revision of the browser, which names its folder. */
  revision: string;
  /** The Chromium version that revision is. */
  version: string;
}

/** The headless Chromium this playwright-core release expects, from its browsers.json. */
export function pinnedBrowser(): Pinned {
  const list = JSON.parse(readFileSync(path.join(packageDir(), 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string; browserVersion?: string }[] };
  const entry = list.browsers.find((b) => b.name === SHELL);
  if (!entry) throw new Error(`playwright-core lists no ${SHELL} to install`);
  return { revision: entry.revision, version: entry.browserVersion ?? '' };
}

/** Where playwright-core puts a revision of the headless shell inside the browsers folder. */
export function revisionDir(folder: string, revision: string): string {
  return path.join(folder, `${SHELL.replace(/-/g, '_')}-${revision}`);
}

/** The browser's executable inside its revision folder: `<platform folder>/chrome-headless-shell[.exe]`. */
function findExecutable(dir: string): string | null {
  const name = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name, name);
      if (entry.isDirectory() && existsSync(file)) return file;
    }
  } catch {}
  return null;
}

export type BrowserErrorKind = 'not-installed' | 'download-failed' | 'missing-libraries' | 'sandbox-blocked' | 'sandbox-root' | 'other';

export interface BrowserFailure {
  kind: BrowserErrorKind;
  /** What went wrong, in a sentence. */
  summary: string;
  /** How to fix it, or '' when there is nothing to tell (an error nobody has seen before is shown as it came). */
  fix: string;
  /** The error as the browser or Playwright printed it. */
  detail: string;
  /** When it happened (ms since the epoch). */
  at: number;
}

/** An error from installing or starting the browser, with what to do about it. */
export class BrowserError extends Error {
  readonly kind: BrowserErrorKind;
  readonly summary: string;
  readonly fix: string;
  readonly detail: string;
  constructor(f: Omit<BrowserFailure, 'at'>) {
    super(f.kind === 'other' ? f.detail : [f.summary, f.fix].filter(Boolean).join('\n\n'));
    this.name = 'BrowserError';
    this.kind = f.kind;
    this.summary = f.summary;
    this.fix = f.fix;
    this.detail = f.detail;
  }
}

/** The command that downloads the browser, as someone would type it. */
export function installCommand(): string {
  return 'droid-office browser install';
}

/** The command that installs Chromium's system libraries, which needs admin rights. */
export function installDepsCommand(node = process.execPath, cli = playwrightCli()): string {
  return `sudo "${node}" "${cli}" install-deps chromium`;
}

/** The commands that let the browser use unprivileged user namespaces under AppArmor. */
export function apparmorCommand(): string {
  return ['droid-office browser apparmor-profile | sudo tee /etc/apparmor.d/droid-office-chromium', 'sudo apparmor_parser -r /etc/apparmor.d/droid-office-chromium'].join('\n');
}

export interface Classify {
  platform?: NodeJS.Platform;
  /** What to run to install the libraries (a test fixes it). */
  depsCommand?: string;
}

/** Turns what Playwright or Chromium said when starting failed into the failure it is, with its fix. */
export function classifyLaunchError(message: string, { platform = process.platform, depsCommand }: Classify = {}): Omit<BrowserFailure, 'at'> {
  const detail = message.trim();
  if (/Executable doesn't exist/i.test(detail)) {
    return {
      kind: 'not-installed',
      summary: "Chromium isn't downloaded yet, so cards can't be rendered.",
      fix: `Download it (about 100 MB, no admin rights needed) with:\n  ${installCommand()}`,
      detail,
    };
  }
  if (/No usable sandbox|setuid sandbox|SUID sandbox|Failed to move to new namespace|user namespace|apparmor/i.test(detail) && platform === 'linux') {
    return {
      kind: 'sandbox-blocked',
      summary: "Chromium's sandbox is blocked: this Linux restricts unprivileged user namespaces (Ubuntu 23.10 and later do, through AppArmor). The office never turns the sandbox off.",
      fix: `With admin rights, install an AppArmor profile for the browser (deploy/provision.sh does this on an AWS box):\n  ${apparmorCommand().split('\n').join('\n  ')}`,
      detail,
    };
  }
  if (/Running as root without --no-sandbox/i.test(detail)) {
    return {
      kind: 'sandbox-root',
      summary: "Chromium's sandbox doesn't run as root, and the office never turns the sandbox off.",
      fix: 'Run the office as a regular user.',
      detail,
    };
  }
  if (/error while loading shared libraries|cannot open shared object file|Host system is missing dependencies|install-deps/i.test(detail)) {
    return {
      kind: 'missing-libraries',
      summary: 'Chromium needs system libraries this machine does not have.',
      fix: `With admin rights, install them with:\n  ${depsCommand ?? installDepsCommand()}`,
      detail,
    };
  }
  return { kind: 'other', summary: 'Chromium did not start.', fix: '', detail };
}

/** Turns what the download command printed into the failure it is. */
export function classifyInstallError(output: string): Omit<BrowserFailure, 'at'> {
  const detail = output.trim() || 'the download command failed without saying why';
  const network = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|Download fail|socket hang up|timed out|proxy|certificate/i.test(detail);
  return {
    kind: 'download-failed',
    summary: network ? "Chromium couldn't be downloaded: the download server wasn't reachable." : "Chromium couldn't be downloaded.",
    fix: `Check your network (a proxy goes in HTTPS_PROXY), then try again with:\n  ${installCommand()}`,
    detail,
  };
}

export interface BrowserStatus {
  installed: boolean;
  /** The revision of Chromium this playwright-core expects. */
  revision: string;
  /** The Chromium version that revision is. */
  version: string;
  /** The shared folder the browser is installed in. */
  path: string;
  /** The browser's executable, once installed. */
  executable: string | null;
  /** A download is running. */
  installing: boolean;
  /** The last install or launch failure, until one succeeds. */
  lastError: BrowserFailure | null;
}

let lastError: BrowserFailure | null = null;
const fail = (f: Omit<BrowserFailure, 'at'>): BrowserError => {
  lastError = { ...f, at: Date.now() };
  return new BrowserError(f);
};

/** Whether the pinned browser is installed, and the last thing that went wrong with it. Never throws. */
export function browserStatus(): BrowserStatus {
  const folder = browsersPath();
  let pinned: Pinned = { revision: '', version: '' };
  try {
    pinned = pinnedBrowser();
  } catch (err) {
    lastError ??= { kind: 'other', summary: "Chromium's version couldn't be read.", fix: '', detail: (err as Error).message, at: Date.now() };
  }
  const dir = pinned.revision ? revisionDir(folder, pinned.revision) : '';
  // playwright-core writes this file last, so a download that was interrupted doesn't count.
  const installed = dir !== '' && existsSync(path.join(dir, 'INSTALLATION_COMPLETE'));
  return { installed, ...pinned, path: folder, executable: installed ? findExecutable(dir) : null, installing: installing !== null, lastError };
}

export interface InstallProgress {
  phase: 'starting' | 'downloading' | 'done';
  /** 0 to 100 of the file being downloaded now. */
  percent?: number;
  /** A line the window can show. */
  message: string;
}

export interface EnsureOptions {
  onProgress?: (p: InstallProgress) => void;
  /** What downloads the browser into the folder; playwright-core's CLI unless a test stands in for it. */
  install?: (folder: string, emit: (p: InstallProgress) => void) => Promise<void>;
}

let installing: { done: Promise<BrowserStatus>; listeners: Set<(p: InstallProgress) => void>; last: InstallProgress } | null = null;

const PERCENT = /(\d{1,3})% of ([\d.]+ [KMG]iB)/;
const DOWNLOADING = /Downloading (.+?)(?: from |$)/;

/** The progress a line of the download command's output stands for, if any. */
export function parseProgress(line: string, what = 'Chromium'): InstallProgress | null {
  const bar = PERCENT.exec(line);
  if (bar) return { phase: 'downloading', percent: Math.min(100, Number(bar[1])), message: `Downloading ${what}: ${bar[1]}% of ${bar[2]}` };
  const start = DOWNLOADING.exec(line.replace(/\u001b\[[0-9;]*m/g, ''));
  if (start) return { phase: 'downloading', message: `Downloading ${downloadName(start[1])}` };
  return null;
}

/** What the window calls a download: the browser, or the small helper (FFmpeg) that comes with it. */
function downloadName(line: string): string {
  return /chrom/i.test(line) ? 'Chromium' : (line.split(' ')[0] ?? 'Chromium');
}

/** Runs playwright-core's CLI with the office's own Node (Electron's, as Node, inside the Mac app). */
function runInstall(folder: string, emit: (p: InstallProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const asNode = runAsNode().sh ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    // No sudo and no `--with-deps`: the download is a user-owned folder. Libraries are a separate step.
    const child = spawn(process.execPath, [playwrightCli(), ...INSTALL_ARGS], {
      env: { ...process.env, ...asNode, PLAYWRIGHT_BROWSERS_PATH: folder },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let tail = '';
    let pending = '';
    let what = 'Chromium';
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-OUTPUT_TAIL);
      const lines = (pending + text).split(/[\r\n]+/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const p = parseProgress(line, what);
        if (!p) continue;
        if (p.percent === undefined) what = p.message.slice('Downloading '.length);
        emit(p);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      tail += '\nthe download took more than 15 minutes and was stopped';
      child.kill('SIGKILL');
    }, INSTALL_TIMEOUT_MS);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(err.message));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(tail.trim() || `exit ${code ?? signal}`));
    });
  });
}

/**
 * Downloads the pinned Chromium into the shared folder unless it is there already. One download runs
 * at a time: a call made during one joins it, and its progress goes to every caller's `onProgress`.
 * Rejects with a BrowserError, which is also kept as `browserStatus().lastError`.
 */
export function ensureBrowser({ onProgress, install = runInstall }: EnsureOptions = {}): Promise<BrowserStatus> {
  const status = browserStatus();
  if (status.installed) return Promise.resolve(status);
  if (installing) {
    if (onProgress) {
      installing.listeners.add(onProgress);
      onProgress(installing.last);
    }
    return installing.done;
  }
  const listeners = new Set<(p: InstallProgress) => void>();
  if (onProgress) listeners.add(onProgress);
  const state = { done: Promise.resolve(status), listeners, last: { phase: 'starting', message: 'Starting the Chromium download' } as InstallProgress };
  const emit = (p: InstallProgress) => {
    state.last = p;
    for (const fn of listeners) {
      try {
        fn(p);
      } catch {}
    }
  };
  state.done = (async () => {
    emit(state.last);
    try {
      await install(status.path, emit);
    } catch (err) {
      throw fail(classifyInstallError((err as Error).message));
    }
    const after = { ...browserStatus(), installing: false };
    if (!after.installed) throw fail(classifyInstallError(`the download finished, but ${revisionDir(after.path, after.revision)} is incomplete`));
    lastError = null;
    emit({ phase: 'done', percent: 100, message: 'Chromium is installed' });
    return after;
  })().finally(() => {
    installing = null;
  });
  installing = state;
  // The caller may only be watching progress; a failure is still in `lastError`.
  state.done.catch(() => {});
  return state.done;
}

/**
 * Starts the download in the background when the browser is missing, and costs a folder check when it
 * isn't. For the office to call once at start; never throws and never delays anything.
 */
export function warmBrowser(onProgress?: (p: InstallProgress) => void): void {
  if (browserStatus().installed) return;
  ensureBrowser({ onProgress }).catch(() => {});
}

let browser: Promise<Browser> | null = null;

/**
 * The one headless Chromium for every render, started on first use and again if it dies. Its OS
 * sandbox is on, which Playwright's default is not, and there is no fallback to `--no-sandbox`. A
 * failure rejects with a BrowserError that says how to fix it.
 */
export function launchBrowser(): Promise<Browser> {
  if (browser) return browser;
  const started = (async () => {
    const status = browserStatus();
    if (!status.installed || !status.executable) {
      throw fail(classifyLaunchError(`Executable doesn't exist in ${status.path} (chromium-headless-shell ${status.revision} is not downloaded)`));
    }
    let playwright: typeof import('playwright-core');
    try {
      playwright = await import('playwright-core');
    } catch (err) {
      throw fail({ kind: 'other', summary: "Playwright couldn't be loaded.", fix: '', detail: (err as Error).message });
    }
    try {
      // The executable is named, so the launch never looks anywhere but the shared folder.
      const b = await playwright.chromium.launch({ headless: true, chromiumSandbox: true, executablePath: status.executable });
      lastError = null;
      b.once('disconnected', () => {
        if (browser === started) browser = null;
      });
      return b;
    } catch (err) {
      throw fail(classifyLaunchError((err as Error).message));
    }
  })();
  browser = started;
  started.catch(() => {
    if (browser === started) browser = null;
  });
  return started;
}

/** Stops the shared browser, if one is running. */
export async function closeBrowser(): Promise<void> {
  const running = browser;
  browser = null;
  if (!running) return;
  try {
    await (await running).close();
  } catch {}
}

export type IsolatedContextOptions = Omit<BrowserContextOptions, 'permissions' | 'serviceWorkers' | 'acceptDownloads' | 'storageState' | 'recordVideo' | 'recordHar'>;

/**
 * A fresh context for one render: no permission granted (camera, microphone, geolocation, clipboard and
 * the rest stay denied), no service workers, no downloads (a download is cancelled, never written to disk),
 * and no cookies or storage carried over from any other context.
 */
export function newIsolatedContext(b: Browser, options: IsolatedContextOptions = {}): Promise<BrowserContext> {
  return b.newContext({ ...options, permissions: [], serviceWorkers: 'block', acceptDownloads: false });
}

/**
 * The AppArmor profile that lets this folder's Chromium use unprivileged user namespaces, which its
 * sandbox needs on Ubuntu 23.10 and later. It covers any revision, so an upgrade needs no new profile.
 */
export function apparmorProfile(folder = browsersPath()): string {
  const escaped = folder.replace(/[\\"*?[\]{}^,]/g, '\\$&').replace(/\/+$/, '');
  const profile = (name: string, glob: string) => `profile ${name} "${escaped}/${glob}" flags=(unconfined) {\n  userns,\n\n  include if exists <local/${name}>\n}`;
  return [
    '# Droid Office: lets the Chromium the Whiteboard renders with use unprivileged user namespaces, which its sandbox needs.',
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    profile('droid-office-chromium-shell', 'chromium_headless_shell-*/*/chrome-headless-shell'),
    '',
    profile('droid-office-chromium', 'chromium-*/*/chrome'),
    '',
  ].join('\n');
}

const BROWSER_HELP = `Usage: droid-office browser <command>

The Chromium the Whiteboard renders cards with.

Commands:
  install           Download it into the shared folder (about 100 MB, no admin rights)
  status [--json]   Say whether it is installed
  path              Print the shared folder (env DROID_OFFICE_BROWSERS_PATH moves it)
  apparmor-profile  Print the AppArmor profile Ubuntu 23.10+ needs for its sandbox
`;

/** `droid-office browser …`, for the installers, the Mac app and anyone fixing a host by hand. Resolves to the exit code. */
export async function browserCommand(args: string[], out: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'install': {
      let last = -1;
      try {
        const s = await ensureBrowser({
          onProgress: (p) => {
            // A line per tenth, so a log or an install script isn't flooded.
            const step = p.percent === undefined ? -1 : Math.floor(p.percent / 10);
            if (p.percent === undefined ? p.phase !== 'done' : step !== last) out(`${p.message}\n`);
            last = step;
          },
        });
        out(`Chromium ${s.version} is installed in ${s.path}\n`);
        return 0;
      } catch (err) {
        process.stderr.write(`droid-office: ${(err as Error).message}\n`);
        if (err instanceof BrowserError && err.kind !== 'other') process.stderr.write(`\n${err.detail.split('\n').slice(-6).join('\n')}\n`);
        return 1;
      }
    }
    case 'status': {
      const s = browserStatus();
      out(rest.includes('--json') ? `${JSON.stringify(s)}\n` : `${s.installed ? 'installed' : 'not installed'}: Chromium ${s.version} (revision ${s.revision}) in ${s.path}\n`);
      return 0;
    }
    case 'path':
      out(`${browsersPath()}\n`);
      return 0;
    case 'apparmor-profile':
      out(`${apparmorProfile()}\n`);
      return 0;
    case '-h':
    case '--help':
    case undefined:
      out(BROWSER_HELP);
      return cmd === undefined ? 2 : 0;
    default:
      process.stderr.write(`droid-office: unknown browser command "${cmd}"\n\n${BROWSER_HELP}`);
      return 2;
  }
}
