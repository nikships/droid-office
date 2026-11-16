// A view's choices saved in this browser: one JSON object under one localStorage key, with every
// change told to whoever listens, in this tab and (through the `storage` event) in the others.

/** The values each choice can take; anything else saved for it falls back to its default. */
export type PrefOptions<T> = { [K in keyof T]: readonly T[K][] };

export interface SavedPrefs<T> {
  /** The saved choices, with anything unknown or invalid back at its value in `base` (the defaults). Accepts the parsed JSON as is, or a partial of it. */
  normalize(raw: unknown, base?: Readonly<T>): T;
  isDefault(prefs: T): boolean;
  /** The saved choices, else the defaults. */
  get(): T;
  /** Changes some of the choices. Anything invalid in `patch` is ignored. */
  set(patch: Partial<T>): void;
  reset(): void;
  /** Hears every change of the choices, from here or another tab; returns the unlisten. */
  on(fn: (prefs: T) => void): () => void;
}

export function savedPrefs<T extends object>(storageKey: string, defaults: Readonly<T>, options: PrefOptions<T>): SavedPrefs<T> {
  const keys = Object.keys(options) as (keyof T)[];
  const listeners = new Set<(prefs: T) => void>();
  let current: T | undefined;
  let watching = false;

  const normalize = (raw: unknown, base: Readonly<T> = defaults): T => {
    const src: Partial<Record<keyof T, unknown>> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const prefs = { ...base } as T;
    for (const key of keys) {
      const value = src[key];
      if ((options[key] as readonly unknown[]).includes(value)) prefs[key] = value as T[keyof T];
    }
    return prefs;
  };
  const same = (a: T, b: Readonly<T>) => keys.every((key) => a[key] === b[key]);
  const isDefault = (prefs: T) => same(prefs, defaults);

  const read = (): T => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) return normalize(JSON.parse(saved));
    } catch {
      // storage blocked or unreadable
    }
    return { ...defaults } as T;
  };
  const get = (): T => (current ??= read());
  const announce = (next: T) => {
    current = next;
    for (const fn of listeners) fn(next);
  };
  const save = (next: T) => {
    try {
      if (isDefault(next)) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // storage blocked
    }
    announce(next);
  };
  /** Another tab saved a change: apply it here too. */
  const watchStorage = () => {
    if (watching) return;
    watching = true;
    try {
      window.addEventListener('storage', (event) => {
        if (event.key !== null && event.key !== storageKey) return;
        const next = read();
        if (!current || !same(next, current)) announce(next);
      });
    } catch {
      // no window here
    }
  };

  return {
    normalize,
    isDefault,
    get,
    set(patch) {
      const next = normalize(patch, get());
      if (!same(next, get())) save(next);
    },
    reset() {
      if (!isDefault(get())) save({ ...defaults } as T);
    },
    on(fn) {
      watchStorage();
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
