// The office's per-start LAN token, when this page was opened with ?t= (a device on the LAN,

// loopback has none and needs none. The office checks it once per connection (see server/lan.ts).
// A share link's page (dashboard-guest.ts) carries a guest token instead, and only that.

import { GUEST_QUERY_KEY } from '../shared/guest-links';

/** The LAN token this page carries, if any. */
let deviceToken = '';
let bootstrapToken: string | undefined;
let guestToken = '';

/** The dashboard authenticates explicitly, without putting a persistent credential in its page URL. */
export function setBrowserAuth(device: string, bootstrap = '') {
  deviceToken = device;
  bootstrapToken = bootstrap;
}

/** A share link's page: the guest token replaces every owner credential. */
export function setGuestAuth(token: string) {
  guestToken = token;
  deviceToken = '';
  bootstrapToken = '';
}

export function lanToken(): string {
  if (bootstrapToken !== undefined) return bootstrapToken;
  if (typeof location === 'undefined') return '';
  return new URLSearchParams(location.search).get('t') ?? '';
}

/** `path` with this page's LAN token appended, when it has one. */
export function withToken(path: string): string {
  // Never send an office credential to a card capability or another origin.
  if (!path.startsWith('/api/') || path.startsWith('//')) return path;
  // Embedded GETs (<img>, file previews) can't carry a header; fetch() drops this and sends a header (guestFetch).
  if (guestToken) return `${path}${path.includes('?') ? '&' : '?'}${GUEST_QUERY_KEY}=${encodeURIComponent(guestToken)}`;
  if (deviceToken) return `${path}${path.includes('?') ? '&' : '?'}d=${encodeURIComponent(deviceToken)}`;
  const t = lanToken();
  if (!t) return path;
  return `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}`;
}

/**
 * A guest page's request to its own office API, as fetch should send it: same origin, under `/api/`,
 * without the `?g=` that withToken adds for embedded GETs. Anything else isn't the office's, so it gets
 * no token at all (undefined).
 */
export function guestApiUrl(url: string, base: string): string | undefined {
  let u: URL;
  let origin: string;
  try {
    u = new URL(url, base);
    origin = new URL(base).origin;
  } catch {
    return undefined;
  }
  if (u.origin !== origin || !u.pathname.startsWith('/api/')) return undefined;
  u.searchParams.delete(GUEST_QUERY_KEY);
  return `${u.pathname}${u.search}`;
}

/**
 * Sends the guest token on every fetch to this office's API as `Authorization: Bearer`, never in the
 * request line. Installed once, by a share link's page. `may` says which office paths the link can use at
 * all; any other is answered here, as the guest backend would (404), without asking it.
 */
export function guestFetch(base: () => string, real: typeof fetch, may: (pathname: string) => boolean = () => true): typeof fetch {
  return (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const page = base();
    const path = guestTokenOn() ? guestApiUrl(raw, page) : undefined;
    if (path === undefined) return real(input, init);
    const target = new URL(path, page);
    if (!may(target.pathname)) return Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${guestToken}`);
    if (typeof input === 'object' && !(input instanceof URL)) return real(new Request(target.href, input), { ...init, headers });
    return real(target.href, { ...init, headers });
  };
}
/** Whether this page is a share link's. */
export const guestTokenOn = () => !!guestToken;
