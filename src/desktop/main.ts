import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions, shell } from 'electron';
import { linkAction } from './links.js';
import { type Office, probePort, startOffice } from './office.js';
import { officeRuntime } from './runtime.js';
import { DEFAULT_PORT, defaultOfficeDir, type DesktopSettings, loadSettings, officeArgs, saveSettings } from './settings.js';
import { desktopPath } from './shell-path.js';
import { Updates } from './updates.js';

const BACKGROUND = '#050505';
/** How many ports past the chosen one to try when something that isn't an office holds it. */
const PORT_TRIES = 20;

// Not ~/Library/Application Support/Droid Office (the product name): the Unity office keeps its
// own data under that folder.
app.setPath('userData', path.join(app.getPath('appData'), 'com.nikships.droid-office'));
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const logDir = app.getPath('logs');
const officeLog = path.join(logDir, 'office.log');
let settings: DesktopSettings = loadSettings(settingsFile);
let PATH = process.env.PATH ?? '';
let win: BrowserWindow | undefined;
/** The office this app started, if it started one (it may be using one that was already running). */
let office: Office | undefined;
let officeUrl: string | undefined;
/** Set while the app stops its office on purpose, so its exit isn't reported as a crash. */
let stopping = false;
let quitting = false;
/** Set while the app itself replaces the page, which the office's "Leave the office?" guard mustn't stop. */
let replacing = false;

const updates = new Updates({ log: path.join(logDir, 'updates.log'), beforeInstall: () => stopOffice(true) });

function page(title: string, detail = ''): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const html = `<!doctype html><meta charset="utf-8"><title>Droid Office</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:${BACKGROUND};color:#e8e8e8;font:15px -apple-system,system-ui,sans-serif">
<div style="text-align:center;max-width:720px;padding:24px"><div style="font:600 13px ui-monospace,monospace;letter-spacing:.2em;color:#ef6f2e">DROID OFFICE</div>
<p style="font-size:20px;margin:18px 0 10px">${esc(title)}</p><pre style="white-space:pre-wrap;text-align:left;color:#9a9a9a;font:12px ui-monospace,monospace">${esc(detail)}</pre></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function show(url: string) {
  if (!win || win.isDestroyed()) createWindow(false);
  replacing = true;
  // An aborted load (the next page replaced this one first) rejects; that's no error here.
  void win!
    .loadURL(url)
    .catch(() => {})
    .finally(() => {
      replacing = false;
    });
}

function createWindow(loadOffice = true) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: 'Droid Office',
    backgroundColor: BACKGROUND,
    webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  const created = win;
  // Full screen once there's something to show: asked for at creation, macOS sometimes leaves a
  // window that isn't on screen yet as an ordinary one.
  created.once('ready-to-show', () => {
    created.show();
    created.setFullScreen(true);
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    const action = officeUrl ? linkAction(url, new URL(officeUrl).origin) : 'ignore';
    if (action === 'app') return { action: 'allow', overrideBrowserWindowOptions: { fullscreen: false, backgroundColor: BACKGROUND } };
    if (action === 'browser') void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    const action = officeUrl ? linkAction(url, new URL(officeUrl).origin) : 'ignore';
    if (action === 'app') return;
    e.preventDefault();
    if (action === 'browser') void shell.openExternal(url);
  });
  // The office asks before its page closes or reloads (src/client/leave.ts). A browser shows that
  // prompt itself; Electron just cancels, which would also stop the app from ever quitting.
  contents.on('will-prevent-unload', (e) => {
    if (quitting || replacing) {
      e.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(created, { type: 'question', message: 'Leave the office?', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1 });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => {
    win = undefined;
  });
  if (loadOffice && officeUrl) void win.loadURL(officeUrl).catch(() => {});
}

async function chooseOfficeDir(firstRun: boolean): Promise<string | undefined> {
  const fallback = defaultOfficeDir();
  if (firstRun) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: 'Where does your office live?',
      detail: `Droid Office keeps its data (floors, workers, queue) in a folder. Pick a folder an office already ran in to carry on with it, such as the checkout you ran \`npm start\` in. You can change this later from Office → Change Office Folder….`,
      buttons: [`Use ${fallback.replace(os.homedir(), '~')}`, 'Choose Folder…'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 0) return fallback;
  }
  const picked = await dialog.showOpenDialog({
    title: 'Choose the office folder',
    defaultPath: settings.officeDir ?? fallback,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return firstRun ? fallback : undefined;
  return picked.filePaths[0];
}

/** The chosen port, or the first one after it that nothing holds; an office already on one is used as is. */
async function findPort(): Promise<{ port: number; running: boolean }> {
  const first = settings.port ?? DEFAULT_PORT;
  for (let port = first; port < first + PORT_TRIES && port <= 65535; port++) {
    const state = await probePort(port);
    if (state === 'office') return { port, running: true };
    if (state === 'free') return { port, running: false };
  }
  throw new Error(`ports ${first} to ${first + PORT_TRIES - 1} are all in use.`);
}

async function openOffice() {
  show(page('Opening the office…'));
  try {
    const { port, running } = await findPort();
    if (running) {
      // Another office (a terminal's `npm start`, an earlier app) already answers here: use it rather than start a second one.
      officeUrl = `http://localhost:${port}/`;
    } else {
      const dir = settings.officeDir ?? defaultOfficeDir();
      mkdirSync(logDir, { recursive: true });
      office = await startOffice({ runtime: officeRuntime(process.execPath), cli: path.join(app.getAppPath(), 'bin', 'droid-office.js'), args: officeArgs(dir, port), port, env: { ...process.env, PATH }, log: officeLog });
      officeUrl = office.url;
      const mine = office;
      void mine.exited.then((code) => {
        if (office !== mine) return;
        office = undefined;
        if (!stopping && !quitting) void officeStopped(code);
      });
    }
    show(officeUrl);
  } catch (err) {
    officeUrl = undefined;
    show(page("The office didn't open", (err as Error).message));
    const { response } = await dialog.showMessageBox({ type: 'error', message: "The office didn't open", detail: (err as Error).message, buttons: ['Try Again', 'Show Log', 'Quit'], defaultId: 0 });
    if (response === 0) return openOffice();
    if (response === 1) shell.showItemInFolder(officeLog);
    if (response === 2) app.quit();
  }
}

async function officeStopped(code: number | null) {
  officeUrl = undefined;
  show(page('The office stopped', `exit ${code ?? 'signal'} — see ${officeLog}`));
  const { response } = await dialog.showMessageBox({ type: 'warning', message: 'The office stopped', buttons: ['Restart', 'Show Log', 'Quit'], defaultId: 0 });
  if (response === 0) await openOffice();
  if (response === 1) shell.showItemInFolder(officeLog);
  if (response === 2) app.quit();
}

async function stopOffice(keepWorkers: boolean) {
  const running = office;
  if (!running) return;
  stopping = true;
  try {
    await running.stop(keepWorkers);
  } finally {
    if (office === running) office = undefined;
    stopping = false;
  }
}

async function changeOfficeDir() {
  const dir = await chooseOfficeDir(false);
  if (!dir || dir === settings.officeDir) return;
  settings = { ...settings, officeDir: dir };
  saveSettings(settingsFile, settings);
  if (!office && officeUrl) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Saved',
      detail: `This window shows an office that was already running on ${officeUrl}, which the app didn't start. The app opens ${dir} once that one is stopped.`,
      buttons: ['OK'],
    });
    return;
  }
  await stopOffice(false);
  await openOffice();
}

async function restartOffice() {
  if (!office) return openOffice();
  await stopOffice(true);
  await openOffice();
}

function menu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => void updates.check(true) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Office',
      submenu: [
        { label: 'Open in Browser', click: () => officeUrl && void shell.openExternal(officeUrl) },
        { label: 'Restart Office', click: () => void restartOffice() },
        { label: 'Change Office Folder…', click: () => void changeOfficeDir() },
        { type: 'separator' },
        { label: 'Show Office Log', click: () => shell.showItemInFolder(officeLog) },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) createWindow();
    else win.focus();
  });

  app.on('activate', () => {
    if (!win || win.isDestroyed()) createWindow();
  });

  // The Mac way: closing the window leaves the app (and the office) running until you quit.
  app.on('window-all-closed', () => {});

  app.on('before-quit', (e) => {
    quitting = true;
    if (!office) return;
    e.preventDefault();
    void stopOffice(true).finally(() => app.quit());
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(menu());
    show(page('Opening the office…'));
    PATH = await desktopPath();
    if (!settings.officeDir) {
      settings = { ...settings, officeDir: await chooseOfficeDir(true) };
      saveSettings(settingsFile, settings);
    }
    await openOffice();
    updates.start();
  });
}
