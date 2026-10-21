// The office's per-start LAN token, when this page was opened with ?t= (a device on the LAN,

// loopback has none and needs none. The office checks it once per connection (see server/lan.ts).

/** The LAN token this page carries, if any. */
let deviceToken = '';
let bootstrapToken: string | undefined;

/** The dashboard authenticates explicitly, without putting a persistent credential in its page URL. */
export function setBrowserAuth(device: string, bootstrap = '') {
  deviceToken = device;
  bootstrapToken = bootstrap;
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
  if (deviceToken) return `${path}${path.includes('?') ? '&' : '?'}d=${encodeURIComponent(deviceToken)}`;
  const t = lanToken();
  if (!t) return path;
  return `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}`;
}
