import type { WorkerStatus } from '../shared/protocol.js';

/** What the Mac app's menu bar icon shows of a running office (`GET /api/status`). */
export interface OfficeStatus {
  workers: number;
  working: number;
  needsInput: number;
  /** Paired phones with a connection open, each counted once however many sockets it holds. */
  phones: number;
  /** Open office pages and web companions that didn't come in on a phone's token. */
  browsers: number;
}

export interface StatusConnection {
  device?: string;
  /** Set only for a phone's connection (a paired browser has none; see PhoneSizes). */
  phone: boolean;
}

export function officeStatus(workers: Iterable<{ status: WorkerStatus }>, connections: Iterable<StatusConnection>): OfficeStatus {
  const out: OfficeStatus = { workers: 0, working: 0, needsInput: 0, phones: 0, browsers: 0 };
  for (const w of workers) {
    out.workers++;
    if (w.status === 'working') out.working++;
    else if (w.status === 'needs_input') out.needsInput++;
  }
  const phones = new Set<string>();
  for (const c of connections) {
    if (c.phone && c.device) phones.add(c.device);
    else out.browsers++;
  }
  out.phones = phones.size;
  return out;
}
