import { randomUUID } from 'node:crypto';
import type { HostUpdateCommand, HostUpdateResponse, HostUpdateState } from '../shared/host-update.js';
import { isHostUpdateState } from '../shared/host-update-state.js';

type Channel = Pick<NodeJS.Process, 'on' | 'off' | 'send' | 'connected'>;

const UNAVAILABLE: HostUpdateState = {
  supported: false,
  currentVersion: '',
  phase: 'unavailable',
  title: 'Host updates unavailable',
  detail: 'The office must be started by the packaged Mac app to update its host remotely.',
  busy: false,
  canInstall: false,
};

export function hostUpdateCommand(value: unknown): HostUpdateCommand | undefined {
  if (!value || typeof value !== 'object') return;
  const c = value as Record<string, unknown>;
  if (c.action === 'check') return { action: 'check' };
  // This is only a bounded identifier. Electron also requires equality with its actual offer,
  // and never uses a client version as a URL, file name, command or download target.
  if (c.action === 'install' && typeof c.version === 'string' && c.version.length > 0 && c.version.length <= 100) return { action: 'install', version: c.version };
}

/** Requests go only to the Electron process that spawned this server, never to a network URL. */
export class HostUpdates {
  private closed = false;
  private pending = new Map<string, { resolve: (state: HostUpdateState) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly channel: Channel = process,
    private readonly timeoutMs = 5000,
  ) {
    channel.on('message', this.message);
    channel.on('disconnect', this.disconnected);
  }

  request(command: HostUpdateCommand): Promise<HostUpdateState> {
    if (this.closed) return Promise.reject(new Error('The host updater disconnected.'));
    if (!this.channel.send || !this.channel.connected) {
      return command.action === 'status' ? Promise.resolve(UNAVAILABLE) : Promise.reject(new Error(UNAVAILABLE.detail));
    }
    if (this.pending.size >= 32) return Promise.reject(new Error('Too many host update requests. Try again.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const fail = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('The host updater did not answer. Try again.')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.channel.send!({ t: 'host.update', id, command }, (err: Error | null) => {
          if (err) fail(err);
        });
      } catch (err) {
        fail(err as Error);
      }
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.channel.off('message', this.message);
    this.channel.off('disconnect', this.disconnected);
    this.disconnected();
  }

  private message = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const response = value as HostUpdateResponse;
    if (response.t !== 'host.update.result' || typeof response.id !== 'string') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (isHostUpdateState(response.state)) pending.resolve(response.state);
    else pending.reject(new Error(response.error || 'The host updater sent no status.'));
  };

  private disconnected = () => {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The host updater disconnected.'));
    }
    this.pending.clear();
  };
}
