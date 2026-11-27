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
  let restore: (() => void) | undefined;
  const close = (restorePosition: boolean) => {
    if (!opened) return;
    opened = false;
    native.clearSearch();
    if (restorePosition && restore) {
      adapter.cancelReaderRestore();
      restore();
    }
    restore = undefined;
    callbacks.onClose?.();
  };
  const release = () => close(false);
  el.addEventListener(searchStarting, release, { signal });
  const reset = adapter.onReset(release);
  native.onSearchChange = callbacks.onChange ?? null;
  signal.addEventListener(
    'abort',
    () => {
      opened = false;
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
      const pinned = el.scrollHeight - el.clientHeight - el.scrollTop < 1;
      restore = pinned ? () => adapter.scrollToBottom() : adapter.saveReader({ explicit: true });
      opened = true;
    },
    setQuery(query: string, options?: SearchOptions) {
      if (!opened) return;
      adapter.cancelReaderRestore();
      native.search(query, options);
    },
    next() {
      if (!opened) return false;
      adapter.cancelReaderRestore();
      return native.findNext();
    },
    previous() {
      if (!opened) return false;
      adapter.cancelReaderRestore();
      return native.findPrevious();
    },
    close: () => close(true),
    getState: () => native.getSearchState(),
  };
}
