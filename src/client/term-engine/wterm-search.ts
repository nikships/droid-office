import type { SearchState } from '@wterm/dom';
import { claimEscape, h } from '../ui/dom';
import type { WTermAdapter } from './wterm';
import type { TerminalPaths } from '../ui/terminal-path-links';
import { attachCwd } from './wterm-cwd';
import { registerTerminalReader } from './wterm-search-read';
import { createWtermSearch, hasNativeSearchControls } from './wterm-search-controls';

export function attachWtermSearch(adapter: WTermAdapter, paths?: TerminalPaths) {
  adapter.onOpen((native, signal) => {
    if (paths) attachCwd(native, paths, signal);
    registerTerminalReader(adapter, signal);
    if (hasNativeSearchControls(adapter)) return;
    const root = native.element;
    // Changes Log has a disabled terminal input: its host is the single tab stop.
    const keyboardHost = adapter.textarea?.disabled ? root.parentElement : null;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const button = (label: string, text: string, click: () => void) => {
      const el = h('button', { type: 'button', title: label, 'aria-label': label }, text);
      el.addEventListener('click', click, { signal });
      return el;
    };
    const field = h('input', { type: 'text', placeholder: 'Find in terminal', 'aria-label': 'Find in terminal', maxlength: 1024, autocomplete: 'off', spellcheck: 'false' });
    const status = h('span', { role: 'status', 'aria-live': 'polite' });
    let sensitive = false;
    const search = () => controller.setQuery(field.value, { caseSensitive: sensitive });
    const matchCase = button('Match case', 'Aa', () => {
      sensitive = !sensitive;
      matchCase.setAttribute('aria-pressed', String(sensitive));
      search();
    });
    matchCase.setAttribute('aria-pressed', 'false');
    const prev = button('Previous match (Shift+Enter)', '↑', () => controller.previous());
    const next = button('Next match (Enter)', '↓', () => controller.next());
    const launcher = button(`Find in terminal (${mac ? '⌘F' : 'Ctrl+Shift+F'})`, 'Find', open);
    if (keyboardHost) launcher.tabIndex = -1;
    const bar = h(
      'div.wterm-search-bar',
      { role: 'search', 'aria-label': 'Terminal scrollback', hidden: true },
      field,
      status,
      matchCase,
      prev,
      next,
      button('Close search (Esc)', '×', () => controller.close()),
    );
    const panel = h('div.wterm-search-panel', {}, launcher, bar);
    root.prepend(panel);
    const controller = createWtermSearch(adapter, native, signal, {
      onChange: render,
      onClose() {
        const focused = panel.contains(document.activeElement);
        bar.hidden = true;
        launcher.hidden = false;
        if (focused) {
          if (keyboardHost) keyboardHost.focus({ preventScroll: true });
          else adapter.focus();
        }
      },
    });
    function render(state: SearchState) {
      if (bar.hidden) return;
      status.textContent = !state.query ? '' : state.count ? `${state.activeIndex + 1} of ${state.count}${state.limited ? '+' : ''}` : state.searching ? 'Searching…' : 'No matches';
      prev.disabled = next.disabled = !state.count;
    }
    function open() {
      if (bar.hidden) {
        controller.open();
        launcher.hidden = true;
        bar.hidden = false;
        search();
        render(controller.getState());
      }
      field.focus({ preventScroll: true });
      field.select();
    }
    field.addEventListener('input', search, { signal });
    // The terminal owns capture-phase keyboard handling, including Kitty releases.
    // Claim only keys in this pane before that boundary; leave browser text editing intact.
    const swallowed = new Set<string>();
    const ownsFocus = (target: Element) => root.contains(target) || target === keyboardHost || (target === root.closest('.modal') && root.checkVisibility());
    // A read-only window would close on Esc before the Find field saw it.
    const releaseEscape = keyboardHost
      ? claimEscape(panel, () => {
          if (swallowed.has('Escape')) return true;
          if (bar.hidden || !document.activeElement || !ownsFocus(document.activeElement)) return false;
          swallowed.add('Escape');
          controller.close();
          return true;
        })
      : undefined;
    const keyboard = (e: KeyboardEvent) => {
      if (swallowed.has(e.code) && (e.repeat || e.type !== 'keydown')) {
        if (e.type === 'keyup') swallowed.delete(e.code);
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (!(e.target instanceof Element) || !ownsFocus(e.target)) return;
      const isPanel = panel.contains(e.target);
      const find = e.key.toLowerCase() === 'f' && !e.altKey && (mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey);
      const again = !bar.hidden && e.key.toLowerCase() === 'g' && e.metaKey && !e.ctrlKey && !e.altKey;
      const enter = e.target === field && e.key === 'Enter';
      const esc = !bar.hidden && e.key === 'Escape';
      if (e.type === 'keydown' && !e.isComposing && (find || again || enter || esc)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        swallowed.add(e.code);
        if (find) open();
        else if (esc) controller.close();
        else if (e.shiftKey) controller.previous();
        else controller.next();
      } else if (isPanel) e.stopPropagation();
    };
    const scoped = { signal, capture: true };
    window.addEventListener('blur', () => swallowed.clear(), { signal });
    for (const type of ['keydown', 'keypress', 'keyup'] as const) window.addEventListener(type, keyboard, scoped);
    // Host capture handlers turn pasted images into PTY input before the terminal sees them.
    window.addEventListener(
      'paste',
      (e) => {
        if (e.target instanceof Node && panel.contains(e.target)) e.stopPropagation();
      },
      scoped,
    );
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'drop'] as const) panel.addEventListener(type, (e) => e.stopPropagation(), { signal });
    signal.addEventListener(
      'abort',
      () => {
        releaseEscape?.();
        panel.remove();
      },
      { once: true },
    );
  });
}
