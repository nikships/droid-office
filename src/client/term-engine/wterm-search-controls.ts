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
  let steps = 0;
  let queuedRevision = 0;
  let applyingSteps = false;
  // A normal pan need not supersede an adapter restore or change its revision.
  // Listen for reader input, not scroll events from output or Find's own reveal.
  const dropSteps = () => {
    steps = 0;
  };
  const passive = { passive: true, signal };
  el.addEventListener('wheel', dropSteps, passive);
  el.addEventListener('touchmove', dropSteps, passive);
  el.addEventListener(
    'pointerdown',
    (event) => {
      if (steps && event.clientX - el.getBoundingClientRect().left >= el.clientLeft + el.clientWidth) dropSteps();
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
    if (queuedRevision !== adapter.navigationRevision) steps = 0;
    queuedRevision = adapter.navigationRevision;
    steps += direction;
    return true;
  };
  const close = (restorePosition: boolean) => {
    if (!opened) return;
    opened = false;
    finished = undefined;
    steps = 0;
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
    steps = 0;
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
    if (!state.searching && steps) {
      const pending = steps;
      steps = 0;
      if (state.count && queuedRevision === adapter.navigationRevision) {
        applyingSteps = true;
        try {
          // Whole laps have the same destination. Preserve their final reveal
          // even when it happens to be the already-selected match.
          let remaining = pending % state.count;
          if (!remaining) {
            step(1);
            if (state.count > 1) step(-1);
          } else {
            if (Math.abs(remaining) > state.count / 2) remaining -= Math.sign(remaining) * state.count;
            for (let i = 0; i < Math.min(Math.abs(remaining), maxStepsPerRefresh); i++) step(remaining > 0 ? 1 : -1);
          }
        } finally {
          applyingSteps = false;
        }
        state = native.getSearchState();
      }
    }
    const shown = display(state);
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
      steps = 0;
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
        steps = 0;
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
