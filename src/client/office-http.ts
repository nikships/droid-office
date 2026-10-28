import { withToken } from './token';

// How the shared windows reach the office over HTTP. In a page the office serves (the 3D office and
// the web companion), a request goes to the same origin with this page's credential. A sealed host
// (the Android management panel) has no address or credential of its own: it installs one that
// hands each request to its native side, which checks it against an allowlist and adds the device's.

export interface OfficeHttp {
  /** `path` is an office path (`/api/...`), never a full URL. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** What an <img>, link or download of `path` points at. */
  url(path: string): string;
}

const sameOrigin: OfficeHttp = {
  fetch: (path, init) => fetch(withToken(path), { credentials: 'same-origin', ...init }),
  url: withToken,
};

let http: OfficeHttp = sameOrigin;

/** Installs a sealed host's transport; null puts the page's own back. */
export function setOfficeHttp(next: OfficeHttp | null) {
  http = next ?? sameOrigin;
}

export function officeFetch(path: string, init?: RequestInit): Promise<Response> {
  return http.fetch(path, init);
}

export function officeUrl(path: string): string {
  return http.url(path);
}
