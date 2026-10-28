import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { lastFloor, spotParams, store, type Profile, type Spot } from './state';
import { lanToken } from './token';

type Handler = (msg: ServerMsg) => void;

type ActionResult = Extract<ServerMsg, { t: 'action.result' }>;

/**
 * A socket someone else owns: a sealed host whose native side holds the connection, the device
 * credential and route choice. Net never reconnects, queues or replays through it.
 */
export interface NetTransport {
  connect(): void;
  close(): void;
  /** Sends now, or says it could not; never queues. */
  send(msg: ClientMsg): boolean;
  onMessage(fn: (msg: ServerMsg) => void): () => void;
  onStatus(fn: (up: boolean) => void): () => void;
}

export interface NetOptions {
  client?: 'dashboard';
  device?: () => string;
  floor?: () => string | null;
  /** Probe HTTP before each browser upgrade: failed upgrades cannot expose a 401 to JavaScript. */
  authorize?: (signal: AbortSignal) => Promise<boolean>;
  unauthorized?: () => void;
  /** Use this instead of opening a WebSocket from the page. */
  transport?: NetTransport;
}

/** One view's claim on a worker's terminal stream. The connection attaches while any claim is held. */
export interface TerminalHold {
  readonly workerId: string;
  /** Attached on the current connection and floor. */
  readonly attached: boolean;
  /** Asks for a fresh `term.snapshot` (a mirror that fell behind). */
  resnapshot(): void;
  /** Idempotent. The last release detaches. */
  release(): void;
}

export class Net {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private statusHandlers: ((up: boolean) => void)[] = [];
  private readyHandlers: ((ready: boolean) => void)[] = [];
  private lostHandlers: (() => void)[] = [];
  private retry = 0;
  private closedByUs = false;
  /** The server is restarting on purpose: retry every second instead of backing off. */
  private restartExpected = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connecting: number | undefined;
  private authorizing?: AbortController;
  private generation = 0;
  private requests = new Map<string, (result: ActionResult) => void>();
  /** Bumped on every connection loss, arrival and departure: async work started before it is stale. */
  private epoch = 0;
  /** The floor.go in flight: where to, and the receipt that would refuse it. */
  private switching: { floor: string; requestId: string } | undefined;
  /** Message handlers are seeing a welcome or floor.enter: the server already put this connection there. */
  private arriving = false;
  private holds = new Map<string, number>();
  /** Worker id → the epoch its attach was sent in. The server forgets attachments on leave and on a new socket. */
  private attachedIn = new Map<string, number>();
  /** Attached by a raw `worker.attach` from a view that doesn't hold, so the last hold leaves it attached. */
  private rawAttached = new Set<string>();
  private transport?: NetTransport;
  up = false;
  /** Up, and the office has said which floor this connection is on, with no floor switch in flight. */
  ready = false;
  /** The floor of the last welcome or floor.enter. */
  floor: string | null = null;

  constructor(
    private profile: () => Profile,
    /** Where you are (or were, before this page), to be put back in the same spot. */
    private where: () => Spot | null,
    private options: NetOptions = {},
  ) {
    const transport = options.transport;
    if (transport) {
      this.transport = transport;
      transport.onMessage((msg) => this.receive(msg));
      transport.onStatus((up) => {
        // Closed on purpose: a reconnect native had in flight, or a resume, doesn't bring the page back up.
        if (up) {
          if (!this.closedByUs) this.opened();
        } else if (this.up) this.lost();
      });
    }
  }

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

  /**
   * False before a floor switch is sent and on connection loss (dispose the old floor's views then);
   * true once every message handler has seen the authoritative welcome or floor.enter.
   */
  onReady(h: (ready: boolean) => void) {
    this.readyHandlers.push(h);
    return () => {
      this.readyHandlers = this.readyHandlers.filter((fn) => fn !== h);
    };
  }

  /** An open connection was lost or closed. Never a floor switch. Unsent drafts go with it. */
  onConnectionLost(h: () => void) {
    this.lostHandlers.push(h);
    return () => {
      this.lostHandlers = this.lostHandlers.filter((fn) => fn !== h);
    };
  }

  /** Taken before async work; `current` afterwards says whether the same connection and floor are still ready. */
  stamp(): number {
    return this.epoch;
  }

  current(stamp: number): boolean {
    return this.ready && stamp === this.epoch;
  }

  async connect() {
    if (this.transport) {
      this.closedByUs = false;
      this.transport.connect();
      return;
    }
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
      this.opened();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || generation !== this.generation) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.lost();
      if (this.closedByUs) return;
      // 4401: this device was unpaired. 4403: the owner turned the web companion off.
      if (event.code === 4401 || event.code === 4403) return this.unauthorized();
      this.schedule();
    };
  }

  private opened() {
    if (this.up) return;
    this.up = true;
    this.statusHandlers.forEach((h) => h(true));
  }

  private lost() {
    const wasUp = this.up;
    this.up = false;
    this.switching = undefined;
    this.epoch++;
    this.attachedIn.clear();
    this.rawAttached.clear();
    this.uncertain();
    this.unready();
    this.statusHandlers.forEach((h) => h(false));
    if (wasUp) this.lostHandlers.forEach((h) => h());
  }

  private unready() {
    if (!this.ready) return;
    this.ready = false;
    this.readyHandlers.forEach((h) => h(false));
  }

  private receive(msg: ServerMsg) {
    if (msg.t === 'action.result') this.requests.get(msg.requestId)?.(msg);
    const entering = msg.t === 'welcome' || msg.t === 'floor.enter';
    // Only the office's receipt for this very switch says it was refused and the connection stayed put.
    // A success receipt changes nothing: the arrival is what moves the connection.
    const refused = !!this.switching && msg.t === 'action.result' && !msg.ok && msg.requestId === this.switching.requestId;
    if (entering) {
      this.unready();
      this.switching = undefined;
      this.epoch++;
      this.floor = msg.floor;
      this.attachedIn.clear();
      this.rawAttached.clear();
    }
    this.arriving = entering;
    try {
      for (const h of this.handlers) h(msg);
    } finally {
      this.arriving = false;
    }
    if (entering) this.arrive(new Set(msg.workers.map((w) => w.id)));
    else if (refused) {
      // Still on the old floor, where the server kept every attachment made before the switch.
      const before = this.epoch - 1;
      this.switching = undefined;
      this.epoch++;
      for (const [id, epoch] of this.attachedIn) {
        if (epoch === before) this.attachedIn.set(id, this.epoch);
        else this.attachedIn.delete(id);
      }
      this.arrive();
    }
  }

  /** Re-attaches every held terminal that is on this floor, then says the connection is ready. */
  private arrive(here?: Set<string>) {
    if (!this.up) return;
    for (const id of this.holds.keys()) {
      if (here && !here.has(id)) continue;
      if (this.attachedIn.get(id) === this.epoch) continue;
      this.attachedIn.set(id, this.epoch);
      this.write({ t: 'worker.attach', workerId: id });
    }
    this.ready = true;
    this.readyHandlers.forEach((h) => h(true));
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
    this.transport?.close();
    this.lost();
  }

  /** Business confirmation, not a successful socket send. No queue and no automatic replay. */
  request(msg: ClientMsg): Promise<ActionResult> {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const done = (result: ActionResult) => {
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

  /**
   * Holds a worker's terminal attached for as long as the hold lasts, across reconnects and arrivals
   * back on its floor. `snapshot` asks for a fresh `term.snapshot` even when another view already holds it.
   */
  acquireTerminal(workerId: string, opts: { snapshot?: boolean } = {}): TerminalHold {
    const count = this.holds.get(workerId) ?? 0;
    this.holds.set(workerId, count + 1);
    if (this.ready && (opts.snapshot || this.attachedIn.get(workerId) !== this.epoch)) {
      this.attachedIn.set(workerId, this.epoch);
      this.write({ t: 'worker.attach', workerId });
    }
    let released = false;
    const net = this;
    return {
      workerId,
      get attached() {
        return !released && net.ready && net.attachedIn.get(workerId) === net.epoch;
      },
      resnapshot() {
        if (released || !net.ready) return;
        net.attachedIn.set(workerId, net.epoch);
        net.write({ t: 'worker.attach', workerId });
      },
      release() {
        if (released) return;
        released = true;
        const left = (net.holds.get(workerId) ?? 1) - 1;
        if (left > 0) {
          net.holds.set(workerId, left);
          return;
        }
        net.holds.delete(workerId);
        if (net.rawAttached.has(workerId)) return;
        net.attachedIn.delete(workerId);
        if (net.up) net.write({ t: 'worker.detach', workerId });
      },
    };
  }

  /** Whether any view holds this worker's terminal. */
  terminalHeld(workerId: string): boolean {
    return this.holds.has(workerId);
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
    if (!this.up) return false;
    if (msg.t === 'worker.detach') {
      this.rawAttached.delete(msg.workerId);
      // Another view still holds it: closing one window must not cut the other's stream.
      if (this.holds.has(msg.workerId)) return true;
      this.attachedIn.delete(msg.workerId);
    } else if (msg.t === 'worker.attach') {
      // Before the office says where this connection is, or while it leaves a floor, the attach would
      // land on whichever floor comes next. Views attach again on the welcome or arrival.
      if (!this.ready && !this.arriving) return false;
      // A view that attaches without a hold detaches itself, so holds releasing around it leave it attached.
      this.rawAttached.add(msg.workerId);
      this.attachedIn.set(msg.workerId, this.epoch);
    } else if (msg.t === 'floor.go') {
      // One switch at a time: a second would let the first arrival look final while another is on its way.
      if (this.switching) return false;
      // The office answers a trip to the floor this connection is on with no arrival: nothing to leave.
      if (msg.floor !== this.floor) return this.leaveFloor(msg);
    }
    return this.write(msg);
  }

  /** The floor a switch in flight is going to, if one is. */
  get switchingTo(): string | undefined {
    return this.switching?.floor;
  }

  /**
   * The old floor's views go before the switch is on the wire: a transport may deliver the arrival
   * while the send is still running, and nothing of theirs may apply after it.
   */
  private leaveFloor(msg: Extract<ClientMsg, { t: 'floor.go' }>): boolean {
    const before = this.epoch;
    // Carries a receipt, so a refusal is told apart from every other warning. A caller's own id is
    // kept, so Net.request still resolves on the same receipt.
    const requestId = msg.requestId ?? `floor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const switching = { floor: msg.floor, requestId };
    this.switching = switching;
    this.epoch++;
    this.unready();
    if (this.write({ ...msg, requestId, requestFloor: msg.requestFloor ?? this.floor ?? undefined })) return true;
    // Never sent, so the connection is still on its floor; a lost socket says so itself.
    if (this.switching !== switching || !this.up) return false;
    this.switching = undefined;
    for (const [id, epoch] of this.attachedIn) if (epoch === before) this.attachedIn.set(id, this.epoch);
    this.arrive();
    return false;
  }

  private write(msg: ClientMsg): boolean {
    if (this.transport) return this.up && this.transport.send(msg);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }
}
