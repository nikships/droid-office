import type { WTerm } from '@wterm/dom';

const open = new Set<WTerm>();
export function registerTerminalReader(native: WTerm, signal: AbortSignal) {
  open.add(native);
  signal.addEventListener('abort', () => open.delete(native), { once: true });
}

/** Page-local read of already-open terminals. Never attach to or send input to a PTY. */
export function readTerminal(): Promise<{ workerId?: string; text: string }[]> {
  return Promise.all(
    [...open]
      .filter((t) => t.element.isConnected && t.element.checkVisibility())
      .map(async (t) => {
        const workerId = t.element.closest<HTMLElement>('[data-worker-id]')?.dataset.workerId;
        return { ...(workerId && { workerId }), text: await t.readText() };
      }),
  );
}
