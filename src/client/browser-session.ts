/** Origin-scoped browser authorization. No globals at import time; no credential in a page URL. */
export const BROWSER_KEY = 'droid-office.browser';
export const DASHBOARD_FLOOR_KEY = 'droid-office.dashboard-floor';

export interface BrowserCredential {
  token: string;
  device: { id: string; name: string };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function browserCredential(storage: StorageLike): BrowserCredential | undefined {
  try {
    const saved = JSON.parse(storage.getItem(BROWSER_KEY) ?? 'null');
    if (typeof saved?.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(saved.token) && typeof saved.device?.id === 'string' && typeof saved.device?.name === 'string') return saved;
  } catch {
    // Blocked or corrupt storage is not authentication.
  }
  return undefined;
}

export function saveBrowserCredential(storage: StorageLike, value: BrowserCredential): boolean {
  try {
    storage.setItem(BROWSER_KEY, JSON.stringify(value));
    return browserCredential(storage)?.token === value.token;
  } catch {
    return false;
  }
}

export function forgetBrowserCredential(storage: StorageLike): boolean {
  try {
    storage.removeItem(BROWSER_KEY);
    return !storage.getItem(BROWSER_KEY);
  } catch {
    return false;
  }
}

/** Drafts are namespaced by this origin's storage, floor and exact worker, never the selected row. */
export function draftKey(floor: string, worker: string): string {
  return `droid-office.dashboard-draft.${JSON.stringify([floor, worker])}`;
}
