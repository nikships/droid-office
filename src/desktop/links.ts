/** What the app does with a link the office opens or navigates to. */
export type LinkAction = 'app' | 'browser' | 'ignore';

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
