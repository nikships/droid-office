import type { WTermAdapter } from '../term-engine/wterm';
import { h, toast } from './dom';

/** Opening never attaches to a PTY until the renderer is ready. Only an explicit
 * Retry repeats a failed attempt, in the existing host. */
export async function openTerminalRenderer(term: WTermAdapter, host: HTMLElement, alive: () => boolean) {
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
          if (alive() && term.native?.element === root) term.refreshMetrics();
          root.classList.remove('measuring-cells');
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
