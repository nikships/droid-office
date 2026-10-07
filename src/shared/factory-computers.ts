// Droid Computers: Factory's cloud (managed) computers and the owner's own (BYOM) ones, with each
// managed one's CPU, memory and disk now and over the last few hours. Read by
// src/server/factory/computers.ts; drawn on the compute wall (client/world/factory-computers.ts) and
// in the Computers window (client/ui/factory-computers.ts).

export type FactoryComputerStatus = 'provisioning' | 'active' | 'error';

export interface FactoryProvisioningStep {
  id: string;
  name: string;
  status: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface FactoryComputer {
  id: string;
  name: string;
  /** The provider behind it: `byom` (bring your own machine) or a managed one such as `e2b`. */
  providerType: string;
  /** Factory runs it (anything but BYOM). Only managed computers have metrics. */
  managed: boolean;
  status: FactoryComputerStatus | string;
  createdAt: number;
  remoteUser?: string;
  ownerId?: string;
  ownerPrincipalKind?: string;
  provisioningSteps?: FactoryProvisioningStep[];
  /** Where its repositories were cloned on it, when Factory says. */
  repos?: string[];
}

/** One 5-minute sample of a managed computer's load. */
export interface FactoryMetricSample {
  /** ms */
  at: number;
  cpuPct: number;
  cpuCount: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
}

/** A sample cut down for the slice: [at (ms), CPU %, memory %, disk %], the percents whole. */
export type FactoryMetricPoint = [at: number, cpu: number, mem: number, disk: number];

export interface FactoryComputerMetrics {
  /** The newest sample there is, however old; none for a computer that has been asleep all day. */
  latest?: FactoryMetricSample;
  /** The last METRICS_HOURS of samples, oldest first, for the sparklines. */
  history: FactoryMetricPoint[];
  fetchedAt: number;
  error?: string;
}

/** How many hours of samples each computer's history keeps. */
export const METRICS_HOURS = 6;
/** How far back the first metrics read of a computer looks, to find its last sample if it's asleep. */
export const METRICS_LOOKBACK_HOURS = 24;
/** A managed computer whose newest sample is older than this is asleep (Factory samples every 5 minutes). */
export const ASLEEP_AFTER_MS = 20 * 60_000;

export interface FactoryComputersState {
  items: FactoryComputer[];
  /** By computer id, managed computers only. */
  metrics: Record<string, FactoryComputerMetrics>;
  /** Who can make a new computer (GET /computers/providers), e.g. ['e2b']. */
  providers: string[];
  /** The BYOM computer that is the office's own machine (its name matches this machine's host name). */
  here?: string;
  /** Computers asked to wake (restart) and not yet back, with when (ms). */
  waking: Record<string, number>;
  /** The organization's computer secrets by name. Their values are write-only and never come back. */
  secrets: string[];
  secretsError?: string;
  /** When the list last came back (ms), 0 before it has. */
  fetchedAt: number;
  error?: string;
}

export function emptyComputers(): FactoryComputersState {
  return { items: [], metrics: {}, providers: [], waking: {}, secrets: [], fetchedAt: 0 };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A computer from GET /computers, keeping what the office shows (no relay URLs or keys). */
export function computerOf(raw: unknown): FactoryComputer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return undefined;
  const providerType = typeof r.providerType === 'string' ? r.providerType : '';
  const steps = Array.isArray(r.provisioningSteps)
    ? r.provisioningSteps
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string')
        .map((s) => ({
          id: String(s.id),
          name: typeof s.name === 'string' ? s.name : String(s.id),
          status: typeof s.status === 'string' ? s.status : '',
          ...(optStr(s.error) ? { error: optStr(s.error) } : {}),
          ...(optNum(s.startedAt) !== undefined ? { startedAt: optNum(s.startedAt) } : {}),
          ...(optNum(s.completedAt) !== undefined ? { completedAt: optNum(s.completedAt) } : {}),
        }))
    : undefined;
  const repos = Array.isArray(r.clonedRepoDirectories) ? r.clonedRepoDirectories.filter((d): d is string => typeof d === 'string' && !!d).slice(0, 50) : undefined;
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : r.id,
    providerType,
    managed: providerType !== 'byom',
    status: typeof r.status === 'string' ? r.status : 'active',
    createdAt: num(r.createdAt),
    ...(optStr(r.remoteUser) ? { remoteUser: optStr(r.remoteUser) } : {}),
    ...(optStr(r.ownerId) ? { ownerId: optStr(r.ownerId) } : {}),
    ...(optStr(r.ownerPrincipalKind) ? { ownerPrincipalKind: optStr(r.ownerPrincipalKind) } : {}),
    ...(steps ? { provisioningSteps: steps } : {}),
    ...(repos?.length ? { repos } : {}),
  };
}

/** A sample from GET /computers/{id}/metrics; undefined for one without a time. */
export function metricOf(raw: unknown): FactoryMetricSample | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  if (!Number.isFinite(at)) return undefined;
  return { at, cpuPct: num(r.cpuUsedPct), cpuCount: num(r.cpuCount), memUsed: num(r.memUsed), memTotal: num(r.memTotal), diskUsed: num(r.diskUsed), diskTotal: num(r.diskTotal) };
}

/** Every sample in an answer from GET /computers/{id}/metrics, oldest first. */
export function samplesOf(raw: unknown): FactoryMetricSample[] {
  return (Array.isArray(raw) ? raw : [])
    .map(metricOf)
    .filter((s): s is FactoryMetricSample => !!s)
    .sort((a, b) => a.at - b.at);
}

const pct = (used: number, total: number) => (total > 0 ? Math.round(Math.max(0, Math.min(100, (used / total) * 100))) : 0);

export const memPct = (s: FactoryMetricSample) => pct(s.memUsed, s.memTotal);
export const diskPct = (s: FactoryMetricSample) => pct(s.diskUsed, s.diskTotal);

export function pointOf(s: FactoryMetricSample): FactoryMetricPoint {
  return [s.at, Math.round(Math.max(0, Math.min(100, s.cpuPct))), memPct(s), diskPct(s)];
}

/**
 * A computer's metrics after a read: the samples it already had and the `fresh` ones, with the
 * newest as `latest` and the last METRICS_HOURS (before `now`) as its history.
 */
export function mergeMetrics(last: FactoryComputerMetrics | undefined, fresh: FactoryMetricSample[], now: number, hours = METRICS_HOURS): FactoryComputerMetrics {
  const since = now - hours * 3600_000;
  const byAt = new Map<number, FactoryMetricPoint>();
  for (const p of last?.history ?? []) if (p[0] >= since) byAt.set(p[0], p);
  for (const s of fresh) if (s.at >= since) byAt.set(s.at, pointOf(s));
  const history = [...byAt.values()].sort((a, b) => a[0] - b[0]);
  const newest = fresh.length ? fresh[fresh.length - 1] : undefined;
  const latest = newest && (!last?.latest || newest.at >= last.latest.at) ? newest : last?.latest;
  return { ...(latest ? { latest } : {}), history, fetchedAt: now };
}

/** What a computer is doing, as the wall and the window say it. */
export type ComputerPhase = 'provisioning' | 'active' | 'asleep' | 'waking' | 'error';

/**
 * Its phase: Factory's status, except that a managed computer that's active by Factory's lights
 * but has sent no sample for a while is asleep (Factory pauses idle ones), or waking once someone
 * asked it to.
 */
export function computerPhase(c: FactoryComputer, state: Pick<FactoryComputersState, 'metrics' | 'waking'>, now: number): ComputerPhase {
  if (c.status === 'provisioning') return 'provisioning';
  if (c.status === 'error') return 'error';
  if (state.waking[c.id] !== undefined) return 'waking';
  if (!c.managed) return 'active';
  const m = state.metrics[c.id];
  // Before its first metrics read, say nothing new.
  if (!m) return 'active';
  return m.latest && now - m.latest.at <= ASLEEP_AFTER_MS ? 'active' : 'asleep';
}

/** The provisioning step under way (or the one that failed), for "provisioning: Cloning repositories". */
export function currentStep(c: FactoryComputer): FactoryProvisioningStep | undefined {
  const steps = c.provisioningSteps ?? [];
  return steps.find((s) => s.status === 'failed' || s.status === 'error' || !!s.error) ?? steps.find((s) => s.status === 'in_progress' || s.status === 'running') ?? steps.find((s) => s.status !== 'completed');
}

/**
 * A host name the way Factory names a BYOM computer after its machine: lower case, no `.local`,
 * apostrophes dropped and anything else that isn't a letter or digit a single hyphen
 * ("Nikhil’s MacBook-Pro.local" → "nikhils-macbook-pro").
 */
export function hostKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(local|lan|home|localdomain)$/, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The BYOM computer among `items` that is this machine, by any of its `names`. */
export function hereOf(items: FactoryComputer[], names: string[]): string | undefined {
  const keys = new Set(names.map(hostKey).filter(Boolean));
  return items.find((c) => !c.managed && keys.has(hostKey(c.name)))?.id;
}

/** A computer name Factory takes for one: 1-63 characters. Bulk prefixes are stricter (see NAME_PREFIX). */
export const NAME_MAX = 63;
/**
 * The remote user a new managed computer gets when none is given: the droid CLI's default. Factory turns
 * down a create without one ("remoteUser is required when source is omitted"), though its OpenAPI lists
 * only `name` as required.
 */
export const DEFAULT_REMOTE_USER = 'factory-user';
/** A bulk create's name prefix: lower-case letters, digits and hyphens, starting with a letter. */
export const NAME_PREFIX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
export const BULK_MAX = 20;
/** A computer secret's name, as Factory takes it. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** A repository the new-computer form can pick from (GitHub repos Factory's app sees). */
export interface FactoryRepoChoice {
  fullName: string;
  url: string;
  isPrivate?: boolean;
}
