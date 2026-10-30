import { BrowserWindow, shell } from 'electron';
import { COMPANION_CHROME } from './companion-chrome.js';
import { companionNavigation } from './finder-links.js';

/** The dashboard in an ordinary Electron window, without the walkable office's Metal presenter. `main.ts` loads the page and owns the window. */
export function createCompanionWindow(officeUrl: () => string | undefined): BrowserWindow {
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
  const navigation = (url: string) => companionNavigation(url, officeUrl() ?? '');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (navigation(url) === 'external') void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const action = navigation(url);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'external') void shell.openExternal(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (navigation(url) !== 'allow') event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('dom-ready', () => {
    void win.webContents.insertCSS(COMPANION_CHROME).catch(() => {});
  });
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  return win;
}
