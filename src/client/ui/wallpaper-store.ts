// The owner's own companion wallpaper: a picture from this computer, kept in this browser exactly as
// chosen (the original file, never shrunk or re-encoded), or a link to one. IndexedDB holds the file
// (localStorage can't hold a large photo); a BroadcastChannel tells this browser's other tabs.

export type CustomWallpaper = { kind: 'file'; blob: Blob; name: string } | { kind: 'url'; url: string };

const DB_NAME = 'droid-office-companion';
const STORE = 'wallpaper';
const KEY = 'custom';
const CHANNEL = 'droid-office.companion-wallpaper';

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null | undefined;
/** Bumped by every change asked for, so a picture still being checked never lands over a later choice. */
let latest = 0;

function bus(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => {
      for (const fn of listeners) fn();
    };
  } catch {
    channel = null;
  }
  return channel;
}

function announce() {
  for (const fn of listeners) fn();
  bus()?.postMessage('changed');
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
  } finally {
    db.close();
  }
}

/** Accepts http(s) links and inline image data; anything else (javascript:, file:) is refused. */
export function wallpaperUrlError(url: string): string | null {
  const value = url.trim();
  if (!value) return 'Paste a link to a picture.';
  if (/^data:image\//i.test(value)) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? null : 'Use an http or https link to a picture.';
  } catch {
    return 'That isn’t a link. Paste the picture’s full address, starting with https://.';
  }
}

export async function loadWallpaper(): Promise<CustomWallpaper | null> {
  try {
    const value = await run<unknown>('readonly', (s) => s.get(KEY));
    if (!value || typeof value !== 'object') return null;
    const w = value as Partial<{ kind: string; blob: unknown; name: unknown; url: unknown }>;
    if (w.kind === 'file' && w.blob instanceof Blob) return { kind: 'file', blob: w.blob, name: typeof w.name === 'string' ? w.name : 'Wallpaper' };
    if (w.kind === 'url' && typeof w.url === 'string' && !wallpaperUrlError(w.url)) return { kind: 'url', url: w.url };
  } catch {
    // storage blocked
  }
  return null;
}

/** Whether this browser can draw the picture at all (Chrome can't draw HEIC, for one). */
async function drawable(src: string): Promise<boolean> {
  const img = new Image();
  img.src = src;
  return img.decode().then(
    () => img.naturalWidth > 0 && img.naturalHeight > 0,
    () => false,
  );
}

/** Keeps `file` as the wallpaper, byte for byte. Rejects with a message when this browser can't show it. */
export async function saveWallpaperFile(file: File): Promise<void> {
  const mine = ++latest;
  const src = URL.createObjectURL(file);
  try {
    if (!(await drawable(src))) throw new Error(`This browser can’t show “${file.name}”. Try a JPEG, PNG, WebP or AVIF.`);
  } finally {
    URL.revokeObjectURL(src);
  }
  if (mine !== latest) return;
  await run('readwrite', (s) => s.put({ kind: 'file', blob: file, name: file.name }, KEY));
  announce();
}

export async function saveWallpaperUrl(url: string): Promise<void> {
  const error = wallpaperUrlError(url);
  if (error) throw new Error(error);
  const value = url.trim();
  const mine = ++latest;
  if (!(await drawable(value))) throw new Error('That link didn’t load as a picture. Check it opens in a new tab.');
  if (mine !== latest) return;
  await run('readwrite', (s) => s.put({ kind: 'url', url: value }, KEY));
  announce();
}

export async function clearWallpaper(): Promise<void> {
  latest++;
  await run('readwrite', (s) => s.delete(KEY));
  announce();
}

/** Hears every change of the wallpaper, from here or another tab; returns the unlisten. */
export function onWallpaper(fn: () => void): () => void {
  bus();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
