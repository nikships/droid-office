import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { app, dialog } from 'electron';
import updater from 'electron-updater';

const { autoUpdater } = updater;

/** Where releases are published (.github/workflows/release.yml). */
export const RELEASES = { owner: 'nikships', repo: 'droid-office' } as const;

const CHECK_EVERY_MS = 30 * 60_000;

/** The GitHub CLI's token, which lets the updater read the releases of a private repository. */
function ghToken(PATH: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { env: { ...process.env, PATH }, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
  });
}

export interface UpdatesOptions {
  /** The PATH to find `gh` on. */
  path: () => string;
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
    // Read each time: `gh auth login` may have happened since the last check.
    const token = await ghToken(this.o.path());
    autoUpdater.setFeedURL({ provider: 'github', ...RELEASES, ...(token ? { private: true, token } : {}) });
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      if (manual) {
        const hint = token ? '' : '\n\nThe releases are in a private repository: sign the GitHub CLI in (`gh auth login`) so the app can read them.';
        this.tell(`Couldn't check for updates: ${(err as Error).message}${hint}`, 'warning');
      }
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
