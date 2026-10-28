import type { AgentEffort, WorkerInfo, WorkerStatus } from '../shared/protocol';
import { isAsleep } from '../shared/status';

/** The same words as the web client's STATUS_LABEL. */
export const STATUS_LABEL: Record<WorkerStatus, string> = {
  starting: 'starting',
  idle: 'ready',
  working: 'working',
  needs_input: 'needs input',
  done: 'done',
  exited: 'exited',
  offline: 'asleep',
};

export function statusLabel(status: WorkerStatus): string {
  return isAsleep(status) ? 'asleep' : STATUS_LABEL[status];
}

export function kindLabel(w: WorkerInfo): string {
  if (w.guest) return `Guest · ${w.guest.provider}`;
  if (w.cloud || w.kind === 'cloud') return 'Cloud';
  return w.kind === 'shell' ? 'Shell' : 'Droid';
}

/** "Opus 4.5 · high", as the session reports it, else as requested; nothing for a shell. */
export function modelLabel(w: WorkerInfo): string | undefined {
  if (w.kind === 'shell') return undefined;
  const model = w.activeModel ?? w.model;
  const effort: AgentEffort | undefined = w.activeEffort ?? w.effort;
  if (!model && !effort) return undefined;
  return [model ?? 'Default model', effort].filter(Boolean).join(' · ');
}

/** 45s, 12m, 3h 05m. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "3m ago", only from a time the office actually sent. */
export function ago(at: number | undefined, now: number): string | undefined {
  if (!at || at > now + 60_000) return undefined;
  return `${duration(now - at)} ago`;
}

/** "2 working · 1 needs input · 3 done" for a lead's subagents. */
export function childSummary(counts: Partial<Record<WorkerStatus, number>>): string {
  const order: WorkerStatus[] = ['needs_input', 'working', 'starting', 'idle', 'done', 'exited', 'offline'];
  // Two statuses can share a word (exited and offline are both "asleep"): one count per word.
  const byLabel = new Map<string, number>();
  for (const s of order) if (counts[s]) byLabel.set(statusLabel(s), (byLabel.get(statusLabel(s)) ?? 0) + (counts[s] ?? 0));
  return [...byLabel].map(([label, n]) => `${n} ${label}`).join(' · ');
}

export function oneLine(text: string | undefined, max = 160): string | undefined {
  const line = text
    ?.split('\n')
    .find((l) => l.trim())
    ?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
