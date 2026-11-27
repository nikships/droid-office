import { h } from '../ui/dom';
import { guestTokenOn } from '../token';
import { attachWtermClipboard } from './wterm-clipboard';
import type { WTermAdapter } from './wterm';
import { searchStarting } from './wterm-search-controls';

export function attachWtermPrompts(adapter: WTermAdapter) {
  adapter.onOpen((native, signal) => {
    const root = native.element;
    const label = h('span', { role: 'status' });
    const jump = (direction: -1 | 1) => {
      root.dispatchEvent(new Event(searchStarting));
      adapter.cancelReaderRestore();
      return native.scrollToPrompt(direction);
    };
    const arrow = (direction: -1 | 1) => {
      const name = direction === -1 ? 'Previous prompt' : 'Next prompt';
      return h('button', { type: 'button', 'aria-label': name, title: `${name} (Ctrl+Shift+${direction === -1 ? '[' : ']'})`, onclick: () => jump(direction) }, direction === -1 ? '↑' : '↓');
    };
    const chip = h('div.wterm-prompt-chip', { hidden: true }, label, arrow(-1), arrow(1));
    const overlay = h('div.wterm-shell-tools', {}, chip);
    root.prepend(overlay);
    // The controls are inside the scrolling pane but are not cells or terminal input.
    for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'wheel']) overlay.addEventListener(type, (e) => e.stopPropagation(), { signal });
    const host = root.parentElement!;
    const held = new Set<string>();
    adapter.textarea?.addEventListener('blur', () => held.clear(), { signal });
    for (const type of ['keydown', 'keypress', 'keyup'] as const) {
      host.addEventListener(
        type,
        (e) => {
          if (e.target instanceof Node && overlay.contains(e.target)) {
            e.stopPropagation();
            return;
          }
          if (e.target !== adapter.textarea) return;
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
    native.onShellIntegration = ({ phase, exitCode }) => {
      chip.hidden = phase === 'unknown';
      label.textContent = phase === 'running' ? 'Running' : exitCode !== null ? `Exit ${exitCode}` : phase === 'complete' ? 'Finished' : 'Prompt';
      chip.dataset.state = phase === 'running' ? 'running' : exitCode ? 'error' : 'ready';
    };
    attachWtermClipboard(native, signal, () => !adapter.options.disableStdin && !guestTokenOn());
    signal.addEventListener(
      'abort',
      () => {
        native.onShellIntegration = null;
        overlay.remove();
      },
      { once: true },
    );
  });
}
