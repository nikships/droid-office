import { app, BrowserWindow, dialog, shell } from 'electron';
import { COMPANION_CHROME } from './companion-chrome.js';
import { companionNavigation } from './finder-links.js';

/** The dashboard in an ordinary Electron window, without the walkable office's Metal presenter. */
export class OfficeCompanion {
  private window: BrowserWindow | undefined;
  private officeUrl = '';
  private load = 0;

  constructor(private readonly onClosed: () => void) {}

  currentWindow(): BrowserWindow | undefined {
    return this.window && !this.window.isDestroyed() ? this.window : undefined;
  }

  focusedWindow(): BrowserWindow | undefined {
    const win = this.currentWindow();
    return win?.isFocused() ? win : undefined;
  }

  focus(): boolean {
    const win = this.currentWindow();
    if (!win) return false;
    void app.dock?.show();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  }

  open(officeUrl: string) {
    if (this.currentWindow()) {
      if (officeUrl !== this.officeUrl || this.window!.webContents.isCrashed()) this.navigate(officeUrl);
      this.focus();
      return;
    }
    const win = new BrowserWindow({
      title: 'Droid Office · Companion',
      width: 1200,
      height: 800,
      minWidth: 1100,
      minHeight: 480,
      backgroundColor: '#050505',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 27 },
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, partition: 'persist:office-companion' },
    });
    this.window = win;
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (companionNavigation(url, this.officeUrl) === 'external') void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      const action = companionNavigation(url, this.officeUrl);
      if (action === 'allow') return;
      event.preventDefault();
      if (action === 'external') void shell.openExternal(url);
    });
    win.webContents.on('will-redirect', (event, url) => {
      if (companionNavigation(url, this.officeUrl) !== 'allow') event.preventDefault();
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('dom-ready', () => {
      void win.webContents.insertCSS(COMPANION_CHROME).catch(() => {});
    });
    win.once('ready-to-show', () => this.focus());
    win.once('closed', () => {
      if (this.window === win) this.window = undefined;
      this.onClosed();
    });
    this.navigate(officeUrl);
  }

  /** Reload an open companion once its office has restarted or changed folders. */
  reconnect(officeUrl: string) {
    if (this.currentWindow()) this.navigate(officeUrl);
  }

  private navigate(officeUrl: string) {
    this.officeUrl = officeUrl;
    const win = this.currentWindow()!;
    const load = ++this.load;
    void win.loadURL(new URL('/dashboard', officeUrl).href).catch(() => {
      if (load !== this.load || this.window !== win || win.isDestroyed()) return;
      win.destroy();
      void dialog.showMessageBox({ type: 'error', message: 'The Office Companion could not open', detail: 'The office may be restarting. Try Open Office Companion again from the menu bar.', buttons: ['OK'] }).catch(() => {});
    });
  }
}
