import type { WTermAdapter } from '../term-engine/wterm';
import { h, toast } from './dom';

/** Observe every box, but never reflow the shared program through a gesture's
 * intermediate boxes. Input bytes don't wait for the queued ownership claim. */
export function followTerminalFit(term: WTermAdapter, changed: () => void, fit: (claim: boolean, dimensions: () => WTermAdapter['observedDimensions']) => void, workspace?: Element | null) {
  let frame = 0;
  let task = 0;
  let settling = false;
  let pending = false;
  let claim = false;
  let dragging = false;
  let fontSize: number | undefined;
  let fontBox: { width: number; layout: string } | undefined;
  let fontProbe: HTMLElement | undefined;
  let cellWidth = 0;
  let fittedFont: WTermAdapter['observedDimensions'];
  let syncWait: { generation: number; until: number } | undefined;
  // The observer supplies exact unscaled content pixels. Compare its layout
  // again in the commit task: another task can resize or hide the pane after
  // the last observation. client sizes include scrollbar loss but round to
  // integers, while the resolved CSS box retains fractional layout changes.
  const layout = (el: HTMLElement) => {
    const css = getComputedStyle(el);
    return `${el.clientWidth}/${el.clientHeight}/${css.width}/${css.height}/${css.borderWidth}/${css.padding}`;
  };
  const fontObserver = new ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      if (target === fontProbe) cellWidth = contentRect.width;
      else fontBox = contentRect.width && contentRect.height ? { width: contentRect.width, layout: layout(target as HTMLElement) } : undefined;
    }
    if (fontBox && cellWidth) settle();
  });
  const cancel = () => {
    cancelAnimationFrame(frame);
    clearTimeout(task);
    frame = task = 0;
  };
  const clearFont = () => {
    fontObserver.disconnect();
    fontProbe?.remove();
    fontProbe = fontBox = fontSize = undefined;
    cellWidth = 0;
    syncWait = undefined;
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
    if ((settling || fontSize !== undefined) && movingBox()) return settle();
    if (fontSize !== undefined && fontSize !== term.options.fontSize) {
      // Native resize cannot paint inside a synchronized update. Keep the old
      // font until it closes or wterm's one-second fallback for this generation.
      if (term.core?.synchronizedOutput()) {
        const generation = term.core.synchronizedOutputGeneration();
        if (generation !== syncWait?.generation) syncWait = { generation, until: performance.now() + 1000 };
        if (performance.now() < syncWait.until) {
          settling = false;
          term.setFitPending(false);
          return settle();
        }
      }
      const root = term.native!.element;
      const box = fontBox;
      if (!box || !cellWidth || !term.observedDimensions || layout(root) !== box.layout) {
        // Re-arm even if the box returns to its previous size before the next
        // observation. A zero box waits for reveal without publishing a fit.
        fontBox = undefined;
        fontObserver.unobserve(root);
        fontObserver.observe(root);
        return;
      }
      const px = fontSize;
      const { cols, rows } = term;
      const oldFont = root.style.getPropertyValue('--term-font-size');
      const oldHeight = root.style.getPropertyValue('--term-row-height');
      const oldWidth = root.style.getPropertyValue('--term-cell-width');
      // A disconnected mirror or a pending snapshot cannot apply a grid.
      // Claim only this proposal, not the next snapshot if the owner declines.
      fit(true, () => {
        term.setFontForFit(px);
        fittedFont = term.proposeDimensions(box.width, cellWidth);
        return fittedFont;
      });
      // A sync block may also open *after* resize and cancel its queued paint.
      // wterm replaces the mounted rows on grid rebuild. Keep those old nodes
      // at their painted metrics; the new rows inherit the new metrics directly.
      if (cols !== term.cols || rows !== term.rows) {
        for (const row of root.querySelectorAll<HTMLElement>('.term-grid > .term-row')) {
          row.style.fontSize ||= oldFont;
          if (!row.style.getPropertyValue('--term-row-height')) row.style.setProperty('--term-row-height', oldHeight);
          if (!row.style.getPropertyValue('--term-cell-width')) row.style.setProperty('--term-cell-width', oldWidth);
        }
      }
      if (term.options.fontSize === px) clearFont();
    } else if (pending) fit(claim, () => fittedFont ?? term.observedDimensions);
    settling = false;
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
    } else if (fontSize === undefined) return commit();
    if (fontSize !== undefined && fontBox && !frame && !task) settle();
  };
  term.onFit((resized) => {
    const applied = fittedFont;
    fittedFont = undefined;
    // The font probe observes our own completed fit before paint. Do not
    // suspend the program's subsequent redraw to fit the same cells again.
    if (applied && applied.cols === term.observedDimensions?.cols && applied.rows === term.observedDimensions.rows && !settling) return;
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
        clearFont();
        observer.disconnect();
        geometry.disconnect();
        release();
      },
      { once: true },
    );
  });
  const requestedFontSize = () => fontSize ?? term.options.fontSize;
  const setFontSize = (px: number) => {
    if (px === requestedFontSize()) return;
    if (px === term.options.fontSize) {
      clearFont();
      if (settling || dragging) settle();
      else commit();
      return;
    }
    const root = term.native?.element;
    const probe = root?.querySelector<HTMLElement>('.term-size-probe');
    if (!root || !probe) {
      term.options.fontSize = px;
      return;
    }
    // Keep both the old font and the old grid until the last press (and any
    // simultaneous box gesture) settles. Native can render both in its next rAF.
    fontSize = px;
    // Observe the requested font on a duplicate of the native probe while
    // the painted cells retain their old font. This width is unscaled even
    // when a fractional CSS box rounds up in offsetWidth.
    fontProbe ??= probe.cloneNode(true) as HTMLElement;
    fontProbe.style.fontSize = `${px}px`;
    if (!fontProbe.isConnected) root.append(fontProbe);
    cancel();
    cellWidth = 0;
    fontObserver.unobserve(fontProbe);
    fontObserver.observe(fontProbe);
    fontObserver.observe(root);
  };
  return { requestFit: request, setFontSize, requestedFontSize };
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
