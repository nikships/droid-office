import {
  GUEST_AUDIT_ACTION_LABEL,
  GUEST_EXPIRY_CHOICES,
  GUEST_LABEL_MAX,
  GUEST_PRESET_INFO,
  type GuestAuditEntry,
  type GuestAuditTarget,
  type GuestExpiry,
  type GuestLinkCreate,
  type GuestLinkItem,
  type GuestLinksState,
  type GuestPreset,
  type GuestTargetFloor,
  type GuestTransportState,
  guestScope,
} from '../../shared/guest-links';

// The Share window's words and rules, kept free of the DOM so tests can load them. The window itself
// is guest-links.ts.

/** What `GET /api/guest-links` answers. */
export type ShareState = GuestLinksState;

export type Tone = 'info' | 'good' | 'warn' | 'bad';

/** The guest backend's state in words: what the toggle row says under itself. */
export interface TransportView {
  /** The short pill: Off, Starting, Live, Unavailable, Locked. */
  pill: string;
  tone: Tone;
  text: string;
  /** The public origin while serving. */
  origin?: string;
  fixUrl?: string;
}

export function transportView(on: boolean, t: GuestTransportState): TransportView {
  if (t.locked) return { pill: 'Locked', tone: 'warn', text: t.locked };
  if (!on || t.status === 'off') return { pill: 'Off', tone: 'info', text: 'External sharing is off. No share link opens, and nothing is published to the internet.' };
  if (t.status === 'starting') return { pill: 'Starting', tone: 'info', text: 'Publishing the guest address through Tailscale Funnel…' };
  if (t.status === 'serving')
    return {
      pill: 'Live',
      tone: 'good',
      text: 'Share links open from anywhere on the internet at this address. Each link only reaches what its permission allows.',
      ...(t.origin ? { origin: t.origin } : {}),
    };
  return {
    pill: 'Unavailable',
    tone: 'bad',
    text: t.reason ?? 'Tailscale Funnel isn’t available on this computer, so share links can’t open.',
    ...(t.fixUrl ? { fixUrl: t.fixUrl } : {}),
  };
}

/** Why the create form can't make a link right now, or undefined when it can. */
export function createBlocked(state: Pick<ShareState, 'on' | 'transport' | 'links' | 'max'>, now = Date.now()): string | undefined {
  if (state.transport.locked) return 'External sharing is locked for this office.';
  if (!state.on) return 'Turn on external sharing to create a share link.';
  if (state.transport.status === 'starting') return 'Wait for the guest address to finish publishing.';
  if (state.transport.status !== 'serving') return 'Share links can’t be created until Tailscale Funnel is available.';
  const active = state.links.filter((l) => !linkEnded(l, now)).length;
  if (active >= state.max) return `You have ${state.max} active share links, the most at once. Revoke one to create another.`;
  return undefined;
}

/** Whether a link no longer opens: revoked, or past its expiry by the server's word or this clock's. */
export function linkEnded(link: Pick<GuestLinkItem, 'status' | 'expiresAt'>, now = Date.now()): boolean {
  return link.status !== 'active' || (!!link.expiresAt && Date.parse(link.expiresAt) <= now);
}

/** A duration as the largest two units: `3d 4h`, `2h 5m`, `12m`, `40s`. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export interface ExpiryView {
  text: string;
  tone: Tone;
  ended: boolean;
}

/** A link's expiration status: until revoked, expires in …, expired or revoked. */
export function expiryView(link: Pick<GuestLinkItem, 'status' | 'expiresAt'>, now = Date.now()): ExpiryView {
  if (link.status === 'revoked') return { text: 'Revoked', tone: 'bad', ended: true };
  if (link.status === 'expired') return { text: 'Expired', tone: 'warn', ended: true };
  if (!link.expiresAt) return { text: 'Until revoked', tone: 'info', ended: false };
  const left = Date.parse(link.expiresAt) - now;
  if (left <= 0) return { text: 'Expired', tone: 'warn', ended: true };
  return { text: `Expires in ${countdown(left)}`, tone: left < 60 * 60 * 1000 ? 'warn' : 'info', ended: false };
}

/** How long until any expiry text changes: every second in the last minute, else at the next minute. */
export function tickDelay(links: Pick<GuestLinkItem, 'status' | 'expiresAt'>[], now = Date.now()): number | undefined {
  let soonest: number | undefined;
  for (const l of links) {
    if (l.status !== 'active' || !l.expiresAt) continue;
    const left = Date.parse(l.expiresAt) - now;
    if (left <= 0) continue;
    const step = left <= 60_000 ? left % 1000 || 1000 : left % 60_000 || 60_000;
    soonest = Math.min(soonest ?? step, step);
  }
  return soonest === undefined ? undefined : Math.max(250, soonest + 50);
}

/** What a link reaches: its preset, plus the floor or worker, or that the floor closed or the worker left. */
export function scopeText(link: Pick<GuestLinkItem, 'preset' | 'floorId' | 'floorName' | 'workerId' | 'workerName'>): string {
  const preset = GUEST_PRESET_INFO[link.preset].label;
  const scope = guestScope(link.preset);
  if (scope === 'office') return preset;
  const floor = link.floorName ?? 'floor closed';
  if (scope === 'floor') return `${preset} · ${floor}`;
  const worker = link.workerName ?? 'worker left';
  return `${preset} · ${worker}${link.floorName ? ` on ${link.floorName}` : ` (${floor})`}`;
}

/** Live guests on a link, or across all of them. */
export function guestCountText(n: number): string {
  return n === 0 ? 'No guests connected' : `${n} guest${n === 1 ? '' : 's'} connected`;
}

/** The create form as the owner filled it in. */
export interface ShareDraft {
  label: string;
  preset: GuestPreset | '';
  floorId: string;
  workerId: string;
  expiry: GuestExpiry;
}

export type DraftCheck = { ok: true; body: GuestLinkCreate } | { ok: false; field: 'label' | 'preset' | 'floor' | 'worker'; error: string };

/** Checks the create form against the floors and workers the office offers, and builds the request body. */
export function checkDraft(draft: ShareDraft, targets: GuestTargetFloor[]): DraftCheck {
  const label = draft.label.replace(/\s+/g, ' ').trim();
  if (!label) return { ok: false, field: 'label', error: 'Give the link a label, like who it’s for.' };
  if (label.length > GUEST_LABEL_MAX) return { ok: false, field: 'label', error: `Keep the label to ${GUEST_LABEL_MAX} characters.` };
  if (!draft.preset) return { ok: false, field: 'preset', error: 'Choose what the link lets someone see and do.' };
  const expiry = GUEST_EXPIRY_CHOICES.some((c) => c.id === draft.expiry) ? draft.expiry : 'never';
  const scope = guestScope(draft.preset);
  if (scope === 'office') return { ok: true, body: { label, preset: draft.preset, expiry } };
  const floor = targets.find((f) => f.id === draft.floorId);
  if (!floor) return { ok: false, field: 'floor', error: targets.length ? 'Choose a floor.' : 'No floor is open to share.' };
  if (scope === 'floor') return { ok: true, body: { label, preset: draft.preset, floorId: floor.id, expiry } };
  const worker = floor.workers.find((w) => w.id === draft.workerId);
  if (!worker) return { ok: false, field: 'worker', error: floor.workers.length ? 'Choose a worker.' : `No workers are on ${floor.name}.` };
  return { ok: true, body: { label, preset: draft.preset, floorId: floor.id, workerId: worker.id, expiry } };
}

/** The floor or worker or Mission Control an audited action touched, by name. */
export function auditTargetText(t: GuestAuditTarget): string {
  if (t.kind === 'missionControl') return 'Mission Control';
  const floor = t.floorName ?? t.floorId ?? 'a floor';
  if (t.kind === 'floor') return floor;
  return `${t.workerName ?? t.workerId ?? 'a worker'} on ${floor}`;
}

/** What an audited action was, with a coalesced burst's count. */
export function auditActionText(e: Pick<GuestAuditEntry, 'action' | 'count'>): string {
  const label = GUEST_AUDIT_ACTION_LABEL[e.action] ?? e.action;
  return e.count && e.count > 1 ? `${label} ×${e.count}` : label;
}

/** An older page appended under the entries shown, without repeats. */
export function appendAudit(shown: GuestAuditEntry[], page: GuestAuditEntry[]): GuestAuditEntry[] {
  const seen = new Set(shown.map((e) => e.id));
  return [...shown, ...page.filter((e) => !seen.has(e.id))];
}

/**
 * The newest page laid over the entries shown: new entries on top, a burst that grew replaced in place.
 * When the page doesn't reach anything shown, entries went unseen between them, so the list starts over
 * from the newest page (`reset`) and the caller takes that page's cursor.
 */
export function refreshAudit(shown: GuestAuditEntry[], newest: GuestAuditEntry[]): { entries: GuestAuditEntry[]; reset: boolean } {
  const fresh = new Set(newest.map((e) => e.id));
  const overlaps = shown.some((e) => fresh.has(e.id));
  if (!overlaps && shown.length && newest.length) return { entries: newest, reset: true };
  if (!shown.length) return { entries: newest, reset: true };
  return { entries: [...newest, ...shown.filter((e) => !fresh.has(e.id))], reset: false };
}
