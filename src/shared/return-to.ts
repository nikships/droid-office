// Where the sign-in page sends you once you're in: back to the page that sent you there (the office,
// or the office opened for a headset with `/?native=1`), never to another site.

/** The sign-in page's query parameter naming the page to come back to. */
export const RETURN_PARAM = 'next';

const MAX_LENGTH = 512;
/**
 * A same-origin path with its query and fragment, in printable ASCII only. Browsers strip tabs and
 * newlines from a URL and read a backslash as a slash, which turns `/\t/evil` or `/\evil` into a
 * `//evil` link to another host; neither can get past this.
 */
const SAFE_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/;
/** Pages that would send you straight back to sign in, or that aren't pages at all. */
const NOT_A_RETURN = /^\/(?:login|join|claim)(?:\.html)?(?:[/?#]|$)|^\/api(?:[/?#]|$)/;

/** `raw` if it is a path on this office that is safe to send someone back to, else `fallback`. */
export function safeReturnTo(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || raw.length > MAX_LENGTH || !SAFE_PATH.test(raw) || NOT_A_RETURN.test(raw)) return fallback;
  return raw;
}

/** The sign-in page, remembering `target` to come back to. The plain office needs no reminder. */
export function loginPath(target: string): string {
  const back = safeReturnTo(target, '/');
  return back === '/' ? '/login' : `/login?${RETURN_PARAM}=${encodeURIComponent(back)}`;
}
