import { createWebSocketDaemonClient, MachineType, SDK_VERSION } from '@factory/droid-sdk';
import type { FactoryApi } from './api.js';
import { record } from './cloud-stream-messages.js';

export interface CloudStreamSource {
  computerId: string;
  sessionId: string;
}

interface Identity {
  publicKey: string;
  keyId: string;
}

export interface CloudStreamComputer {
  id: string;
  providerType: string;
  relayClientUrl: string;
  computerIdentity?: Identity;
}

/** Only notifications are observed. A passive watcher never answers permission or AskUser requests. */
export interface CloudStreamClient {
  connect(url: string): Promise<void>;
  authenticate(params: { apiKey: string; caller: 'sdk'; metadata: { sdk: { language: 'typescript'; version: string } } }): Promise<unknown>;
  loadSession(params: { sessionId: string; token: string; messageLimit: number }): Promise<unknown>;
  onTransportMessage(handler: (message: unknown) => void): void;
  onConnectionClose(handler: (code: number, reason: string) => void): unknown;
  onConnectionError(handler: (error: Error) => void): void;
  disconnect(): void;
}

export interface CloudStreamOptions {
  api(): FactoryApi | undefined;
  key(): string | undefined;
  sources(): Iterable<CloudStreamSource>;
  /** `superseded`: notifications while it loaded changed its settings, its title, or anything else (its state). */
  snapshot(sessionId: string, snapshot: Record<string, unknown>, superseded: Superseded): void;
  notification(sessionId: string, notification: Record<string, unknown>): void;
  reset(): void;
  now?: () => number;
  warn?: (message: string) => void;
  client?: (computer: CloudStreamComputer, key: string, refresh: () => Promise<Identity | null>) => CloudStreamClient;
}

export interface Superseded {
  settings: boolean;
  title: boolean;
  state: boolean;
}

const supersedes = (type: unknown): keyof Superseded => (type === 'settings_updated' ? 'settings' : type === 'session_title_updated' ? 'title' : 'state');

interface Connection {
  id: string;
  sessions: Set<string>;
  loaded: Set<string>;
  client?: CloudStreamClient;
  connecting?: Promise<void>;
  loading?: { sessionId: string } & Superseded;
  ready: boolean;
  failures: number;
  retryAt: number;
  warned: boolean;
}

function daemon(computer: CloudStreamComputer, key: string, refresh: () => Promise<Identity | null>): CloudStreamClient {
  return createWebSocketDaemonClient({
    machineType: MachineType.Computer,
    computerId: computer.id,
    providerType: computer.providerType,
    getCredential: async () => ({ apiKey: key }),
    ...(computer.computerIdentity ? { trustedIdentity: { pin: computer.computerIdentity, refresh } } : {}),
    clientSurface: 'sdk',
    requestTimeout: 25_000,
    transportConfig: { maxConnectRetries: 0, initialRetryDelayMs: 0, maxRetryDelayMs: 0, connectionTimeoutMs: 15_000 },
  });
}

/**
 * One server-only relay connection per computer hosting an office worker. It never wakes machines,
 * starts turns, sends prompts, answers asks or closes daemon sessions. REST remains the fallback.
 */
export class CloudStream {
  private connections = new Map<string, Connection>();
  private credential?: string;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private now: () => number;

  constructor(private opts: CloudStreamOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), 1000);
    this.timer.unref?.();
  }

  healthy(sessionId: string): boolean {
    for (const c of this.connections.values()) if (c.ready && c.sessions.has(sessionId) && c.loaded.has(sessionId)) return true;
    return false;
  }

  /** Called immediately on office credential changes, and periodically for workers and retries. */
  async sync(): Promise<void> {
    if (this.stopped) return;
    const key = this.opts.api() ? this.opts.key() : undefined;
    if (key !== this.credential) {
      this.reset();
      this.credential = key;
    }
    if (!key) return;
    const desired = new Map<string, Set<string>>();
    for (const source of this.opts.sources()) {
      let sessions = desired.get(source.computerId);
      if (!sessions) desired.set(source.computerId, (sessions = new Set()));
      sessions.add(source.sessionId);
    }
    for (const [id, connection] of this.connections) {
      if (!desired.has(id)) {
        this.connections.delete(id);
        this.close(connection);
      }
    }
    const jobs: Promise<void>[] = [];
    for (const [id, sessions] of desired) {
      let c = this.connections.get(id);
      if (!c) {
        c = { id, sessions, loaded: new Set(), ready: false, failures: 0, retryAt: 0, warned: false };
        this.connections.set(id, c);
      }
      c.sessions = sessions;
      for (const sid of c.loaded) if (!sessions.has(sid)) c.loaded.delete(sid);
      if (c.connecting) jobs.push(c.connecting);
      else if (this.now() >= c.retryAt) {
        const connection = c;
        c.connecting = this.connect(connection, key).finally(() => {
          connection.connecting = undefined;
        });
        jobs.push(c.connecting);
      }
    }
    await Promise.all(jobs);
  }

  reset(): void {
    const previous = [...this.connections.values()];
    this.connections.clear();
    this.credential = undefined;
    for (const c of previous) this.close(c);
    this.opts.reset();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.reset();
  }

  private current(c: Connection, key: string, client?: CloudStreamClient): boolean {
    return !this.stopped && this.connections.get(c.id) === c && this.credential === key && this.opts.key() === key && !!this.opts.api() && (!client || c.client === client);
  }

  private close(c: Connection): void {
    const client = c.client;
    c.client = undefined;
    c.ready = false;
    c.loading = undefined;
    c.loaded.clear();
    client?.disconnect();
  }

  private async computer(id: string): Promise<CloudStreamComputer> {
    const raw = await this.opts.api()!.get<unknown>(`/computers/${encodeURIComponent(id)}`);
    const c = record(raw);
    const identity = record(c.computerIdentity);
    const url = typeof c.relayClientUrl === 'string' ? new URL(c.relayClientUrl) : undefined;
    if (c.id !== id || typeof c.providerType !== 'string' || !url || url.protocol !== 'wss:' || !['relay.factory.ai', 'relay.eu.factory.ai'].includes(url.hostname)) throw new Error('Computer has no supported relay');
    if (c.computerIdentity && (typeof identity.publicKey !== 'string' || typeof identity.keyId !== 'string' || identity.algorithm !== 'X25519')) throw new Error('Computer has an invalid relay identity');
    return {
      id,
      providerType: c.providerType,
      relayClientUrl: url.toString(),
      ...(c.computerIdentity ? { computerIdentity: { publicKey: identity.publicKey as string, keyId: identity.keyId as string } } : {}),
    };
  }

  private async connect(c: Connection, key: string): Promise<void> {
    try {
      if (!c.client) {
        const computer = await this.computer(c.id);
        if (!this.current(c, key)) return;
        const client = (this.opts.client ?? daemon)(computer, key, async () => (await this.computer(c.id)).computerIdentity ?? null);
        c.client = client;
        const failed = () => {
          if (this.current(c, key, client)) this.failed(c);
        };
        client.onConnectionClose(failed);
        client.onConnectionError(failed);
        client.onTransportMessage((raw) => {
          if (!this.current(c, key, client)) return;
          const message = record(raw);
          const params = record(message.params);
          if (message.type !== 'notification' || message.method !== 'daemon.session_notification' || typeof params.sessionId !== 'string' || !c.sessions.has(params.sessionId)) return;
          const n = record(params.notification);
          if (c.loading?.sessionId === params.sessionId) c.loading[supersedes(n.type)] = true;
          if (['session_process_exited', 'session_inactivity', 'session_closed', 'session_unsubscribed'].includes(String(n.type))) c.loaded.delete(params.sessionId);
          this.opts.notification(params.sessionId, n);
        });
        await client.connect(computer.relayClientUrl);
        if (!this.current(c, key, client)) return;
        await client.authenticate({ apiKey: key, caller: 'sdk', metadata: { sdk: { language: 'typescript', version: SDK_VERSION } } });
        if (!this.current(c, key, client)) return;
        c.ready = true;
      }
      const client = c.client;
      if (!client) return;
      for (const sessionId of c.sessions) {
        if (c.loaded.has(sessionId)) continue;
        const loading = { sessionId, settings: false, title: false, state: false };
        c.loading = loading;
        const snapshot = await client.loadSession({ sessionId, token: key, messageLimit: 100 });
        if (!this.current(c, key, client)) return;
        c.loading = undefined;
        if (!c.sessions.has(sessionId)) continue;
        this.opts.snapshot(sessionId, record(snapshot), { settings: loading.settings, title: loading.title, state: loading.state });
        c.loaded.add(sessionId);
      }
      c.failures = 0;
      c.warned = false;
    } catch {
      if (this.current(c, key)) this.failed(c);
    }
  }

  private failed(c: Connection): void {
    if (!c.client && c.retryAt > this.now()) return;
    this.close(c);
    c.retryAt = this.now() + Math.min(300_000, 30_000 * 2 ** Math.min(c.failures++, 4));
    if (!c.warned) {
      c.warned = true;
      // Don't log raw transport errors: they can carry authentication request details.
      (this.opts.warn ?? console.warn)(`  Cloud stream for ${c.id} unavailable; using Factory polling until it reconnects.`);
    }
  }
}
