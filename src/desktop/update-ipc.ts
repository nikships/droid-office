import type { ChildProcess } from 'node:child_process';
import type { HostUpdateCommand, HostUpdateRequest, HostUpdateResponse, HostUpdateState } from '../shared/host-update.js';

/** Only fixed updater operations cross the private parent/child channel. No URLs or paths. */
export function updateRequest(value: unknown): HostUpdateRequest | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Partial<HostUpdateRequest>;
  if (v.t !== 'host.update' || typeof v.id !== 'string' || v.id.length === 0 || v.id.length > 100 || !v.command) return;
  const c = v.command;
  if (c.action === 'status' || c.action === 'check' || (c.action === 'install' && typeof c.version === 'string' && c.version.length > 0 && c.version.length <= 100)) return v as HostUpdateRequest;
}

export function serveHostUpdates(child: ChildProcess, run: (command: HostUpdateCommand) => HostUpdateState) {
  child.on('message', (value: unknown) => {
    const request = updateRequest(value);
    if (!request || !child.connected) return;
    const response: HostUpdateResponse = { t: 'host.update.result', id: request.id };
    try {
      response.state = run(request.command);
    } catch (err) {
      response.error = (err as Error)?.message ?? String(err);
    }
    child.send(response, () => {});
  });
}
