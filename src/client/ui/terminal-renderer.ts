import type { WTermAdapter } from '../term-engine/wterm';
import { h, toast } from './dom';

/** Observe every box, but never reflow the shared program through a gesture's
 * intermediate boxes. Input bytes don't wait for the queued ownership claim. */
export function followTerminalFit(term: WTermAdapter, changed: () => void, fit: (claim: boolean) => void, workspace?: Element | null) {
  let frame = 0;
  let task = 0;
  let settling = false;
  let pending = false;
  let claim = false;
  let dragging = false;
  const cancel = () => {
    cancelAnimationFrame(frame);
    clearTimeout(task);
  };
  const commit = () => {
    cancel();
    if (dragging || document.hidden) return;
    settling = false;
    if (pending) fit(claim);
    pending = claim = false;
    term.setFitPending(false);
  };
  const settle = () => {
    cancel();
    if (dragging || document.hidden) return;
    // Frame callbacks run *before* box observations. Allow two quiet frames,
    // then publish after observations on the third, not before its new layout.
    let remaining = 3;
    const tick = () => {
      if (--remaining) frame = requestAnimationFrame(tick);
      else task = window.setTimeout(commit, 0);
    };
    frame = requestAnimationFrame(tick);
  };
  const request = (typing = false) => {
    pending = true;
    claim ||= typing;
    if (!settling && !dragging) commit();
  };
  term.onFit((resized) => {
    if (resized) changed();
    if (resized && (settling || dragging) && !document.hidden) {
      term.setFitPending(true);
      settle();
    }
    request();
  });
  term.onOpen((_native, signal) => {
    window.addEventListener(
      'resize',
      () => {
        settling = true;
        settle();
      },
      { signal },
    );
    dragging = !!workspace?.classList.contains('resizing');
    const observer = new MutationObserver(() => {
      const next = !!workspace?.classList.contains('resizing');
      if (next === dragging || document.hidden) return;
      dragging = next;
      if (!dragging) {
        settling = true;
        settle();
      }
    });
    if (workspace) observer.observe(workspace, { attributes: true, attributeFilter: ['class'] });
    const release = () => {
      cancel();
      settling = dragging = false;
      term.setFitPending(false);
    };
    document.addEventListener('visibilitychange', () => (document.hidden ? release() : commit()), { signal });
    signal.addEventListener(
      'abort',
      () => {
        observer.disconnect();
        release();
      },
      { once: true },
    );
  });
  return request;
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
