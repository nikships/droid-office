/** The part of a window `leaveFullScreen` needs: Electron's `BaseWindow` fits it. */
export interface FullScreenWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  once(event: 'leave-full-screen' | 'closed', listener: () => void): unknown;
  removeListener(event: 'leave-full-screen' | 'closed', listener: () => void): unknown;
}

/** How long to wait for macOS to animate out of full screen before going on regardless. */
export const LEAVE_FULL_SCREEN_MS = 3000;

/**
 * Takes a window out of full screen and settles once macOS has finished doing it (or the window is gone, or `timeoutMs` passed).
 * A window closed in full screen leaves its Space behind while macOS animates away from it, and a window shown during
 * that animation (the presenter's invisible page window joins every Space) keeps the Space as an empty black one.
 */
export function leaveFullScreen(win: FullScreenWindow, timeoutMs = LEAVE_FULL_SCREEN_MS): Promise<void> {
  if (win.isDestroyed() || !win.isFullScreen()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (!win.isDestroyed()) {
        win.removeListener('leave-full-screen', done);
        win.removeListener('closed', done);
      }
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    win.once('leave-full-screen', done);
    win.once('closed', done);
    win.setFullScreen(false);
  });
}
