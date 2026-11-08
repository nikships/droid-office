# The presenter, input and the offscreen page

The Mac app shows the office page offscreen and draws it into the visible window through `native/presenter`. These are the rules for the code between them. The general desktop rules, including the page's trust boundary, are in [AGENTS.md](AGENTS.md).

## Input

- Nothing arrives at the offscreen page by itself. `input_view.mm` turns AppKit events into plain dictionaries, `presenter-input.ts` (`PresenterInput`, tested over fakes in `tests/presenter-input.test.ts`) turns those into `sendInputEvent` / CDP calls, and the pure pieces (`input-events.ts`, `input-keys.ts`, `input-lock.ts`, `input-bridge.ts`, `input-cursor.ts`, `edit-menu.ts`) are tested in `tests/input-events.test.ts` without Electron. They stay free of `electron` imports.
- The window's content view is Electron's `BridgedContentView`, whose hit test answers itself for any subview it did not host, so AppKit never gives `DOPresenterView` a click, drag or scroll by itself (hover works, because tracking areas ignore hit testing). `input_view.mm` installs a local event monitor (`routed:`) that hands the presenter view the mouse and scroll events the content view took, and only re-takes first responder for keys; the title bar, traffic lights and resize edges stay the frame's. Synthesized events that go straight into the view skip all of this, so a check of clicks posts them through the event queue (`NSApp postEvent:`), and `tests/presenter-native-input.test.ts` guards the monitor's shape.
- The Edit menu in `edit-menu.ts` acts on `win.contents`; it stays custom rather than `{ role: 'editMenu' }`.

## The page shim

The injected page script is `page/shim.ts`, a real source file with its own `tsconfig.desktop-page.json` (DOM types, no imports, emitted to `dist/desktop/page/shim.js`, which `build:desktop` and `typecheck` cover). It implements pointer lock (Chromium refuses it offscreen), the `<select>` list, `title` tooltips and the caret report. Behavior it keeps for `src/client/player.ts`: the events, `pointerLockElement`, the promise (rejecting `NotSupportedError` for `unadjustedMovement` without a raw mouse), Esc and relock rules (#195). The rules are in `input-lock.ts`; change them with its tests.

## The DevTools Protocol and visibility

- Attach the DevTools Protocol to the offscreen page only after `did-finish-load` of a first page: `Runtime.enable` hangs before the first commit. `PresenterInput` does this and re-injects the shim for every new document with `Page.addScriptToEvaluateOnNewDocument`.
- Visibility belongs to `presenter.ts` (`PresenterWindow.setVisible`). Input code focuses `contents` and turns on CDP focus emulation (`Emulation.setFocusEmulationEnabled`) so `document.hasFocus()` follows the visible window; showing, hiding and focusing the page's window stay with `presenter.ts`. `webContents.invalidate()` hangs the offscreen page, so it is never called on it.

## Recovery

A page that crashes or a window that can't draw always ends in a recovered page or a startup failure, never a frozen or black window. `presenter-recovery.ts` (pure, `tests/presenter-recovery.test.ts`) holds the policies `presenter.ts` applies:

- Reload the page once on a render-process crash, and ask after a second crash within a minute.
- Reload once when the GPU process dies and the page stays silent for 3 s.
- Show the window only once the addon reports a drawn frame (`firstDrawn`), so an import failure ends in `failStartup`.
- A window the page opens goes to the browser (`windowOpenAction`), never into an Electron window: a child of the offscreen page would inherit shared-texture rendering with nothing to show it. The page's IPC is accepted only from its main frame at the office's origin (`trustedFrame`).
- After the navigation to the office, Electron's offscreen view sometimes starts with no paint events reaching the presenter (the page runs, the window keeps the splash). `PaintStall` kicks it (stop then start painting), reloads once, and ends in `failStartup` about 9 to 10 s after the page loaded. An app-started reload sets `PresenterWindow.reloading` so the "Leave the office?" prompt in `main.ts` stays quiet. Keep that watch armed on every load of the office origin and off the splash, which a cold first launch can sit on for 20 s.

## Lifecycle

Everything in the presenter ends with the offscreen page. Quitting closes and destroys the page before the visible window's `closed`, so a timer or event that reaches `contents` after that raises "Object has been destroyed" as an uncaught exception in the main process.

- Every presenter timer goes through `PresenterTimers` (`presenter-lifecycle.ts`). `PresenterWindow.quiesce()` stops them all, stops `InputFrameRate` and calls `onGone` (which stops `PresenterInput`) on `before-quit`, the page window's `close` and the contents' `destroyed`.
- A call on the page goes through `onPage` or checks `gone()`. `PresenterInput` drops every event, visibility change and protocol call once `stop()` has run, and wraps the calls a destroyed page throws on.
- A new timer or listener in the presenter takes the same path, with a test in `tests/presenter-lifecycle.test.ts`.
