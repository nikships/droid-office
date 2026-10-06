// The office's per-start LAN token, when this page was opened with ?t= (a device on the LAN,

// loopback has none and needs none. The office checks it once per connection (see server/lan.ts).

/** The LAN token this page carries, if any. */
export function lanToken(): string {
  if (typeof location === 'undefined') return '';
  return new URLSearchParams(location.search).get('t') ?? '';
}

/** `path` with this page's LAN token appended, when it has one. */
export function withToken(path: string): string {
  const t = lanToken();
  if (!t) return path;
  return `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}`;
}
