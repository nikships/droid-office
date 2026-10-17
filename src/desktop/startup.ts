import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, dialog } from 'electron';
import { requirePresenter } from './native.js';
import { checkRequirements, type Machine } from './requirements.js';
import { formatStartupFailure, nativeModuleFailure, type StartupFailure } from './startup-failure.js';

/** Set by CI and nothing else: the packaged app starts, checks and exits without a window or a dialog (`--startup-check`). */
export const STARTUP_CHECK_FLAG = '--startup-check';

export function isStartupCheck(argv: readonly string[] = process.argv): boolean {
  return argv.includes(STARTUP_CHECK_FLAG);
}

function chipBrand(): string | undefined {
  try {
    return execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
}

export function readMachine(env: NodeJS.ProcessEnv = process.env): Machine {
  return { platform: process.platform, arch: process.arch, release: os.release(), brand: chipBrand(), allowAnyChip: env.DROID_OFFICE_ALLOW_ANY_CHIP === '1' };
}

/** Thrown by `failStartup` after it has asked the app to exit: the startup code in flight must not carry on. */
export class StartupAborted extends Error {
  constructor(readonly failure: StartupFailure) {
    super(`startup failed: ${failure.kind}`);
  }
}

/** Appends a failure to `startup.log`; the log is a courtesy, the dialog is the report. */
export function logStartupFailure(failure: StartupFailure): void {
  try {
    const logs = app.getPath('logs');
    mkdirSync(logs, { recursive: true });
    appendFileSync(path.join(logs, 'startup.log'), `${new Date().toISOString()} [${failure.kind}] ${formatStartupFailure(failure)}\n\n`);
  } catch {
    // Nothing to do about a log that can't be written.
  }
}

/**
 * Shows why the app can't run and quits, with exit code 1. Every startup failure goes through here: the Mac app
 * has one way to draw, so a missing piece is an error the user reads, never a quieter mode. Call it once the app is
 * ready (a dialog needs that), and let its `StartupAborted` propagate to `main.ts`, which swallows it. With `--startup-check` it prints to stderr instead of opening a dialog.
 */
export function failStartup(failure: StartupFailure): never {
  const text = formatStartupFailure(failure);
  logStartupFailure(failure);
  if (isStartupCheck()) {
    process.stderr.write(`startup failure [${failure.kind}]: ${text}\n`);
  } else {
    dialog.showMessageBoxSync({ type: 'error', message: failure.title, detail: failure.detail, buttons: ['Quit'], defaultId: 0 });
  }
  app.exit(1);
  // app.exit() returns before the process is gone, so the caller must stop running at once.
  throw new StartupAborted(failure);
}

/** Refuses to go on unless this is macOS 14+ on Apple silicon with a Pro, Max or Ultra chip. */
export function enforceRequirements(machine: Machine = readMachine()): void {
  const failure = checkRequirements(machine);
  if (failure) failStartup(failure);
}

/** Loads a native module, or fails startup with the load error. */
export function loadNative<T>(load: () => T): T {
  try {
    return load();
  } catch (err) {
    return failStartup(nativeModuleFailure(err));
  }
}

/**
 * What CI runs the packaged app with: the gates, the presenter module loaded from the bundle, its `probe()` (a Metal device,
 * an IOSurface import and a CAMetalLayer, with no window), then a one-line report on stdout and exit 0. A module that won't
 * load, or a probe that throws, exits 1 through `failStartup`, as the app itself would.
 */
export function runStartupCheck(): void {
  const machine = readMachine();
  const presenter = loadNative(() => {
    const exports = requirePresenter(app.getAppPath());
    if (typeof exports.probe !== 'function') throw new Error('the presenter module has no probe()');
    return { exports: Object.keys(exports).sort(), probe: (exports.probe as () => unknown)() };
  });
  const report = { chip: machine.brand ?? null, arch: machine.arch, darwin: machine.release, electron: process.versions.electron, presenter };
  process.stdout.write(`startup-check ok: ${JSON.stringify(report)}\n`);
  app.exit(0);
}
