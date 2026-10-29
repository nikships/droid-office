import type { WorkerTask } from '../shared/protocol.js';

/** Cloud workers still use a prompt preview; local workers use the Office-wide sign writer. */
export function fallbackTask(prompt: string): WorkerTask {
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
