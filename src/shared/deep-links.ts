// Deep links into Droid Office for Android: a worker's live terminal, a floor, a Whiteboard card,
// or a pending AskUser question. Links come in two forms sharing one path and query shape:
//   - http(s)://<tailscale-or-lan-host>:<port>/open/<kind>/<id>?... (clickable in any chat app)
//   - droidoffice://open/<kind>/<id>?...[&u=<office-base>]           (direct Android custom scheme)
// Neither form ever carries a token or private office state; the paired Android app authenticates
// with its own Keystore-sealed device token over Wi-Fi or Tailscale.

import type { PairingAddress } from './devices.js';

export const DEEP_LINK_SCHEME = 'droidoffice';
export const DEEP_LINK_OPEN_PREFIX = '/open/';

export type DeepLinkTarget =
  | { kind: 'worker'; workerId: string; floorId?: string; view?: 'tty' | 'thread' }
  | { kind: 'floor'; floorId: string }
  | { kind: 'card'; cardId: string; floorId?: string }
  | { kind: 'question'; workerId: string; floorId?: string; questionId?: string };

export interface ParsedDeepLink {
  target: DeepLinkTarget;
  /** Normalized `http(s)://host[:port]` origin when present on the URL or in `?u=`. */
  officeBase?: string;
  /** Optional explicit paired-office id (`?office=`). */
  officeId?: string;
}

const ID_RE = /^[A-Za-z0-9_\-:.]{1,128}$/;
const ASK_COMPOSITE_RE = /^ask:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_\-:.]{1,64}):([0-9a-f]{12}|permission|terminal)$/;
const SHORT_HOSTS = new Set(['worker', 'floor', 'card', 'question', 'ask']);

const enc = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

function validId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && ID_RE.test(trimmed) ? trimmed : undefined;
}

/** `scheme://host[:port]` lower-cased without default ports, paths, queries or credentials. */
export function normalizeDeepLinkBase(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return undefined;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const host = url.hostname.toLowerCase();
  const defaultPort = scheme === 'http' ? '80' : '443';
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : '';
  return `${scheme}://${host}${port}`;
}

/**
 * Picks the best chat-clickable base URL for a phone reaching the office: Tailscale MagicDNS first
 * (works on cellular and Wi-Fi alike over the tailnet), then Tailscale IPv4, then Wi-Fi LAN.
 */
export function pickDeepLinkBase(addresses: readonly PairingAddress[]): string | undefined {
  for (const a of addresses) {
    if (a.kind === 'tailscale' && a.dns) {
      const base = normalizeDeepLinkBase(a.url);
      if (base) return base;
    }
  }
  for (const a of addresses) {
    if (a.kind === 'tailscale') {
      const base = normalizeDeepLinkBase(a.url);
      if (base) return base;
    }
  }
  for (const a of addresses) {
    if (a.kind === 'wifi') {
      const base = normalizeDeepLinkBase(a.url);
      if (base) return base;
    }
  }
  return undefined;
}

/** Relative `/open/<kind>/<id>?...` path and query shared by HTTP bounce links and `droidoffice://open/...`. */
export function deepLinkPathAndQuery(target: DeepLinkTarget, extra?: { base?: string; office?: string; stay?: boolean }): string {
  const params: string[] = [];
  const segKind: string = target.kind;
  let segId: string;
  switch (target.kind) {
    case 'worker':
      segId = target.workerId;
      if (target.floorId) params.push(`floor=${enc(target.floorId)}`);
      if (target.view === 'thread') params.push('view=thread');
      break;
    case 'floor':
      segId = target.floorId;
      break;
    case 'card':
      segId = target.cardId;
      if (target.floorId) params.push(`floor=${enc(target.floorId)}`);
      break;
    case 'question':
      segId = target.workerId;
      if (target.floorId) params.push(`floor=${enc(target.floorId)}`);
      if (target.questionId) params.push(`ask=${enc(target.questionId)}`);
      break;
  }
  const normalizedBase = normalizeDeepLinkBase(extra?.base);
  if (normalizedBase) params.push(`u=${enc(normalizedBase)}`);
  const office = validId(extra?.office);
  if (office) params.push(`office=${enc(office)}`);
  if (extra?.stay) params.push('stay=1');
  const query = params.length ? `?${params.join('&')}` : '';
  return `/open/${enc(segKind)}/${enc(segId)}${query}`;
}

/** Custom-scheme URI (`droidoffice://open/...`) handled directly by `MainActivity` on Android. */
export function appDeepLink(target: DeepLinkTarget, opts?: { base?: string; office?: string }): string {
  const pq = deepLinkPathAndQuery(target, opts);
  return `${DEEP_LINK_SCHEME}://${pq.slice(1)}`;
}

/** HTTP(S) Tailscale/LAN URL (`http(s)://<host>:<port>/open/...`) auto-linked by chat apps. */
export function webDeepLink(base: string, target: DeepLinkTarget): string {
  const origin = normalizeDeepLinkBase(base);
  if (!origin) return appDeepLink(target);
  return `${origin}${deepLinkPathAndQuery(target)}`;
}

/** Ready-made deep link for MCP results: HTTP(S) `/open/...` when reachable, else `droidoffice://open/...`. */
export function officeDeepLink(target: DeepLinkTarget, base?: string): string {
  const origin = normalizeDeepLinkBase(base);
  return origin ? webDeepLink(origin, target) : appDeepLink(target);
}

export function workerDeepLink(workerId: string, floorId?: string, base?: string): string {
  return officeDeepLink({ kind: 'worker', workerId, ...(floorId ? { floorId } : {}) }, base);
}

export function floorDeepLink(floorId: string, base?: string): string {
  return officeDeepLink({ kind: 'floor', floorId }, base);
}

export function cardDeepLink(cardId: string, floorId: string | undefined, base?: string): string {
  return officeDeepLink({ kind: 'card', cardId, ...(floorId ? { floorId } : {}) }, base);
}

export function questionDeepLink(workerId: string, floorId: string | undefined, questionId?: string, base?: string): string {
  return officeDeepLink({ kind: 'question', workerId, ...(floorId ? { floorId } : {}), ...(questionId ? { questionId } : {}) }, base);
}

/**
 * Android `intent://` URI used by `/open/...` on Android browsers: opens any installed Droid Office
 * build (`ai.factory.droidoffice` or `.debug`) and falls back to `fallbackUrl` when uninstalled.
 */
export function androidIntentDeepLink(target: DeepLinkTarget, opts: { base?: string; office?: string; fallbackUrl: string }): string {
  const pq = deepLinkPathAndQuery(target, { base: opts.base, office: opts.office });
  return `intent://${pq.slice(1)}#Intent;scheme=${DEEP_LINK_SCHEME};S.browser_fallback_url=${enc(opts.fallbackUrl)};end`;
}

function extractCandidates(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  const lower = text.toLowerCase();
  const prefixes = [`${DEEP_LINK_SCHEME}://`, 'https://', 'http://'];
  const starts = new Set<number>();
  for (const prefix of prefixes) {
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(prefix, from);
      if (idx < 0) break;
      starts.add(idx);
      from = idx + prefix.length;
    }
  }
  return [...starts]
    .sort((a, b) => a - b)
    .map((start) => {
      let end = text.length;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch) || ch === '"' || ch === "'" || ch === '<' || ch === '>') {
          end = i;
          break;
        }
      }
      return text.slice(start, end).replace(/[.,)\];]+$/, '');
    })
    .filter(Boolean);
}

function decodePart(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function parseSingleDeepLink(candidate: string): ParsedDeepLink | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  // Never treat a token-bearing join link or pairing URI as a navigation deep link.
  if (url.searchParams.has('t')) return undefined;

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  let segments: string[];
  let implicitBase: string | undefined;

  if (scheme === DEEP_LINK_SCHEME) {
    const host = url.hostname.toLowerCase();
    if (host === 'pair') return undefined;
    const pathParts = url.pathname.split('/').filter(Boolean).map(decodePart);
    if (pathParts.some((p) => p === undefined)) return undefined;
    const cleanParts = pathParts as string[];
    if (host === 'open') {
      segments = cleanParts;
    } else if (SHORT_HOSTS.has(host)) {
      segments = [host, ...cleanParts];
    } else {
      return undefined;
    }
  } else if (scheme === 'http' || scheme === 'https') {
    implicitBase = normalizeDeepLinkBase(url.origin);
    if (!implicitBase) return undefined;
    const pathParts = url.pathname.split('/').filter(Boolean).map(decodePart);
    if (pathParts.some((p) => p === undefined)) return undefined;
    const cleanParts = pathParts as string[];
    if (cleanParts[0]?.toLowerCase() !== 'open') return undefined;
    segments = cleanParts.slice(1);
  } else {
    return undefined;
  }

  if (segments.length !== 2) return undefined;
  const rawKind = segments[0].toLowerCase();
  const rawId = segments[1].trim();
  const floorParam = validId(url.searchParams.get('floor'));
  const askParam = validId(url.searchParams.get('ask'));
  const officeBase = normalizeDeepLinkBase(url.searchParams.get('u')) ?? implicitBase;
  const officeId = validId(url.searchParams.get('office'));

  let target: DeepLinkTarget | undefined;
  switch (rawKind) {
    case 'worker': {
      const workerId = validId(rawId);
      if (!workerId) return undefined;
      const viewParam = url.searchParams.get('view')?.toLowerCase();
      const view = viewParam === 'thread' ? 'thread' : viewParam === 'tty' ? 'tty' : undefined;
      target = { kind: 'worker', workerId, ...(floorParam ? { floorId: floorParam } : {}), ...(view ? { view } : {}) };
      break;
    }
    case 'floor': {
      const floorId = validId(rawId);
      if (!floorId) return undefined;
      target = { kind: 'floor', floorId };
      break;
    }
    case 'card': {
      const cardId = validId(rawId);
      if (!cardId) return undefined;
      target = { kind: 'card', cardId, ...(floorParam ? { floorId: floorParam } : {}) };
      break;
    }
    case 'question':
    case 'ask': {
      const composite = ASK_COMPOSITE_RE.exec(rawId);
      if (composite) {
        const [, askFloor, askWorker] = composite;
        target = {
          kind: 'question',
          workerId: askWorker,
          floorId: floorParam ?? askFloor,
          questionId: askParam ?? rawId,
        };
      } else {
        const workerId = validId(rawId);
        if (!workerId) return undefined;
        target = {
          kind: 'question',
          workerId,
          ...(floorParam ? { floorId: floorParam } : {}),
          ...(askParam ? { questionId: askParam } : {}),
        };
      }
      break;
    }
    default:
      return undefined;
  }

  return {
    target,
    ...(officeBase ? { officeBase } : {}),
    ...(officeId ? { officeId } : {}),
  };
}

/**
 * Parses a `droidoffice://open/...`, `droidoffice://<kind>/...`, or `http(s)://<host>/open/...` link.
 * Returns `undefined` for pairing invites (`droidoffice://pair`, `?t=` join links) and malformed input.
 */
export function parseDeepLink(raw: string): ParsedDeepLink | undefined {
  for (const candidate of extractCandidates(raw)) {
    const parsed = parseSingleDeepLink(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}
