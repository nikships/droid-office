import { app, BrowserWindow, clipboard, dialog, Menu, type MessageBoxOptions, screen, shell } from 'electron';
import { COMPANION_MIN_HEIGHT, COMPANION_MIN_WIDTH, type CompanionBounds, type ResolvedCompanionBounds, resolveCompanionBounds } from './companion-bounds.js';
import { COMPANION_CHROME } from './companion-chrome.js';
import { companionCommand, sendCompanionCommand } from './companion-commands.js';
import { contextMenu } from './edit-menu.js';
import { companionNavigation, companionWindowOpenAction } from './links.js';
import { CrashPolicy } from './presenter-recovery.js';
import { rendererCrashFailure } from './startup-failure.js';
import { logStartupFailure } from './startup.js';

export interface CompanionWindowOptions {
  officeUrl: () => string | undefined;
  isQuitting?: () => boolean;
  isSwitching?: () => boolean;
  bounds?: CompanionBounds;
  onBoundsChange?: (bounds: CompanionBounds) => void;
}

/** The dashboard in an ordinary Electron window, without the walkable office's Metal presenter. `main.ts` loads the page and owns the window. */
export function createCompanionWindow(optionsOrUrl: CompanionWindowOptions | (() => string | undefined)): BrowserWindow {
  const options = typeof optionsOrUrl === 'function' ? { officeUrl: optionsOrUrl } : optionsOrUrl;
  const { officeUrl } = options;
  const primary = screen.getPrimaryDisplay();
  const workAreas = [
    primary.workArea,
    ...screen
      .getAllDisplays()
      .filter((display) => display.id !== primary.id)
      .map((display) => display.workArea),
  ];
  const { fullScreen, maximized, ...frame } = resolveCompanionBounds(options.bounds, workAreas);
  const win = new BrowserWindow({
    title: 'Droid Office · Companion',
    ...frame,
    minWidth: COMPANION_MIN_WIDTH,
    minHeight: COMPANION_MIN_HEIGHT,
    backgroundColor: '#050505',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, partition: 'persist:office-companion' },
  });
  const contents = win.webContents;
  const gone = () => win.isDestroyed() || contents.isDestroyed();
  const navigation = (url: string) => companionNavigation(url, officeUrl() ?? '');
  const openLink = (url: string) => {
    if (companionWindowOpenAction(url, officeUrl() ?? '') === 'browser') void shell.openExternal(url).catch(() => {});
  };
  contents.on('before-input-event', (event, input) => {
    const command = companionCommand(input);
    if (!command) return;
    // Stop both page input and the menu accelerator; a held key must not close successive panes.
    event.preventDefault();
    if (!input.isAutoRepeat) sendCompanionCommand(contents, officeUrl(), command);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const action = navigation(url);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'external') openLink(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (navigation(url) !== 'allow') event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('context-menu', (_event, params) => {
    const items = contextMenu(params, contents, openLink, (text) => clipboard.writeText(text), {
      replace: (word) => {
        if (!gone()) contents.replaceMisspelling(word);
      },
      add: (word) => {
        if (!gone()) contents.session.addWordToSpellCheckerDictionary(word);
      },
    });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win, x: params.x, y: params.y });
  });
  const syncFullScreenChrome = () => {
    if (gone()) return;
    void contents.executeJavaScript(`document.body?.classList.toggle('companion-fullscreen', ${win.isFullScreen()})`).catch(() => {});
  };
  win.on('enter-full-screen', syncFullScreenChrome);
  win.on('leave-full-screen', syncFullScreenChrome);
  contents.on('dom-ready', () => {
    if (gone()) return;
    void contents.insertCSS(COMPANION_CHROME).catch(() => {});
    syncFullScreenChrome();
    void contents.setVisualZoomLevelLimits(1, 1).catch(() => {});
    if (contents.getZoomFactor() !== 1) contents.setZoomFactor(1);
  });
  trackCompanionBounds(win, { fullScreen, maximized, ...frame }, options);
  recoverCompanion(win, options);
  return win;
}

function trackCompanionBounds(win: BrowserWindow, restored: ResolvedCompanionBounds, { onBoundsChange, isQuitting, isSwitching }: CompanionWindowOptions): void {
  let ready = false;
  let { fullScreen, maximized } = restored;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function saveBounds() {
    clearTimeout(timer);
    if (!onBoundsChange || !ready || win.isDestroyed()) return;
    if (!fullScreen) maximized = win.isMaximized();
    onBoundsChange({ ...win.getNormalBounds(), maximized, fullScreen });
  }
  if (onBoundsChange) {
    const scheduleSave = () => {
      clearTimeout(timer);
      timer = setTimeout(saveBounds, 250);
    };
    win.on('move', scheduleSave);
    win.on('resize', scheduleSave);
    win.on('maximize', saveBounds);
    win.on('unmaximize', saveBounds);
    win.on('enter-full-screen', () => {
      fullScreen = true;
      saveBounds();
    });
    win.on('leave-full-screen', () => {
      // Switching exits the native Space before closing. Remember the owner's full screen preference
      // even if the switch flag is already cleared by the time the old window emits 'close'.
      if (!isSwitching?.() && !isQuitting?.()) fullScreen = false;
      saveBounds();
    });
    win.on('close', saveBounds);
    win.once('closed', () => clearTimeout(timer));
  }
  win.once('ready-to-show', () => {
    if (isQuitting?.() || isSwitching?.()) return;
    ready = true;
    if (restored.fullScreen) {
      win.show();
      win.setFullScreen(true);
    } else if (restored.maximized) {
      win.maximize();
      win.show();
    } else {
      win.show();
      win.focus();
    }
  });
}

/** Delay the first three retries. Ignore replaced loads, app-owned splash pages and subframes. */
function loadRetryDelay(attempt: number): number | undefined {
  return [500, 1500, 3000][attempt];
}

function loadErrorPage(url: string): string {
  const retry = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const html = `<!doctype html><meta charset="utf-8"><title>Droid Office · Companion</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#050505;color:#e8e8e8;font:16px system-ui,sans-serif">
<div style="text-align:center"><p>The companion couldn’t load the office.</p><a style="color:#ef6f2e" href="${retry}">Retry</a></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function recoverCompanion(win: BrowserWindow, { officeUrl, isQuitting = () => false, isSwitching }: CompanionWindowOptions): void {
  const contents = win.webContents;
  const canRecover = () => !win.isDestroyed() && !contents.isDestroyed() && !isQuitting() && !isSwitching?.();
  const dashboardUrl = () => {
    const url = officeUrl();
    return url ? new URL('/dashboard', url).toString() : undefined;
  };
  const crashes = new CrashPolicy();
  let prompt: { kind: 'crash' | 'hang'; controller: AbortController } | undefined;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  function resetRetries() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retries = 0;
  }
  function reload() {
    resetRetries();
    const current = contents.getURL();
    if (current && current !== 'about:blank' && !current.startsWith('chrome-error:')) {
      contents.reload();
    } else {
      const url = dashboardUrl();
      if (url) void contents.loadURL(url).catch(() => {});
    }
  }
  function dismissPrompt() {
    const current = prompt;
    prompt = undefined;
    current?.controller.abort();
  }
  async function ask(kind: 'crash' | 'hang', box: MessageBoxOptions, handle: (response: number) => void) {
    const current = { kind, controller: new AbortController() };
    prompt = current;
    let response: number;
    try {
      ({ response } = await dialog.showMessageBox(win, { ...box, signal: current.controller.signal }));
    } catch {
      return;
    } finally {
      if (current === prompt) prompt = undefined;
    }
    if (!current.controller.signal.aborted && canRecover()) handle(response);
  }
  contents.on('render-process-gone', (_event, { reason }) => {
    const action = crashes.onGone(reason, Date.now(), isQuitting());
    if (action === 'ignore' || !canRecover() || prompt?.kind === 'crash') return;
    dismissPrompt();
    resetRetries();
    if (action === 'reload') {
      reload();
      return;
    }
    const failure = rendererCrashFailure(`companion reason: ${reason}`);
    logStartupFailure(failure);
    void ask('crash', { type: 'error', message: failure.title, detail: failure.detail, buttons: ['Reload', 'Quit'], defaultId: 0, cancelId: 1 }, (response) => {
      if (response === 0) {
        crashes.reset();
        reload();
      } else app.quit();
    });
  });
  contents.on('unresponsive', () => {
    if (!canRecover() || prompt) return;
    void ask('hang', { type: 'warning', message: 'The companion window is not responding', buttons: ['Wait', 'Reload'], defaultId: 0, cancelId: 0 }, (response) => {
      if (response !== 1) return;
      crashes.reset();
      contents.forcefullyCrashRenderer();
    });
  });
  contents.on('responsive', () => {
    if (prompt?.kind === 'hang') dismissPrompt();
  });
  contents.on('did-fail-load', (_event, code, _description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || failedUrl.startsWith('data:') || retryTimer || !canRecover() || !officeUrl()) return;
    const delay = loadRetryDelay(retries);
    if (delay === undefined) {
      const url = dashboardUrl();
      console.warn(`droid-office: companion failed to load after ${retries} retries (error ${code})`);
      if (url) void contents.loadURL(loadErrorPage(url)).catch(() => {});
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!canRecover()) return;
      const url = dashboardUrl();
      if (!url) return;
      retries++;
      void contents.loadURL(url).catch(() => {});
    }, delay);
  });
  contents.on('did-finish-load', () => {
    if (!contents.getURL().startsWith('chrome-error:')) resetRetries();
  });
  win.once('closed', () => {
    resetRetries();
    dismissPrompt();
  });
}
