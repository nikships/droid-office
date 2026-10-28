import { companionCapabilities } from '../shared/companion-roster';
import { type CompanionView, type CompanionWorkspace, createCompanionWorkspace, emptyFloorWorkspace, type FloorWorkspace, MAX_COMPANION_PANES, reduceCompanionWorkspace, type WorkspaceAction } from '../shared/companion-workspace';
import { PROMPT_IMAGES_MAX } from '../shared/drops';
import type { Menu } from '../shared/asks';
import { CLEAR_DROID_QUEUE } from '../shared/droid-queue';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../shared/protocol';
import { slashOf, slashRefusal } from '../shared/slash-commands';
import { isBusy } from '../shared/status';
import { linkStep } from '../client/worker-link';
import type { HostActionResult, HostIncoming, HostLink, HostMessageMeta, HostOffices, ManagementEvent, MobileHost } from './host';
import { dropToast, emptyOffice, expireToasts, type OfficeState, officeDisconnected, reduceOffice, withToast } from './office-state';
import { FeedPool, requestId } from './thread-feed';

/** What a delayed action was started under. Any change to it means the owner is looking at something else. */
export interface ActionToken {
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
}

export const STALE = 'The office changed before this was sent. Nothing was sent.';
export const OFFLINE = 'Disconnected. Nothing was sent.';
export const FLOOR_TIMEOUT_MS = 10_000;
export const LAYOUT_SAVE_MS = 400;

type FloorAction = WorkspaceAction extends infer A ? (A extends { floor: string } ? Omit<A, 'floor'> : never) : never;

const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
const sendKey = (floor: string, worker: string) => `${floor}\u0000${worker}`;

/** A persisted layout from native storage, checked field by field: never drafts, at most four distinct panes. */
export function restoreLayout(saved: unknown): CompanionWorkspace {
  const out = createCompanionWorkspace();
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  const floors = (saved as { floors?: unknown }).floors;
  if (!floors || typeof floors !== 'object' || Array.isArray(floors)) return out;
  for (const [id, value] of Object.entries(floors as Record<string, unknown>).slice(0, 200)) {
    if (!id || id.length > 200 || !value || typeof value !== 'object') continue;
    const floor = value as Partial<Record<keyof FloorWorkspace, unknown>>;
    const seen = new Set<string>();
    const panes = (Array.isArray(floor.panes) ? floor.panes : []).flatMap((p: unknown) => {
      if (!p || typeof p !== 'object') return [];
      const pane = p as { workerId?: unknown; view?: unknown; size?: unknown };
      if (typeof pane.workerId !== 'string' || !pane.workerId || pane.workerId.length > 200 || seen.has(pane.workerId) || seen.size >= MAX_COMPANION_PANES) return [];
      seen.add(pane.workerId);
      const view: CompanionView = pane.view === 'terminal' ? 'terminal' : 'thread';
      const size = typeof pane.size === 'number' && Number.isFinite(pane.size) ? Math.min(4, Math.max(0.25, pane.size)) : 1;
      return [{ workerId: pane.workerId, view, size }];
    });
    const active = typeof floor.active === 'string' && seen.has(floor.active) ? floor.active : (panes[0]?.workerId ?? '');
    const collapsed = (Array.isArray(floor.collapsed) ? floor.collapsed : []).filter((c: unknown): c is string => typeof c === 'string' && c.length <= 200).slice(0, 500);
    Object.defineProperty(out.floors, id, { value: { panes, active, drafts: {}, collapsed }, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

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
  readonly feeds = new FeedPool();
  /** The app is in the foreground. */
  visible = true;
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
    for (const fn of this.listeners) fn();
  }

  /** Subscribes first, then bootstraps, so no message falls between the snapshot and the stream. */
  async start(): Promise<void> {
    if (this.offs.length) return;
    // React may dispose and start again (StrictMode): an earlier run's bootstrap must not continue.
    const run = ++this.run;
    this.disposed = false;
    // Messages and link changes share one counter: whatever came before the bootstrap answered is
    // applied after it, in the order it happened.
    const early: ({ msg: ServerMsg; meta: HostMessageMeta } | { link: HostLink })[] = [];
    let booted = false;
    this.offs.push(
      this.host.onMessage((msg, meta) => (booted ? this.message(msg, meta) : early.push({ msg, meta }))),
      this.host.onLink((link) => (booted ? this.linked(link) : early.push({ link }))),
      this.host.onOffices((offices) => void this.officesChanged(offices)),
      this.host.onIncoming((incoming) => this.incoming(incoming)),
      this.host.onScreen(() => this.emit()),
      this.feeds.subscribe(() => this.emit()),
    );
    const boot = await this.host.bootstrap();
    if (run !== this.run) return;
    this.bootSeq = boot.seq;
    const workspace = boot.active ? restoreLayout(await this.host.layout.load(boot.active).catch(() => undefined)) : createCompanionWorkspace();
    if (run !== this.run) return;
    this.set({ started: true, offices: { offices: boot.offices, active: boot.active }, link: boot.link, workspace });
    for (const msg of boot.replay) this.message(msg, { seq: boot.seq, epoch: boot.link.epoch }, true);
    booted = true;
    const seqOf = (e: (typeof early)[number]) => ('link' in e ? e.link.seq : e.meta.seq);
    for (const e of early.sort((a, b) => seqOf(a) - seqOf(b))) {
      if (seqOf(e) <= boot.seq) continue;
      if ('link' in e) this.linked(e.link);
      else this.message(e.msg, e.meta);
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.sync();
  }

  dispose(): void {
    this.run++;
    this.disposed = true;
    this.bootSeq = -1;
    this.state = { ...this.state, started: false };
    clearInterval(this.timer);
    clearTimeout(this.floorTimer);
    clearTimeout(this.saveTimer);
    for (const off of this.offs.splice(0)) off();
    for (const release of this.holds.values()) release();
    this.holds.clear();
  }

  private emit(): void {
    this.state = { ...this.state };
    for (const fn of this.listeners) fn();
  }

  tick(): void {
    const s = this.state;
    this.feeds.tick(this.now(), { connected: this.ready(), visible: this.visible, focused: this.floorWorkspace().active || undefined, teamOpen: this.teamOpen }, (msg) => this.send(msg));
    const office = expireToasts(s.office, this.now());
    if (office !== s.office) this.set({ office });
  }

  // --- What the host says ---------------------------------------------------------------------------

  private message(msg: ServerMsg, meta: HostMessageMeta, replayed = false): void {
    if (!replayed && meta.seq <= this.bootSeq) return;
    // A message from a socket that has since closed describes an office nobody is looking at.
    if (meta.epoch !== this.state.link.epoch) return;
    const office = reduceOffice(this.state.office, msg);
    const next: Partial<SessionSnapshot> = { office };
    if (msg.t === 'welcome') {
      next.welcomedEpoch = meta.epoch;
      next.switching = undefined;
    }
    if (msg.t === 'floor.enter') next.switching = undefined;
    if (msg.t === 'welcome' || msg.t === 'floor.enter') clearTimeout(this.floorTimer);
    let workspace = this.state.workspace;
    if ((msg.t === 'welcome' || msg.t === 'floor.enter' || msg.t === 'worker.remove') && office.floor) {
      workspace = reduceCompanionWorkspace(workspace, { type: 'reconcile', floor: office.floor, workerIds: Object.keys(office.workers) });
      next.workspace = workspace;
    }
    this.set(next);
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
    this.set({ link, ...(link.epoch !== prev.epoch || link.phase !== 'connected' ? { office: officeDisconnected(this.state.office), switching: undefined } : {}) });
    this.sync();
  }

  /** An actual loss, not a floor switch: unsent text and pictures go on every floor; panes stay. */
  private connectionLost(): void {
    clearTimeout(this.floorTimer);
    this.feeds.disconnected();
    this.set({ workspace: reduceCompanionWorkspace(this.state.workspace, { type: 'disconnect' }), previews: {}, sending: {}, picking: {}, switching: undefined });
  }

  /** Another office: nothing of the last one is current, and its unsent drafts go with it. */
  private async officesChanged(offices: HostOffices): Promise<void> {
    const before = this.state.offices.active;
    if (offices.active === before) return this.set({ offices });
    this.flushLayout(before);
    this.set({ offices, office: emptyOffice(), welcomedEpoch: -1, workspace: { floors: {}, epoch: this.state.workspace.epoch + 1 }, previews: {}, sending: {}, picking: {}, switching: undefined, pendingOpen: undefined });
    this.sync();
    const loaded = offices.active ? restoreLayout(await this.host.layout.load(offices.active).catch(() => undefined)) : createCompanionWorkspace();
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
    return { epoch: this.state.link.epoch, floor: this.state.office.floor, arrival: this.state.office.arrival };
  }

  valid(t: ActionToken): boolean {
    const now = this.token();
    return this.ready() && t.epoch === now.epoch && t.floor === now.floor && t.arrival === now.arrival;
  }

  send(msg: ClientMsg): boolean {
    return this.ready() && this.host.send(msg);
  }

  /** A confirmed action, refused outright when the office moved on since `token`. */
  async request(msg: ClientMsg, token = this.token()): Promise<HostActionResult> {
    if (!this.ready()) return { ok: false, error: OFFLINE };
    if (!this.valid(token)) return { ok: false, error: STALE };
    return this.host.request({ ...msg, ...(token.floor ? { requestFloor: token.floor } : {}) });
  }

  toast(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.set({ office: withToast(this.state.office, text, level, this.now()) });
  }
  dismissToast(id: number): void {
    this.set({ office: dropToast(this.state.office, id) });
  }

  // --- Floors and panes -----------------------------------------------------------------------------

  /** Holds and feeds of the old floor go before `floor.go`; the new floor's panes come back on `floor.enter`. */
  goFloor(floor: string): boolean {
    if (!this.ready() || floor === this.state.office.floor) return false;
    this.set({ switching: floor });
    this.sync();
    if (!this.host.send({ t: 'floor.go', floor })) {
      this.set({ switching: undefined });
      this.sync();
      this.toast(OFFLINE, 'warn');
      return false;
    }
    clearTimeout(this.floorTimer);
    this.floorTimer = setTimeout(() => {
      if (this.state.switching !== floor) return;
      this.set({ switching: undefined });
      this.sync();
      this.toast('The office did not move you to that floor. Try again.', 'warn');
    }, FLOOR_TIMEOUT_MS);
    return true;
  }

  floorWorkspace(): FloorWorkspace {
    const floor = this.state.office.floor;
    return (floor && own(this.state.workspace.floors, floor)) || emptyFloorWorkspace();
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
    if (pin && !ws.panes.some((p) => p.workerId === workerId) && ws.panes.length >= MAX_COMPANION_PANES) {
      this.toast(`At most ${MAX_COMPANION_PANES} panes. Close one first.`, 'warn');
      return false;
    }
    this.dispatch({ type: 'open', workerId, pin: !this.phone && pin });
    return true;
  }
  close(workerId: string): void {
    this.dispatch({ type: 'close', workerId });
  }
  focus(workerId: string): void {
    this.dispatch({ type: 'focus', workerId });
  }
  view(workerId: string, view: CompanionView): void {
    this.dispatch({ type: 'view', workerId, view });
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
    if (this.ready()) this.host.forgetImage(floor, id);
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
    const want = new Set(this.ready() ? shown.map((w) => w.id) : []);
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
    if (!this.valid(token)) {
      for (const image of images) this.host.forgetImage(floor, image.id);
      return;
    }
    const draft = own(this.floorWorkspace().drafts, workerId) ?? { text: '', attachments: [] };
    const room = PROMPT_IMAGES_MAX - draft.attachments.length;
    const kept = images.slice(0, Math.max(0, room));
    for (const image of images.slice(kept.length)) this.host.forgetImage(floor, image.id);
    this.dispatch({ type: 'draft', workerId, draft: { text: draft.text, attachments: [...draft.attachments, ...kept.map((i) => i.id)] } });
    this.set({ previews: { ...this.state.previews, ...Object.fromEntries(kept.flatMap((i) => (i.preview ? [[i.id, i.preview]] : []))) } });
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
    if (!text && !draft.attachments.length) return undefined;
    const token = this.token();
    const key = sendKey(floor, workerId);
    const receipts = this.feeds.queue(floor, workerId);
    const after = receipts.sequence;
    this.set({ sending: { ...this.state.sending, [key]: true } });
    const result = await this.request({ t: 'worker.prompt', workerId, prompt: text, images: draft.attachments, queue: queueSend }, token);
    const { [key]: _sent, ...sending } = this.state.sending;
    this.set({ sending });
    if (!result.ok) return result.error ?? 'The office did not confirm this message. Check the thread before sending it again.';
    if (queueSend) receipts.sent(text, draft.attachments.length > 0, after, this.now());
    // Cleared on the floor it was written on, even after a floor change; a reconnect while it went
    // cleared every draft already, and one typed since is kept.
    const left = own(this.state.workspace.floors, floor);
    const now = left && own(left.drafts, workerId);
    if (this.state.link.epoch === token.epoch && now && now.text.trim() === text && now.attachments.join() === draft.attachments.join()) this.dispatch({ type: 'draft', workerId, draft: { text: '', attachments: [] } }, floor);
    this.feeds.feed(workerId)?.latest();
    if (w.kind === 'agent' && slashOf(text)?.command?.kind === 'tty') this.view(workerId, 'terminal');
    return undefined;
  }

  /** Esc, the CLI's own cancel; Thread panes hold the worker so it reaches its terminal. */
  stop(workerId: string): boolean {
    return this.send({ t: 'term.input', workerId, data: '\u001b' });
  }

  async answer(workerId: string, menu: Menu, value: { choice: number } | { text: string }): Promise<string | undefined> {
    const result = await this.request({ t: 'worker.answer', workerId, menu, ...value });
    return result.ok ? undefined : (result.error ?? 'The office did not confirm the answer. Look at the question before answering again.');
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
