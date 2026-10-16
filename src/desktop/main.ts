import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, type BaseWindow, clipboard, dialog, Menu, type MenuItemConstructorOptions, shell } from 'electron';
import { downloadBrowser } from './browser.js';
import { contextMenu, editMenu } from './edit-menu.js';
import { gpuReport } from './gpu.js';
import { linkAction, windowOpenAction } from './links.js';
import { type Office, probePort, startOffice } from './office.js';
import type { NativeEvent } from './input-events.js';
import { createTrace, traceFile } from './input-trace.js';
import { type InputNative, PresenterInput } from './presenter-input.js';
import { PresenterWindow, presenterModule } from './presenter.js';
import { officeRuntime } from './runtime.js';
import { DEFAULT_PORT, defaultOfficeDir, type DesktopSettings, isolatedPortOk, loadSettings, officeArgs, saveSettings } from './settings.js';
import { desktopEnv } from './shell-path.js';
import { enforceRequirements, isStartupCheck, runStartupCheck, StartupAborted } from './startup.js';
import { Updates } from './updates.js';

const BACKGROUND = '#050505';
/** How many ports past the chosen one to try when something that isn't an office holds it. */
const PORT_TRIES = 20;

// Not ~/Library/Application Support/Droid Office (the product name): the Unity office keeps its
// own data under that folder. `--user-data-dir=<folder>` (Chromium's switch) moves it and the logs, so a
// test run never shares the single-instance lock, settings or logs of the app someone is using.
const userDataSwitch = app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', userDataSwitch || path.join(app.getPath('appData'), 'com.nikships.droid-office'));
if (userDataSwitch) app.setPath('logs', path.join(userDataSwitch, 'logs'));
/** A run with its own userData is a test run: it only shows an office that is already up, and never moves, updates or installs anything. */
const isolated = Boolean(userDataSwitch);
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const logDir = app.getPath('logs');
const officeLog = path.join(logDir, 'office.log');
const gpuLog = path.join(logDir, 'gpu.log');
let settings: DesktopSettings = loadSettings(settingsFile);
/** What the office and its workers run with: the login shell's environment (see desktopEnv). */
let officeEnv: NodeJS.ProcessEnv = process.env;
/** The office window: the native Metal view and the offscreen page it shows (see presenter.ts). */
let win: PresenterWindow | undefined;
/** The office this app started, if it started one (it may be using one that was already running). */
let office: Office | undefined;
let officeUrl: string | undefined;
/** Set while the app stops its office on purpose, so its exit isn't reported as a crash. */
let stopping = false;
let quitting = false;
/** Set while the app itself replaces the page, which the office's "Leave the office?" guard mustn't stop. */
let replacing = false;

const updates = new Updates({
  log: path.join(logDir, 'updates.log'),
  // Squirrel closes the windows before app.quit's before-quit, so the "Leave the office?" guard
  // has to know now that the app is quitting.
  beforeInstall: () => {
    quitting = true;
    return stopOffice(true);
  },
  parent: () => (win && !win.base.isDestroyed() ? win.base : undefined),
});

function page(title: string, detail = ''): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const html = `<!doctype html><meta charset="utf-8"><title>Droid Office</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:${BACKGROUND};color:#e8e8e8;font:15px -apple-system,system-ui,sans-serif">
<div style="text-align:center;max-width:720px;padding:24px"><div style="font:600 13px ui-monospace,monospace;letter-spacing:.2em;color:#ef6f2e">DROID OFFICE</div>
<p style="font-size:20px;margin:18px 0 10px">${esc(title)}</p><pre style="white-space:pre-wrap;text-align:left;color:#9a9a9a;font:12px ui-monospace,monospace">${esc(detail)}</pre></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function show(url: string) {
  if (!win || win.base.isDestroyed()) createWindow(false);
  replacing = true;
  // An aborted load (the next page replaced this one first) rejects; that's no error here.
  void win!.contents
    .loadURL(url)
    .catch(() => {})
    .finally(() => {
      replacing = false;
    });
}

function createWindow(loadOffice = true) {
  const created = new PresenterWindow({
    title: 'Droid Office',
    backgroundColor: BACKGROUND,
    // Full screen once there's something to show: asked for at creation, macOS sometimes leaves a
    // window that isn't on screen yet as an ordinary one.
    onFirstFrame: (base: BaseWindow) => {
      base.show();
      base.setFullScreen(true);
    },
    officeOrigin: () => (officeUrl ? new URL(officeUrl).origin : undefined),
    isQuitting: () => quitting,
  });
  win = created;
  const contents = created.contents;
  const input = new PresenterInput({
    page: contents,
    native: presenterModule() as unknown as InputNative,
    shimSource: readFileSync(fileURLToPath(new URL('./page/shim.js', import.meta.url)), 'utf8'),
    officeOrigin: () => (officeUrl ? new URL(officeUrl).origin : undefined),
    focused: () => created.base.isFocused(),
    log: (message) => console.warn(`droid-office: ${message}`),
    trace: createTrace(traceFile()),
  });
  created.onNativeEvent = (event) => input.handle(event as unknown as NativeEvent);
  created.onVisibleChange = (visible) => input.setPageVisible(visible);
  // A right click the page left alone gets the menu a browser would show, since an offscreen page has no native one.
  contents.on('context-menu', (_event, params) => {
    const items = contextMenu(
      params,
      contents,
      (url) => officeUrl && linkAction(url, new URL(officeUrl).origin) === 'browser' && void shell.openExternal(url),
      (text) => clipboard.writeText(text),
    );
    if (items.length) Menu.buildFromTemplate(items).popup({ window: created.base, x: params.x, y: params.y });
  });
  // Never an Electron window: a child of the offscreen page would inherit its shared-texture rendering with nothing to show it (see windowOpenAction).
  contents.setWindowOpenHandler(({ url }) => {
    if (officeUrl && windowOpenAction(url, new URL(officeUrl).origin) === 'browser') void shell.openExternal(url);
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
    if (quitting || replacing || created.reloading) {
      e.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(created.base, { type: 'question', message: 'Leave the office?', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1 });
    if (choice === 0) e.preventDefault();
  });
  created.base.on('closed', () => {
    input.stop();
    if (win === created) win = undefined;
  });
  if (loadOffice && officeUrl) void contents.loadURL(officeUrl).catch(() => {});
}

/**
 * Opened from its disk image or from Downloads, macOS runs the app from a read-only, randomized
 * copy: it can't update itself, and the terminal host that keeps workers running across restarts
 * is left pointing at files that go away. Offers the move; true when the app is relaunching moved.
 */
async function moveToApplications(): Promise<boolean> {
  if (!app.isPackaged || process.platform !== 'darwin' || app.isInApplicationsFolder()) return false;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Move Droid Office to your Applications folder?',
    detail: "It's running from its disk image or from where it was downloaded. From there it can't update itself, and workers' terminals stop working once the disk image is ejected.",
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  try {
    return app.moveToApplicationsFolder();
  } catch (err) {
    await dialog.showMessageBox({ type: 'warning', message: "Droid Office couldn't move itself", detail: `${(err as Error).message}\n\nDrag it into Applications from the Finder instead.`, buttons: ['OK'] });
    return false;
  }
}

async function chooseOfficeDir(firstRun: boolean): Promise<string | undefined> {
  const fallback = defaultOfficeDir();
  if (firstRun) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: 'Where does your office live?',
      detail: `Droid Office keeps its data (floors, workers, pictures) in a folder. Pick a folder an office already ran in to carry on with it, such as the checkout you ran \`npm start\` in. You can change this later from Office → Change Office Folder….`,
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
  if (isolated) {
    // Never starts an office and never scans: it shows the one office already on the chosen port, which is not the owner's.
    if (!isolatedPortOk(first, await probePort(first))) throw new Error(`--user-data-dir is set: start an office on port ${first} first (not ${DEFAULT_PORT}), and put that port in ${settingsFile}.`);
    return { port: first, running: true };
  }
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
      office = await startOffice({ runtime: officeRuntime(process.execPath), cli: path.join(app.getAppPath(), 'bin', 'droid-office.js'), args: officeArgs(dir, port), port, env: officeEnv, log: officeLog });
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

/** Writes what Electron says the GPU draws with to gpu.log. Never fatal: the report is for reading, not for starting. */
async function writeGpuReport() {
  try {
    const info = await app.getGPUInfo('complete');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(gpuLog, gpuReport(info, app.getGPUFeatureStatus() as unknown as Record<string, string>, new Date()));
  } catch (err) {
    console.warn('droid-office: no GPU report', err);
  }
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
    // Not Electron's edit roles: the page is offscreen and never the focused web contents, so they would find nothing to act on.
    editMenu(() => win?.contents),
    {
      label: 'Office',
      submenu: [
        { label: 'Open in Browser', click: () => officeUrl && void shell.openExternal(officeUrl) },
        { label: 'Restart Office', click: () => void restartOffice() },
        { label: 'Change Office Folder…', click: () => void changeOfficeDir() },
        { type: 'separator' },
        { label: 'Show Office Log', click: () => shell.showItemInFolder(officeLog) },
        { label: 'Show GPU Report', click: () => void writeGpuReport().then(() => shell.showItemInFolder(gpuLog)) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win?.contents.reload() },
        { label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R', click: () => win?.contents.reloadIgnoringCache() },
        { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => win?.contents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: 'Ctrl+CmdOrCtrl+F', click: () => win?.base.setFullScreen(!win.base.isFullScreen()) },
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { label: 'Minimize', accelerator: 'CmdOrCtrl+M', click: () => win?.base.minimize() },
        { label: 'Zoom', click: () => (win?.base.isMaximized() ? win.base.unmaximize() : win?.base.maximize()) },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => win?.base.close() },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

if (!isStartupCheck() && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.base.isDestroyed()) createWindow();
    else win.base.focus();
  });

  app.on('activate', () => {
    if (!win || win.base.isDestroyed()) createWindow();
  });

  // The Mac way: closing the window leaves the app (and the office) running until you quit.
  app.on('window-all-closed', () => {});

  app.on('before-quit', (e) => {
    quitting = true;
    if (!office) return;
    e.preventDefault();
    void stopOffice(true).finally(() => app.quit());
  });

  void app
    .whenReady()
    .then(async () => {
      enforceRequirements();
      if (isStartupCheck()) return runStartupCheck();
      Menu.setApplicationMenu(menu());
      if (!isolated && (await moveToApplications())) return;
      show(page('Opening the office…'));
      officeEnv = await desktopEnv();
      if (!isolated && !settings.officeDir) {
        settings = { ...settings, officeDir: await chooseOfficeDir(true) };
        saveSettings(settingsFile, settings);
      }
      await openOffice();
      void writeGpuReport();
      mkdirSync(logDir, { recursive: true });
      if (!isolated) downloadBrowser({ runtime: officeRuntime(process.execPath), cli: path.join(app.getAppPath(), 'bin', 'droid-office.js'), env: officeEnv, log: path.join(logDir, 'browser.log') });
      if (!isolated) updates.start();
    })
    .catch((err: unknown) => {
      // failStartup has already shown why and asked the app to exit; anything else is a bug that should surface.
      if (!(err instanceof StartupAborted)) throw err;
    });
}
