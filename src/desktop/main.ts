import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, type BaseWindow, clipboard, dialog, Menu, type MenuItemConstructorOptions, Notification, shell, type WebContents } from 'electron';
import { downloadBrowser } from './browser.js';
import { createCompanionWindow } from './companion.js';
import { contextMenu, editMenu } from './edit-menu.js';
import { finderBridgeArgs, parseThreadLink } from './finder-links.js';
import { leaveFullScreen } from './full-screen.js';
import { explainFinder, openFinderSettings } from './finder.js';
import { gpuReport } from './gpu.js';
import { linkAction, windowOpenAction } from './links.js';
import { fetchStatus, type Office, probePort, startOffice } from './office.js';
import type { NativeEvent } from './input-events.js';
import { createTrace, traceFile } from './input-trace.js';
import { type InputNative, PresenterInput } from './presenter-input.js';
import { PresenterWindow, presenterModule } from './presenter.js';
import { DISABLED_CHROMIUM_FEATURES } from './presenter-model.js';
import { officeRuntime } from './runtime.js';
import { DEFAULT_PORT, defaultOfficeDir, type DesktopSettings, isolatedPortOk, loadSettings, officeArgs, saveSettings } from './settings.js';
import { desktopEnv } from './shell-path.js';
import { enforceRequirements, isStartupCheck, runStartupCheck, StartupAborted } from './startup.js';
import { OfficeTray } from './tray.js';
import { listCut, type OfficeStatus, parseStatus, switchLabel, type TrayAction, trayTitle, type TrayView, WaitingWatch, waitingNotice, type WorkerLink, workerHash } from './tray-model.js';
import { Updates } from './updates.js';
import { serveHostUpdates } from './update-ipc.js';
import { saveUpdateWindows, takeUpdateWindows } from './update-windows.js';

const BACKGROUND = '#050505';

// Before ready, or Chromium never sees it: a card frame in a process of its own gets no clicks from the offscreen page.
app.commandLine.appendSwitch('disable-features', DISABLED_CHROMIUM_FEATURES.join(','));
/** How many ports past the chosen one to try when something that isn't an office holds it. */
const PORT_TRIES = 20;
/** How often the menu bar icon asks the office what it's doing. */
const TRAY_REFRESH_MS = 5000;

// Not ~/Library/Application Support/Droid Office (the product name): the Unity office keeps its
// own data under that folder. `--user-data-dir=<folder>` (Chromium's switch) moves it and the logs, so a
// test run never shares the single-instance lock, settings or logs of the app someone is using.
const userDataSwitch = app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', userDataSwitch || path.join(app.getPath('appData'), 'com.nikships.droid-office'));
if (userDataSwitch) app.setPath('logs', path.join(userDataSwitch, 'logs'));
/** A run with its own userData is a test run: it only shows an office that is already up, and never moves, updates or installs anything. */
const isolated = Boolean(userDataSwitch);
const finderEnabled = app.isPackaged && !isolated && !isStartupCheck();
function hideDockIfNoWindows() {
  if (!appWindow()) app.dock?.hide();
}

/** A Finder thread link that arrived before the office could take it; the next window that opens on the office shows it. */
let pendingThread: WorkerLink | undefined;
/**
 * A Finder thread goes to the app's one window: the one that is open, or else the mode the owner last used
 * (`settings.mode`). Never a window of its own.
 */
function receiveThread(raw: string): boolean {
  if (!finderEnabled) return false;
  const link = parseThreadLink(raw);
  if (!link) return false;
  const worker: WorkerLink = { worker: link.lead, floor: link.floor, view: 'thread' };
  if (officeUrl && !opening && !switching) {
    openWorker(worker);
    return true;
  }
  pendingThread = worker;
  windowWanted = true;
  if (!starting) openWindow();
  return true;
}

function takePendingThread(): string {
  const link = pendingThread;
  pendingThread = undefined;
  return link ? workerHash(link) : '';
}
app.on('open-url', (event, url) => {
  event.preventDefault();
  receiveThread(url);
});
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const updateWindowsFile = path.join(app.getPath('userData'), 'update-windows.json');
const logDir = app.getPath('logs');
const officeLog = path.join(logDir, 'office.log');
const gpuLog = path.join(logDir, 'gpu.log');
let settings: DesktopSettings = loadSettings(settingsFile);
/** What the office and its workers run with: the login shell's environment (see desktopEnv). */
let officeEnv: NodeJS.ProcessEnv = process.env;
/**
 * The app's one window, in the mode `settings.mode` names: the 3D office (the native Metal view and the offscreen
 * page it shows, see presenter.ts) or the web companion (an ordinary window, see companion.ts). Never both at once.
 */
let win: { base: BaseWindow; contents: WebContents } | undefined;
const appWindow = () => (win && !win.base.isDestroyed() ? win : undefined);
const companionMode = () => settings.mode === 'companion';

/** The page the window shows for the office at `officeUrl`; `hash` is a worker link (see tray-model.ts `workerHash`). */
function officePage(hash = ''): string {
  return new URL(companionMode() ? `/dashboard${hash}` : hash, officeUrl).toString();
}
/** The office this app started, if it started one (it may be using one that was already running). */
let office: Office | undefined;
let officeUrl: string | undefined;
/** Set while the app stops its office on purpose, so its exit isn't reported as a crash. */
let stopping = false;
let quitting = false;
/** Set while the app itself replaces the page, which the office's "Leave the office?" guard mustn't stop. */
let replacing = false;
/** Set while the app looks for or starts its office. */
let opening = false;
/** Launch activation must not open the office before an update's saved windows are restored. */
let starting = true;
/**
 * Whether the office should have a window. Cleared when the owner closes it: the office, the menu bar
 * icon and the phones and browsers connected to it keep running, and a restart doesn't open it again.
 */
let windowWanted = true;
/** Set while switchMode waits for the window it is replacing to leave full screen. */
let switching = false;
/** Set by Cmd+Q, which closes the window to the menu bar without the "Leave the office?" prompt. */
let leavingToMenuBar = false;
/** Set by the menu bar's Quit and Stop Workers: the quit ends the workers instead of keeping them for the next office. */
let stopWorkersOnQuit = false;
let tray: OfficeTray | undefined;
/** Which workers already waited at the last status, so only a new wait is notified. */
const waitingWatch = new WaitingWatch();
/** The office the watch is on: another one (or none) starts it over. */
let watchedUrl: string | undefined;
/** The status asked for last: an answer to an older request is dropped. */
let trayRequest = 0;
/** The notification up for each waiting worker, taken down once it stops waiting or the window opens. */
const notices = new Map<string, Notification>();
/** How many new waits get a notification each of their own at once. */
const NOTICES_AT_ONCE = 3;

const updates = new Updates({
  log: path.join(logDir, 'updates.log'),
  // Squirrel closes the windows before app.quit's before-quit, so the "Leave the office?" guard
  // has to know now that the app is quitting.
  beforeInstall: () => {
    saveUpdateWindows(updateWindowsFile, { open: Boolean(appWindow()) });
    quitting = true;
    return stopOffice(true);
  },
  parent: () => appWindow()?.base,
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
  if (!appWindow()) {
    if (!windowWanted) return;
    createWindow(false);
  }
  replacing = true;
  // An aborted load (the next page replaced this one first) rejects; that's no error here.
  void win!.contents
    .loadURL(url)
    .catch(() => {})
    .finally(() => {
      replacing = false;
    });
}

/** `hash` is a worker link (see tray-model.ts `workerHash`) for the office page to open. */
function createWindow(loadOffice = true, hash = '') {
  windowWanted = true;
  clearNotices();
  void app.dock?.show();
  const created = companionMode() ? openCompanion() : openPresenter();
  win = created;
  created.base.on('closed', () => {
    if (win !== created) return;
    win = undefined;
    leavingToMenuBar = false;
    if (quitting) return;
    // The window is gone, with its page and its GPU work; the office and the menu bar icon stay.
    windowWanted = false;
    hideDockIfNoWindows();
    void refreshTray();
  });
  if (loadOffice && officeUrl) void created.contents.loadURL(officePage(hash)).catch(() => {});
}

function openCompanion(): { base: BaseWindow; contents: WebContents } {
  const base = createCompanionWindow(() => officeUrl);
  return { base, contents: base.webContents };
}

function openPresenter(): PresenterWindow {
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
  const contents = created.contents;
  const input = new PresenterInput({
    page: contents,
    native: presenterModule() as unknown as InputNative,
    shimSource: readFileSync(fileURLToPath(new URL('./page/shim.js', import.meta.url)), 'utf8'),
    officeOrigin: () => (officeUrl ? new URL(officeUrl).origin : undefined),
    focused: () => created.base.isFocused(),
    chooseFiles: async ({ multiple, directory, filters }) => {
      const picked = await dialog.showOpenDialog(created.base, {
        properties: [directory ? 'openDirectory' : 'openFile', ...(multiple ? (['multiSelections'] as const) : [])],
        ...(filters.length ? { filters } : {}),
      });
      return picked.canceled ? [] : picked.filePaths;
    },
    log: (message) => console.warn(`droid-office: ${message}`),
    trace: createTrace(traceFile()),
  });
  created.onNativeEvent = (event) => input.handle(event as unknown as NativeEvent);
  created.onVisibleChange = (visible) => input.setPageVisible(visible);
  // Quitting destroys the page before this window's 'closed': from then on no native event or visibility change may reach it.
  created.onGone = () => input.stop();
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
    // A window that is no longer the app's (switched away from) has nothing left to ask about.
    if (quitting || replacing || leavingToMenuBar || created.reloading || win !== created) {
      e.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(created.base, { type: 'question', message: 'Leave the office?', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1 });
    if (choice === 0) e.preventDefault();
  });
  created.base.on('closed', () => input.stop());
  return created;
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
  opening = true;
  void refreshTray();
  show(page('Opening the office…'));
  try {
    const { port, running } = await findPort();
    if (running) {
      // Another office (a terminal's `npm start`, an earlier app) already answers here: use it rather than start a second one.
      officeUrl = `http://localhost:${port}/`;
    } else {
      const dir = settings.officeDir ?? defaultOfficeDir();
      mkdirSync(logDir, { recursive: true });
      office = await startOffice({
        runtime: officeRuntime(process.execPath),
        cli: path.join(app.getAppPath(), 'bin', 'droid-office.js'),
        args: [...officeArgs(dir, port), ...finderBridgeArgs(app.getAppPath(), app.isPackaged, isolated)],
        port,
        env: officeEnv,
        log: officeLog,
        onSpawn: (child) => serveHostUpdates(child, (command) => updates.controller.remote(command)),
      });
      officeUrl = office.url;
      const mine = office;
      void mine.exited.then((code) => {
        if (office !== mine) return;
        office = undefined;
        if (!stopping && !quitting) void officeStopped(code);
      });
    }
    opening = false;
    show(officePage(takePendingThread()));
    if (finderEnabled && office) void explainFinder(app.getPath('userData')).catch(() => {});
    void refreshTray();
  } catch (err) {
    pendingThread = undefined;
    windowWanted = true;
    officeUrl = undefined;
    opening = false;
    void refreshTray();
    show(page("The office didn't open", (err as Error).message));
    toFront();
    const { response } = await dialog.showMessageBox({ type: 'error', message: "The office didn't open", detail: (err as Error).message, buttons: ['Try Again', 'Show Log', 'Quit'], defaultId: 0 });
    if (response === 0) return openOffice();
    if (response === 1) shell.showItemInFolder(officeLog);
    if (response === 2) app.quit();
  }
}

async function officeStopped(code: number | null) {
  officeUrl = undefined;
  void refreshTray();
  show(page('The office stopped', `exit ${code ?? 'signal'} — see ${officeLog}`));
  toFront();
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

/** Brings the app forward for a dialog or window: with only the menu bar icon left, it isn't the active app. */
function toFront() {
  app.focus({ steal: true });
}

/** The office window again, from the menu bar icon, the Dock or a second launch. */
function openWindow() {
  // switchMode opens the next window itself once the last one is out of full screen.
  if (switching) return;
  toFront();
  clearNotices();
  const current = appWindow();
  if (current) {
    if (officeUrl && current.contents.isCrashed()) void current.contents.loadURL(officePage()).catch(() => {});
    current.base.show();
    current.base.focus();
    return;
  }
  if (officeUrl && !opening) return createWindow(true, takePendingThread());
  createWindow(false);
  if (opening) show(page('Opening the office…'));
  else void openOffice();
}

/** The one switch between the 3D office and the web companion: the window of one is replaced by the window of the other, and is opened if it was closed. */
async function switchMode() {
  if (switching) return;
  settings = { ...settings, mode: companionMode() ? 'office' : 'companion' };
  saveSettings(settingsFile, settings);
  Menu.setApplicationMenu(menu());
  const old = appWindow();
  // Detached first, so its closing isn't taken for the owner closing the window to the menu bar.
  win = undefined;
  if (old) {
    switching = true;
    try {
      // Out of full screen before the next window opens, or its Space stays behind as an empty black one (see leaveFullScreen).
      await leaveFullScreen(old.base);
    } finally {
      switching = false;
    }
    if (!old.base.isDestroyed()) old.base.close();
  }
  void refreshTray();
  // Before startup has chosen the folder and the environment, only the window changes: openOffice runs once, from startup, and loads this mode's page.
  if (starting) {
    createWindow(false);
    show(page('Opening the office…'));
    return;
  }
  openWindow();
}

/** A waiting worker's terminal, from the menu bar or a notification: the office page goes to its floor and opens it. */
function openWorker(link: WorkerLink) {
  if (!officeUrl) return openWindow();
  const hash = workerHash(link);
  toFront();
  clearNotices();
  const current = appWindow();
  if (!current) return createWindow(true, hash);
  current.base.show();
  current.base.focus();
  // Both pages read the hash as it changes (src/client/main.ts, dashboard.ts); any other page (an error, the splash) is replaced.
  if (onOffice(current.contents.getURL())) void current.contents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
  else show(officePage(hash));
}

function onOffice(url: string): boolean {
  try {
    return Boolean(officeUrl) && new URL(url).origin === new URL(officeUrl!).origin;
  } catch {
    return false;
  }
}

function clearNotices() {
  for (const n of notices.values()) n.close();
  notices.clear();
}

/**
 * Unless the 3D office is open, a worker that starts to wait on the owner gets a notification, as the office page
 * gives one while it's in the background (src/client/notify.ts). The 3D page does that itself; the companion page doesn't.
 */
function noticeWaiting(status: OfficeStatus | undefined) {
  const fresh = waitingWatch.next(status);
  // A failed fetch or a cut-off list says nothing about who stopped waiting.
  if (status && !listCut(status)) {
    const still = new Set(status.waiting.map((w) => w.id));
    for (const [id, n] of notices) {
      if (still.has(id)) continue;
      n.close();
      notices.delete(id);
    }
  }
  if (!status || settings.notify === false || (appWindow() && !companionMode()) || !Notification.isSupported()) return;
  for (const w of fresh.slice(0, NOTICES_AT_ONCE)) {
    notices.get(w.id)?.close();
    const n = new Notification(waitingNotice(w, status.floors));
    n.on('click', () => {
      notices.delete(w.id);
      openWorker({ worker: w.id, floor: w.floor });
    });
    n.on('close', () => {
      if (notices.get(w.id) === n) notices.delete(w.id);
    });
    notices.set(w.id, n);
    n.show();
  }
  const rest = fresh.length - NOTICES_AT_ONCE;
  if (rest > 0) {
    const n = new Notification({ title: `${rest} more worker${rest === 1 ? '' : 's'} waiting on you`, body: '' });
    n.on('click', () => openWindow());
    n.show();
  }
}

function toggleNotify() {
  settings = { ...settings, notify: settings.notify === false };
  saveSettings(settingsFile, settings);
  if (settings.notify === false) clearNotices();
  void refreshTray();
}

/** Cmd+Q: closes the window and leaves the office running behind the menu bar icon. The first time, says so. */
async function leaveToMenuBar() {
  const current = appWindow();
  if (!current) {
    windowWanted = false;
    hideDockIfNoWindows();
    return;
  }
  if (!settings.menuBarExplained) {
    const { response } = await dialog.showMessageBox(current.base, {
      type: 'info',
      message: 'Cmd+Q closes the window and keeps the office running',
      detail: 'Workers keep working, and phones and browsers stay connected. Open the office again from the Droid Office icon in the menu bar. To stop the office, choose Quit Droid Office in that menu, or press Option+Cmd+Q.',
      buttons: ['Keep Running in Menu Bar', 'Stop the Office and Quit'],
      defaultId: 0,
      cancelId: 0,
    });
    settings = { ...settings, menuBarExplained: true };
    saveSettings(settingsFile, settings);
    if (response === 1) return app.quit();
  }
  if (current.base.isDestroyed()) return;
  leavingToMenuBar = true;
  current.base.close();
}

async function quitStoppingWorkers() {
  toFront();
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Stop every worker and quit?',
    detail: "The workers' terminals end with the office, instead of waiting for the next office to take them back.",
    buttons: ['Stop Workers and Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;
  stopWorkersOnQuit = true;
  app.quit();
}

function trayAction(action: TrayAction) {
  if (action === 'open') openWindow();
  else if (action === 'notify') toggleNotify();
  else if (action === 'switch') {
    toFront();
    void switchMode();
  } else if (action === 'restart') void restartOffice();
  else if (action === 'updates') {
    toFront();
    void updates.check(true);
  } else if (action === 'quit') app.quit();
  else void quitStoppingWorkers();
}

async function refreshTray() {
  if (!tray) return;
  const request = ++trayRequest;
  const url = opening ? undefined : officeUrl;
  const status = url ? parseStatus(await fetchStatus(url)) : undefined;
  if (request !== trayRequest || url !== (opening ? undefined : officeUrl)) return;
  if (url !== watchedUrl) {
    waitingWatch.reset();
    clearNotices();
    watchedUrl = url;
  }
  noticeWaiting(status);
  const view: TrayView = {
    state: opening ? 'starting' : officeUrl ? 'running' : 'stopped',
    ...(status ? { status } : {}),
    ownWindows: officeUrl && appWindow() ? 1 : 0,
    mode: settings.mode ?? 'office',
    external: Boolean(officeUrl && !office),
    notify: settings.notify !== false,
    version: app.getVersion(),
  };
  tray.render(view);
  // The Dock icon counts them too while the window is open (the Dock icon is hidden while it's closed).
  app.dock?.setBadge(trayTitle(view));
}

async function restartOffice() {
  if (!office) return openOffice();
  await stopOffice(true);
  await openOffice();
}

function menu(): Menu {
  const contents = () => win?.contents;
  const base = () => win?.base;
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
        // Cmd+Q leaves the office running behind the menu bar icon; quitting it is a separate item.
        { label: 'Close to Menu Bar', accelerator: 'CmdOrCtrl+Q', click: () => void leaveToMenuBar() },
        { label: `Quit ${app.name}`, accelerator: 'Alt+CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    // Not Electron's edit roles: the page is offscreen and never the focused web contents, so they would find nothing to act on.
    editMenu(contents),
    {
      label: 'Office',
      submenu: [
        { label: switchLabel(settings.mode ?? 'office'), click: () => trayAction('switch') },
        { label: 'Restart Office', click: () => void restartOffice() },
        { label: 'Change Office Folder…', click: () => void changeOfficeDir() },
        ...(finderEnabled ? [{ label: 'Finder Extension Settings…', click: () => openFinderSettings() }] : []),
        { type: 'separator' },
        { label: 'Show Office Log', click: () => shell.showItemInFolder(officeLog) },
        { label: 'Show GPU Report', click: () => void writeGpuReport().then(() => shell.showItemInFolder(gpuLog)) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => contents()?.reload() },
        { label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R', click: () => contents()?.reloadIgnoringCache() },
        { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => contents()?.toggleDevTools() },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: 'Ctrl+CmdOrCtrl+F', click: () => base()?.setFullScreen(!base()?.isFullScreen()) },
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { label: 'Minimize', accelerator: 'CmdOrCtrl+M', click: () => base()?.minimize() },
        { label: 'Zoom', click: () => (base()?.isMaximized() ? base()?.unmaximize() : base()?.maximize()) },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => base()?.close() },
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
  app.on('second-instance', (_event, argv) => {
    if (!argv.some((arg) => receiveThread(arg))) openWindow();
  });
  app.on('activate', () => {
    if (starting) return;
    openWindow();
  });

  // Closing the window leaves the app, the office and the menu bar icon running until you quit.
  app.on('window-all-closed', () => {});

  // Every real quit comes here: the menu bar's Quit, Quit Droid Office in the app menu, the Dock, logging out,
  // shutting down and installing an update. None of them is turned into a close to the menu bar.
  app.on('before-quit', (e) => {
    quitting = true;
    if (!office) return;
    e.preventDefault();
    void stopOffice(!stopWorkersOnQuit).finally(() => app.quit());
  });

  void app
    .whenReady()
    .then(async () => {
      enforceRequirements();
      if (isStartupCheck()) return runStartupCheck();
      if (finderEnabled) {
        app.setAsDefaultProtocolClient('droid-office');
        for (const arg of process.argv) receiveThread(arg);
      }
      const updateWindows = takeUpdateWindows(updateWindowsFile);
      if (updateWindows && !pendingThread) windowWanted = updateWindows.open;
      if (updateWindows?.mode && updateWindows.mode !== settings.mode) {
        settings = { ...settings, mode: updateWindows.mode };
        saveSettings(settingsFile, settings);
      }
      Menu.setApplicationMenu(menu());
      if (!isolated && (await moveToApplications())) return;
      tray = new OfficeTray(trayAction);
      void refreshTray();
      setInterval(() => void refreshTray(), TRAY_REFRESH_MS);
      show(page('Opening the office…'));
      officeEnv = await desktopEnv();
      if (!isolated && !settings.officeDir) {
        settings = { ...settings, officeDir: await chooseOfficeDir(true) };
        saveSettings(settingsFile, settings);
      }
      await openOffice();
      starting = false;
      hideDockIfNoWindows();
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
