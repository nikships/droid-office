import type { BakeStore, SavedBake } from './world/remaster';

/*
 * The last finished bounce-light bake, kept in this browser's IndexedDB so the next launch loads it instead of baking.
 * Only one is kept: a bake under other settings replaces it.
 */

const DB = 'droid-office-gi';
const STORE = 'bakes';
const RECORD = 'last';

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
          const saved: unknown = await request('readonly', (s) => s.get(RECORD));
          return isBake(saved) && saved.key === key ? saved : null;
        },
        async save(bake) {
          await request('readwrite', (s) => s.put(bake, RECORD));
        },
      };
