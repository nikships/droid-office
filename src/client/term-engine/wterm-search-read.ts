import type { WTermAdapter } from './wterm';

const open = new Set<WTermAdapter>();
export function registerTerminalReader(adapter: WTermAdapter, signal: AbortSignal) {
  open.add(adapter);
  signal.addEventListener('abort', () => open.delete(adapter), { once: true });
}

async function captureVisible() {
  const results = await Promise.allSettled(
    [...open].map(async (adapter) => {
      const t = adapter.native;
      if (!t?.element.isConnected || t.element.closest('[inert]') || !t.element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
      const signal = adapter.paintSignal;
      if (!signal) return;
      const workerId = t.element.closest<HTMLElement>('[data-worker-id]')?.dataset.workerId;
      return { ...(workerId && { workerId }), text: await t.readText({ signal }) };
    }),
  );
  return results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}

// A pane supports only one native text capture at a time. Keep the queue, not its text.
let ready = Promise.resolve();
/** Page-local read of already-open terminals. Never attach to or send input to a PTY. */
export function readTerminal() {
  const result = ready.then(captureVisible);
  ready = result.then(
    () => {},
    () => {},
  );
  return result;
}
