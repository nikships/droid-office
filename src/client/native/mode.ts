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

/**
 * Whether the page's text names the controls that do things: key letters, "press E", "(Q)",
 * "hold grip". The headset app's page (`/?native=1`) never does. As in Half-Life: Alyx, its world
 * and the controllers in your hands explain themselves; the Controls window, opened on purpose, is
 * the one place that lists them. Desktop and WebXR keep every hint.
 */
export function controlHintsShown(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  return !isNativeSearch(search);
}

/** `text`, followed by `hint` (the control that does it) wherever control hints are shown. */
export function withControlHint(text: string, hint: string): string {
  return controlHintsShown() ? text + hint : text;
}
