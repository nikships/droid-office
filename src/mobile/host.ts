import type { ComponentType } from 'react';
import type { ToolArgs, ToolId } from '../shared/companion-tools';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

/**
 * What the React Native app needs from the native Android layer. `src/mobile/native.ts` (owned by the
 * platform) implements this; the app only ever receives it as a value, so tests drive it with a fake.
 * Nothing here carries a token, a pairing secret, a file path or an arbitrary URL: the native side owns
 * the socket, TokenVault, CleartextGuard and route racing.
 */
export interface MobileHost {
  /**
   * Safe current state, including a warm start: an already connected socket sends no new `welcome`, so
   * `replay` carries it. The app subscribes to `onMessage` first, then calls this, applies `replay`, and
   * drops live messages with `seq <= bootstrap.seq`, so nothing is lost or applied twice.
   */
  bootstrap(): Promise<HostBootstrap>;
  /**
   * Every ServerMsg on the active office's socket, in order. `seq` grows by one per message for the life
   * of the native process; `epoch` is the socket it came on (see HostLink.epoch). Returns an unsubscribe.
   */
  onMessage(handler: (msg: ServerMsg, meta: HostMessageMeta) => void): () => void;
  /**
   * The socket's lifecycle. `epoch` grows on each newly opened socket, never on a floor change. A
   * `connected` link for epoch N arrives before any message of socket N.
   */
  onLink(handler: (link: HostLink) => void): () => void;
  /** Offices, the active office and native settings changed (pairing, forgetting, switching). */
  onOffices(handler: (offices: HostOffices) => void): () => void;
  /** A notification tap or deep link the app should follow (droidoffice://… already parsed natively). */
  onIncoming(handler: (incoming: HostIncoming) => void): () => void;
  /** Sends now, or returns false while down. Never queued, never replayed. */
  send(msg: ClientMsg): boolean;
  /**
   * A business action with a receipt: native adds `requestId`, keeps `requestFloor` as given, resolves
   * on `action.result`, and resolves `{ ok: false }` (uncertain, not replayed) when the socket drops or 60 s pass.
   */
  request(msg: ClientMsg): Promise<HostActionResult>;
  /**
   * Reference-counted worker attachment shared with native views (terminal, StayConnectedService):
   * native sends `worker.attach` on the first hold and `worker.detach` on the last release, and
   * re-attaches held workers after a reconnect. The returned function releases this hold once.
   */
  holdWorker(workerId: string): () => void;
  /** Constrained HTTP to the current office: `path` must be an allowlisted `/api/...` route. */
  http(request: HostHttpRequest): Promise<HostHttpResponse>;
  /**
   * Opens the system photo picker and uploads each picture to `/api/prompt/image` for `floor`.
   * Resolves with the uploaded ids (and a local preview URI the RN Image can show), or [] when cancelled.
   */
  pickImages(floor: string, max: number): Promise<HostImage[]>;
  /**
   * Forgets an uploaded but unsent picture (`DELETE /api/prompt/image`) on `office`, the paired office
   * it was uploaded to (the active one when omitted), even after the app switched to another office.
   */
  forgetImage(floor: string, id: string, office?: string): void;
  /**
   * Per-office storage for the workspace layout only (panes, views, sizes, collapsed leads): never
   * drafts or picture ids. Small JSON; native may drop it at any time.
   */
  layout: {
    load(office: string): Promise<unknown>;
    save(office: string, value: unknown): void;
  };
  /** Native screens kept as they are. */
  openPairing(): void;
  openOffices(): void;
  openSettings(): void;
  /** Switches the active office; the socket reconnects and `onLink`/`onMessage` follow the new one. */
  selectOffice(officeId: string): void;
  /** Light haptic tick, when the owner has haptics on. */
  haptic(kind: 'tick' | 'confirm' | 'reject'): void;
  views: {
    /**
     * The native raw terminal (xterm WebView + TerminalKeyboard). It takes its own worker hold while
     * mounted, and sends input or resize only while `active` and laid out at a non-zero size.
     */
    Terminal: ComponentType<{ workerId: string; active: boolean; style?: unknown }>;
    /**
     * The shared DOM management tools in the sealed local host, one tool at a time. Asks to open a
     * worker or change floor come back through `onEvent`, so the RN workspace stays the one that does it.
     */
    Management: ComponentType<{ tool: ToolId; floor: string; params?: ManagementParams; onEvent?: (event: ManagementEvent) => void; style?: unknown }>;
  };
  /** Screen rows as plain text, for asks and Droid's queue; undefined until the native mirror has a screen. */
  screen(workerId: string): readonly string[] | undefined;
  /** The screen of `workerId` changed (throttled natively). */
  onScreen(handler: (workerId: string) => void): () => void;
}

export interface HostBootstrap extends HostOffices {
  link: HostLink;
  /**
   * The authoritative messages of the current socket since its `welcome`, in order (that `welcome`
   * first, then floor.enter, floors, worker.update/remove, gh.pulls, subagents, subscriptions,
   * models.hidden, worker.worktree), compacted as native likes. Empty when no socket has welcomed yet.
   */
  replay: ServerMsg[];
  /** The `seq` of the newest message `replay` reflects. */
  seq: number;
  /**
   * A notification or link that started the app before it subscribed, handed over once. One that
   * arrives after the subscription goes through `onIncoming` instead, and is newer than this.
   */
  incoming?: HostIncoming;
}

export interface HostMessageMeta {
  seq: number;
  epoch: number;
}

export interface HostOffice {
  id: string;
  name: string;
  /** "Mac mini · LAN", for showing only. */
  where?: string;
}

export interface HostOffices {
  offices: HostOffice[];
  active?: string;
  /**
   * From the same counter as message `seq`, on an `onOffices` event: one with `seq <= bootstrap.seq`
   * is already reflected in the bootstrap. Without it, an event that came before the bootstrap answered
   * is taken as newer than it.
   */
  seq?: number;
}

export interface HostLink {
  phase: 'idle' | 'connecting' | 'connected' | 'offline' | 'unauthorized';
  /** Grows on every socket that opens. A submit started under one epoch is refused in another. */
  epoch: number;
  /**
   * Taken from the same counter as message `seq`, so the app orders link changes against messages and
   * the bootstrap: a link with `seq <= bootstrap.seq` is already reflected in `bootstrap.link`.
   */
  seq: number;
  office?: string;
  /** Why it is offline or unauthorized, in the office's words. */
  reason?: string;
}

/** `floor` on a worker link, when native knows it, takes the app to that floor first. */
export type HostIncoming = { kind: 'worker'; office: string; worker: string; floor?: string } | { kind: 'floor'; office: string; floor: string };

export interface HostActionResult {
  ok: boolean;
  error?: string;
  workerId?: string;
}

export interface HostHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  /** JSON-serialisable body, sent as application/json. */
  json?: unknown;
}

export interface HostHttpResponse {
  status: number;
  /** Parsed JSON when the response is JSON, else the text. */
  body: unknown;
}

/** What a management tool opens on: the shared ToolArgs. */
export type ManagementParams = ToolArgs;

export type ManagementEvent = { kind: 'open-worker'; workerId: string; view: 'thread' | 'tty' } | { kind: 'switch-floor'; floor: string } | { kind: 'close' };

export interface HostImage {
  id: string;
  name: string;
  preview?: string;
}
