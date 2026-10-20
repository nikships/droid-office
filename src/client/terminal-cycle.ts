import { DESK_BY_ID } from '../shared/layout';
import { OFFICE_SHELL_ID } from '../shared/office-shell';
import type { WorkerInfo } from '../shared/protocol';
import { isAsleep } from '../shared/status';

type TerminalWorker = Pick<WorkerInfo, 'id' | 'deskId' | 'status' | 'guest' | 'cloud' | 'lost'>;
const deskOrder = new Map([...DESK_BY_ID.keys()].map((id, i) => [id, i]));

/** Live local terminals in desk order, then the boss monitor's shell. Never resumes a stopped worker. */
export function nextTerminal(workers: Iterable<TerminalWorker>, current: string | null, direction: -1 | 1): string {
  const ids = [...workers]
    .filter((w) => !w.guest && !w.cloud && !w.lost && !isAsleep(w.status))
    .sort((a, b) => (deskOrder.get(a.deskId) ?? Infinity) - (deskOrder.get(b.deskId) ?? Infinity) || a.id.localeCompare(b.id))
    .map((w) => w.id);
  ids.push(OFFICE_SHELL_ID);
  const at = current ? ids.indexOf(current) : -1;
  return ids[at < 0 ? (direction === 1 ? 0 : ids.length - 1) : (at + direction + ids.length) % ids.length];
}

/** Command+Left/Right belongs to terminal switching, not the PTY or browser history. */
export function terminalShortcut(e: KeyboardEvent, cycle: (direction: -1 | 1) => void): boolean {
  if (e.defaultPrevented || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return false;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!e.repeat) cycle(e.key === 'ArrowLeft' ? -1 : 1);
  return true;
}
