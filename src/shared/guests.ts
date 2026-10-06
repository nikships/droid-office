// Guests: agent processes someone started outside the office in a floor's checkout, which the
// office only watches (see server/guests.ts). What the browser says about them.

import type { GuestProvider, OutsideProcess, WorkerInfo } from './protocol.js';

export const PROVIDER_LABEL: Record<GuestProvider, string> = { droid: 'Droid', claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok', muse: 'Muse' };

/** "Droid · pid 123 on /dev/ttys004": which process, and which terminal it's in. */
export function processLabel(p: OutsideProcess): string {
  return `${PROVIDER_LABEL[p.provider]} · pid ${p.pid} on ${p.tty}`;
}

/** A worker's status in a word, where a guest the office can't read the state of is only "running". */
export function statusWord(w: WorkerInfo, labels: Record<string, string>): string {
  if (w.guest?.seen === 'process') return 'running';
  return labels[w.status] ?? w.status;
}

/** Why a key at a guest's desk does nothing: the office didn't start it, so it doesn't drive it. */
export function guestKeyNote(w: WorkerInfo, key: string): string {
  const where = w.guest ? processLabel(w.guest) : 'outside the office';
  if (key === 'X') return `${w.name} runs outside the office (${where}). The office never stops it: quit it in its own terminal and it goes home by itself`;
  if (key === 'P') return `${w.name} runs outside the office (${where}). Type to it in its own terminal`;
  return `${w.name} runs outside the office (${where}). The office only watches it: E shows what it knows`;
}

/** A line for a worker that someone also runs an agent by hand in its worktree, outside the office. */
export function outsideNote(w: WorkerInfo): string | undefined {
  const o = w.outside;
  if (!o?.length) return undefined;
  return o.length === 1 ? `👀 ${processLabel(o[0])} also works here, outside the office` : `👀 ${o.length} agents also work here, outside the office`;
}
