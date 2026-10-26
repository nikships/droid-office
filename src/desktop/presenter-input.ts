import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent } from 'electron';
import { BINDING_NAME, type ExecutionContext, type HostMessage, parseHostMessage, trustedContext } from './input-bridge.js';
import { nativeCursor } from './input-cursor.js';
import { BUTTON, captured, type NativeEvent, type NativeFlags, type NativeKey, type Pointer, pointerAt, mouseEvent, wheelEvent, type NativeMouse, type NativeDelta } from './input-events.js';
import { type ChooserOptions, chooserFilters, parseChooserOpened } from './file-chooser.js';
import { cdpFlagEvents, cdpKeyEvent } from './input-keys.js';
import { PointerLock } from './input-lock.js';

/** The commands `native/presenter/src/input_bridge.mm` adds to the addon. */
export interface InputNative {
  inputCapture(on: boolean, raw?: boolean): boolean;
  inputCapabilities(): { rawMouse: boolean };
  inputSetCursor(name: string): void;
  inputSetCursorImage(png: Buffer, hotspotX: number, hotspotY: number, scale: number): void;
  inputSetTextInput(active: boolean): void;
  inputSetImeRect(x: number, y: number, w: number, h: number): void;
  inputFocus(): void;
}

/** The part of the offscreen page's `WebContents` the input code uses. */
export interface InputPage {
  sendInputEvent(event: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent): void;
  focus(): void;
  getURL(): string;
  debugger: {
    attach(protocolVersion?: string): void;
    detach(): void;
    isAttached(): boolean;
    sendCommand(method: string, params?: object): Promise<unknown>;
    on(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): unknown;
    on(event: 'detach', listener: () => void): unknown;
  };
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
}

export interface PresenterInputOptions {
  page: InputPage;
  native: InputNative;
  /** The compiled `page/shim.js`. */
  shimSource: string;
  /** The office's origin, once there is one. Only its main frame may use the page-to-main channel. */
  officeOrigin: () => string | undefined;
  /** Whether the native window is the key window right now. */
  focused: () => boolean;
  /** Shows the open panel for a file input in the office page; the paths chosen, or none when cancelled. */
  chooseFiles?: (options: ChooserOptions) => Promise<string[]>;
  log?: (message: string) => void;
  /** Diagnostic: one line per input step (`input-trace.ts`). */
  trace?: (line: string) => void;
}

const SHIM = "globalThis[Symbol.for('droid-office.shim')]";
/** The most key-trace lines kept for one terminal key report. */
export const KEY_TRACE_MAX_LINES = 5000;

/**
 * Carries what happens in the native view to the offscreen office page, as a browser window would have: mouse and wheel through
 * `sendInputEvent`, keys and text-input-method composition through the DevTools protocol, the mouse capture an offscreen page
 * cannot take for itself (pointer lock, answered to the page by `page/shim.ts`), the cursor, focus, and a caret position for the
 * input method's candidate window. Nothing here waits on a frame: input and painting never share a queue.
 */
export class PresenterInput {
  private readonly lock: PointerLock;
  private pointer: Pointer = pointerAt(0, 0);
  private buttons = 0;
  private mods = 0;
  private cursor: { name: string } | { png: Buffer; hotspot: { x: number; y: number }; scale: number } = { name: 'arrow' };
  /** Key and text-input commands go out one at a time, in the order they happened. */
  private queue: Promise<unknown> = Promise.resolve();
  private contexts = new Map<number, ExecutionContext>();
  private mainFrameId: string | undefined;
  private attached = false;
  private stopped = false;
  private focus = false;
  private pageHidden = false;
  /** An open panel is up; another file input asking meanwhile is ignored. */
  private choosing = false;
  /** While the page records a terminal key report: the input steps since it started (see keyTraceSet). */
  private keyTrace: string[] | null = null;

  constructor(private readonly options: PresenterInputOptions) {
    this.lock = new PointerLock(() => options.native.inputCapabilities().rawMouse);
    const { page } = options;
    page.on('cursor-changed', (_e: unknown, type: string, image: { toPNG(): Buffer; isEmpty(): boolean }, scale: number, _size: unknown, hotspot: { x: number; y: number }) => {
      if (!this.stopped) this.cursorChanged(type, image, scale, hotspot);
    });
    // A page that is going away takes its pointer lock with it.
    page.on('did-start-navigation', (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (!this.stopped && details?.isMainFrame && !details.isSameDocument) this.releaseLock();
    });
    page.on('did-finish-load', () => {
      if (this.stopped) return;
      this.trace(`did-finish-load url=${page.getURL()}`);
      void this.attach().then(() => this.pageHidden && this.applyVisibility());
    });
    page.on('render-process-gone', () => {
      if (this.stopped) return;
      this.trace('render-process-gone');
      this.attached = false;
      this.releaseLock();
    });
    page.debugger.on('detach', () => {
      if (this.stopped) return;
      this.trace('debugger detach');
      this.attached = false;
      this.releaseLock();
    });
    page.debugger.on('message', (_e, method, params) => {
      if (!this.stopped) this.protocolEvent(method, params);
    });
  }

  /** Attaches now. It also happens by itself when a page finishes loading; this is for a page that already has. */
  async start(): Promise<void> {
    await this.attach();
  }

  /**
   * Ends all input: the page is going away (the app is quitting, or its window is closing), so nothing from the native view or the page
   * is acted on after this. It can run when the native view is already gone and every call into it throws, and when the page is gone and
   * every call into it throws, so each step is on its own.
   */
  stop(): void {
    if (this.stopped) return;
    try {
      this.releaseLock();
    } catch {
      // Nothing left to release.
    }
    this.stopped = true;
    this.attached = false;
    try {
      this.options.native.inputSetTextInput(false);
    } catch {
      // The native view is gone.
    }
    try {
      if (this.options.page.debugger.isAttached()) this.options.page.debugger.detach();
    } catch {
      // The page is already destroyed.
    }
  }

  get captured(): boolean {
    return this.lock.locked;
  }

  private log(message: string) {
    this.options.log?.(message);
  }

  private trace(line: string) {
    this.options.trace?.(line);
    if (this.keyTrace && !line.startsWith('native {"type":"mouse"') && this.keyTrace.length < KEY_TRACE_MAX_LINES) this.keyTrace.push(`${(Date.now() / 1000).toFixed(3)} ${line}`);
  }

  /** Tells the page whether its window can be seen. A page nobody sees stops drawing, as a background tab does; the page learns it only from here. */
  setPageVisible(visible: boolean): void {
    this.pageHidden = !visible;
    this.applyVisibility();
  }

  private applyVisibility() {
    if (this.stopped) return;
    void this.evaluate(`${SHIM}?.visibility(${this.pageHidden})`);
  }

  /** The session has no target before the first page commits and hangs, so this runs from `did-finish-load`, never before. */
  private async attach(): Promise<void> {
    if (this.stopped || this.attached) return this.trace(`attach skipped stopped=${this.stopped} attached=${this.attached}`);
    this.focus = this.options.focused();
    const { debugger: dbg } = this.options.page;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      this.attached = true;
      this.contexts.clear();
      // Before the script, so the binding is there when it runs at the start of every document.
      await dbg.sendCommand('Runtime.enable');
      await dbg.sendCommand('Page.enable');
      if (this.options.chooseFiles) await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
      await dbg.sendCommand('Runtime.addBinding', { name: BINDING_NAME });
      await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: this.options.shimSource, runImmediately: true });
      const tree = (await dbg.sendCommand('Page.getFrameTree')) as { frameTree?: { frame?: { id?: string } } };
      this.mainFrameId = tree.frameTree?.frame?.id;
      await this.setFocus(this.focus);
      this.trace(`attached focus=${this.focus} mainFrame=${this.mainFrameId}`);
    } catch (err) {
      this.trace(`attach failed: ${(err as Error).message}`);
      this.attached = false;
      this.log(`input: could not attach to the page: ${(err as Error).message}`);
    }
  }

  private protocolEvent(method: string, params: Record<string, unknown>) {
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const ctx = params.context as ExecutionContext | undefined;
        if (ctx && typeof ctx.id === 'number') this.contexts.set(ctx.id, ctx);
        break;
      }
      case 'Runtime.executionContextDestroyed':
        this.contexts.delete(params.executionContextId as number);
        break;
      case 'Runtime.executionContextsCleared':
        this.contexts.clear();
        break;
      case 'Page.frameNavigated': {
        const frame = params.frame as { id?: string; parentId?: string } | undefined;
        if (frame && !frame.parentId) this.mainFrameId = frame.id;
        break;
      }
      case 'Runtime.bindingCalled':
        if (params.name === BINDING_NAME) this.hostCalled(params.executionContextId as number, params.payload);
        break;
      case 'Page.fileChooserOpened':
        void this.fileChooser(params);
        break;
    }
  }

  // --- File inputs --------------------------------------------------------------------------------------------------

  /** A file input in the page was clicked: the open panel on the visible window, and what was chosen handed to the input. */
  private async fileChooser(params: Record<string, unknown>) {
    const req = parseChooserOpened(params);
    const choose = this.options.chooseFiles;
    if (!req || !choose) return this.trace('file chooser: bad parameters');
    if (!this.officeFrame(req.frameId)) return this.trace(`file chooser from frame ${req.frameId} refused`);
    if (this.choosing) return this.trace('file chooser: one is already open');
    this.choosing = true;
    const dbg = this.options.page.debugger;
    try {
      const resolved = (await dbg.sendCommand('DOM.resolveNode', { backendNodeId: req.backendNodeId })) as { object?: { objectId?: string } };
      const objectId = resolved.object?.objectId;
      let accept: unknown = '';
      let directory = false;
      if (objectId) {
        const read = (await dbg.sendCommand('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function () { return { accept: String(this.accept || ""), directory: !!this.webkitdirectory }; }',
          returnByValue: true,
        })) as { result?: { value?: { accept?: unknown; directory?: unknown } } };
        accept = read.result?.value?.accept;
        directory = read.result?.value?.directory === true;
        void dbg.sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
      }
      if (this.stopped) return;
      const files = await choose({ multiple: req.multiple, directory, filters: directory ? [] : chooserFilters(accept) });
      // The panel can stay up a long while: the page may have gone somewhere else meanwhile.
      if (this.stopped || !files.length || !this.officeFrame(req.frameId)) return;
      await dbg.sendCommand('DOM.setFileInputFiles', { files: req.multiple ? files : files.slice(0, 1), backendNodeId: req.backendNodeId });
    } catch (err) {
      this.log(`input: file chooser: ${(err as Error).message}`);
    } finally {
      this.choosing = false;
    }
  }

  /** Whether `frameId` is the office's own main frame, with the office's page in it. */
  private officeFrame(frameId: string): boolean {
    const office = this.options.officeOrigin();
    return !!office && frameId === this.mainFrameId && originOf(this.options.page.getURL()) === office;
  }

  // --- The page's channel to main -----------------------------------------------------------------------------------

  private hostCalled(contextId: number, payload: unknown) {
    if (!trustedContext(this.contexts.get(contextId), this.mainFrameId, this.options.officeOrigin())) return this.trace(`host message from an untrusted context ${contextId}: ${String(payload).slice(0, 80)}`);
    const message = parseHostMessage(payload);
    if (!message) return this.trace(`host message rejected: ${String(payload).slice(0, 80)}`);
    this.trace(`host ${JSON.stringify(message)}`);
    this.hostMessage(message);
  }

  private hostMessage(m: HostMessage) {
    switch (m.t) {
      case 'lock':
        return this.lockRequested(m.id, m.raw, m.activation);
      case 'exit':
        if (this.lock.pageExit()) this.releaseCapture();
        return;
      case 'escUp':
        if (this.lock.escapeUpSeenByPage(m.prevented)) this.releaseCapture();
        return;
      case 'editable':
        this.options.native.inputSetTextInput(m.on);
        if (m.on) this.options.native.inputSetImeRect(m.x, m.y, m.w, m.h);
        return;
      case 'keyTrace':
        return this.keyTraceSet(m.on);
    }
  }

  /** Starts keeping the key steps for the page's report, or ends it and gives the page what was kept. Text typed is in them: they go only to the owner's own report. */
  private keyTraceSet(on: boolean) {
    if (on) {
      this.keyTrace = [`${(Date.now() / 1000).toFixed(3)} key trace on: attached=${this.attached} focus=${this.focus} window focused=${this.options.focused()} captured=${this.lock.locked}`];
      return;
    }
    const lines = this.keyTrace ?? [];
    this.keyTrace = null;
    this.evaluate(`${SHIM}?.keyTraceLines(${JSON.stringify(lines)})`);
  }

  private lockRequested(id: number, raw: boolean, activation: boolean) {
    const answer = this.lock.request({ raw, activation });
    if (!answer.ok) return void this.evaluate(`${SHIM}?.denied(${id}, ${JSON.stringify(answer.error)})`);
    try {
      this.options.native.inputCapture(true, answer.raw);
    } catch (err) {
      this.lock.userExit();
      this.log(`input: could not capture the mouse: ${(err as Error).message}`);
      return void this.evaluate(`${SHIM}?.denied(${id}, "NotAllowedError")`);
    }
    // The cursor stays where it was, and the page measures movement from there.
    this.evaluate(`${SHIM}?.granted(${id}, ${answer.raw})`);
  }

  /** Tells the page the mouse is no longer captured and gives the real cursor back. */
  private releaseCapture() {
    this.options.native.inputCapture(false);
    this.evaluate(`${SHIM}?.revoked()`);
    // The next normal move measures from here, not from wherever the virtual position went while captured.
    this.pointer = pointerAt(this.pointer.x, this.pointer.y);
    this.send(mouseEvent(this.pointer, 'mouseMove', { buttons: this.buttons, mods: this.mods }));
    this.applyCursor();
  }

  private releaseLock() {
    if (this.lock.userExit()) this.releaseCapture();
  }

  private evaluate(expression: string): Promise<unknown> {
    if (this.stopped || !this.attached) return Promise.resolve();
    try {
      return this.options.page.debugger.sendCommand('Runtime.evaluate', { expression }).catch((err: Error) => this.log(`input: evaluate failed: ${err.message}`));
    } catch (err) {
      // A destroyed page throws at once instead of rejecting.
      this.log(`input: evaluate failed: ${(err as Error).message}`);
      return Promise.resolve();
    }
  }

  // --- Native events ------------------------------------------------------------------------------------------------

  /** Everything the native view reports arrives here. It never throws: input must not take the main process down. */
  handle(event: NativeEvent): void {
    if (this.stopped) return;
    try {
      this.dispatch(event);
    } catch (err) {
      this.log(`input: ${(err as Error).message}`);
    }
  }

  private dispatch(event: NativeEvent) {
    if (event.type !== 'delta' && event.type !== 'scroll' && !(event.type === 'mouse' && (event.kind === 'move' || event.kind === 'enter' || event.kind === 'leave'))) this.trace(`native ${JSON.stringify(event)}`);
    switch (event.type) {
      case 'mouse':
        return this.mouse(event);
      case 'delta':
        return this.delta(event);
      case 'scroll':
        this.mods = event.mods;
        return this.send(wheelEvent(event, this.lock.locked ? this.pointer : { x: event.x, y: event.y }));
      case 'key':
        return this.key(event);
      case 'flags':
        return this.flags(event);
      case 'compose':
        return this.command('Input.imeSetComposition', { text: event.text, selectionStart: event.selStart, selectionEnd: event.selEnd });
      case 'commit':
        return this.command('Input.insertText', { text: event.text });
      case 'composeEnd':
        return this.command('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      case 'focus':
        return this.focusChanged(event.focused);
    }
  }

  private send(event: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent) {
    if (this.stopped) return;
    try {
      this.options.page.sendInputEvent(event);
    } catch (err) {
      // A destroyed page throws; the event is dropped, and what follows it in the same step (the cursor) still runs.
      this.log(`input: sendInputEvent failed: ${(err as Error).message}`);
    }
  }

  private mouse(e: NativeMouse) {
    this.buttons = e.buttons;
    this.mods = e.mods;
    if (!this.lock.locked) this.pointer = pointerAt(e.x, e.y);
    const at = this.pointer;
    switch (e.kind) {
      case 'down':
        return this.send(mouseEvent(at, 'mouseDown', { button: e.button, buttons: e.buttons | buttonBit(e.button), clickCount: e.clickCount, mods: e.mods }));
      case 'up':
        return this.send(mouseEvent(at, 'mouseUp', { button: e.button, buttons: e.buttons & ~buttonBit(e.button), clickCount: e.clickCount, mods: e.mods }));
      case 'move':
        return this.send(mouseEvent(at, 'mouseMove', { buttons: e.buttons, mods: e.mods }));
      case 'enter':
        return this.send(mouseEvent(at, 'mouseEnter', { buttons: e.buttons, mods: e.mods }));
      case 'leave':
        return this.send(mouseEvent(at, 'mouseLeave', { buttons: e.buttons, mods: e.mods }));
    }
  }

  private delta(e: NativeDelta) {
    if (!this.lock.locked) return;
    this.buttons = e.buttons;
    this.mods = e.mods;
    this.pointer = captured(this.pointer, e.dx, e.dy);
    this.send(mouseEvent(this.pointer, 'mouseMove', { buttons: e.buttons, mods: e.mods }));
  }

  private key(e: NativeKey) {
    this.mods = e.mods;
    if (e.keyCode === ESCAPE) {
      if (e.kind === 'down' && !e.repeat) {
        if (this.lock.escapeDown()) this.releaseCapture();
      } else if (e.kind === 'up') this.lock.escapeUp();
    }
    this.command('Input.dispatchKeyEvent', cdpKeyEvent(e));
  }

  private flags(e: NativeFlags) {
    this.mods = e.mods;
    for (const key of cdpFlagEvents(e)) this.command('Input.dispatchKeyEvent', key);
  }

  /** A protocol command in order after the ones before it. A refused command is logged and never stops the ones after it. */
  private command(method: string, params: object) {
    if (this.stopped || !this.attached) return this.trace(`${method} dropped: not attached`);
    const dbg = this.options.page.debugger;
    this.trace(`${method} ${JSON.stringify(params)}`);
    this.queue = this.queue
      .then(() => (this.stopped ? undefined : dbg.sendCommand(method, params)))
      .then(() => this.trace(`${method} ok`))
      .catch((err: Error) => {
        this.trace(`${method} failed: ${err.message}`);
        this.log(`input: ${method}: ${err.message}`);
      });
  }

  // --- Focus and cursor ---------------------------------------------------------------------------------------------

  private focusChanged(focused: boolean) {
    this.focus = focused;
    if (!focused) this.releaseLock();
    void this.setFocus(focused);
    if (focused) this.onPage(() => this.options.page.focus());
  }

  /** The offscreen window can never be the real key window, so the page is told it has focus instead. */
  private async setFocus(focused: boolean) {
    if (this.stopped || !this.attached) return;
    try {
      await this.options.page.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: focused });
    } catch (err) {
      this.log(`input: focus emulation: ${(err as Error).message}`);
    }
  }

  private cursorChanged(type: string, image: { toPNG(): Buffer; isEmpty(): boolean } | undefined, scale: number, hotspot: { x: number; y: number }) {
    const png = type === 'custom' && image && !image.isEmpty() ? image.toPNG() : undefined;
    // The page chooses the image, so it is capped before it is handed to native code: a larger one falls back to the arrow.
    if (png && png.length <= MAX_CURSOR_PNG) this.cursor = { png, hotspot, scale };
    else this.cursor = { name: png ? 'arrow' : nativeCursor(type) };
    if (!this.lock.locked) this.applyCursor();
  }

  /** A call into the page that a destroyed page answers by throwing is dropped. */
  private onPage(fn: () => void) {
    try {
      fn();
    } catch (err) {
      this.log(`input: ${(err as Error).message}`);
    }
  }

  private applyCursor() {
    const c = this.cursor;
    if ('name' in c) this.options.native.inputSetCursor(c.name);
    else this.options.native.inputSetCursorImage(c.png, c.hotspot.x, c.hotspot.y, c.scale);
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

const ESCAPE = 0x35;
/** The largest cursor image (PNG bytes) taken from the page; real cursors are a few KB. */
const MAX_CURSOR_PNG = 256 * 1024;

function buttonBit(button: number): number {
  return button === 1 ? BUTTON.right : button === 2 ? BUTTON.middle : BUTTON.left;
}
