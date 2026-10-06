import { appendFileSync } from 'node:fs';
import { app, dialog } from 'electron';
import updater from 'electron-updater';

const { autoUpdater } = updater;

const CHECK_EVERY_MS = 30 * 60_000;

export interface UpdatesOptions {
  log: string;
  /** Runs before the app quits to install an update: stops the office, keeping its workers. */
  beforeInstall: () => Promise<void>;
}

/**
 * Keeps the app on the newest GitHub release: checks at launch and every half hour, downloads in
 * the background, and asks to restart once an update is ready (or installs it on the next quit).
 */
export class Updates {
  private timer?: NodeJS.Timeout;
  private asked = new Set<string>();
  private manual = false;

  constructor(private readonly o: UpdatesOptions) {
    const write = (level: string) => (msg: unknown) => {
      try {
        appendFileSync(o.log, `${new Date().toISOString()} ${level} ${String(msg)}\n`);
      } catch {
        // logging is best-effort
      }
    };
    autoUpdater.logger = { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => void this.downloaded(info.version));
    autoUpdater.on('update-not-available', () => this.manual && this.tell(`Droid Office ${app.getVersion()} is the newest version.`));
    autoUpdater.on('update-available', (info) => this.manual && this.tell(`Downloading Droid Office ${info.version}. You'll be asked to restart once it's ready.`));
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

  async check(manual: boolean) {
    if (!this.enabled) {
      if (manual) this.tell('Updates are only checked by the packaged app. This one runs from a checkout.');
      return;
    }
    this.manual = manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      if (manual) this.tell(`Couldn't check for updates: ${(err as Error).message}`, 'warning');
    } finally {
      this.manual = false;
    }
  }

  private async downloaded(version: string) {
    if (this.asked.has(version)) return;
    this.asked.add(version);
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `Droid Office ${version} is ready to install`,
      detail: 'Restart now to update. Workers keep running and the office picks them back up. Otherwise it installs the next time you quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    await this.o.beforeInstall();
    autoUpdater.quitAndInstall(false, true);
  }

  private tell(message: string, type: 'info' | 'warning' = 'info') {
    void dialog.showMessageBox({ type, message, buttons: ['OK'] });
  }
}
