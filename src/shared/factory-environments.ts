// Factory Environments: a reusable machine definition (a base image, repositories each with an
// install script, and a machine setup script) that Factory builds and validates once, so a Droid
// Computer started from it is ready in seconds. Read by src/server/factory/environments.ts; shown in
// the Computers window's Environments tab (client/ui/factory-environments.ts). An Environment is not
// a computer: a cloud worker hired on one gets a fresh unlisted computer of its own (an instance),
// which goes when the worker goes home.

export type EnvironmentStatus = 'building' | 'ready' | 'failed';
export type EnvironmentBuildStatus = 'queued' | 'building' | 'validating' | 'succeeded' | 'failed' | 'superseded';

export interface FactoryEnvRepo {
  url: string;
  /** Runs in the repository's clone at build time ('' for none). */
  script: string;
}

/** What an Environment is built on: Factory's default image, or another source its provider offers. */
export interface FactoryEnvSource {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  supportsRepositories: boolean;
  supportsSetupScripts: boolean;
  /** The source can't be built from any more. */
  unavailable?: boolean;
}

export interface FactoryEnvBuildRepo {
  url: string;
  name: string;
  branch: string;
  commit: string;
}

export interface FactoryEnvBuild {
  id: string;
  status: EnvironmentBuildStatus | string;
  /** What started it: create, edit, manual, scheduled or base-update. */
  trigger?: string;
  /** The commit each repository was built at. */
  repos: FactoryEnvBuildRepo[];
  failureReason?: string;
  failureCategory?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** When it became the build new computers start from. */
  promotedAt?: number;
}

export interface FactoryEnvironment {
  id: string;
  name: string;
  /** `user` (only its owner sees it) or `organization`. */
  scope: string;
  isDefault: boolean;
  status: EnvironmentStatus | string;
  /** As last saved: the next build uses these. */
  repositories: FactoryEnvRepo[];
  setupScript: string;
  /** As the build new computers start from has them, when Factory says. */
  activeRepositories?: FactoryEnvRepo[];
  source?: FactoryEnvSource;
  latestBuild?: FactoryEnvBuild;
  /** When a build last succeeded (ms): from then on computers can start from it. */
  lastSuccessfulBuildAt?: number;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

/** One build's log as Factory keeps it: the last few thousand characters, secrets masked. */
export interface FactoryEnvLog {
  buildId: string;
  status?: string;
  excerpt: string;
  /** Only the end of the log is there. */
  truncated: boolean;
  /** Factory held the log back. */
  withheld: boolean;
}

export interface FactoryEnvironmentsState {
  items: FactoryEnvironment[];
  /** The organization's default Environment. */
  defaultId?: string;
  /** What a new Environment can be built on (GET /environments/source-options). */
  sources: FactoryEnvSource[];
  fetchedAt: number;
  error?: string;
}

export function emptyEnvironments(): FactoryEnvironmentsState {
  return { items: [], sources: [], fetchedAt: 0 };
}

/** Factory's rule for an Environment's name: lower case, digits and hyphens, starting with a letter. */
export const ENV_NAME = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const ENV_NAME_MAX = 63;
export const ENV_SCRIPT_MAX = 10_000;
export const ENV_REPOS_MAX = 200;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined);

function reposOf(v: unknown): FactoryEnvRepo[] {
  return (Array.isArray(v) ? v : [])
    .map(obj)
    .filter((r): r is Record<string, unknown> => !!r && typeof r.url === 'string' && !!r.url)
    .map((r) => ({ url: String(r.url), script: typeof r.script === 'string' ? r.script : '' }));
}

export function sourceOf(raw: unknown, provider?: { id?: unknown; name?: unknown }): FactoryEnvSource | undefined {
  const r = obj(raw);
  if (!r || typeof r.id !== 'string') return undefined;
  const p = obj(r.provider) ?? provider ?? {};
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : r.id,
    providerId: typeof p.id === 'string' ? p.id : '',
    providerName: typeof p.name === 'string' ? p.name : '',
    supportsRepositories: r.supportsRepositories !== false,
    supportsSetupScripts: r.supportsSetupScripts !== false,
    ...(r.unavailable === true ? { unavailable: true } : {}),
  };
}

export function buildOf(raw: unknown): FactoryEnvBuild | undefined {
  const r = obj(raw);
  if (!r || typeof r.id !== 'string') return undefined;
  const repos = (Array.isArray(r.repositories) ? r.repositories : [])
    .map(obj)
    .filter((x): x is Record<string, unknown> => !!x && typeof x.url === 'string')
    .map((x) => ({ url: String(x.url), name: typeof x.name === 'string' ? x.name : '', branch: typeof x.defaultBranch === 'string' ? x.defaultBranch : '', commit: typeof x.commitSha === 'string' ? x.commitSha : '' }));
  return {
    id: r.id,
    status: typeof r.status === 'string' ? r.status : 'queued',
    ...(optStr(r.trigger) ? { trigger: optStr(r.trigger) } : {}),
    repos,
    ...(optStr(r.failureReason) ? { failureReason: optStr(r.failureReason) } : {}),
    ...(optStr(r.failureCategory) ? { failureCategory: optStr(r.failureCategory) } : {}),
    createdAt: num(r.createdAt),
    ...(optNum(r.startedAt) !== undefined ? { startedAt: optNum(r.startedAt) } : {}),
    ...(optNum(r.finishedAt) !== undefined ? { finishedAt: optNum(r.finishedAt) } : {}),
    ...(optNum(r.promotedAt) !== undefined ? { promotedAt: optNum(r.promotedAt) } : {}),
  };
}

/** An Environment from GET /environments, without its build log (the log route reads that). */
export function environmentOf(raw: unknown): FactoryEnvironment | undefined {
  const r = obj(raw);
  if (!r || typeof r.id !== 'string' || !r.id) return undefined;
  const source = sourceOf(r.source);
  const latestBuild = buildOf(r.latestBuild);
  const active = Array.isArray(r.activeRepositories) ? reposOf(r.activeRepositories) : undefined;
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : r.id,
    scope: typeof r.scope === 'string' ? r.scope : 'user',
    isDefault: r.isDefault === true,
    status: typeof r.status === 'string' ? r.status : 'building',
    repositories: reposOf(r.repositories),
    setupScript: typeof r.setupScript === 'string' ? r.setupScript : '',
    ...(active ? { activeRepositories: active } : {}),
    ...(source ? { source } : {}),
    ...(latestBuild ? { latestBuild } : {}),
    ...(optNum(r.lastSuccessfulBuildAt) !== undefined ? { lastSuccessfulBuildAt: optNum(r.lastSuccessfulBuildAt) } : {}),
    ...(optStr(r.failureReason) ? { failureReason: optStr(r.failureReason) } : {}),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  };
}

/** Every source from GET /environments/source-options, flattened out of its providers. */
export function sourcesOf(raw: unknown): FactoryEnvSource[] {
  const providers = Array.isArray(obj(raw)?.providers) ? (obj(raw)?.providers as unknown[]) : [];
  return providers.flatMap((p) => {
    const pr = obj(p);
    if (!pr) return [];
    return (Array.isArray(pr.sources) ? pr.sources : []).map((s) => sourceOf(s, pr)).filter((s): s is FactoryEnvSource => !!s);
  });
}

/** A build log from a build-diagnostics answer. */
export function logOf(raw: unknown): FactoryEnvLog | undefined {
  const r = obj(raw);
  if (!r || typeof r.buildId !== 'string') return undefined;
  return {
    buildId: r.buildId,
    ...(optStr(r.status) ? { status: optStr(r.status) } : {}),
    excerpt: typeof r.excerpt === 'string' ? r.excerpt : '',
    truncated: r.truncated === true,
    withheld: r.withheld === true,
  };
}

/** What an Environment is doing, as the window says it. */
export type EnvironmentPhase = 'queued' | 'building' | 'ready' | 'updating' | 'update-failed' | 'failed' | 'unavailable';

export const ENV_PHASE_WORD: Record<EnvironmentPhase, string> = {
  queued: 'Queued',
  building: 'Building',
  ready: 'Ready',
  updating: 'Updating',
  'update-failed': 'Update failed',
  failed: 'Failed',
  unavailable: 'Unavailable',
};

const IN_FLIGHT = new Set(['queued', 'building', 'validating']);

export const buildRunning = (b: Pick<FactoryEnvBuild, 'status'> | undefined) => !!b && IN_FLIGHT.has(b.status);

/**
 * Its phase. One that has built before keeps working while it builds again (updating) and after a
 * rebuild fails (update failed): computers start from its last good build.
 */
export function environmentPhase(e: Pick<FactoryEnvironment, 'status' | 'source' | 'latestBuild' | 'lastSuccessfulBuildAt'>): EnvironmentPhase {
  if (e.source?.unavailable) return 'unavailable';
  const b = e.latestBuild;
  const built = e.lastSuccessfulBuildAt !== undefined;
  if (buildRunning(b)) return built ? 'updating' : b?.status === 'queued' ? 'queued' : 'building';
  if (!built) return e.status === 'building' ? 'building' : 'failed';
  if (b?.status === 'failed') return 'update-failed';
  if (e.status === 'failed') return 'failed';
  return 'ready';
}

/** A computer can start from it: it has a good build and its source is still there. */
export const canStartFrom = (e: Pick<FactoryEnvironment, 'status' | 'source' | 'latestBuild' | 'lastSuccessfulBuildAt'>) => {
  const p = environmentPhase(e);
  return p === 'ready' || p === 'updating' || p === 'update-failed';
};

/** Its saved repositories or setup script differ from what its last good build used: the next build picks them up. */
export function unbuiltChanges(e: Pick<FactoryEnvironment, 'repositories' | 'activeRepositories'>): boolean {
  if (!e.activeRepositories) return false;
  const key = (rs: FactoryEnvRepo[]) => JSON.stringify(rs.map((r) => [r.url, r.script]).sort());
  return key(e.repositories) !== key(e.activeRepositories);
}

/**
 * The name of a cloud worker's own computer from an Environment: the Environment's name and 8 hex
 * digits, inside Factory's 63 characters. Factory names the ones its web app starts the same way.
 */
export function instanceName(envName: string, hex: string): string {
  const base = envName.slice(0, ENV_NAME_MAX - 9).replace(/-+$/, '') || 'env';
  return `${base}-${hex.slice(0, 8)}`;
}

/** The folder of `repo` (owner/name or a URL) among a computer's cloned repositories, else the only one there is. */
export function repoFolder(dirs: readonly string[] | undefined, repo: string | undefined): string | undefined {
  if (!dirs?.length) return undefined;
  const name = repo
    ?.replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.toLowerCase();
  const hit = name ? dirs.find((d) => d.replace(/\/+$/, '').split('/').pop()?.toLowerCase() === name) : undefined;
  return hit ?? (dirs.length === 1 ? dirs[0] : undefined);
}
