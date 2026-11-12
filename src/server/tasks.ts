import type { WorkerTask } from '../shared/protocol.js';
import { linearTaskOf } from '../shared/linear.js';

/** An immediate prompt preview until the Office-wide sign writer has a generated label. */
export function fallbackTask(prompt: string): WorkerTask {
  // "Work on Linear issue DOFF-12: "Title"." would leave every ticket's worker named "Work on Linear issue".
  const ticket = linearTaskOf(prompt.split('\n', 1)[0].trim());
  if (ticket) return { name: clip(`${ticket.identifier} · ${ticket.title}`, 40), summary: cap(clip(ticket.title, 110)) };
  const one = prompt.replace(/\s+/g, ' ').trim();
  const words = one.replace(/^(please|can you|could you|hey|ok|so)\b[\s,]*/i, '').split(' ');
  const name = words
    .slice(0, 4)
    .join(' ')
    .replace(/[\s,.;:!?-]+$/, '');
  return { name: cap(clip(name, 40)), summary: cap(clip(one, 110)) };
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
