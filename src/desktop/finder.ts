import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { companionNavigation, finderBridgeArgs, type ThreadLink, threadDashboardUrl } from './finder-links.js';

export class FinderThreads {
  private window: BrowserWindow | undefined;
  private load = 0;
  constructor(private onClosed: () => void = () => {}) {}
  focusedWindow(): BrowserWindow | undefined {
    return this.window && !this.window.isDestroyed() && this.window.isFocused() ? this.window : undefined;
  }
  focus(): boolean {
    if (!this.window || this.window.isDestroyed()) return false;
    this.window.show();
    this.window.focus();
    return true;
  }
  open(officeUrl: string, link: ThreadLink) {
    const target = threadDashboardUrl(officeUrl, link);
    if (this.window && !this.window.isDestroyed()) {
      this.navigate(this.window, target);
      this.window.show();
      this.window.focus();
      return;
    }
    const win = new BrowserWindow({
      title: 'Droid Office · Thread',
      width: 1000,
      height: 800,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, partition: 'persist:finder-threads' },
    });
    this.window = win;
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (companionNavigation(url, officeUrl) === 'external') void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      const action = companionNavigation(url, officeUrl);
      if (action === 'allow') return;
      event.preventDefault();
      if (action === 'external') void shell.openExternal(url);
    });
    win.webContents.on('will-redirect', (event, url) => {
      if (companionNavigation(url, officeUrl) !== 'allow') event.preventDefault();
    });
    win.webContents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && companionNavigation(event.url, officeUrl) !== 'allow') event.preventDefault();
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.once('ready-to-show', () => {
      void app.dock?.show();
      win.show();
      win.focus();
    });
    win.once('closed', () => {
      if (this.window === win) this.window = undefined;
      this.onClosed();
    });
    this.navigate(win, target);
  }
  private navigate(win: BrowserWindow, target: string) {
    const load = ++this.load;
    void win.loadURL(target).catch(() => {
      if (load !== this.load || this.window !== win || win.isDestroyed()) return;
      win.destroy();
      void dialog.showMessageBox({ type: 'error', message: 'The Thread could not open', detail: 'The office may be restarting. Open Droid Office and try the thread again.', buttons: ['OK'] }).catch(() => {});
    });
  }
  close() {
    this.window?.destroy();
    this.window = undefined;
  }
}

export function openFinderSettings() {
  const helper = finderBridgeArgs(app.getAppPath(), app.isPackaged, false)[1];
  if (!helper) return;
  execFile(helper, ['--settings'], { timeout: 10_000 }, (err) => {
    if (err) void dialog.showMessageBox({ type: 'error', message: 'Finder settings could not open', detail: 'Open System Settings → General → Login Items & Extensions → Finder Extensions.', buttons: ['OK'] });
  });
}

export async function explainFinder(userData: string) {
  const marker = path.join(userData, 'finder-explained-v1');
  if (existsSync(marker)) return;
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: 'Dispatch Finder selections to Droid Office',
    detail:
      'To add “Dispatch to Office…” to Finder, enable Droid Office Finder in System Settings → General → Login Items & Extensions → Finder Extensions. Droid Office never enables it automatically. You can reopen these settings from the Office menu.',
    buttons: ['Open Finder Settings', 'Not Now'],
    defaultId: 1,
    cancelId: 1,
  });
  try {
    writeFileSync(marker, '1\n', { mode: 0o600 });
  } catch {
    // Best effort: a full or read-only disk must not break the running office.
  }
  if (response === 0) openFinderSettings();
}
