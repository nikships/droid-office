import { fileURLToPath } from 'node:url';
import { app, BaseWindow, BrowserWindow, ipcMain, screen, type WebContents } from 'electron';
import { requirePresenter } from './native.js';
import { layerPixelFormat, type NativeStats, osrFrameRate, osrPixelFormat, PageVisibility, pageSize, type PresenterReport, type PresentMode, presentMode, summarizeNativeStats, TextureLedger, windowVisible } from './presenter-model.js';
import { failStartup, loadNative, StartupAborted } from './startup.js';
import { sharedTextureFailure } from './startup-failure.js';

const PAGE_PRELOAD = fileURLToPath(new URL('./page-preload.cjs', import.meta.url));
/** How long the first shared texture may take. The page is a local data: URL at that point, so a healthy start paints within a second or two. */
const FIRST_TEXTURE_MS = 10_000;

/** What `display` state events from the addon carry. */
export interface DisplayState {
  type: 'display';
  maxFps: number;
  edr: number;
  edrPotential: number;
  scale: number;
  screen: string;
  visible: boolean;
}

interface NativePresenter {
  submit(id: number, ioSurface: Buffer, frameCount?: number): void;
  setPacing(options: { fps?: number; followDisplay?: boolean }): void;
  setHdr(on: boolean): void;
  setDisplaySync(on: boolean): void;
  stats(options?: { reset?: boolean }): NativeStats;
  displayInfo(): Record<string, unknown>;
  capture(callback: (frame: { width: number; height: number; pixelFormat: string; data: Buffer }) => void): void;
  focus(): void;
  close(): void;
}

interface NativeModule {
  Presenter: new (
    windowHandle: Buffer,
    options: { pixelFormat: 'rgbaf16' | 'bgra'; mode: PresentMode; frameLatency?: number | undefined; onRelease: (id: number) => void; onState?: (state: Record<string, unknown>) => void; onEvent?: (event: Record<string, unknown>) => void },
  ) => NativePresenter;
  probe(): Record<string, unknown>;
  edrCapable(): boolean;
  now(): number;
}

let moduleCache: NativeModule | undefined;

/** The addon, loaded once; a load failure ends the app through `failStartup`. */
export function presenterModule(): NativeModule {
  moduleCache ??= loadNative(() => requirePresenter(app.getAppPath()) as unknown as NativeModule);
  return moduleCache;
}

export interface PresenterWindowOptions {
  title: string;
  backgroundColor: string;
  /** Called once with the window state the first texture arrives in; show and full-screen it from here. */
  onFirstFrame: (base: BaseWindow) => void;
  /** `direct` (the default) presents each frame as it arrives; `paced` also holds it to the vsync grid at the 40 and 60 FPS limits (steady cadence, but about 15 to 20 ms more latency in a window); `link` draws on `CAMetalDisplayLink` updates (steady cadence, about 20 ms more latency in a window). */
  mode?: PresentMode;
  /** In `link` mode, the frames the display link leads the display by. */
  frameLatency?: number;
  /** Extra `webPreferences` merged under the offscreen ones. */
  webPreferences?: Electron.WebPreferences;
}

/**
 * The office window: a visible `BaseWindow` whose only content is the native Metal view, and a hidden offscreen
 * `BrowserWindow` that renders the page into shared GPU textures. Every texture goes straight to the addon, which
 * presents it on the display's refresh and hands the texture back once the GPU is done with it.
 */

export class PresenterWindow {
  readonly base: BaseWindow;
  readonly page: BrowserWindow;
  readonly contents: WebContents;
  private readonly native: NativePresenter;
  private readonly ledger = new TextureLedger<Electron.OffscreenSharedTexture>();
  /** Receives what the native view's `eventSink` emits (mouse, keys, text input); set by the input code. */
  onNativeEvent: ((event: Record<string, unknown>) => void) | undefined;
  /** Called whenever the page becomes visible or hidden (a minimized or covered window), so the office page can pause its own render loop. */
  onVisibleChange: ((visible: boolean) => void) | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private recheck: NodeJS.Timeout | undefined;
  private settle: NodeJS.Timeout | undefined;
  private gotTexture = false;
  private closed = false;
  private hdr = false;
  private readonly visibility: PageVisibility;
  private maxFps = 60;
  private readonly mode: PresentMode;

  constructor(private readonly options: PresenterWindowOptions) {
    this.mode = options.mode ?? presentMode(process.env);
    const module = presenterModule();
    this.base = new BaseWindow({ width: 1440, height: 900, show: false, title: options.title, backgroundColor: options.backgroundColor });
    const content = this.base.getContentSize();
    const format = osrPixelFormat(module.edrCapable());
    // The scale factor is fixed when the page is created, so take the sharpest screen's: the window then stays sharp on whichever screen it is dragged to, and the presenter filters it down on the others.
    const scaleFactor = Math.max(1, ...screen.getAllDisplays().map((d) => d.scaleFactor));
    this.page = new BrowserWindow({
      show: false,
      frame: false,
      useContentSize: true,
      width: content[0],
      height: content[1],
      backgroundColor: options.backgroundColor,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        spellcheck: false,
        autoplayPolicy: 'no-user-gesture-required',
        ...options.webPreferences,
        preload: PAGE_PRELOAD,
        offscreen: { useSharedTexture: true, sharedTexturePixelFormat: format, deviceScaleFactor: scaleFactor },
      },
    });
    this.contents = this.page.webContents;
    this.visibility = new PageVisibility({
      startPainting: () => this.contents.startPainting(),
      stopPainting: () => this.contents.stopPainting(),
      setFrameRate: (fps) => this.contents.setFrameRate(fps),
      notify: (visible) => this.onVisibleChange?.(visible),
    });
    // The offscreen page is a real window as far as the window server is concerned, so it is made invisible and click-through
    // rather than left unshown. It is never hidden or ordered front again: that does not change the page's visibilityState or slow
    // its animation frames in Electron's offscreen mode (only a low frame rate does), so PageVisibility drops the frame rate and tells
    // the office page itself. It joins every Space: left on the desktop it was ordered from, it is occluded and tugs the Space switch
    // when the visible window goes full screen into a new one, which left the visible window occluded for good about two launches in three.
    this.page.setOpacity(0);
    this.page.setIgnoreMouseEvents(true);
    this.page.setFocusable(false);
    this.page.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // Screen-share pickers list an invisible window too; sharing none keeps it out of them (paints and presented frames were unchanged with it on).
    this.page.setContentProtection(true);
    this.page.setHiddenInMissionControl(true);
    this.page.excludedFromShownWindowsMenu = true;
    this.page.showInactive();
    this.native = new module.Presenter(this.base.getNativeWindowHandle(), {
      pixelFormat: layerPixelFormat(format),
      mode: this.mode,
      frameLatency: options.frameLatency,
      onRelease: (id) => {
        this.ledger.release(id);
      },
      onState: (state) => this.nativeState(state),
      onEvent: (event) => this.onNativeEvent?.(event),
    });
    this.applyDisplay(this.native.displayInfo() as unknown as DisplayState);
    this.contents.on('paint', (event) => this.paint(event.texture));
    // A new page view (a navigation to the office swaps it) is made at Electron's own rate, not the one asked for, so every load sets the rate again.
    for (const event of ['dom-ready', 'did-navigate', 'did-finish-load'] as const) this.contents.on(event as 'dom-ready', () => this.visibility.reapply());
    // A minimized window does not always report an occlusion change, so the window's own events speak for it too.
    this.base.on('minimize', () => this.setVisible(false));
    this.base.on('restore', () => this.setVisible(true));
    this.base.on('resize', () => this.resizePage());
    this.base.on('enter-full-screen', () => this.resizePage());
    this.base.on('leave-full-screen', () => this.resizePage());
    this.base.once('closed', () => this.dispose());
    this.watchdog = setTimeout(() => this.noTexture(`no paint event carried a shared texture within ${FIRST_TEXTURE_MS / 1000} s of the window opening`), FIRST_TEXTURE_MS);
    this.registerIpc();
  }

  /** The native side's presentation numbers, judged against `plannedMs` between frames (the FPS cap or the refresh). */
  stats(options: { reset?: boolean; plannedMs?: number; samples?: boolean } = {}): PresenterReport {
    const raw = this.native.stats({ reset: options.reset });
    return summarizeNativeStats(raw, options.plannedMs ?? 1000 / this.maxFps, options.samples === true, this.mode);
  }

  /** Reads back the next presented frame (tests and measurement only). */
  capture(): Promise<{ width: number; height: number; pixelFormat: string; data: Buffer }> {
    return new Promise((resolve) => this.native.capture(resolve));
  }

  focus(): void {
    this.native.focus();
  }

  private paint(texture: Electron.OffscreenSharedTexture | undefined): void {
    if (this.closed) {
      texture?.release();
      return;
    }
    if (!texture) {
      this.noTexture('a paint event arrived without a shared texture (the offscreen page is not exporting GPU frames)');
      return;
    }
    const info = texture.textureInfo;
    const surface = info.handle.ioSurface;
    if (!surface || surface.length < 8) {
      texture.release();
      this.noTexture(`the shared texture has no IOSurface handle (pixel format ${info.pixelFormat})`);
      return;
    }
    if (info.widgetType !== 'frame') {
      // Popup widgets (a <select> list, say) are separate textures positioned over the frame; nothing composites them yet.
      texture.release();
      return;
    }
    if (!this.gotTexture) {
      this.gotTexture = true;
      clearTimeout(this.watchdog);
      this.options.onFirstFrame(this.base);
    }
    const id = this.ledger.hold(texture);
    try {
      this.native.submit(id, surface, info.metadata.frameCount ?? 0);
    } catch (err) {
      this.ledger.release(id);
      this.noTexture(`the Metal presenter refused a frame: ${(err as Error).message}`);
    }
  }

  private noTexture(why: string): void {
    if (this.closed) return;
    try {
      failStartup(sharedTextureFailure(why));
    } catch (err) {
      if (!(err instanceof StartupAborted)) throw err;
    }
  }

  private resizePage(): void {
    const size = pageSize({ width: this.base.getContentSize()[0]!, height: this.base.getContentSize()[1]! });
    this.page.setContentSize(size.width, size.height);
  }

  private nativeState(state: Record<string, unknown>): void {
    if (state.type === 'display') this.applyDisplay(state as unknown as DisplayState);
  }

  private applyDisplay(state: DisplayState): void {
    if (this.closed) return;
    this.maxFps = osrFrameRate(state.maxFps);
    this.visibility.setDisplayRate(this.maxFps);
    this.native.setPacing({ followDisplay: true });
    // The window isn't on screen until the first frame, so "not visible" means nothing before then.
    this.setVisible(windowVisible(state) || !this.gotTexture);
  }

  /** A window nobody can see (minimized, covered, on another Space) makes no frames and its page is slowed to the floor frame rate and told it is hidden (`onVisibleChange`), which is what pauses the office's render loop. */
  private setVisible(visible: boolean): void {
    this.visibility.set(visible);
    clearTimeout(this.settle);
    // A visible page must run at the display's rate, so it is set again once the fullscreen or restore transition has settled: a rate lost to it must not leave a visible page at the hidden floor.
    if (visible) this.settle = setTimeout(() => this.visibility.reapply(), 500);
    if (visible || this.closed) {
      clearInterval(this.recheck);
      this.recheck = undefined;
    } else if (!this.recheck) {
      // An occlusion event is the only thing that turns a hidden page back on, so while hidden the window's real state is read once a second: a missed event must not strand a window that is on screen at the floor frame rate.
      this.recheck = setInterval(() => {
        if (!this.closed && windowVisible(this.native.displayInfo() as unknown as DisplayState)) this.setVisible(true);
      }, 1000);
    }
  }

  private registerIpc(): void {
    const own = (sender: WebContents) => sender === this.contents;
    ipcMain.handle('presenter:stats', (event, reset: unknown, plannedMs: unknown, samples: unknown) => {
      if (!own(event.sender)) return null;
      return this.stats({ reset: reset === true, plannedMs: typeof plannedMs === 'number' && plannedMs > 0 ? plannedMs : undefined, samples: samples === true });
    });
    ipcMain.on('presenter:hdr', (event, on: unknown) => {
      if (!own(event.sender) || typeof on !== 'boolean') return;
      this.hdr = on;
      this.native.setHdr(on);
    });
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.watchdog);
    clearInterval(this.recheck);
    clearTimeout(this.settle);
    ipcMain.removeHandler('presenter:stats');
    ipcMain.removeAllListeners('presenter:hdr');
    this.native.close();
    this.ledger.releaseAll();
    if (!this.page.isDestroyed()) this.page.destroy();
  }

  get hdrActive(): boolean {
    return this.hdr;
  }
}
