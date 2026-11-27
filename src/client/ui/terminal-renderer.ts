import { createTerminalEngine, type TerminalEngine } from '../term-engine';
import { toast } from './dom';

/** Replace only a renderer that couldn't load, not its worker window, pane or diff. */
export async function openTerminalRenderer(engine: TerminalEngine, host: HTMLElement, alive: () => boolean, replace: (engine: TerminalEngine) => void) {
  try {
    await engine.term.open(host);
  } catch (error) {
    if (!alive()) return;
    if (!engine.ghostty) throw error;
    const fallback = createTerminalEngine({ ...engine.term.options }, 'xterm');
    engine.term.dispose();
    replace(fallback);
    await fallback.term.open(host);
    if (alive()) toast('Ghostty could not load. Using xterm for this terminal.', 'warn');
  }
}
