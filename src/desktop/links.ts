/** What the app does with a link the office opens or navigates to. */
export type LinkAction = 'app' | 'browser' | 'ignore';

/**
 * What a page-opened window (`window.open`, `target=_blank`) turns into. It is never an Electron window: a child of the offscreen
 * page would inherit its shared-texture rendering and have nothing to show it, so it would paint invisibly and never release a texture.
 * Anything that leaves the office, and a same-origin link too (opening the office a second time in place would throw this one away),
 * goes to the browser.
 */
export function windowOpenAction(url: string, officeOrigin: string): 'browser' | 'ignore' {
  return linkAction(url, officeOrigin) === 'ignore' ? 'ignore' : 'browser';
}

/**
 * Pages of the office itself stay in the app; every other web page (an issue, a PR, a docs link)
 * and mail link opens in the default browser, as `target=_blank` does in one. Anything else
 * (file:, javascript:, custom schemes) is dropped.
 */
export function linkAction(url: string, officeOrigin: string): LinkAction {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'ignore';
  }
  if (u.origin === officeOrigin) return 'app';
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? 'browser' : 'ignore';
}
