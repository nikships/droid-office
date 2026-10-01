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

/**
 * Whether characters wear floating billboards: the name pill over a head and the line under it,
 * the status bubble or task card over a worker, the bulb on its antenna, the "Ask me" pitch at a
 * board agent's kiosk and the farewell over a worker walking out. Desktop and WebXR keep them. The
 * headset app (`/?native=1`) floats no name, state, light or pitch over anyone, as in Half-Life:
 * Alyx: a worker wears no antenna, and its name, engine and state are printed on its seat's
 * nameplate (world/nameplate.ts), whose status lamp and the worker's body show how it's doing; a
 * teammate wears a name badge; and a board agent's pitch lights the screen in its kiosk's front
 * only once you greet it.
 */
export function floatingTagsShown(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  return !isNativeSearch(search);
}

/**
 * What a sign in the world says about a problem: all of `text` wherever control hints are shown.
 * In the headset app, only what is wrong: its first sentence, up to any dash, without asides in
 * parentheses ("This project has no GitHub remote yet.", not what to type to fix it). The whole
 * text stays in the window the sign belongs to.
 */
export function worldNotice(text: string): string {
  if (controlHintsShown()) return text;
  const first = text.split(/(?<=[.!?])\s|\s[—–]\s/, 1)[0] ?? text;
  return first.replace(/\s*\([^)]*\)/g, '').trim();
}
