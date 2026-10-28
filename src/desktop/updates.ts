import { appendFileSync } from 'node:fs';
import { app, type BaseWindow, autoUpdater as squirrel } from 'electron';
import updater from 'electron-updater';
import { UpdateController } from './update-controller.js';
import { type UpdatePhase, updateView } from './update-view.js';
import { UpdateWindow } from './update-window.js';

const { autoUpdater, CancellationToken } = updater;

const CHECK_EVERY_MS = 30 * 60_000;

export interface UpdatesOptions {
  log: string;
  /** Runs before the app quits to install an update: stops the office, keeping its workers. */
  beforeInstall: () => Promise<void>;
  /** The office window, which the update window opens on as a sheet. */
  parent: () => BaseWindow | undefined;
}

/**
 * Keeps the app on the newest GitHub release. Checks at launch and every half hour, and when one
 * is out, opens a single window that offers it, downloads it with a progress bar, and restarts
 * into it. Nothing downloads until the owner chooses Install and Restart.
 */
export class Updates {
  private timer?: NodeJS.Timeout;
  private initial?: NodeJS.Timeout;
  private window?: UpdateWindow;
  private checkedVersion?: string;
  readonly controller: UpdateController;

  constructor(private readonly o: UpdatesOptions) {
    const write = (level: string) => (msg: unknown) => {
      try {
        appendFileSync(o.log, `${new Date().toISOString()} ${level} ${String(msg)}\n`);
      } catch {
        // logging is best-effort
      }
    };
    autoUpdater.logger = { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
    autoUpdater.autoDownload = false;
    // On macOS this also hands the download to Squirrel.Mac as soon as it's done, which is what
    // lets the app restart into the update without a second wait.
    autoUpdater.autoInstallOnAppQuit = true;
    this.controller = new UpdateController({
      enabled: app.isPackaged,
      currentVersion: app.getVersion(),
      check: async () => {
        const result = await autoUpdater.checkForUpdates();
        this.checkedVersion = result?.isUpdateAvailable ? result.updateInfo.version : undefined;
        return this.checkedVersion;
      },
      download: (version, preparing) => {
        if (version !== this.checkedVersion) throw new Error('The offered update changed. Check for updates again before installing.');
        const token = new CancellationToken();
        const ready = squirrelReady();
        const promise = (async () => {
          try {
            await autoUpdater.downloadUpdate(token);
            if (token.cancelled) return;
            preparing();
            await ready.promise;
          } finally {
            ready.dispose();
          }
        })();
        return {
          promise,
          cancel: () => {
            token.cancel();
            ready.dispose();
          },
        };
      },
      beforeInstall: o.beforeInstall,
      quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
      render: (phase, open) => this.show(phase, open),
      close: () => this.window?.close(),
    });
    autoUpdater.on('download-progress', (p) => {
      this.controller.progress(p.transferred, p.total);
    });
  }

  /** Only a packaged app updates itself; `npm run desktop` runs whatever the checkout has. */
  get enabled(): boolean {
    return app.isPackaged;
  }

  start() {
    if (!this.enabled) return;
    this.stop();
    this.initial = setTimeout(() => void this.check(false), 10_000);
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.initial);
  }

  /** `manual` is the menu's Check for Updates…: it always opens the window and says what it found. */
  check(manual: boolean) {
    const checking = this.controller.check(manual);
    if (manual) this.window?.focus();
    return checking;
  }

  private show(phase: UpdatePhase, open: boolean) {
    if (!open && !this.window?.open) return;
    if (!this.window?.open) {
      const opened: UpdateWindow = new UpdateWindow({
        parent: this.o.parent(),
        onAction: (action) => this.controller.act(action),
        onClosed: () => this.closed(opened),
      });
      this.window = opened;
    }
    this.window.render(updateView(phase, app.getVersion()));
  }

  private closed(closed: UpdateWindow) {
    // A window closing just as the next phase opened a new one.
    if (this.window !== closed) return;
    this.window = undefined;
    this.controller.closed();
  }
}

/**
 * Squirrel.Mac's own "update-downloaded": electron-updater's download resolves once Squirrel has
 * the zip, but Squirrel still verifies its signature before it can install it.
 */
function squirrelReady(): { promise: Promise<void>; dispose: () => void } {
  if (process.platform !== 'darwin') return { promise: Promise.resolve(), dispose: () => {} };
  let dispose = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const ok = () => {
      dispose();
      resolve();
    };
    const fail = (err: Error) => {
      dispose();
      reject(err);
    };
    dispose = () => {
      squirrel.off('update-downloaded', ok);
      squirrel.off('error', fail);
    };
    squirrel.on('update-downloaded', ok);
    squirrel.on('error', fail);
  });
  promise.catch(() => {});
  return { promise, dispose };
}
