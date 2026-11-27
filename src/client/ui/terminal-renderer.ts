import type { WTermAdapter } from '../term-engine/wterm';
import { h, toast } from './dom';

/** Observe every box, but never reflow the shared program through a gesture's
 * intermediate boxes. First observation (attach) and explicit typing stay immediate. */
export function followTerminalFit(term: WTermAdapter, changed: () => void, fit: () => void, workspace?: Element | null) {
  let frame = 0;
  let task = 0;
  let viewportChanging = false;
  const cancel = () => {
    cancelAnimationFrame(frame);
    clearTimeout(task);
  };
  const commit = () => {
    cancel();
    if (workspace?.classList.contains('resizing')) return;
    viewportChanging = false;
    fit();
    term.setFitPending(false);
  };
  const settle = () => {
    cancel();
    if (workspace?.classList.contains('resizing')) return;
    // Frame callbacks run *before* box observations. Allow two quiet frames,
    // then publish after observations on the third, not before its new layout.
    let remaining = 3;
    const tick = () => {
      if (--remaining) frame = requestAnimationFrame(tick);
      else task = window.setTimeout(commit, 0);
    };
    frame = requestAnimationFrame(tick);
  };
  term.onFit((resized) => {
    if (!resized) return fit();
    changed();
    // Terminal layouts don't tween. A discrete split, font or spacing change
    // already has its final box; continuous window and pointer drags do not.
    if (!viewportChanging && !workspace?.classList.contains('resizing')) return commit();
    term.setFitPending(true);
    settle();
  });
  term.onOpen((_native, signal) => {
    window.addEventListener('resize', () => (viewportChanging = true), { signal });
    // A divider can stop moving before release, with no final box observation.
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      workspace?.addEventListener(
        type,
        (event) => {
          if (event.target instanceof Element && event.target.closest('.dash-handle')) settle();
        },
        { signal },
      );
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Opening never attaches to a PTY until the renderer is ready. Only an explicit
 * Retry repeats a failed attempt, in the existing host. */
export async function openTerminalRenderer(term: WTermAdapter, host: HTMLElement, alive: () => boolean) {
  let notified = false;
  while (alive()) {
    try {
      await term.open(host);
      return;
    } catch {
      if (!alive()) return;
      const message = 'The terminal could not load.';
      if (!notified) toast(message, 'warn');
      notified = true;
      const retry = h('button.btn', { type: 'button' }, 'Retry');
      const notice = h('div.empty-state', { role: 'alert' }, h('p', {}, message), retry);
      host.append(notice);
      await new Promise<void>((resolve) => retry.addEventListener('click', () => resolve(), { once: true }));
      notice.remove();
    }
  }
}
