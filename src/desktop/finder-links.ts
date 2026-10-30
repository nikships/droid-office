import path from 'node:path';

export interface ThreadLink {
  lead: string;
  floor: string;
}

/** A protocol link carries identifiers only, never a URL, path, prompt or credential. */
export function parseThreadLink(raw: string): ThreadLink | undefined {
  if (raw.length > 2048 || /[\s\\]/.test(raw) || !/^droid-office:\/\/thread\/[^/?#]+\?floor=[^&#]+$/.test(raw)) return;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'droid-office:' || url.host !== 'thread' || url.username || url.password || url.hash) return;
    const params = [...url.searchParams];
    if (params.length !== 1 || params[0][0] !== 'floor') return;
    const lead = decodeURIComponent(url.pathname.slice(1));
    const floor = params[0][1];
    const id = /^[A-Za-z0-9_-]{1,128}$/;
    if (!id.test(lead) || !id.test(floor)) return;
    return { lead, floor };
  } catch {
    return;
  }
}

export function finderBridgeArgs(appPath: string, packaged: boolean, isolated: boolean): string[] {
  return packaged && !isolated ? ['--finder-bridge', path.join(appPath, 'native/mac/build/DroidOfficeFinderBridge.app/Contents/MacOS/DroidOfficeFinderBridge')] : [];
}

/** Only the companion itself may replace the trusted window. External web links go to a browser. */
export function companionNavigation(raw: string, officeUrl: string): 'allow' | 'external' | 'deny' {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return 'deny';
    if (url.origin === new URL(officeUrl).origin) return url.pathname === '/dashboard' && !url.search ? 'allow' : 'deny';
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? 'external' : 'deny';
  } catch {
    return 'deny';
  }
}
