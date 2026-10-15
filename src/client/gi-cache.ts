import type { BakeStore, SavedBake } from './world/remaster';

/*
 * The two most recently used finished bounce-light bakes, kept in this browser's IndexedDB so the next launch loads one
 * instead of baking. Each is stored under its key, so switching between two lighting setups (SDR and HDR glow the
 * screens differently, so they bake differently) loads the other one back instead of baking it again. A third replaces
 * the one used longest ago, which bounds the storage at two atlases.
 */

const DB = 'droid-office-gi';
const STORE = 'bakes';
/** Where earlier builds kept their one bake. It is still loaded when its key matches, and dropped the next time any bake is used or saved. */
const LEGACY_RECORD = 'last';
/** The keys of the saved bakes, most recently used first. */
const INDEX = 'index';
export const KEEP_BAKES = 2;

/** The keys to keep once `key` is used, most recently used first, and the ones that no longer fit. */
export function touch(order: readonly string[], key: string, keep = KEEP_BAKES): { order: string[]; drop: string[] } {
  const next = [key, ...order.filter((k) => k !== key)];
  return { order: next.slice(0, keep), drop: next.slice(keep) };
}

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open (storage blocked) is tried again next time rather than remembered.
  db.catch(() => {
    db = null;
  });
  return db;
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Marks `key` as used (and stores `bake` under it), and drops what no longer fits, in one transaction. */
function remember(key: string, bake: SavedBake | null): Promise<void> {
  return open().then(
    (d) =>
      new Promise<void>((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const read = store.get(INDEX);
        read.onsuccess = () => {
          const order = Array.isArray(read.result) ? read.result.filter((k): k is string => typeof k === 'string') : [];
          const next = touch(order, key);
          if (bake) store.put(bake, key);
          store.put(next.order, INDEX);
          for (const k of next.drop) store.delete(k);
          store.delete(LEGACY_RECORD);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      }),
  );
}

function isBake(v: unknown): v is SavedBake {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return typeof b.key === 'string' && typeof b.width === 'number' && typeof b.height === 'number' && typeof b.depth === 'number' && b.data instanceof Float32Array;
}

/** Null without IndexedDB, and then every launch bakes. */
export const bakeCache: BakeStore | null =
  typeof indexedDB === 'undefined'
    ? null
    : {
        async load(key) {
          const saved: unknown = await request('readonly', (s) => s.get(key));
          if (isBake(saved) && saved.key === key) {
            void remember(key, null).catch(() => {});
            return saved;
          }
          const legacy: unknown = await request('readonly', (s) => s.get(LEGACY_RECORD));
          if (!isBake(legacy) || legacy.key !== key) return null;
          void remember(key, legacy).catch(() => {});
          return legacy;
        },
        async save(bake) {
          await remember(bake.key, bake);
        },
      };
