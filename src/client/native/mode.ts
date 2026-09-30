/** The query parameter the headset app opens the office with: `/?native=1`. */
export const NATIVE_PARAM = 'native';

/** Whether a page's query (`location.search`) asks for the headset panel's presentation. */
export function isNativeSearch(search: string): boolean {
  return new URLSearchParams(search).get(NATIVE_PARAM) === '1';
}

/** Whether a same-origin path (`/?native=1#x`) asks for it. */
export function isNativePath(path: string): boolean {
  const noHash = path.split('#', 1)[0] ?? '';
  const q = noHash.indexOf('?');
  return q >= 0 && isNativeSearch(noHash.slice(q));
}
