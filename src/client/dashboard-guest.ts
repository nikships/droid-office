// The web companion opened from a share link (docs/guest-sharing.md): what the guest's link lets the page
// show and do, how its access check and socket closes read, and the shared-view badge. Pure, so tests load
// it without a page. The office enforces every boundary; this only keeps the page from offering what the
// office would refuse, or showing what its link doesn't cover.

import { GUEST_CLOSE_DISABLED, GUEST_CLOSE_ENDED, GUEST_FRAGMENT_KEY, GUEST_PRESET_INFO, GUEST_UNAVAILABLE_TEXT, guestTokenFromHash, isGuestPreset, type GuestSession, type GuestUnavailableReason } from '../shared/guest-links';

/** What the companion shows and offers. The owner's page has all of it. */
export interface CompanionAbilities {
  guest: boolean;
  /**
   * In-scope work on floor workers: prompts, terminal input and resizing, answering questions and
   * permission prompts, hire, interrupt, send home, fork, resume, rewind, queue, model and effort,
   * git and pull requests, and Whiteboard edits.
   */
  work: boolean;
  /** Mission Control is listed. */
  missionControl: boolean;
  /** The Orchestrator's composer, Stop and New conversation. */
  missionWork: boolean;
  /** Floor tabs and the floor switcher. */
  floorSwitch: boolean;
  /** Adding, reordering and removing floors. */
  floorAdmin: boolean;
  /** The all-workers directory and the building pulse. */
  building: boolean;
  /** The sidebar with the floor's workers. */
  roster: boolean;
  /** The floor's Whiteboard. */
  whiteboard: boolean;
  /** Settings, usage, Orchestrator settings, pairing, setup and update prompts: the owner's alone. */
  owner: boolean;
  /** The one worker a single-worker link shows, alone in one pane. */
  worker?: string;
  /** The one floor a floor or worker link covers. */
  floor?: string;
}

export const OWNER_ABILITIES: Readonly<CompanionAbilities> = {
  guest: false,
  work: true,
  missionControl: true,
  missionWork: true,
  floorSwitch: true,
  floorAdmin: true,
  building: true,
  roster: true,
  whiteboard: true,
  owner: true,
};

/** What a link's session lets its page show and do: the preset decides, never more than the session says. */
export function guestAbilities(session: GuestSession): CompanionAbilities {
  const info = GUEST_PRESET_INFO[session.preset];
  const write = info.write && session.write;
  const office = info.scope === 'office';
  const single = info.scope === 'worker';
  const mission = office && session.missionControl;
  return {
    guest: true,
    work: write,
    missionControl: mission,
    missionWork: mission && write,
    floorSwitch: office,
    floorAdmin: false,
    building: office,
    roster: !single,
    whiteboard: !single,
    owner: false,
    ...(single && session.workerId ? { worker: session.workerId } : {}),
    ...(!office && session.floorId ? { floor: session.floorId } : {}),
  };
}

/** A `GuestSession` from the office, or undefined when the body isn't one. */
export function parseGuestSession(value: unknown): GuestSession | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const s = value as Partial<GuestSession>;
  if (!isGuestPreset(s.preset)) return undefined;
  const info = GUEST_PRESET_INFO[s.preset];
  const id = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const floorId = id(s.floorId);
  const workerId = id(s.workerId);
  if (info.scope !== 'office' && !floorId) return undefined;
  if (info.scope === 'worker' && !workerId) return undefined;
  const expires = typeof s.expiresAt === 'string' && Number.isFinite(Date.parse(s.expiresAt)) ? s.expiresAt : undefined;
  return {
    preset: s.preset,
    write: info.write && s.write === true,
    scope: info.scope,
    ...(info.scope !== 'office' ? { floorId } : {}),
    ...(info.scope === 'worker' ? { workerId } : {}),
    missionControl: info.scope === 'office' && s.missionControl === true,
    ...(expires ? { expiresAt: expires } : {}),
  };
}

const REASONS: readonly GuestUnavailableReason[] = ['unavailable', 'expired', 'revoked', 'disabled'];
const isReason = (v: unknown): v is GuestUnavailableReason => typeof v === 'string' && (REASONS as readonly string[]).includes(v);

/** What `GET /api/guest/hello` said. */
export type GuestHelloOutcome =
  | { kind: 'ok'; session: GuestSession }
  /** The link opens nothing: say why and stop. */
  | { kind: 'refused'; reason: GuestUnavailableReason }
  /** Too many failed attempts from this address: wait, then ask again. */
  | { kind: 'throttled'; retryMs: number }
  /** The office (or the way to it) isn't answering: keep trying. */
  | { kind: 'offline' };

export const GUEST_THROTTLE_MIN_MS = 5_000;
export const GUEST_THROTTLE_MAX_MS = 60_000;

export function guestHelloOutcome(status: number, body: unknown, retryAfter?: string | null): GuestHelloOutcome {
  if (status === 429) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 10_000;
    return { kind: 'throttled', retryMs: Math.min(GUEST_THROTTLE_MAX_MS, Math.max(GUEST_THROTTLE_MIN_MS, ms)) };
  }
  const b = body && typeof body === 'object' ? (body as { ok?: unknown; reason?: unknown; session?: unknown }) : {};
  if (status === 200 && b.ok === true) {
    const session = parseGuestSession(b.session);
    return session ? { kind: 'ok', session } : { kind: 'offline' };
  }
  // Only the guest backend's own refusal ends a link; anything else on the way (a proxy, an office
  // half started) is treated as the office being out of reach, which retries by itself.
  if ((status === 401 || status === 403 || status === 410) && b.ok === false && isReason(b.reason)) return { kind: 'refused', reason: b.reason };
  return { kind: 'offline' };
}

/** What a closed guest socket means: the link ended (say why, stop), or the office went away (reconnect). */
export type GuestCloseOutcome = { kind: 'ended'; reason: GuestUnavailableReason } | { kind: 'reconnect' };

export function guestCloseOutcome(code: number, reason: string): GuestCloseOutcome {
  if (code === GUEST_CLOSE_DISABLED) return { kind: 'ended', reason: 'disabled' };
  if (code === GUEST_CLOSE_ENDED) return { kind: 'ended', reason: reason === 'expired' || reason === 'revoked' ? reason : 'unavailable' };
  // Anything else, including the owner-only 4401/4403, is checked again with hello before reconnecting.
  return { kind: 'reconnect' };
}

/** Whether a refusal ends the link for good, so this tab forgets its token. Sharing turned off can come back. */
export const guestRefusalFinal = (reason: GuestUnavailableReason): boolean => reason !== 'disabled';

export const GUEST_UNAVAILABLE_TITLE: Readonly<Record<GuestUnavailableReason, string>> = {
  unavailable: 'This link isn’t available',
  expired: 'This link has expired',
  revoked: 'This link was turned off',
  disabled: 'Sharing is turned off',
};

/** The status screen for a link that opens nothing. Nothing in it comes from the office or the address. */
export function guestUnavailableView(reason: GuestUnavailableReason): { title: string; text: string } {
  return { title: GUEST_UNAVAILABLE_TITLE[reason], text: GUEST_UNAVAILABLE_TEXT[reason] };
}

/**
 * Guest backend routes it opens only to write presets (server-runtime/guest-http.ts): a view-only page
 * never asks for them, so model badges and file links don't send requests the office would refuse.
 */
export const GUEST_WRITE_ONLY_PATHS: ReadonlySet<string> = new Set([
  '/api/agents/droid/models',
  '/api/agents/droid/commands',
  '/api/thread/file',
  '/api/thread/files',
  '/api/term/paths',
  '/api/term/file',
  '/api/term/drop',
  '/api/prompt/image',
  '/api/whiteboard/blob',
  '/api/gh/labels',
]);

export const guestMayFetch = (pathname: string, write: boolean): boolean => write || !GUEST_WRITE_ONLY_PATHS.has(pathname);

/** What a guest reads where the owner sees why the Orchestrator can't start: fixing that is the owner's setup, in Settings. */
export const GUEST_ORCHESTRATOR_BLOCKED = 'Not available right now';

/** Why the Orchestrator can't start, as this page may show it. */
export const orchestratorBlockedFor = (why: string | undefined, owner: boolean): string | undefined => (why && !owner ? GUEST_ORCHESTRATOR_BLOCKED : why);

/** Where this tab keeps its link's token, so a refresh still opens it. Per tab (sessionStorage), never localStorage. */
export const GUEST_TAB_KEY = 'droid-office.guest-link';

type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The guest token this page was opened with: from the address's `#g=` (kept for this tab), or the one
 * this tab kept before a refresh. A new `#g=` replaces the kept one.
 */
export function guestTokenAtBoot(hash: string, tab: TabStorage | undefined): string | undefined {
  const fromHash = guestTokenFromHash(hash);
  if (fromHash) {
    try {
      tab?.setItem(GUEST_TAB_KEY, fromHash);
    } catch {
      /* Blocked storage: this load still works, a refresh won't. */
    }
    return fromHash;
  }
  let kept: string | null | undefined;
  try {
    kept = tab?.getItem(GUEST_TAB_KEY);
  } catch {
    return undefined;
  }
  return kept ? guestTokenFromHash(`#${GUEST_FRAGMENT_KEY}=${kept}`) : undefined;
}

export function forgetGuestToken(tab: TabStorage | undefined) {
  try {
    tab?.removeItem(GUEST_TAB_KEY);
  } catch {
    /* blocked */
  }
}

/**
 * Set in this tab once a share link here has said anything about itself, so a refresh after the link ended
 * (its token forgotten) asks the guest backend again instead of the owner's routes it would 404.
 */
export const GUEST_ORIGIN_TAB_KEY = 'droid-office.guest-origin';

export function markGuestOrigin(tab: TabStorage | undefined) {
  try {
    tab?.setItem(GUEST_ORIGIN_TAB_KEY, '1');
  } catch {
    /* blocked: a refresh asks the owner's hello first, which the guest backend's 404 still leads back here */
  }
}

export function guestOriginMarked(tab: TabStorage | undefined): boolean {
  try {
    return tab?.getItem(GUEST_ORIGIN_TAB_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearGuestOrigin(tab: TabStorage | undefined) {
  try {
    tab?.removeItem(GUEST_ORIGIN_TAB_KEY);
  } catch {
    /* blocked */
  }
}

/** The guest backend answers every owner route 404, so an owner hello answered 404 may be a share link's origin. */
export const mayBeGuestOrigin = (ownerHelloStatus: number): boolean => ownerHelloStatus === 404;

/**
 * What a page holding no token learns from `GET /api/guest/hello` without one: the guest backend's own
 * refusal (this is a share link's origin, show its status screen), `offline` (nothing answered usefully,
 * ask again later) or `other` (some other server: this is not the guest backend).
 */
export function tokenlessGuestHello(status: number, body: unknown): GuestUnavailableReason | 'offline' | 'other' {
  const outcome = guestHelloOutcome(status, body);
  if (outcome.kind === 'refused') return outcome.reason;
  return status === 429 || status >= 500 ? 'offline' : 'other';
}

/** The address bar's hash without the token (other keys, such as a worker link, stay). */
export function hashWithoutGuestToken(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (!params.has(GUEST_FRAGMENT_KEY)) return hash;
  params.delete(GUEST_FRAGMENT_KEY);
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}

/** The shared-view badge: that this is a shared view, whether it can change anything, and when the link ends. */
export function guestBadge(session: GuestSession, format: (iso: string) => string = defaultExpiry): { label: string; mode: string; expires?: string; title: string } {
  const mode = session.write ? 'Can edit' : 'View only';
  const expires = session.expiresAt ? `Until ${format(session.expiresAt)}` : undefined;
  const scope = session.scope === 'worker' ? 'one worker' : session.scope === 'floor' ? 'one floor' : 'the office';
  return {
    label: 'Shared view',
    mode,
    ...(expires ? { expires } : {}),
    title: [`Shared view of ${scope}`, session.write ? 'you can work here' : 'view only', session.expiresAt ? `the link ends ${format(session.expiresAt)}` : 'the link lasts until it is turned off'].join(' · '),
  };
}

function defaultExpiry(iso: string): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}
