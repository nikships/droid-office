import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { lastFloor, spotParams, store, type Profile, type Spot } from './state';
import { lanToken } from './token';

type Handler = (msg: ServerMsg) => void;

export interface NetOptions {
  client?: 'dashboard';
  device?: () => string;
  floor?: () => string | null;
  /** Probe HTTP before each browser upgrade: failed upgrades cannot expose a 401 to JavaScript. */
  authorize?: (signal: AbortSignal) => Promise<boolean>;
  unauthorized?: () => void;
}

export class Net {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private statusHandlers: ((up: boolean) => void)[] = [];
  private retry = 0;
  private closedByUs = false;
  /** The server is restarting on purpose: retry every second instead of backing off. */
  private restartExpected = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connecting: number | undefined;
  private authorizing?: AbortController;
  private generation = 0;
  private requests = new Map<string, (result: Extract<ServerMsg, { t: 'action.result' }>) => void>();
  up = false;

  constructor(
    private profile: () => Profile,
    /** Where you are (or were, before this page), to be put back in the same spot. */
    private where: () => Spot | null,
    private options: NetOptions = {},
  ) {}

  onMessage(h: Handler) {
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((fn) => fn !== h);
    };
  }

  onStatus(h: (up: boolean) => void) {
    this.statusHandlers.push(h);
    return () => {
      this.statusHandlers = this.statusHandlers.filter((fn) => fn !== h);
    };
  }

  async connect() {
    if (this.connecting !== undefined || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    clearTimeout(this.timer);
    this.closedByUs = false;
    const generation = this.generation;
    this.connecting = generation;
    const controller = new AbortController();
    this.authorizing = controller;
    try {
      if (this.options.authorize && !(await this.options.authorize(controller.signal))) {
        if (generation === this.generation) this.unauthorized();
        return;
      }
    } catch {
      if (generation === this.generation) this.schedule();
      return;
    } finally {
      if (this.connecting === generation) this.connecting = undefined;
      if (this.authorizing === controller) this.authorizing = undefined;
    }
    if (generation !== this.generation) return;
    const { name, color } = this.profile();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ name, color });
    // Back to the floor you were on (after a reload or a restart), in the spot you were in there.
    const floor = this.options.floor ? this.options.floor() : (store.floor ?? lastFloor());
    if (floor) q.set('floor', floor);
    const at = spotParams(floor, this.where());
    if (at) for (const [k, v] of Object.entries(at)) q.set(k, v);
    // A page opened over the LAN carries this start's token (?t=); loopback needs none.
    const device = this.options.device?.();
    if (device) q.set('d', device);
    else {
      const t = lanToken();
      if (t) q.set('t', t);
    }
    if (this.options.client) q.set('client', this.options.client);
    const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || generation !== this.generation) return;
      this.retry = 0;
      this.up = true;
      this.statusHandlers.forEach((h) => h(true));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || generation !== this.generation) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'action.result') this.requests.get(msg.requestId)?.(msg);
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.up = false;
      this.ws = null;
      this.uncertain();
      this.statusHandlers.forEach((h) => h(false));
      if (this.closedByUs) return;
      if (event.code === 4401) return this.unauthorized();
      this.schedule();
    };
  }

  private schedule() {
    if (this.closedByUs) return;
    clearTimeout(this.timer);
    const delay = this.restartExpected ? 1000 : Math.min(8000, 500 * 2 ** this.retry++);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private unauthorized() {
    this.close();
    this.options.unauthorized?.();
  }

  private uncertain() {
    for (const [requestId, done] of this.requests) done({ t: 'action.result', requestId, ok: false, error: 'The office did not confirm this action. Check its current state before trying again; it was not replayed.' });
  }

  close() {
    this.closedByUs = true;
    this.generation++;
    this.authorizing?.abort();
    this.authorizing = undefined;
    this.connecting = undefined;
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.up = false;
    this.uncertain();
    this.statusHandlers.forEach((h) => h(false));
  }

  /** Business confirmation, not a successful socket send. No queue and no automatic replay. */
  request(msg: ClientMsg): Promise<Extract<ServerMsg, { t: 'action.result' }>> {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const done = (result: Extract<ServerMsg, { t: 'action.result' }>) => {
        clearTimeout(timer);
        this.requests.delete(requestId);
        resolve(result);
      };
      const timer = setTimeout(() => done({ t: 'action.result', requestId, ok: false, error: 'Confirmation timed out. Check the office before trying again; the action was not replayed.' }), 60_000);
      this.requests.set(requestId, done);
      const floor = this.options.floor ? this.options.floor() : (store.floor ?? null);
      if (!this.send({ ...msg, requestId, requestFloor: floor ?? undefined })) done({ t: 'action.result', requestId, ok: false, error: 'Disconnected. Nothing was sent.' });
    });
  }

  expectRestart() {
    this.restartExpected = true;
  }
  /** Emulator test hook (?vrtest=1): drops the socket (it reconnects on its own, like any outage). */
  debugDrop() {
    this.ws?.close();
  }

  /**
   * Sends now, or drops the message while the connection is down: says which. Whatever must not be
   * lost keeps it and sends it again itself (the Whiteboard's batches wait in WhiteboardSync).
   */
  send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }
}
