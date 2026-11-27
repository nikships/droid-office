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
  // A stepped transition, or the rounded end of an easing curve, can produce
  // identical boxes for several frames before its last layout change.
  const movingBox = () => {
    for (let el = term.native?.element as Element | null | undefined; el; el = el.parentElement) {
      for (const animation of el.getAnimations()) {
        const effect = animation.effect;
        if (animation.playState !== 'running' || !(effect instanceof KeyframeEffect) || effect.getComputedTiming().iterations === Infinity) continue;
        if (effect.getKeyframes().some((k) => Object.keys(k).some((p) => /^(?:width|height|(?:min|max)(?:Width|Height)|(?:block|inline)Size|grid|flex|margin|padding|font|--)/.test(p)))) return true;
      }
    }
    return false;
  };
  const commit = () => {
    cancel();
    if (dragging || document.hidden) return;
    if (settling && movingBox()) return settle();
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
    if (settling || dragging) {
      if (!document.hidden) term.setFitPending(true);
    } else commit();
  };
  term.onFit((resized) => {
    if (resized) changed();
    if (!document.hidden && (resized || movingBox())) {
      settling = true;
      settle();
    }
    request();
  });
  term.onOpen((native, signal) => {
    window.addEventListener(
      'resize',
      () => {
        term.pinTailForFit();
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
    // Arm the bottom snap target before the first interpolated layout. Waiting
    // for ResizeObserver or even transitionstart misses the first shrinking box.
    const geometry = new MutationObserver(() => {
      if (document.hidden || !movingBox()) return;
      settling = true;
      term.pinTailForFit();
      settle();
    });
    for (let el = native.element.parentElement; el; el = el.parentElement) geometry.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
    for (const type of ['wheel', 'pointerdown', 'touchstart']) native.element.addEventListener(type, () => native.element.classList.remove('pinning-tail'), { capture: true, passive: true, signal });
    const release = () => {
      cancel();
      settling = dragging = false;
      term.setFitPending(false);
    };
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) return release();
        dragging = !!workspace?.classList.contains('resizing');
        settling = true;
        if (pending) term.setFitPending(true);
        settle();
      },
      { signal },
    );
    signal.addEventListener(
      'abort',
      () => {
        observer.disconnect();
        geometry.disconnect();
        release();
      },
      { once: true },
    );
  });
  return request;
}

/** Opening never attaches to a PTY until the renderer is ready. Only an explicit
 * Retry repeats a failed attempt, in the existing host. */
export async function openTerminalRenderer(term: WTermAdapter, host: HTMLElement, alive: () => boolean, interactive = false) {
  if (interactive)
    term.onOpen((native, signal) => {
      // Concealed cells cannot handle a pointer, but the click still belongs to this keyboard.
      host.addEventListener(
        'pointerdown',
        (e) => {
          if (e.button !== 0 || e.target !== host || !native.element.classList.contains('replaying')) return;
          e.preventDefault();
          term.focus();
        },
        { signal },
      );
    });
  let notified = false;
  while (alive()) {
    try {
      await term.open(host);
      const root = term.native?.element;
      const opening = [host.closest('.modal'), host.closest('.dash-pane')].flatMap((el) => el?.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity) ?? []);
      if (root && opening.length) {
        // Only pointer coordinates depend on the scaled DOM measurement. Attach,
        // write and fit the PTY immediately, then measure the unscaled cells once.
        root.classList.add('measuring-cells');
        void Promise.allSettled(opening.map((a) => a.finished)).then(() => {
          try {
            if (alive() && term.native?.element === root) term.refreshMetrics();
          } catch (error) {
            console.warn('Could not refresh terminal cell metrics', error);
          } finally {
            root.classList.remove('measuring-cells');
          }
        });
      }
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
