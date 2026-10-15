import { appendFileSync } from 'node:fs';
import { app, type BaseWindow, autoUpdater as squirrel } from 'electron';
import updater from 'electron-updater';
import { briefError, type UpdateAction, type UpdatePhase, updateBusy, updateView } from './update-view.js';
import { UpdateWindow } from './update-window.js';

const { autoUpdater, CancellationToken } = updater;
type Token = InstanceType<typeof CancellationToken>;

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
  private window?: UpdateWindow;
  private phase?: UpdatePhase;
  private download?: Token;
  /** Versions the owner chose Later for, which the background checks don't offer again this run. */
  private dismissed = new Set<string>();

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
    autoUpdater.on('download-progress', (p) => {
      if (this.phase?.kind === 'downloading') this.show({ ...this.phase, transferred: p.transferred, total: p.total });
    });
  }

  /** Only a packaged app updates itself; `npm run desktop` runs whatever the checkout has. */
  get enabled(): boolean {
    return app.isPackaged;
  }

  start() {
    if (!this.enabled) return;
    setTimeout(() => void this.check(false), 10_000);
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** `manual` is the menu's Check for Updates…: it always opens the window and says what it found. */
  async check(manual: boolean) {
    if (this.phase && updateBusy(this.phase)) {
      if (manual) {
        this.show(this.phase);
        this.window?.focus();
      }
      return;
    }
    if (!manual && this.window?.open) return;
    if (!this.enabled) {
      if (manual) this.show({ kind: 'unpackaged' });
      return;
    }
    if (manual) this.show({ kind: 'checking' });
    try {
      const result = await autoUpdater.checkForUpdates();
      // The owner closed the window while it checked, or a manual check took over a background one.
      if (manual ? !this.window?.open : this.window?.open) return;
      const version = result?.isUpdateAvailable ? result.updateInfo.version : undefined;
      if (!version) {
        if (manual) this.show({ kind: 'latest' });
        return;
      }
      if (!manual && this.dismissed.has(version)) return;
      this.show({ kind: 'available', version });
    } catch (err) {
      if (manual && this.window?.open) this.show({ kind: 'error', during: 'check', message: briefError(String((err as Error)?.message ?? err)) });
    }
  }

  private async install(version: string) {
    const token = new CancellationToken();
    this.download = token;
    this.show({ kind: 'downloading', version, transferred: 0, total: 0 });
    const ready = squirrelReady();
    try {
      await autoUpdater.downloadUpdate(token);
      if (token.cancelled) return ready.dispose();
      this.show({ kind: 'preparing', version });
      await ready.promise;
    } catch (err) {
      ready.dispose();
      if (!token.cancelled) this.show({ kind: 'error', during: 'download', version, message: briefError(String((err as Error)?.message ?? err)) });
      return;
    } finally {
      if (this.download === token) this.download = undefined;
    }
    this.show({ kind: 'restarting', version });
    // Stopping the office keeps its workers; if it fails, quitting stops it again anyway.
    await this.o.beforeInstall().catch(() => {});
    autoUpdater.quitAndInstall(false, true);
  }

  private act(action: UpdateAction) {
    const phase = this.phase;
    if (!phase) return;
    if (action === 'install' && phase.kind === 'available') void this.install(phase.version);
    else if (action === 'later' && phase.kind === 'available') {
      this.dismissed.add(phase.version);
      this.window?.close();
    } else if (action === 'retry' && phase.kind === 'error') {
      if (phase.during === 'download') void this.install(phase.version);
      else void this.check(true);
    } else if (action === 'cancel' || action === 'close') this.window?.close();
  }

  private show(phase: UpdatePhase) {
    this.phase = phase;
    if (!this.window?.open) {
      const opened: UpdateWindow = new UpdateWindow({
        parent: this.o.parent(),
        onAction: (action) => this.act(action),
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
    this.download?.cancel();
    if (this.phase?.kind !== 'preparing' && this.phase?.kind !== 'restarting') this.phase = undefined;
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
