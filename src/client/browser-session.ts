/** Origin-scoped browser authorization. No globals at import time; no credential in a page URL. */
export const BROWSER_KEY = 'droid-office.browser';
export const DASHBOARD_FLOOR_KEY = 'droid-office.dashboard-floor';
export const DASHBOARD_WORKSPACE_KEY = 'droid-office.dashboard-workspace';
const DRAFT_PREFIX = 'droid-office.dashboard-draft.';

export interface BrowserCredential {
  token: string;
  device: { id: string; name: string };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function isBrowserCredential(saved: unknown): saved is BrowserCredential {
  if (!saved || typeof saved !== 'object') return false;
  const value = saved as Partial<BrowserCredential>;
  return typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token) && typeof value.device?.id === 'string' && typeof value.device?.name === 'string';
}

export function browserCredential(storage: StorageLike): BrowserCredential | undefined {
  try {
    const saved = JSON.parse(storage.getItem(BROWSER_KEY) ?? 'null') as unknown;
    if (isBrowserCredential(saved)) return saved;
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
  return `${DRAFT_PREFIX}${JSON.stringify([floor, worker])}`;
}

/** Remove legacy persisted unsent drafts on connection loss, never submitted queue receipts. */
export function clearBrowserDrafts(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(DRAFT_PREFIX) && !key.endsWith(':queue-receipts')) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
