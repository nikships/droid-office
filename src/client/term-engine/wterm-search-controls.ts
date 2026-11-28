import type { WTermAdapter } from './wterm';
import type { SearchOptions, SearchState, WTerm } from '@wterm/dom';

/** Before either Find UI takes the viewport, release the other one's highlights and scroll ownership. */
export const searchStarting = 'office-terminal-search-starting';

const externalControls = new WeakSet<WTermAdapter>();
// Each native step can reveal a row and notify a mobile bridge synchronously.
const maxStepsPerRefresh = 8;
/** Native shells provide their own controls and own WTerm.onSearchChange. Call before open(). */
export function useNativeSearchControls(adapter: WTermAdapter) {
  externalControls.add(adapter);
}
export function hasNativeSearchControls(adapter: WTermAdapter) {
  return externalControls.has(adapter);
}

/** Shared controller for keyboard and touch hosts. It never sends input, moves focus or mounts UI. */
export function createWtermSearch(adapter: WTermAdapter, native: WTerm, signal: AbortSignal, callbacks: { onChange?(state: SearchState): void; onClose?(): void } = {}) {
  const el = native.element;
  let opened = false;
  let awaitingMatch = false;
  let revealed = false;
  let restore: (() => void) | undefined;
  let finished: SearchState | undefined;
  let lastSent: SearchState | undefined;
  let steps: number | undefined; // Zero is an accepted round trip that must still reveal its match.
  let queuedRevision = 0;
  let applyingSteps = false;
  // A normal pan need not supersede an adapter restore or change its revision.
  // Listen for reader input, not scroll events from output or Find's own reveal.
  const passive = { passive: true, signal };
  // Vertical intent counts even at a scroll bound; horizontal gestures and zoom do not.
  const vertical = (dx: number, dy: number) => dy !== 0 && Math.abs(dy) >= Math.abs(dx);
  el.parentElement?.addEventListener(
    'wheel',
    (e) => {
      if (steps !== undefined && !e.ctrlKey && vertical(e.deltaX, e.deltaY) && e.composedPath().includes(el)) steps = undefined;
    },
    { ...passive, capture: true },
  ); // Mouse tracking can stop propagation at the terminal.
  let touchStart: Touch | undefined;
  el.addEventListener(
    'touchstart',
    (e) => {
      touchStart = e.touches.length === 1 ? e.touches[0] : undefined;
    },
    passive,
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      const p = e.touches[0];
      if (steps !== undefined && touchStart && e.touches.length === 1 && p.identifier === touchStart.identifier && vertical(p.clientX - touchStart.clientX, p.clientY - touchStart.clientY)) steps = undefined;
    },
    passive,
  );
  let thumbTop: number | undefined;
  const checkThumb = () => {
    if (thumbTop !== undefined && thumbTop !== el.scrollTop) steps = thumbTop = undefined;
  };
  el.addEventListener('scroll', checkThumb, passive);
  el.addEventListener(
    'pointerup',
    () => {
      checkThumb();
      thumbTop = undefined;
    },
    passive,
  );
  el.addEventListener(
    'pointercancel',
    () => {
      thumbTop = undefined;
    },
    passive,
  );
  el.addEventListener(
    'pointerdown',
    (event) => {
      thumbTop = undefined;
      if (steps === undefined || event.button !== 0 || event.target !== el) return;
      if (event.clientX - el.getBoundingClientRect().left >= el.clientLeft + el.clientWidth) steps = undefined;
      // Overlay scrollbars hit the scrollport itself, inside clientWidth. Only a drag, not a click, moves it.
      else if (event.pointerType === 'mouse' && el.offsetWidth === el.clientWidth) thumbTop = el.scrollTop;
    },
    passive,
  );
  const display = (state: SearchState) => (state.searching ? (finished ?? state) : state);
  const step = (direction: 1 | -1) => {
    const moved = direction === 1 ? native.findNext() : native.findPrevious();
    adapter.cancelReaderRestore(moved);
    return moved;
  };
  const navigate = (direction: 1 | -1) => {
    if (!opened) return false;
    if (!finished || !native.getSearchState().searching) return step(direction);
    if (!finished.count) return false;
    if (queuedRevision !== adapter.navigationRevision) steps = undefined;
    const next = (steps ?? 0) + direction;
    if (Math.abs(next) > maxStepsPerRefresh) return false;
    queuedRevision = adapter.navigationRevision;
    thumbTop = undefined;
    steps = next;
    return true;
  };
  const replay = (state: SearchState) => {
    if (state.searching || steps === undefined) return state;
    const pending = steps;
    steps = undefined;
    if (!state.count || queuedRevision !== adapter.navigationRevision) return state;
    applyingSteps = true;
    try {
      const remaining = pending % state.count;
      if (remaining) {
        for (let i = 0; i < Math.abs(remaining); i++) step(remaining > 0 ? 1 : -1);
      } else {
        // A whole lap still reveals the selected match.
        step(1);
        if (state.count > 1) step(-1);
      }
      return native.getSearchState();
    } finally {
      applyingSteps = false;
    }
  };
  const close = (restorePosition: boolean) => {
    if (!opened) return;
    opened = false;
    finished = undefined;
    steps = undefined;
    lastSent = undefined;
    awaitingMatch = false;
    native.clearSearch();
    if (restorePosition && revealed && restore) {
      adapter.cancelReaderRestore();
      restore();
    }
    restore = undefined;
    callbacks.onClose?.();
  };
  const release = () => close(false);
  el.addEventListener(searchStarting, release, { signal });
  const reset = adapter.onReset(release);
  // A live RIS is handled by the parser, not by adapter.reset(). Observe it
  // before the adapter forwards it, including when ESC and c arrive separately.
  const ris = adapter.parser.registerEscHandler({ final: 'c' }, () => {
    finished = lastSent = undefined;
    steps = undefined;
    restore = undefined;
    return false;
  });
  native.onSearchChange = (state) => {
    // Search can finish in a later paint. An empty or unsuccessful query
    // never took the viewport away from a stationary reader.
    if (awaitingMatch && state.count) {
      awaitingMatch = false;
      revealed = true;
      adapter.cancelReaderRestore();
    }
    // Writes invalidate WTerm's match list before its asynchronous rescan.
    // Keep the last completed result visible, but navigate only on fresh matches.
    if (opened && !state.searching) finished = state;
    if (applyingSteps) return;
    const shown = display(replay(state));
    if (
      !lastSent ||
      shown.query !== lastSent.query ||
      shown.caseSensitive !== lastSent.caseSensitive ||
      shown.count !== lastSent.count ||
      shown.activeIndex !== lastSent.activeIndex ||
      shown.searching !== lastSent.searching ||
      shown.limited !== lastSent.limited
    ) {
      lastSent = shown;
      callbacks.onChange?.(shown);
    }
  };
  signal.addEventListener(
    'abort',
    () => {
      opened = false;
      steps = undefined;
      finished = undefined;
      restore = undefined;
      reset.dispose();
      ris.dispose();
      native.onSearchChange = null;
    },
    { once: true },
  );
  return {
    open() {
      if (opened || signal.aborted) return;
      el.dispatchEvent(new Event(searchStarting));
      const pinned = adapter.isAtTail();
      restore = pinned ? () => adapter.scrollToBottom() : adapter.saveReader({ explicit: true });
      opened = true;
      revealed = false;
    },
    setQuery(query: string, options?: SearchOptions) {
      if (!opened) return;
      const previous = native.getSearchState();
      lastSent = undefined; // Explicit host requests need a reply, even for the same text.
      if (previous.query !== query || previous.caseSensitive !== (options?.caseSensitive ?? false)) {
        steps = undefined;
        finished = undefined;
      }
      adapter.cancelReaderRestore(false);
      awaitingMatch = !!query;
      native.search(query, options);
    },
    next: () => navigate(1),
    previous: () => navigate(-1),
    close: () => close(true),
    getState: () => display(native.getSearchState()),
  };
}
