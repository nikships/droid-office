import type { WTermAdapter } from './wterm';
import type { SearchOptions, SearchState, WTerm } from '@wterm/dom';

/** Before either Find UI takes the viewport, release the other one's highlights and scroll ownership. */
export const searchStarting = 'office-terminal-search-starting';

const externalControls = new WeakSet<WTermAdapter>();
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
  let steps: (1 | -1)[] = [];
  const display = (state: SearchState): SearchState => {
    if (!state.searching) return state;
    return finished ?? { ...state, count: 0, activeIndex: -1, limited: false };
  };
  const step = (direction: 1 | -1) => {
    const moved = direction === 1 ? native.findNext() : native.findPrevious();
    adapter.cancelReaderRestore(moved);
    return moved;
  };
  const navigate = (direction: 1 | -1) => {
    if (!opened) return false;
    if (!native.getSearchState().searching) return step(direction);
    if (!finished?.count) return false;
    steps.push(direction);
    return true;
  };
  const close = (restorePosition: boolean) => {
    if (!opened) return;
    opened = false;
    finished = undefined;
    steps = [];
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
    const pending = steps;
    if (!state.searching) steps = [];
    callbacks.onChange?.(display(state));
    if (!state.searching && state.count) {
      for (const direction of pending) navigate(direction);
    }
  };
  signal.addEventListener(
    'abort',
    () => {
      opened = false;
      steps = [];
      finished = undefined;
      restore = undefined;
      reset.dispose();
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
      if (previous.query !== query || previous.caseSensitive !== (options?.caseSensitive ?? false)) {
        steps = [];
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
