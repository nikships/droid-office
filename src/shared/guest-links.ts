// External guest sharing ("Share" in the UI): an owner-made secret link that opens the web companion
// for someone outside the owner's tailnet, scoped by one of five presets. The office publishes a
// dedicated guest backend through Tailscale Funnel only while external sharing is on (see
// docs/guest-sharing.md and server/guest-links.ts). Pure types and helpers shared by server and client.
//
// HTTP API
// ========
// Owner routes answer only the office's own page on its own machine (the `/api/mobile/pairing` gate:
// loopback, same origin, no device or guest token). Anything else gets 403 `{ error }`. Bodies are JSON.
//
//   GET    /api/guest-links                  -> 200 GuestLinksState
//   PUT    /api/guest-links                  { on: boolean } -> 200 GuestLinksState
//                                            Off disconnects every guest at once and removes the Funnel mapping.
//   POST   /api/guest-links                  GuestLinkCreate -> 200 GuestLinkCreated (the URL is returned this once)
//                                            400 { error } bad label/preset/target/expiry
//                                            409 { error } sharing off, Funnel not serving, or GUEST_LINKS_MAX active links
//   DELETE /api/guest-links/<id>             -> 200 GuestLinksState (revoked: permanent, its guests disconnect at once)
//                                            404 { error } no such link
//   GET    /api/guest-links/audit?before=<cursor>&limit=<1..GUEST_AUDIT_PAGE_MAX>
//                                            -> 200 GuestAuditPage, newest first; pass `next` as `before` for older entries
//
// Guest routes exist only on the guest backend (the Funnel origin). Every request there is a guest:
// loopback trust, LAN tokens (`?t=`) and device tokens are refused, and guest tokens are refused on
// every other listener.
//
//   GET    /api/guest/hello                  -> 200 GuestHello
//                                            401 GuestRefusal { reason: 'unavailable' } missing/unknown token
//                                            410 GuestRefusal { reason: 'expired' | 'revoked' }
//                                            403 GuestRefusal { reason: 'disabled' } external sharing is off
//                                            429 GuestRefusal { reason: 'unavailable' } too many failed attempts (Retry-After)
//
// The same refusal shapes and status codes answer any other guest request whose token fails. Routes
// outside the guest allowlist answer 404 `{ error: 'Not found' }` whether or not they exist elsewhere.
// Read routes the companion needs (thread pictures and files, Whiteboard files and renders, changed
// pictures, docs) work for in-scope floors and workers; write routes (prompt pictures, terminal drops)
// only for write presets, in scope.
//
// Token presentation
// ==================
// The share URL is `<guest origin>/dashboard#g=<token>` (GUEST_FRAGMENT_KEY). The page reads the token
// from the fragment and removes it from the address bar, then sends it:
//   - on fetch():                 `Authorization: Bearer <token>`
//   - on embedded GETs (<img>):   `?g=<token>` (GUEST_QUERY_KEY), read-only routes only
//   - on the WebSocket upgrade:   `new WebSocket(url, guestWsProtocols(token))`. The server answers with
//                                 GUEST_WS_PROTOCOL and never echoes the token.
// A guest socket closed by the office uses GUEST_CLOSE_ENDED (close reason 'expired' or 'revoked') or
// GUEST_CLOSE_DISABLED ('disabled'). These do not collide with 4401 (device unpaired) or 4403
// (web companion off).

/** The five mutually exclusive permission presets. */
export type GuestPreset = 'view-office' | 'view-worker' | 'view-floor' | 'edit-floor' | 'edit-office';
export const GUEST_PRESETS: readonly GuestPreset[] = ['view-office', 'view-worker', 'view-floor', 'edit-floor', 'edit-office'];

/** What a preset is about: the whole office, one floor, or one worker on its floor. */
export type GuestScope = 'office' | 'floor' | 'worker';

export interface GuestPresetInfo {
  id: GuestPreset;
  label: string;
  description: string;
  scope: GuestScope;
  write: boolean;
}

export const GUEST_PRESET_INFO: Readonly<Record<GuestPreset, GuestPresetInfo>> = {
  'view-office': {
    id: 'view-office',
    label: 'View only (entire office)',
    description: 'Watch every open floor, worker, Whiteboard and Mission Control. No controls.',
    scope: 'office',
    write: false,
  },
  'view-worker': {
    id: 'view-worker',
    label: 'View only (single worker)',
    description: 'Watch one worker’s Thread, terminal and status. Nothing else in the office is visible.',
    scope: 'worker',
    write: false,
  },
  'view-floor': {
    id: 'view-floor',
    label: 'View only (single floor)',
    description: 'Watch one floor’s workers and Whiteboard. Other floors and Mission Control stay hidden.',
    scope: 'floor',
    write: false,
  },
  'edit-floor': {
    id: 'edit-floor',
    label: 'Single floor (full read & write)',
    description: 'Watch and work on one floor: prompts, terminals, questions, hiring, git and its Whiteboard.',
    scope: 'floor',
    write: true,
  },
  'edit-office': {
    id: 'edit-office',
    label: 'Complete access overall',
    description: 'Watch and work across every floor, Whiteboard and Mission Control. Settings and sharing stay yours.',
    scope: 'office',
    write: true,
  },
};

export function isGuestPreset(value: unknown): value is GuestPreset {
  return typeof value === 'string' && (GUEST_PRESETS as readonly string[]).includes(value);
}
/** Whether guests on this preset may change anything (always within scope). */
export const guestCanWrite = (preset: GuestPreset): boolean => GUEST_PRESET_INFO[preset].write;
/** Whether this preset spans every floor rather than one floor or worker. */
export const guestOfficeWide = (preset: GuestPreset): boolean => GUEST_PRESET_INFO[preset].scope === 'office';
/** Whether guests on this preset see Mission Control (and, with write, drive the Orchestrator). */
export const guestIncludesMissionControl = (preset: GuestPreset): boolean => guestOfficeWide(preset);
export const guestScope = (preset: GuestPreset): GuestScope => GUEST_PRESET_INFO[preset].scope;

/** How long a new link lasts. `never` lasts until revoked. */
export type GuestExpiry = 'never' | '1h' | '24h' | '7d';
export const GUEST_EXPIRY_CHOICES: readonly { id: GuestExpiry; label: string; ms?: number }[] = [
  { id: 'never', label: 'Until revoked' },
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
];
export function isGuestExpiry(value: unknown): value is GuestExpiry {
  return typeof value === 'string' && GUEST_EXPIRY_CHOICES.some((c) => c.id === value);
}
export function guestExpiryMs(expiry: GuestExpiry): number | undefined {
  return GUEST_EXPIRY_CHOICES.find((c) => c.id === expiry)?.ms;
}

/** The most links that can be active (not expired or revoked) at once. */
export const GUEST_LINKS_MAX = 32;
/** The longest link label. */
export const GUEST_LABEL_MAX = 64;
/** The longest audit detail text. */
export const GUEST_AUDIT_DETAIL_MAX = 200;
/** Audit entries per page at most. */
export const GUEST_AUDIT_PAGE_MAX = 100;

export type GuestLinkStatus = 'active' | 'expired' | 'revoked';

/** One link in the owner's Share list. Never carries the token or its hash. Times are ISO strings. */
export interface GuestLinkItem {
  id: string;
  label: string;
  preset: GuestPreset;
  /** The scoped floor (view-floor, edit-floor, view-worker). */
  floorId?: string;
  /** Its current name; absent when the floor is closed or gone (the link then exposes nothing else). */
  floorName?: string;
  /** The scoped worker (view-worker). */
  workerId?: string;
  /** Its current name; absent when the worker left. */
  workerName?: string;
  createdAt: string;
  /** Absent for links that last until revoked. */
  expiresAt?: string;
  revokedAt?: string;
  status: GuestLinkStatus;
  /** Guest connections open on this link right now. */
  guests: number;
}

/** The Funnel-published guest backend, shaped like TailnetHttpsState. */
export interface GuestTransportState {
  status: 'off' | 'starting' | 'serving' | 'unavailable';
  /** The public guest origin (`https://<machine>.<tailnet>.ts.net:<port>`) while serving. */
  origin?: string;
  /** Why it isn't serving, in words for the owner. */
  reason?: string;
  /** An admin console page that fixes the reason (enable HTTPS or Funnel for this machine). */
  fixUrl?: string;
  /** Set when the office was started with external sharing disabled. */
  locked?: string;
}

/** What `GET /api/guest-links` answers. Ended links stay listed for GUEST_ENDED_KEEP_MS. */
export interface GuestLinksState {
  /** The global external-sharing toggle (kill switch). Off by default. */
  on: boolean;
  transport: GuestTransportState;
  links: GuestLinkItem[];
  /** Every open guest connection across links. */
  guests: number;
  max: number;
}

/** How long expired and revoked links stay in the Share list before the office forgets them. */
export const GUEST_ENDED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** `POST /api/guest-links` body. */
export interface GuestLinkCreate {
  label: string;
  preset: GuestPreset;
  /** Required for view-floor, edit-floor and view-worker. */
  floorId?: string;
  /** Required for view-worker. */
  workerId?: string;
  expiry: GuestExpiry;
}

export interface GuestLinkCreated {
  link: GuestLinkItem;
  /** `<guest origin>/dashboard#g=<token>`. Shown once; the office keeps only the token's hash. */
  url: string;
  state: GuestLinksState;
}

/** What an audited guest action was. */
export type GuestAuditAction = 'prompt' | 'tty' | 'answer' | 'permission.approve' | 'permission.deny' | 'hire' | 'interrupt' | 'dismiss' | 'worker' | 'git' | 'whiteboard' | 'upload' | 'mission' | 'board';

export const GUEST_AUDIT_ACTION_LABEL: Readonly<Record<GuestAuditAction, string>> = {
  prompt: 'Prompt sent',
  tty: 'Terminal input',
  answer: 'Question answered',
  'permission.approve': 'Permission approved',
  'permission.deny': 'Permission denied',
  hire: 'Worker hired',
  interrupt: 'Worker interrupted',
  dismiss: 'Worker sent home',
  worker: 'Worker changed',
  git: 'Git or PR action',
  whiteboard: 'Whiteboard change',
  upload: 'File uploaded',
  mission: 'Mission Control',
  board: 'Board change',
};

export interface GuestAuditTarget {
  kind: 'floor' | 'worker' | 'missionControl';
  floorId?: string;
  floorName?: string;
  workerId?: string;
  workerName?: string;
}

/** One accepted guest mutation. The label is copied in so it survives revocation. */
export interface GuestAuditEntry {
  id: string;
  /** ISO time of the action (for a coalesced burst, its first keystroke). */
  at: string;
  linkId: string;
  linkLabel: string;
  preset: GuestPreset;
  target: GuestAuditTarget;
  action: GuestAuditAction;
  /** At most GUEST_AUDIT_DETAIL_MAX characters, one line. */
  detail?: string;
  /** For a coalesced burst: how many inputs it covers, and when the last one arrived. */
  count?: number;
  until?: string;
}

export interface GuestAuditPage {
  entries: GuestAuditEntry[];
  /** Cursor for the next (older) page; absent at the end. */
  next?: string;
}

/** Why a link opens nothing. The guest page shows each in plain words without internal details. */
export type GuestUnavailableReason = 'unavailable' | 'expired' | 'revoked' | 'disabled';
export const GUEST_UNAVAILABLE_TEXT: Readonly<Record<GuestUnavailableReason, string>> = {
  unavailable: 'This share link isn’t available. Ask the person who shared it for a new one.',
  expired: 'This share link has expired. Ask the person who shared it for a new one.',
  revoked: 'This share link was turned off by the person who shared it.',
  disabled: 'Sharing is turned off for this office right now.',
};

/** What the guest page knows about its own link. No token, no label, no hostnames. */
export interface GuestSession {
  preset: GuestPreset;
  write: boolean;
  scope: GuestScope;
  /** The scoped floor (floor and worker presets). */
  floorId?: string;
  /** The scoped worker (view-worker). */
  workerId?: string;
  missionControl: boolean;
  /** ISO time the link expires, if it does. */
  expiresAt?: string;
}

/** `GET /api/guest/hello` success body. */
export interface GuestHello {
  ok: true;
  session: GuestSession;
}

/** The body of every refused guest request. */
export interface GuestRefusal {
  ok: false;
  reason: GuestUnavailableReason;
  error: string;
}

/** The share URL's fragment key: `/dashboard#g=<token>`. */
export const GUEST_FRAGMENT_KEY = 'g';
/** Query key for embedded read-only GETs (<img src>) that cannot carry a header. */
export const GUEST_QUERY_KEY = 'g';
/** The WebSocket subprotocol a guest page offers first; the token follows as the second entry. */
export const GUEST_WS_PROTOCOL = 'droid-office-guest';
/** Close code: the link expired or was revoked (close reason says which). */
export const GUEST_CLOSE_ENDED = 4410;
/** Close code: the owner turned external sharing off. */
export const GUEST_CLOSE_DISABLED = 4411;

/** Protocols for `new WebSocket(url, protocols)` on a guest page. */
export function guestWsProtocols(token: string): string[] {
  return [GUEST_WS_PROTOCOL, token];
}

/** The share URL for a token at the guest origin. */
export function guestShareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/dashboard#${GUEST_FRAGMENT_KEY}=${token}`;
}

/** The guest token in a page's location hash (`#g=<token>`), if any. */
export function guestTokenFromHash(hash: string): string | undefined {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get(GUEST_FRAGMENT_KEY);
  return value && /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : undefined;
}

/** The session a link grants, as the guest page sees it. */
export function guestSessionOf(link: { preset: GuestPreset; floorId?: string; workerId?: string; expiresAt?: string }): GuestSession {
  const scope = guestScope(link.preset);
  return {
    preset: link.preset,
    write: guestCanWrite(link.preset),
    scope,
    ...(scope !== 'office' && link.floorId ? { floorId: link.floorId } : {}),
    ...(scope === 'worker' && link.workerId ? { workerId: link.workerId } : {}),
    missionControl: guestIncludesMissionControl(link.preset),
    ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}),
  };
}
