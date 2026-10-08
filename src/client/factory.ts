import type { FactoryFeatureId } from '../shared/factory';
import type { ServerMsg } from '../shared/protocol';
import type { Net } from './net';
import { store } from './state';
import { withToken } from './token';

// The browser's side of the Factory connection (docs/factory.md): the HTTP helper for a feature's
// routes, the watches that make a feature poll fast while its board or window is open, and the answer
// to connecting. FactoryState itself is store.factory (topic 'factory').

type SetupMsg = Extract<ServerMsg, { t: 'factory.setup' }>;

let net: Net | undefined;
const setupWaiters = new Set<(msg: SetupMsg) => void>();
/** How many boards and windows of this tab watch each feature. */
const watching = new Map<FactoryFeatureId, number>();

/** Main hands over the connection once: Factory messages and watches go through it. */
export function bindFactory(n: Net) {
  net = n;
  n.onMessage((msg) => {
    if (msg.t === 'factory.setup') for (const fn of setupWaiters) fn(msg);
  });
  // A new connection starts with no watches on the server: say again what's open.
  n.onStatus((up) => {
    if (!up) return;
    for (const [feature, count] of watching) if (count > 0) n.send({ t: 'factory.watch', feature, on: true });
  });
}

/** Hears the answer to factory.connect; returns the unlisten. */
export function onFactorySetup(fn: (msg: SetupMsg) => void): () => void {
  setupWaiters.add(fn);
  return () => setupWaiters.delete(fn);
}

/**
 * Says a board or window of `feature` is open, so it polls fast; call what it returns when it closes.
 * Several at once count as one watch; calling the stop twice does nothing.
 */
export function watchFactory(feature: FactoryFeatureId): () => void {
  const count = watching.get(feature) ?? 0;
  watching.set(feature, count + 1);
  if (count === 0) net?.send({ t: 'factory.watch', feature, on: true });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const left = (watching.get(feature) ?? 1) - 1;
    watching.set(feature, left);
    if (left === 0) net?.send({ t: 'factory.watch', feature, on: false });
  };
}

/** Asks for one feature (or, without one, the key and all of them) to be read again now. */
export function refreshFactory(feature?: FactoryFeatureId) {
  net?.send(feature ? { t: 'factory.refresh', feature } : { t: 'factory.refresh' });
}

export interface FactoryFetchInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as JSON. */
  body?: unknown;
}

/** What factoryFetch throws: the server's message, and its HTTP status (0 when the office didn't answer). */
export class FactoryFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * A feature's route, `/api/factory/<feature><path>`: JSON in and out. Throws a FactoryFetchError with
 * the server's message when it doesn't answer 2xx.
 */
export async function factoryFetch<T = unknown>(feature: FactoryFeatureId, path = '', init: FactoryFetchInit = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  const url = `/api/factory/${feature}${path && !path.startsWith('/') ? `/${path}` : path}${qs ? `?${qs}` : ''}`;
  let res: Response;
  try {
    res = await fetch(withToken(url), {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', 'x-droid-office-name': store.profile.name, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new FactoryFetchError('Couldn’t reach the office.', 0);
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) throw new FactoryFetchError(typeof body?.error === 'string' && body.error ? body.error : `HTTP ${res.status}`, res.status);
  return body as T;
}
