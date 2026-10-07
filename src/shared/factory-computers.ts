// Droid Computers: Factory's cloud (managed) computers and the owner's own (BYOM) ones, with the
// latest CPU, memory and disk of each managed one. Read by src/server/factory/computers.ts.

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

export interface FactoryComputerMetrics {
  /** The newest sample; none for a computer asleep since the window started. */
  latest?: FactoryMetricSample;
  /** The last samples, oldest first (at most METRICS_HISTORY). */
  history: FactoryMetricSample[];
  fetchedAt: number;
  error?: string;
}

/** How many samples each computer's history keeps: two hours of 5-minute samples. */
export const METRICS_HISTORY = 24;

export interface FactoryComputersState {
  items: FactoryComputer[];
  /** By computer id, managed computers only. */
  metrics: Record<string, FactoryComputerMetrics>;
  /** Who can make a new computer (GET /computers/providers), e.g. ['e2b']. */
  providers: string[];
  /** When the list last came back (ms), 0 before it has. */
  fetchedAt: number;
  error?: string;
}

export function emptyComputers(): FactoryComputersState {
  return { items: [], metrics: {}, providers: [], fetchedAt: 0 };
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

/** A computer's metrics from the samples, oldest first, cut to the last `keep`. */
export function metricsOf(raw: unknown, fetchedAt: number, keep = METRICS_HISTORY): FactoryComputerMetrics {
  const samples = (Array.isArray(raw) ? raw : [])
    .map(metricOf)
    .filter((s): s is FactoryMetricSample => !!s)
    .sort((a, b) => a.at - b.at);
  const history = keep > 0 ? samples.slice(-keep) : [];
  return { ...(history.length ? { latest: history[history.length - 1] } : {}), history, fetchedAt };
}
