import { h } from '../ui/dom';
import { guestTokenOn } from '../token';
import { attachWtermClipboard } from './wterm-clipboard';
import type { WTermAdapter } from './wterm';
import { searchStarting } from './wterm-search-controls';

export function attachWtermPrompts(adapter: WTermAdapter) {
  adapter.onOpen((native, signal) => {
    const root = native.element;
    const host = root.parentElement!;
    const keyTarget = adapter.textarea?.disabled ? host : adapter.textarea;
    const label = h('span', { role: 'status' });
    const jump = (direction: -1 | 1) => {
      root.dispatchEvent(new Event(searchStarting));
      adapter.cancelReaderRestore();
      return native.scrollToPrompt(direction);
    };
    const arrow = (direction: -1 | 1) => {
      const name = direction === -1 ? 'Previous prompt' : 'Next prompt';
      const el = h('button', { type: 'button', 'aria-label': name, title: `${name} (Ctrl+Shift+${direction === -1 ? '[' : ']'})` }, direction === -1 ? '↑' : '↓');
      if (keyTarget === host) el.tabIndex = -1;
      el.addEventListener('click', () => jump(direction), { signal });
      return el;
    };
    const chip = h('div.wterm-prompt-chip', { hidden: true }, label, arrow(-1), arrow(1));
    const overlay = h('div.wterm-shell-tools', {}, chip);
    root.prepend(overlay);
    // The controls are inside the scrolling pane but are not cells or terminal input.
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'wheel']) overlay.addEventListener(type, (e) => e.stopPropagation(), { signal });
    const held = new Set<string>();
    host.addEventListener('focusout', () => held.clear(), { signal });
    for (const type of ['keydown', 'keypress', 'keyup'] as const) {
      host.addEventListener(
        type,
        (e) => {
          if (e.target instanceof Node && overlay.contains(e.target)) {
            e.stopPropagation();
            return;
          }
          if (e.target !== keyTarget && !(keyTarget === host && e.target === root)) return;
          const dir = e.code === 'BracketLeft' ? -1 : e.code === 'BracketRight' ? 1 : 0;
          if (!dir) return;
          if (e.type === 'keydown') {
            if (chip.hidden || e.isComposing || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
            held.add(e.code);
            jump(dir);
          } else {
            if (!held.has(e.code)) return;
            if (e.type === 'keyup') held.delete(e.code);
          }
          e.preventDefault();
          e.stopPropagation();
        },
        { capture: true, signal },
      );
    }
    let marked = false;
    const updateVisibility = () => {
      const hidden = !marked || !!adapter.core?.usingAltScreen();
      if (chip.hidden !== hidden) chip.hidden = hidden;
    };
    // Entering or leaving a full-screen app need not emit another shell mark.
    const parsed = adapter.onWriteParsed(updateVisibility);
    native.onShellIntegration = ({ phase, exitCode }) => {
      marked = phase !== 'unknown';
      updateVisibility();
      label.textContent = phase === 'running' ? 'Running' : exitCode !== null ? `Exit ${exitCode}` : phase === 'complete' ? 'Finished' : 'Prompt';
      chip.dataset.state = phase === 'running' ? 'running' : exitCode ? 'error' : 'ready';
    };
    attachWtermClipboard(adapter, native, signal, () => !adapter.options.disableStdin && !guestTokenOn());
    signal.addEventListener(
      'abort',
      () => {
        parsed.dispose();
        native.onShellIntegration = null;
        overlay.remove();
      },
      { once: true },
    );
  });
}
