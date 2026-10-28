import { companionCapabilities } from '../shared/companion-roster';
import { TOOL_BY_ID, type ToolArgs, type ToolId, toolAvailability } from '../shared/companion-tools';
import {
  type CompanionView,
  type CompanionWorkspace,
  companionFloorWorkspace,
  createCompanionWorkspace,
  type FloorWorkspace,
  MAX_COMPANION_PANES,
  reduceCompanionWorkspace,
  restoreCompanionWorkspace,
  type WorkspaceAction,
} from '../shared/companion-workspace';
import { PROMPT_IMAGES_MAX } from '../shared/drops';
import type { Menu } from '../shared/asks';
import { CLEAR_DROID_QUEUE } from '../shared/droid-queue';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../shared/protocol';
import { slashOf, slashRefusal } from '../shared/slash-commands';
import { readDroidQueue } from '../shared/droid-queue';
import type { QueuedView } from '../shared/thread-queue';
import { isBusy } from '../shared/status';
import { linkStep } from '../client/worker-link';
import type { HostActionResult, HostImage, HostIncoming, HostLink, HostMessageMeta, HostOffices, ManagementEvent, MobileHost } from './host';
import { dropToast, emptyOffice, expireToasts, type OfficeState, officeDisconnected, reduceOffice, toolContext, withToast } from './office-state';
import { FeedPool, requestId } from './thread-feed';
import { type HireRequest, hireMsg, stopMsg } from './actions';

type Early = { msg: ServerMsg; meta: HostMessageMeta } | { link: HostLink } | { offices: HostOffices } | { incoming: HostIncoming };

/** What a delayed action was started under. Any change to it means the owner is looking at something else. */
export interface ActionToken {
  /** The office it was started in: pictures it staged are forgotten there, never on another. */
  office?: string;
  epoch: number;
  floor: string | null;
  arrival: number;
}

export interface SessionSnapshot {
  started: boolean;
  link: HostLink;
  offices: HostOffices;
  office: OfficeState;
  /** The socket epoch whose `welcome` the app has; actions need it to be the current one. */
  welcomedEpoch: number;
  /** A floor change sent and not yet answered by `floor.enter`. */
  switching?: string;
  workspace: CompanionWorkspace;
  /** Previews of attached pictures, by upload id; dropped with their drafts. */
  previews: Record<string, string>;
  /** Workers with a send in flight, by `floor\u0000worker`. */
  sending: Record<string, true>;
  /** Workers whose picture picker is open or uploading. */
  picking: Record<string, true>;
  /** A worker link waiting for its office or floor. */
  pendingLink?: HostIncoming & { travelling?: boolean };
  /** A worker just hired from here, opened once the office lists it. */
  pendingOpen?: { id: string; token: ActionToken };
  /** A floor change the office hasn't answered for FLOOR_TIMEOUT_MS: still refused, with a way to ask again. */
  floorSlow?: boolean;
  /** Grows whenever a worker is opened, from the roster, a link, a hire or a tool: the UI shows it. */
  navigation: number;
  /** Why the first state couldn't be read from the phone; start() again retries. */
  bootError?: string;
  /** Pictures staged for the Hire sheet, on the floor and socket they were picked under. */
  hire?: { token: ActionToken; images: HostImage[] };
  /** The management tool open in the Tools tab, and what it opens on. */
  tool?: { id: ToolId; args: ToolArgs };
  /** Grows whenever a tool is opened from here (the rail, a worker's actions): the UI shows the Tools tab. */
  toolNavigation: number;
}

export const STALE = 'The office changed before this was sent. Nothing was sent.';
export const OFFLINE = 'Disconnected. Nothing was sent.';
export const UNCONFIRMED = 'The office did not confirm this. Check before trying again; nothing was re-sent.';
export const IN_FLIGHT = 'Already sent: waiting for the office to answer.';
/** Pictures waiting for the office to be reachable again so it can forget them. */
const ORPHANS_KEPT = 200;
export const FLOOR_TIMEOUT_MS = 10_000;
const HIRE_KEY = '\u0000hire';
export const LAYOUT_SAVE_MS = 400;

type FloorAction = WorkspaceAction extends infer A ? (A extends { floor: string } ? Omit<A, 'floor'> : never) : never;

const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
const sendKey = (floor: string, worker: string) => `${floor}\u0000${worker}`;

function layoutOf(ws: CompanionWorkspace): unknown {
  return { floors: Object.fromEntries(Object.entries(ws.floors).map(([id, f]) => [id, { panes: f.panes, active: f.active, collapsed: f.collapsed }])) };
}

/**
 * The app's one controller: what the host says, in order, folded into a snapshot the UI renders. It
 * owns every rule about when the owner may act: only on the socket whose `welcome` it has, never during
 * a floor change, and never with a token from an earlier socket, floor or arrival. It replays nothing.
 */
export class Session {
  private state: SessionSnapshot;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private holds = new Map<string, () => void>();
  private timer?: ReturnType<typeof setInterval>;
  private floorTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private bootSeq = -1;
  private disposed = false;
  private run = 0;
  /** Confirmed actions sent and not yet answered, by message: a second tap is refused, not sent. */
  /** In-flight actions by message, each owned by the call that started it. */
  private inflight = new Map<string, object>();
  /** Who is sending each draft: a send from before a reconnect never clears one started after it. */
  private senders = new Map<string, object>();
  /** The cold-start link this session already followed. */
  private coldIncoming?: string;
  /** The `floor.go` receipts of the floor change in progress, by requestId: unanswered, ok or refused. */
  private floorRequests = new Map<string, 'sent' | 'ok' | 'refused'>();
  /** Staged pictures dropped while the office couldn't be told, forgotten on its next welcome. */
  private orphans: { office: string; floor: string; id: string }[] = [];
  /** Receipts for messages queued behind a turn, as the thread shows them; computed outside render. */
  private queued = new Map<string, { views: QueuedView[]; droid: boolean }>();
  readonly feeds = new FeedPool();
  /** The app is in the foreground. */
  visible = true;
  /** The Workers tab is showing (not Tools or Device): only then do panes read and hold. */
  workspaceShown = true;
  /** The focused pane's Team activity is expanded. */
  teamOpen = false;
  /** One full-screen conversation, not pinned panes. */
  phone = true;

  constructor(
    readonly host: MobileHost,
    private now: () => number = Date.now,
  ) {
    this.state = {
      started: false,
      link: { phase: 'idle', epoch: 0, seq: 0 },
      offices: { offices: [] },
      office: emptyOffice(),
      welcomedEpoch: -1,
      workspace: createCompanionWorkspace(),
      previews: {},
      sending: {},
      picking: {},
      navigation: 0,
      toolNavigation: 0,
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = (): SessionSnapshot => this.state;

  private set(next: Partial<SessionSnapshot>): void {
    this.state = { ...this.state, ...next };
    this.syncAttachments();
    this.refreshQueues();
    for (const fn of this.listeners) fn();
  }

  /** Subscribes first, then bootstraps, so no message falls between the snapshot and the stream. */
  async start(): Promise<void> {
    if (this.offs.length) return;
    // React may dispose and start again (StrictMode): an earlier run's bootstrap must not continue.
    const run = ++this.run;
    this.disposed = false;
    // Everything native says before the bootstrap answered is kept in the one order it arrived in
    // (native emits it all on one channel) and applied after the bootstrap's replay: an office change
    // followed by the new office's link and welcome lands as change, link, welcome, never reordered.
    const early: Early[] = [];
    let booted = false;
    this.offs.push(
      this.host.onMessage((msg, meta) => (booted ? this.message(msg, meta) : early.push({ msg, meta }))),
      this.host.onLink((link) => (booted ? this.linked(link) : early.push({ link }))),
      this.host.onOffices((offices) => (booted ? void this.officesChanged(offices) : early.push({ offices }))),
      this.host.onIncoming((incoming) => (booted ? this.incoming(incoming) : early.push({ incoming }))),
      this.host.onScreen(() => this.emit()),
      this.feeds.subscribe(() => this.emit()),
    );
    let boot: Awaited<ReturnType<MobileHost['bootstrap']>>;
    try {
      boot = await this.host.bootstrap();
    } catch (err) {
      if (run !== this.run) return;
      // Unsubscribed, so start() again subscribes once; what was buffered goes with this attempt.
      for (const off of this.offs.splice(0)) off();
      early.length = 0;
      this.set({ bootError: err instanceof Error && err.message ? err.message : 'The app could not read its offices.' });
      return;
    }
    if (run !== this.run) return;
    this.bootSeq = boot.seq;
    const workspace = boot.active ? restoreCompanionWorkspace(await this.host.layout.load(boot.active).catch(() => undefined)) : createCompanionWorkspace();
    if (run !== this.run) return;
    this.set({ started: true, bootError: undefined, offices: { offices: boot.offices, active: boot.active }, link: boot.link, workspace });
    for (const msg of boot.replay) this.message(msg, { seq: boot.seq, epoch: boot.link.epoch }, true);
    booted = true;
    // The link that started the app is older than anything tapped since. A bootstrap read again
    // (React's StrictMode starts twice) may hand over the same one: it is followed once.
    const cold = boot.incoming && JSON.stringify(boot.incoming);
    if (boot.incoming && cold !== this.coldIncoming) {
      this.coldIncoming = cold;
      this.incoming(boot.incoming);
    }
    const changes: Promise<void>[] = [];
    for (const e of early.splice(0)) {
      // What the bootstrap already reflects is not applied again; an office list without a seq can't
      // be placed against it, so it counts as newer.
      if ('msg' in e) {
        if (e.meta.seq > boot.seq) this.message(e.msg, e.meta);
      } else if ('link' in e) {
        if (e.link.seq > boot.seq) this.linked(e.link);
      } else if ('offices' in e) {
        if (e.offices.seq === undefined || e.offices.seq > boot.seq) changes.push(this.officesChanged(e.offices));
      } else this.incoming(e.incoming);
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.sync();
    await Promise.all(changes);
  }

  dispose(): void {
    this.run++;
    this.disposed = true;
    this.bootSeq = -1;
    clearInterval(this.timer);
    clearTimeout(this.floorTimer);
    // A pane change made just before unmount is still saved.
    if (this.saveTimer) this.flushLayout(this.state.offices.active);
    this.state = { ...this.state, started: false };
    for (const off of this.offs.splice(0)) off();
    for (const release of this.holds.values()) release();
    this.holds.clear();
  }

  /** Tries the bootstrap again after it failed. */
  retryStart(): Promise<void> {
    this.set({ bootError: undefined });
    return this.start();
  }

  private emit(): void {
    this.refreshQueues();
    this.state = { ...this.state };
    for (const fn of this.listeners) fn();
  }

  tick(): void {
    const s = this.state;
    this.feeds.tick(this.now(), { connected: this.ready(), visible: this.visible && this.workspaceShown, focused: this.floorWorkspace().active || undefined, teamOpen: this.teamOpen }, (msg) => this.send(msg));
    const office = expireToasts(s.office, this.now());
    if (office !== s.office) this.set({ office });
    else if (this.refreshQueues()) this.emit();
  }

  // --- What the host says ---------------------------------------------------------------------------

  private message(msg: ServerMsg, meta: HostMessageMeta, replayed = false): void {
    if (!replayed && meta.seq <= this.bootSeq) return;
    // A message from a socket that has since closed describes an office nobody is looking at.
    if (meta.epoch !== this.state.link.epoch) return;
    const office = reduceOffice(this.state.office, msg);
    const next: Partial<SessionSnapshot> = { office };
    if (msg.t === 'welcome') next.welcomedEpoch = meta.epoch;
    // Only the office ends a floor change: its arrival, or its receipt refusing every floor.go sent for
    // it, which leaves this connection where it was. A successful receipt waits for floor.enter; time
    // passing, a toast or a request the host couldn't confirm prove nothing.
    let refused = false;
    if (msg.t === 'action.result' && this.floorRequests.has(msg.requestId)) {
      this.floorRequests.set(msg.requestId, msg.ok ? 'ok' : 'refused');
      if (!msg.ok && [...this.floorRequests.values()].every((v) => v === 'refused')) {
        refused = true;
        next.office = withToast(office, msg.error ?? 'The office did not move you to that floor.', 'warn', this.now());
      }
    }
    if (msg.t === 'welcome' || msg.t === 'floor.enter' || refused) {
      next.switching = undefined;
      next.floorSlow = undefined;
      this.floorRequests.clear();
      clearTimeout(this.floorTimer);
    }
    let workspace = this.state.workspace;
    if ((msg.t === 'welcome' || msg.t === 'floor.enter' || msg.t === 'worker.remove') && office.floor) {
      workspace = reduceCompanionWorkspace(workspace, { type: 'reconcile', floor: office.floor, workerIds: Object.keys(office.workers) });
      next.workspace = workspace;
    }
    const tool = this.state.tool;
    if (tool) {
      const scope = TOOL_BY_ID.get(tool.id)?.scope;
      const floorGone = (msg.t === 'welcome' || msg.t === 'floor.enter') && scope !== 'office' && office.floor !== this.state.office.floor;
      const workerGone = scope === 'worker' && !!tool.args.workerId && !own(office.workers, tool.args.workerId);
      if (floorGone || workerGone) next.tool = undefined;
    }
    this.set(next);
    if ((msg.t === 'welcome' || msg.t === 'floor.enter') && this.state.hire && !this.valid(this.state.hire.token)) this.discardHire();
    if (msg.t === 'welcome') this.flushOrphans();
    // Refused: still on the floor it was on, so its panes hold and read again.
    if (refused) this.sync();
    this.feeds.receive(msg);
    const pending = this.state.pendingOpen;
    if (msg.t === 'worker.update' && pending?.id === msg.worker.id) {
      this.set({ pendingOpen: undefined });
      if (this.valid(pending.token)) this.open(msg.worker.id);
    }
    if (msg.t === 'welcome' || msg.t === 'floor.enter' || msg.t === 'worker.update' || msg.t === 'worker.remove') {
      this.sync();
      this.followLink();
    }
    if (msg.t === 'welcome' || msg.t === 'floor.enter' || msg.t === 'worker.remove') this.saveLayout();
  }

  private linked(link: HostLink): void {
    const prev = this.state.link;
    const lost = prev.phase === 'connected' && (link.phase !== 'connected' || link.epoch !== prev.epoch);
    if (lost) this.connectionLost();
    if (link.epoch !== prev.epoch || link.phase !== 'connected') this.floorRequests.clear();
    this.set({ link, ...(link.epoch !== prev.epoch || link.phase !== 'connected' ? { office: officeDisconnected(this.state.office), switching: undefined, floorSlow: undefined } : {}) });
    this.sync();
  }

  /** An actual loss, not a floor switch: unsent text and pictures go on every floor; panes stay. */
  private connectionLost(): void {
    clearTimeout(this.floorTimer);
    this.feeds.disconnected();
    this.orphanDropped(this.state.offices.active);
    this.inflight.clear();
    this.senders.clear();
    this.hiring = undefined;
    // The office can't be asked to forget pictures now; they are dropped here and never re-sent.
    this.set({ workspace: reduceCompanionWorkspace(this.state.workspace, { type: 'disconnect' }), previews: {}, sending: {}, picking: {}, switching: undefined, floorSlow: undefined, hire: undefined });
  }

  /** Another office: nothing of the last one is current, and its unsent drafts go with it. */
  private async officesChanged(offices: HostOffices): Promise<void> {
    const before = this.state.offices.active;
    if (offices.active === before) return this.set({ offices });
    this.flushLayout(before);
    // The last office's unsent pictures are forgotten there, not on the new one.
    this.orphanDropped(before);
    this.flushOrphans(before);
    this.inflight.clear();
    this.senders.clear();
    this.hiring = undefined;
    this.set({
      offices,
      office: emptyOffice(),
      welcomedEpoch: -1,
      workspace: { floors: {}, epoch: this.state.workspace.epoch + 1 },
      previews: {},
      sending: {},
      picking: {},
      switching: undefined,
      floorSlow: undefined,
      pendingOpen: undefined,
      hire: undefined,
      tool: undefined,
    });
    this.sync();
    const loaded = offices.active ? restoreCompanionWorkspace(await this.host.layout.load(offices.active).catch(() => undefined)) : createCompanionWorkspace();
    if (this.disposed || this.state.offices.active !== offices.active) return;
    // Panes opened while the layout loaded win over the saved ones.
    let workspace: CompanionWorkspace = { floors: { ...loaded.floors, ...this.state.workspace.floors }, epoch: this.state.workspace.epoch };
    const floor = this.state.office.floor;
    if (floor && this.state.office.synced) workspace = reduceCompanionWorkspace(workspace, { type: 'reconcile', floor, workerIds: Object.keys(this.state.office.workers) });
    this.set({ workspace });
    this.sync();
  }

  private incoming(incoming: HostIncoming): void {
    this.set({ pendingLink: incoming });
    if (incoming.office !== this.state.offices.active && this.state.offices.offices.some((o) => o.id === incoming.office)) this.host.selectOffice(incoming.office);
    this.followLink();
  }

  private followLink(): void {
    const link = this.state.pendingLink;
    if (!link || !this.ready()) return;
    if (link.office !== this.state.offices.active) {
      if (!this.state.offices.offices.some((o) => o.id === link.office)) this.set({ pendingLink: undefined });
      return;
    }
    const office = this.state.office;
    if (link.kind === 'floor') {
      this.set({ pendingLink: undefined });
      if (link.floor !== office.floor && office.floors.some((f) => f.id === link.floor)) this.goFloor(link.floor);
      return;
    }
    const step = linkStep({ worker: link.worker, ...(link.floor ? { floor: link.floor } : {}) }, { floor: office.floor, hasWorker: (id) => !!own(office.workers, id), hasFloor: (id) => office.floors.some((f) => f.id === id) });
    // Going to its floor first: the link waits for that floor's `floor.enter`, once.
    if (step === 'go' && !link.travelling && link.floor) {
      this.set({ pendingLink: { ...link, travelling: true } });
      if (!this.goFloor(link.floor)) this.set({ pendingLink: undefined });
      return;
    }
    this.set({ pendingLink: undefined });
    if (step === 'open') this.open(link.worker);
    else this.toast('That worker has gone home, or its floor left the building.', 'warn');
  }

  // --- When the owner may act -------------------------------------------------------------------------

  /** Connected, on the socket whose `welcome` this app has, and not between floors. */
  ready(): boolean {
    const s = this.state;
    return s.started && s.link.phase === 'connected' && s.welcomedEpoch === s.link.epoch && s.office.synced && !s.switching;
  }

  token(): ActionToken {
    return { office: this.state.offices.active, epoch: this.state.link.epoch, floor: this.state.office.floor, arrival: this.state.office.arrival };
  }

  valid(t: ActionToken): boolean {
    const now = this.token();
    return this.ready() && t.office === now.office && t.epoch === now.epoch && t.floor === now.floor && t.arrival === now.arrival;
  }

  send(msg: ClientMsg): boolean {
    return this.ready() && this.host.send(msg);
  }

  /** A confirmed action, refused outright when the office moved on since `token`. */
  async request(msg: ClientMsg, token = this.token()): Promise<HostActionResult> {
    if (!this.ready()) return { ok: false, error: OFFLINE };
    if (!this.valid(token)) return { ok: false, error: STALE };
    // The same action twice before the first is answered (a double tap) is one action.
    const key = JSON.stringify(msg);
    if (this.inflight.has(key)) return { ok: false, error: IN_FLIGHT };
    const mine = {};
    this.inflight.set(key, mine);
    try {
      const r = await this.host.request({ ...msg, ...(token.floor ? { requestFloor: token.floor } : {}) });
      return r && typeof r.ok === 'boolean' ? r : { ok: false, error: UNCONFIRMED };
    } catch {
      // A native bridge failure is an unconfirmed action: the UI never waits on it for ever.
      return { ok: false, error: UNCONFIRMED };
    } finally {
      // A reconnect cleared this one and a new call may own the key now: that one is left alone.
      if (this.inflight.get(key) === mine) this.inflight.delete(key);
    }
  }

  toast(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.set({ office: withToast(this.state.office, text, level, this.now()) });
  }
  dismissToast(id: number): void {
    this.set({ office: dropToast(this.state.office, id) });
  }

  // --- Floors and panes -----------------------------------------------------------------------------

  /**
   * Holds and feeds of the old floor go before `floor.go`; the new floor's panes come back on
   * `floor.enter`. One change at a time: another is refused until the office answers this one.
   */
  goFloor(floor: string): boolean {
    if (!this.ready() || floor === this.state.office.floor) return false;
    const from = this.state.office.floor;
    this.set({ switching: floor });
    this.sync();
    if (!this.sendFloorGo(floor, from)) {
      this.set({ switching: undefined });
      this.sync();
      this.toast(OFFLINE, 'warn');
      return false;
    }
    this.armFloorTimer(floor);
    return true;
  }

  /** `floor.go` with a receipt: sent directly, so its `action.result` comes back as a message, not a guess. */
  private sendFloorGo(floor: string, from: string | null): boolean {
    const id = requestId('floor');
    // Registered first: a host may hand the receipt back before send returns.
    this.floorRequests.set(id, 'sent');
    if (this.host.send({ t: 'floor.go', floor, requestId: id, ...(from ? { requestFloor: from } : {}) })) return true;
    this.floorRequests.delete(id);
    return false;
  }

  private armFloorTimer(floor: string): void {
    clearTimeout(this.floorTimer);
    this.set({ floorSlow: undefined });
    this.floorTimer = setTimeout(() => {
      if (this.state.switching === floor) this.set({ floorSlow: true });
    }, FLOOR_TIMEOUT_MS);
  }

  /** The office hasn't answered a floor change: ask it again on the same socket. Nothing else is re-sent. */
  askFloorAgain(): boolean {
    const s = this.state;
    const floor = s.switching;
    if (!floor || s.link.phase !== 'connected' || s.welcomedEpoch !== s.link.epoch) return false;
    if (!this.sendFloorGo(floor, s.office.floor)) return false;
    this.armFloorTimer(floor);
    return true;
  }

  floorWorkspace(): FloorWorkspace {
    const floor = this.state.office.floor;
    return companionFloorWorkspace(this.state.workspace, floor ?? '');
  }

  private dispatch(action: FloorAction, floor = this.state.office.floor): void {
    if (!floor) return;
    this.set({ workspace: reduceCompanionWorkspace(this.state.workspace, { ...action, floor } as WorkspaceAction) });
    this.sync();
    this.saveLayout();
  }

  /** On a phone the conversation takes the screen; on a tablet `pin` adds a pane (at most four). */
  open(workerId: string, pin = false): boolean {
    if (!own(this.state.office.workers, workerId)) return false;
    const ws = this.floorWorkspace();
    const pinned = !this.phone && pin;
    if (pinned && !ws.panes.some((p) => p.workerId === workerId) && ws.panes.length >= MAX_COMPANION_PANES) {
      this.toast(`At most ${MAX_COMPANION_PANES} panes. Close one first.`, 'warn');
      return false;
    }
    this.dispatch({ type: 'open', workerId, pin: pinned });
    this.set({ navigation: this.state.navigation + 1, tool: undefined });
    return true;
  }

  /** Why a management tool can't open now (the shared catalogue's words), or undefined. */
  toolRefusal(id: ToolId, args: ToolArgs = {}): string | undefined {
    const a = toolAvailability(id, toolContext(this.state.office, this.ready(), args), args);
    return a.available ? undefined : a.reason;
  }

  /** Opens a management tool in the Tools tab; the workspace's panes and drafts stay as they are. */
  openTool(id: ToolId, args: ToolArgs = {}): boolean {
    const refused = this.toolRefusal(id, args);
    if (refused) {
      this.toast(refused, 'warn');
      return false;
    }
    this.set({ tool: { id, args }, toolNavigation: this.state.toolNavigation + 1 });
    return true;
  }
  closeTool(): void {
    if (this.state.tool) this.set({ tool: undefined });
  }
  close(workerId: string): void {
    this.dispatch({ type: 'close', workerId });
  }
  /** `''` is the roster: on a phone that is back from the conversation; panes and drafts stay. */
  focus(workerId: string): void {
    this.dispatch({ type: 'focus', workerId });
  }
  view(workerId: string, view: CompanionView, floor = this.state.office.floor): void {
    this.dispatch({ type: 'view', workerId, view }, floor);
  }
  resize(workerId: string, size: number): void {
    this.dispatch({ type: 'resize', workerId, size });
  }
  collapse(workerId: string): void {
    this.dispatch({ type: 'collapse', workerId });
  }
  draft(workerId: string, text: string): void {
    const had = own(this.floorWorkspace().drafts, workerId);
    this.dispatch({ type: 'draft', workerId, draft: { text, attachments: had?.attachments ?? [] } });
  }
  removeAttachment(workerId: string, id: string): void {
    const floor = this.state.office.floor;
    const had = own(this.floorWorkspace().drafts, workerId);
    if (!floor || !had) return;
    this.forget(this.token(), [id]);
    this.dispatch({ type: 'draft', workerId, draft: { text: had.text, attachments: had.attachments.filter((a) => a !== id) } });
  }

  /** The app's width class changed: a phone shows one conversation, a tablet its pinned panes. */
  setPhone(phone: boolean): void {
    if (this.phone === phone) return;
    this.phone = phone;
    this.sync();
    this.emit();
  }
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.tick();
    this.emit();
  }
  /** Tools or Device covers the workspace: its panes stop reading and holding until it shows again. */
  setWorkspaceShown(shown: boolean): void {
    if (this.workspaceShown === shown) return;
    this.workspaceShown = shown;
    this.sync();
    if (shown) this.tick();
    this.emit();
  }
  setTeamOpen(open: boolean): void {
    this.teamOpen = open;
    this.tick();
  }

  /** A management tool asked to open a worker or change floor: the RN workspace does it. */
  managementEvent(event: ManagementEvent): void {
    if (event.kind === 'switch-floor') this.goFloor(event.floor);
    else if (event.kind === 'open-worker' && this.open(event.workerId)) this.view(event.workerId, event.view === 'tty' ? 'terminal' : 'thread');
  }

  /** Opens a worker the office has just confirmed hiring, now or once its first update arrives. */
  openSoon(id: string, token = this.token()): void {
    if (this.worker(id)) this.open(id);
    else this.set({ pendingOpen: { id, token } });
  }

  /** The previous or next worker in `order` (the roster as shown), for the phone's conversation. */
  step(order: readonly string[], delta: 1 | -1): void {
    const active = this.floorWorkspace().active;
    if (!order.length) return;
    const at = order.indexOf(active);
    const next = order[(at < 0 ? 0 : at + delta + order.length) % order.length];
    if (next && next !== active) this.open(next);
  }

  worker(id: string): WorkerInfo | undefined {
    return own(this.state.office.workers, id);
  }

  /** A pane's view as it can be shown: Thread only for a local Droid, Raw TTY only where it has a terminal. */
  effectiveView(w: WorkerInfo, view: CompanionView): CompanionView | 'info' {
    const caps = companionCapabilities(w);
    if (view === 'thread' && caps.thread) return 'thread';
    if (view === 'terminal' && caps.terminal) return 'terminal';
    return caps.thread ? 'thread' : caps.terminal ? 'terminal' : 'info';
  }

  /** Thread panes hold their worker (screen rows, Esc); the native terminal view holds its own. */
  private sync(): void {
    const s = this.state;
    const ws = this.floorWorkspace();
    const workers = ws.panes.flatMap((p) => {
      const w = this.worker(p.workerId);
      return w && this.effectiveView(w, p.view) === 'thread' ? [w] : [];
    });
    const shown = this.phone ? workers.filter((w) => w.id === ws.active) : workers;
    const want = new Set(this.ready() && this.workspaceShown ? shown.map((w) => w.id) : []);
    for (const [id, release] of [...this.holds]) {
      if (want.has(id)) continue;
      release();
      this.holds.delete(id);
    }
    for (const id of want) if (!this.holds.has(id)) this.holds.set(id, this.host.holdWorker(id));
    this.feeds.sync(this.ready() ? shown : [], ws.active || undefined, Object.values(s.office.workers), `${s.offices.active}:${s.office.floor}:${s.link.epoch}:${s.office.arrival}`);
  }

  /** Who holds which worker now, for tests. */
  held(): string[] {
    return [...this.holds.keys()];
  }

  private saveLayout(): void {
    clearTimeout(this.saveTimer);
    const office = this.state.offices.active;
    this.saveTimer = setTimeout(() => this.flushLayout(office), LAYOUT_SAVE_MS);
  }
  private flushLayout(office: string | undefined): void {
    clearTimeout(this.saveTimer);
    if (office && office === this.state.offices.active) this.host.layout.save(office, layoutOf(this.state.workspace));
  }

  /** Previews whose ids are no longer in any draft are let go. */
  private syncAttachments(): void {
    const ids = new Set(Object.values(this.state.workspace.floors).flatMap((f) => Object.values(f.drafts).flatMap((d) => d.attachments)));
    const previews = this.state.previews;
    if (Object.keys(previews).every((id) => ids.has(id))) return;
    this.state = { ...this.state, previews: Object.fromEntries(Object.entries(previews).filter(([id]) => ids.has(id))) };
  }

  // --- Composer ---------------------------------------------------------------------------------------

  isSending(workerId: string): boolean {
    const floor = this.state.office.floor;
    return !!floor && !!own(this.state.sending, sendKey(floor, workerId));
  }
  isPicking(workerId: string): boolean {
    const floor = this.state.office.floor;
    return !!floor && !!own(this.state.picking, sendKey(floor, workerId));
  }

  /** Pictures picked under one socket and floor never land in a draft of another. */
  async attach(workerId: string): Promise<void> {
    const floor = this.state.office.floor;
    if (!floor || !this.ready()) return;
    const token = this.token();
    const had = own(this.floorWorkspace().drafts, workerId)?.attachments ?? [];
    if (had.length >= PROMPT_IMAGES_MAX) return this.toast(`A prompt takes at most ${PROMPT_IMAGES_MAX} pictures`, 'warn');
    const key = sendKey(floor, workerId);
    this.set({ picking: { ...this.state.picking, [key]: true } });
    let images: Awaited<ReturnType<MobileHost['pickImages']>> = [];
    try {
      images = await this.host.pickImages(floor, PROMPT_IMAGES_MAX - had.length);
    } catch (err) {
      this.toast(err instanceof Error ? err.message : 'Those pictures could not be attached.', 'warn');
    }
    const { [key]: _done, ...picking } = this.state.picking;
    this.set({ picking });
    if (!images.length) return;
    if (!this.valid(token))
      return this.forget(
        token,
        images.map((i) => i.id),
      );
    const draft = own(this.floorWorkspace().drafts, workerId) ?? { text: '', attachments: [] };
    const room = PROMPT_IMAGES_MAX - draft.attachments.length;
    const kept = images.slice(0, Math.max(0, room));
    this.forget(
      token,
      images.slice(kept.length).map((i) => i.id),
    );
    this.dispatch({ type: 'draft', workerId, draft: { text: draft.text, attachments: [...draft.attachments, ...kept.map((i) => i.id)] } });
    this.set({ previews: { ...this.state.previews, ...Object.fromEntries(kept.flatMap((i) => (i.preview ? [[i.id, i.preview]] : []))) } });
  }

  isPickingHire(): boolean {
    const floor = this.state.office.floor;
    return !!floor && !!own(this.state.picking, sendKey(floor, HIRE_KEY));
  }

  /** Pictures for a hire's first prompt, picked under this socket and floor, at most PROMPT_IMAGES_MAX. */
  async attachHire(): Promise<void> {
    const floor = this.state.office.floor;
    if (!floor || !this.ready() || this.isPickingHire()) return;
    const token = this.token();
    if (this.state.hire && !this.valid(this.state.hire.token)) this.discardHire();
    const had = this.state.hire?.images ?? [];
    if (had.length >= PROMPT_IMAGES_MAX) return this.toast(`A prompt takes at most ${PROMPT_IMAGES_MAX} pictures`, 'warn');
    const key = sendKey(floor, HIRE_KEY);
    this.set({ picking: { ...this.state.picking, [key]: true } });
    let images: HostImage[] = [];
    try {
      images = await this.host.pickImages(floor, PROMPT_IMAGES_MAX - had.length);
    } catch (err) {
      this.toast(err instanceof Error ? err.message : 'Those pictures could not be attached.', 'warn');
    }
    const { [key]: _done, ...picking } = this.state.picking;
    this.set({ picking });
    if (!images.length) return;
    if (!this.valid(token))
      return this.forget(
        token,
        images.map((i) => i.id),
      );
    const now = this.state.hire?.images ?? [];
    const kept = images.slice(0, Math.max(0, PROMPT_IMAGES_MAX - now.length));
    this.forget(
      token,
      images.slice(kept.length).map((i) => i.id),
    );
    this.set({ hire: { token, images: [...now, ...kept] } });
  }

  removeHireImage(id: string): void {
    const hire = this.state.hire;
    if (!hire) return;
    this.forget(hire.token, [id]);
    this.set({ hire: { ...hire, images: hire.images.filter((i) => i.id !== id) } });
  }

  /** The Hire sheet closed without hiring, or its floor or socket went: its pictures are forgotten. */
  discardHire(): void {
    const hire = this.state.hire;
    if (!hire) return;
    this.set({ hire: undefined });
    this.forget(
      hire.token,
      hire.images.map((i) => i.id),
    );
  }

  /**
   * Asks the office the pictures were staged on to forget them: now when it can be told, else on its
   * next welcome. Never another office's upload, and never the prompt they were for.
   */
  private forget(token: ActionToken, ids: readonly string[]): void {
    const { office, floor } = token;
    if (!office || !floor || !ids.length) return;
    const reachable = office !== this.state.offices.active || (this.state.link.phase === 'connected' && this.state.welcomedEpoch === this.state.link.epoch);
    for (const id of ids) {
      if (reachable) this.host.forgetImage(floor, id, office);
      else this.orphans.push({ office, floor, id });
    }
    this.orphans = this.orphans.slice(-ORPHANS_KEPT);
  }

  /** Every picture in a draft or the Hire sheet of `office`, now dropped unsent. */
  private orphanDropped(office: string | undefined): void {
    if (!office) return;
    for (const [floor, ws] of Object.entries(this.state.workspace.floors)) for (const d of Object.values(ws.drafts)) for (const id of d.attachments) this.orphans.push({ office, floor, id });
    const hire = this.state.hire;
    if (hire?.token.floor && hire.token.office === office) for (const i of hire.images) this.orphans.push({ office, floor: hire.token.floor, id: i.id });
    this.orphans = this.orphans.slice(-ORPHANS_KEPT);
  }

  /** Forgets what waited for `office` (by default the active one, once welcomed again). */
  private flushOrphans(office = this.state.offices.active): void {
    if (!office) return;
    const keep: typeof this.orphans = [];
    for (const o of this.orphans) {
      if (o.office === office) this.host.forgetImage(o.floor, o.id, o.office);
      else keep.push(o);
    }
    this.orphans = keep;
  }

  /**
   * Hires on this floor with the sheet's pictures. The office lets go of staged pictures whatever it
   * answers, so they are cleared here too: nothing is re-sent, a retry attaches them again.
   */
  async hire(request: Omit<HireRequest, 'images'>, token = this.token()): Promise<HostActionResult> {
    if (this.hiring) return { ok: false, error: IN_FLIGHT };
    const mine = {};
    this.hiring = mine;
    try {
      return await this.hireNow(request, token);
    } finally {
      if (this.hiring === mine) this.hiring = undefined;
    }
  }
  private hiring?: object;
  private async hireNow(request: Omit<HireRequest, 'images'>, token: ActionToken): Promise<HostActionResult> {
    const hire = this.state.hire;
    const images = request.kind === 'agent' && hire && this.valid(hire.token) ? hire.images.map((i) => i.id) : [];
    if (hire && request.kind !== 'agent') this.discardHire();
    const result = await this.request(hireMsg({ ...request, images }), token);
    // Whatever the office answered it let go of them; when unsure, asking it to forget them is harmless.
    if (images.length && this.state.hire === hire) {
      if (result.ok) this.set({ hire: undefined });
      else this.discardHire();
    }
    if (result.ok && result.workerId) this.openSoon(result.workerId, token);
    return result;
  }

  /** Why the draft can't go now, or undefined. */
  composeRefusal(w: WorkerInfo, text: string, queue: boolean): string | undefined {
    if (!this.ready()) return OFFLINE;
    if (!companionCapabilities(w).prompt) return w.guest ? 'A guest takes no prompts from the office.' : 'Its worktree is missing. Rebuild it or send it home.';
    if (w.status === 'needs_input') return 'Answer the current question, or open Raw TTY for this dialog.';
    if (this.isPicking(w.id)) return 'Wait for the pictures to finish attaching.';
    if (w.kind === 'agent') {
      const refused = slashRefusal(text, w.name, isBusy(w.status));
      if (refused) return refused;
      if (queue && slashOf(text)) return 'Slash commands can’t be queued.';
    }
    return undefined;
  }

  /**
   * Sends the floor's draft for `workerId`. With `queue` while a turn runs, Droid queues it behind the
   * turn and a receipt is kept until the conversation shows it. Returns an error, or undefined.
   */
  async submit(workerId: string, queue = false): Promise<string | undefined> {
    const w = this.worker(workerId);
    const floor = this.state.office.floor;
    if (!w || !floor) return OFFLINE;
    const draft = own(this.floorWorkspace().drafts, workerId) ?? { text: '', attachments: [] };
    const text = draft.text.trim();
    const queueSend = queue && w.kind === 'agent' && isBusy(w.status);
    const refused = this.composeRefusal(w, text, queueSend);
    if (refused) return refused;
    const key = sendKey(floor, workerId);
    // Checked before anything awaits: a double tap or Enter plus the button sends once.
    if (own(this.state.sending, key)) return IN_FLIGHT;
    if (!text && !draft.attachments.length) return undefined;
    const token = this.token();
    const receipts = this.feeds.queue(floor, workerId);
    const after = receipts.sequence;
    const mine = {};
    this.senders.set(key, mine);
    this.set({ sending: { ...this.state.sending, [key]: true } });
    const result = await this.request({ t: 'worker.prompt', workerId, prompt: text, images: draft.attachments, queue: queueSend }, token);
    if (this.senders.get(key) === mine) {
      this.senders.delete(key);
      const { [key]: _sent, ...sending } = this.state.sending;
      this.set({ sending });
    }
    if (!result.ok) return result.error ?? 'The office did not confirm this message. Check the thread before sending it again.';
    if (queueSend) receipts.sent(text, draft.attachments.length > 0, after, this.now());
    // Cleared on the floor it was written on, even after a floor change; a reconnect while it went
    // cleared every draft already, and one typed since is kept.
    const now = own(companionFloorWorkspace(this.state.workspace, floor).drafts, workerId);
    if (this.state.link.epoch === token.epoch && now && now.text.trim() === text && now.attachments.join() === draft.attachments.join()) this.dispatch({ type: 'draft', workerId, draft: { text: '', attachments: [] } }, floor);
    this.feeds.feed(workerId)?.latest();
    if (w.kind === 'agent' && slashOf(text)?.command?.kind === 'tty') this.view(workerId, 'terminal', floor);
    return undefined;
  }

  /** Esc, the CLI's own cancel; Thread panes hold the worker so it reaches its terminal. */
  stop(workerId: string): boolean {
    const w = this.worker(workerId);
    return !!w && this.send(stopMsg(w));
  }

  async answer(workerId: string, menu: Menu, value: { choice: number } | { text: string }): Promise<string | undefined> {
    const result = await this.request({ t: 'worker.answer', workerId, menu, ...value });
    return result.ok ? undefined : (result.error ?? 'The office did not confirm the answer. Look at the question before answering again.');
  }

  /** What waits in a worker's queue on this floor, as last computed outside render. */
  queuedFor(workerId: string): { views: readonly QueuedView[]; droid: boolean } {
    return this.queued.get(workerId) ?? { views: [], droid: false };
  }

  /** Matches queue receipts against each Thread pane's conversation and Droid's screen. True when it changed. */
  private refreshQueues(): boolean {
    const floor = this.state.office.floor;
    const next = new Map<string, { views: QueuedView[]; droid: boolean }>();
    if (floor) {
      for (const p of companionFloorWorkspace(this.state.workspace, floor).panes) {
        const w = own(this.state.office.workers, p.workerId);
        if (w?.kind !== 'agent') continue;
        const queue = this.feeds.queue(floor, w.id);
        const feed = this.feeds.feed(w.id);
        queue.sync(w.sessionId, feed?.history.entries ?? []);
        const screen = this.host.screen(w.id);
        const droid = screen ? readDroidQueue(screen) : undefined;
        next.set(w.id, { views: queue.shown(droid, this.now()), droid: !!droid?.length });
      }
    }
    const same = next.size === this.queued.size && [...next].every(([id, v]) => JSON.stringify(v) === JSON.stringify(this.queued.get(id)));
    if (!same) this.queued = next;
    return !same;
  }

  /** Asks what a worker's worktree holds; the answer arrives as `office.worktrees[id]`, never an older one. */
  inspectWorktree(workerId: string): boolean {
    if (!this.ready()) return false;
    const { [workerId]: _old, ...worktrees } = this.state.office.worktrees;
    this.set({ office: { ...this.state.office, worktrees } });
    return this.send({ t: 'worker.worktree', workerId });
  }

  // --- Thread paging ----------------------------------------------------------------------------------

  readEarlier(workerId: string): void {
    if (
      this.feeds.feed(workerId)?.earlier(
        this.now(),
        (msg) => this.send(msg),
        () => requestId('thread'),
      )
    )
      this.emit();
  }
  readLatest(workerId: string): void {
    this.feeds.feed(workerId)?.latest();
    this.tick();
    this.emit();
  }
  retryThread(workerId: string): void {
    this.feeds.feed(workerId)?.retry();
    this.tick();
    this.emit();
  }
  /** Clears Droid's own queue (Ctrl+X) while its screen shows one. */
  clearQueue(workerId: string): boolean {
    return this.send({ t: 'term.input', workerId, data: CLEAR_DROID_QUEUE });
  }
}
