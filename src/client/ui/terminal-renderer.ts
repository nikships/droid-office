import type { WTermAdapter } from '../term-engine/wterm';
import { h, toast } from './dom';

/** Opening never attaches to a PTY until the renderer is ready. Only an explicit
 * Retry repeats a failed attempt, in the existing host. */
export async function openTerminalRenderer(term: WTermAdapter, host: HTMLElement, alive: () => boolean) {
  // Inline modals don't animate, but their dashboard pane scales in. DOM cell
  // measurements include that ancestor transform until the opening animation ends.
  const animations = host
    .closest('.dash-pane')
    ?.getAnimations()
    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
  if (animations?.length) await Promise.allSettled(animations.map((a) => a.finished));
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
