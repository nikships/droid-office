import type { GhPull, TodoProgress, WorkerInfo, WorkerStatus } from '../shared/protocol.js';
import type { PipelinesState, PipelineRun, RunState } from '../shared/pipelines.js';
import { USAGE_STALE_MS, availabilityWords, cannotRun, durationWords, isSubscriptionModel, isSubscriptionProvider, providerName, type ModelAvailability, type ModelUsage, type SubscriptionProviderKey } from '../shared/subscriptions.js';
import { todoCount, type TodoItem } from '../shared/todos.js';
import type { TeamModel, WorkerResult, WorkerReview } from './team.js';
import type { FactoryState } from '../shared/factory.js';
import { factoryLimitsActive, factoryModelAvailability, factoryModelTier, factoryOverageWords, factoryWindows, type FactoryLimitsState } from '../shared/factory-limits.js';

const AT_REST = /\? for help/;
const BOX_TOP = /^\s*╭─+╮\s*$/;
const BOX_BOTTOM = /^\s*╰─+╯\s*$/;
const BOX_ROW = /^\s*│.*│\s*$/;
const BUSY_SPINNER = /Press ESC to stop/i;
const RETRY_LINE = /Retrying the model request(?:\s*\(attempt\s*(\d+)(?:\s*(?:\/|of)\s*(\d+))?\))?[^\r\n]*/i;
const MODEL_ERROR_PATTERNS: readonly RegExp[] = [
  /Usage is exhausted for the model request\.?/i,
  /The model provider rate limited (?:the request|my requests)\.?/i,
  /All credentials for model [^\r\n]+? are cooling down[^\r\n]*/i,
  /\bmodel_cooldown\b[^\r\n]*/i,
  /\busage_limit_reached\b[^\r\n]*/i,
  /(?:\b402\b[^\r\n]*(?:exhaust|usage|quota|subscription)|(?:usage|quota|subscription)[^\r\n]*\b402\b)/i,
];

export interface WorkerToolSpan {
  name: string;
  summary: string;
  at: number;
}

export interface WorkerRuntimeSnapshot {
  todoSteps?: TodoItem[];
  currentTool?: WorkerToolSpan;
  lastTool?: WorkerToolSpan;
  lastHookAt?: number;
  lastOutputAt?: number;
  queuedMessages?: string[];
  queuedNotices?: number;
  screenRows?: string[];
}

export interface WorkerRetryStatus {
  retrying: boolean;
  attempt?: number;
  maxAttempts?: number;
  detail: string;
}

export interface WorkerQuotaWindow {
  name: string;
  leftPercent: number;
  resetsAt: string | null;
  resetsIn?: string;
}

export interface WorkerModelCooldown {
  state: 'ok' | 'cooldown' | 'retrying' | 'rate_limited' | 'signed-out' | 'disabled' | 'proxy-down' | 'unavailable';
  model: string;
  provider?: string;
  providerName?: string;
  window?: string;
  resetsAt?: string | null;
  remainingMs?: number;
  resetsIn?: string;
  summary: string;
  windows?: WorkerQuotaWindow[];
  overageHint?: string;
}

export interface WorkerPullStatus {
  number: number;
  url: string;
  state: 'open' | 'draft' | 'merged' | 'closed' | 'unknown';
  checks: GhPull['checks'];
  title?: string;
  headSha?: string;
  baseBranch?: string;
}

export interface WorkerRunStatus {
  id: number;
  number: number;
  workflow: string;
  state: RunState;
  status: string;
  event: string;
  branch: string;
  sha: string;
  url: string;
  jobs?: { done: number; total: number; current?: string; failed: number };
}

export interface WorkerForgeStatus {
  pr?: WorkerPullStatus;
  ci?: WorkerRunStatus;
  releaseRun?: WorkerRunStatus;
}

export interface WorkerPlanStatus extends TodoProgress {
  steps?: TodoItem[];
}

export interface WorkerLastReport {
  kind: 'report' | 'question' | 'progress';
  at: string;
  summary: string;
  status?: WorkerResult['status'];
  review?: { verdict: WorkerReview['verdict']; by: string; notes: string };
}

export interface WorkerTaskLabel {
  source: 'generated' | 'lead' | 'prompt';
  generated: boolean;
  updatedAt?: string;
  stale?: true;
}

export interface WorkerInspection {
  id: string;
  name: string;
  status: WorkerStatus;
  state: WorkerStatus | 'blocked_on_question';
  model?: string;
  effort?: string;
  task?: string;
  taskLabel?: WorkerTaskLabel;
  doing?: string;
  plan?: WorkerPlanStatus;
  currentTool?: { name: string; summary: string; startedAt: string; runningForMs: number };
  lastTool?: { name: string; summary: string; at: string; agoMs: number };
  lastActivityAt?: string;
  silentForMs?: number;
  lastOutputAt?: string;
  queued?: { terminal: number; notices: number; messages?: string[] };
  retryingModel?: { attempt?: number; maxAttempts?: number; detail: string };
  modelError?: string;
  modelStatus?: WorkerModelCooldown;
  lastReport?: WorkerLastReport;
  pr?: WorkerPullStatus;
  ci?: WorkerRunStatus;
  releaseRun?: WorkerRunStatus;
}

export interface ProviderQuotaSummary {
  provider: string;
  name: string;
  state: 'ok' | 'cooldown' | 'unavailable' | 'unknown';
  accounts?: number;
  windows: WorkerQuotaWindow[];
  cooldownUntil?: string | null;
  cooldownIn?: string;
  cooldownWindow?: string;
  reason?: string;
  unreadable?: string;
  staleAge?: string;
  runnableModels: number;
  totalModels: number;
  overagePreference?: FactoryLimitsState['overagePreference'];
  extraUsageBalanceCents?: number;
  extraUsageAllowed?: boolean;
  overageHint?: string;
}

export interface FactoryModelUsage {
  tier: 'standard' | 'core';
  windows: WorkerQuotaWindow[];
  overagePreference: FactoryLimitsState['overagePreference'];
  extraUsageBalanceCents: number;
  extraUsageAllowed: boolean;
  overageHint: string;
}

export function factoryModelUsage(factory: FactoryState | undefined, model: { id: string; custom?: boolean; displayName?: string }, now: number): FactoryModelUsage | undefined {
  const tier = factoryModelTier(model);
  if (!factory?.connection.connected || factory.connection.rejected || !tier || !factoryLimitsActive(factory.limits)) return undefined;
  return {
    tier,
    windows: factoryWindows(factory.limits, tier).map((w) => ({
      name: w.name,
      leftPercent: Math.max(0, Math.min(100, Math.round(100 - w.usedPercent))),
      resetsAt: w.resetsAt === null ? null : iso(w.resetsAt),
      ...(w.resetsAt !== null && w.resetsAt > now ? { resetsIn: durationWords(w.resetsAt - now) } : {}),
    })),
    overagePreference: factory.limits.overagePreference,
    extraUsageBalanceCents: factory.limits.extraUsageBalanceCents,
    extraUsageAllowed: factory.limits.extraUsageAllowed,
    overageHint: factoryOverageWords(factory.limits),
  };
}

export function factoryUsageWords(usage: FactoryModelUsage): string {
  return `Factory ${usage.tier === 'core' ? 'Droid Core' : 'Standard'}: ${usage.windows.map((w) => `${w.name} ${w.leftPercent}% left${w.resetsIn ? ` (resets in ${w.resetsIn} at ${w.resetsAt})` : w.resetsAt ? ` (reset due since ${w.resetsAt})` : ' (window not started)'}`).join(', ')} · ${usage.overageHint}`;
}

/** Factory tiers remain visible even when the owner's model allowlist has no models in one tier. */
export function summarizeFactoryQuotas(factory: FactoryState | undefined, models: readonly TeamModel[], now: number): ProviderQuotaSummary[] {
  if (!factory?.connection.connected || factory.connection.rejected || !factoryLimitsActive(factory.limits)) return [];
  return (['standard', 'core'] as const).map((tier) => {
    const descriptor = { id: tier === 'core' ? 'glm-5.3-flash' : 'auto' };
    const usage = factoryModelUsage(factory, descriptor, now)!;
    const availability = factoryModelAvailability(factory, descriptor, now);
    const list = models.filter((m) => factoryModelTier(m) === tier);
    const until = availability?.until;
    return {
      provider: `factory-${tier}`,
      name: tier === 'core' ? 'Factory Droid Core' : 'Factory Standard',
      state: availability?.state === 'exhausted' ? 'cooldown' : availability?.state === 'unavailable' ? 'unavailable' : factory.limits.error ? 'unknown' : 'ok',
      windows: usage.windows,
      ...(availability?.state === 'exhausted'
        ? { cooldownUntil: until === null || until === undefined ? null : iso(until), cooldownWindow: availability.window, ...(until && until > now ? { cooldownIn: durationWords(until - now) } : {}) }
        : {}),
      ...(availability?.reason ? { reason: availability.reason } : {}),
      ...(factory.limits.error ? { unreadable: factory.limits.error } : {}),
      runnableModels: list.filter((m) => !m.cannotRun && m.enabled !== false).length,
      totalModels: list.length,
      overagePreference: usage.overagePreference,
      extraUsageBalanceCents: usage.extraUsageBalanceCents,
      extraUsageAllowed: usage.extraUsageAllowed,
      overageHint: usage.overageHint,
    };
  });
}

export function inspectFactoryModelStatus(factory: FactoryState | undefined, model: string | undefined, now: number, retry?: WorkerRetryStatus): WorkerModelCooldown | undefined {
  if (!factory || !model) return undefined;
  const availability = factoryModelAvailability(factory, { id: model }, now);
  const usage = factoryModelUsage(factory, { id: model }, now);
  if (!availability && !usage) return undefined;
  const blocked = availability && availability.state !== 'ok';
  if (!blocked && !retry) return undefined;
  const until = blocked ? availability.until : null;
  const remainingMs = until !== null && until > now ? until - now : undefined;
  return {
    state: availability?.state === 'exhausted' ? 'cooldown' : availability?.state === 'unavailable' ? 'unavailable' : retry?.retrying ? 'retrying' : 'rate_limited',
    model,
    provider: `factory-${usage?.tier ?? availability?.tier}`,
    providerName: (usage?.tier ?? availability?.tier) === 'core' ? 'Factory Droid Core' : 'Factory Standard',
    ...(blocked ? { window: availability.window, resetsAt: until === null ? null : iso(until) } : {}),
    ...(remainingMs !== undefined ? { remainingMs, resetsIn: durationWords(remainingMs) } : {}),
    summary: blocked ? availability.reason : `${retry?.detail} · ${usage ? factoryUsageWords(usage) : availability?.overageHint}`,
    ...(usage ? { windows: usage.windows, overageHint: usage.overageHint } : {}),
  };
}

const iso = (at: number) => (Number.isFinite(at) ? new Date(at).toISOString() : new Date(0).toISOString());

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Rows right above Droid's input box (excluding text typed inside the input box itself). */
function liveAboveInputBox(rows: readonly string[]): { above: string[]; hasBusySpinner: boolean } {
  const nonempty = rows.filter((r) => r.trim());
  if (!nonempty.length) return { above: [], hasBusySpinner: false };
  let footerRow = nonempty.length - 1;
  while (footerRow >= 0 && !AT_REST.test(nonempty[footerRow])) footerRow--;
  let top = footerRow - 2;
  const hasBottom = footerRow >= 1 && BOX_BOTTOM.test(nonempty[footerRow - 1] ?? '');
  if (hasBottom) {
    while (top >= 0 && BOX_ROW.test(nonempty[top])) top--;
  }
  const hasBox = hasBottom && footerRow >= nonempty.length - 8 && top >= 0 && BOX_TOP.test(nonempty[top] ?? '');
  const above = hasBox ? nonempty.slice(Math.max(0, top - 10), top) : nonempty.slice(-10);
  const tail = hasBox ? [...above, ...nonempty.slice(footerRow)] : above;
  return { above, hasBusySpinner: tail.some((line) => BUSY_SPINNER.test(line)) };
}

/**
 * Reads Droid's live status area above its input box for an in-flight model retry spinner or a
 * terminal quota/rate-limit failure banner after retries gave up.
 */
export function inspectTerminalRetry(rows: readonly string[] | undefined, status: WorkerStatus, hasCurrentTool = false): WorkerRetryStatus | undefined {
  if (!rows?.length) return undefined;
  const { above, hasBusySpinner } = liveAboveInputBox(rows);
  if (!above.length) return undefined;
  if (status === 'working' && !hasCurrentTool) {
    for (let i = above.length - 1; i >= 0; i--) {
      const m = RETRY_LINE.exec(above[i]);
      if (!m) continue;
      // Require either the active turn spinner or no settled prompt box quoting old output.
      if (!hasBusySpinner && i < above.length - 4) continue;
      const attempt = m[1] ? Number(m[1]) : undefined;
      const maxAttempts = m[2] ? Number(m[2]) : undefined;
      const detail = clipText(m[0].replace(/\s*\(Press ESC to stop\)\s*$/i, ''), 140);
      return {
        retrying: true,
        ...(attempt !== undefined && Number.isSafeInteger(attempt) ? { attempt } : {}),
        ...(maxAttempts !== undefined && Number.isSafeInteger(maxAttempts) ? { maxAttempts } : {}),
        detail,
      };
    }
  }
  if (!hasCurrentTool) {
    const recent = above.slice(-5);
    for (let i = recent.length - 1; i >= 0; i--) {
      for (const re of MODEL_ERROR_PATTERNS) {
        const m = re.exec(recent[i]);
        if (m) return { retrying: false, detail: clipText(m[0], 160) };
      }
    }
  }
  return undefined;
}

function mapQuotaWindows(usage: ModelUsage | undefined, now: number): WorkerQuotaWindow[] | undefined {
  if (!usage?.windows.length) return undefined;
  return usage.windows.map((w) => ({
    name: w.name,
    leftPercent: w.leftPercent,
    resetsAt: w.resetsAt !== null ? iso(w.resetsAt) : null,
    ...(w.resetsAt !== null && w.resetsAt > now ? { resetsIn: durationWords(w.resetsAt - now) } : {}),
  }));
}

/**
 * Combines DroidProxy model availability, subscription quota windows, and live terminal retry signals
 * into one actionable model status with explicit reset countdown and ISO timestamp.
 */
export function inspectModelStatus(model: string | undefined, availability: ModelAvailability | undefined, usage: ModelUsage | undefined, now: number, retry?: WorkerRetryStatus): WorkerModelCooldown | undefined {
  if (!model) return undefined;
  const windows = mapQuotaWindows(usage, now);
  const provider = usage?.provider ?? (availability && ('provider' in availability ? availability.provider : undefined));
  const pName = provider ? providerName(provider) : undefined;

  if (availability?.state === 'exhausted') {
    const until = availability.until;
    const remainingMs = until !== null && until > now ? until - now : undefined;
    const resetsIn = remainingMs !== undefined ? durationWords(remainingMs) : undefined;
    const resetsAt = until !== null ? iso(until) : null;
    const summary = remainingMs !== undefined && resetsIn ? `Out of quota on ${availability.window}, resets in ${resetsIn} (${resetsAt})` : `Out of quota on ${availability.window}${resetsAt ? ` (reset due since ${resetsAt})` : ''}`;
    return {
      state: 'cooldown',
      model,
      ...(provider ? { provider, providerName: pName } : {}),
      window: availability.window,
      resetsAt,
      ...(remainingMs !== undefined ? { remainingMs, resetsIn } : {}),
      summary,
      ...(windows ? { windows } : {}),
    };
  }

  if (availability && cannotRun(availability)) {
    return {
      state: availability.state === 'ok' ? 'ok' : availability.state,
      model,
      ...(provider ? { provider, providerName: pName } : {}),
      summary: availabilityWords(availability, now),
      ...(windows ? { windows } : {}),
    };
  }

  // Usage window at 0% left before the next /models poll, or while Droid is retrying.
  const depleted = usage?.windows.filter((w) => w.leftPercent <= 0) ?? [];
  if (depleted.length) {
    const backAt = depleted.reduce<number | null>((latest, w) => {
      if (w.resetsAt === null) return latest;
      return latest === null || w.resetsAt > latest ? w.resetsAt : latest;
    }, null);
    const which = depleted.map((w) => w.name).join(', ');
    const remainingMs = backAt !== null && backAt > now ? backAt - now : undefined;
    const resetsIn = remainingMs !== undefined ? durationWords(remainingMs) : undefined;
    const resetsAt = backAt !== null ? iso(backAt) : null;
    const summary = remainingMs !== undefined && resetsIn ? `Out of quota on ${which}, resets in ${resetsIn} (${resetsAt})` : `Out of quota on ${which}${resetsAt ? ` (reset due since ${resetsAt})` : ''}`;
    return {
      state: 'cooldown',
      model,
      ...(provider ? { provider, providerName: pName } : {}),
      window: which,
      resetsAt,
      ...(remainingMs !== undefined ? { remainingMs, resetsIn } : {}),
      summary,
      ...(windows ? { windows } : {}),
    };
  }

  if (retry) {
    const windowSummary = windows?.length ? windows.map((w) => `${w.name} ${w.leftPercent}% left${w.resetsIn ? ` (resets in ${w.resetsIn} at ${w.resetsAt})` : ''}`).join(', ') : undefined;
    return {
      state: retry.retrying ? 'retrying' : 'rate_limited',
      model,
      ...(provider ? { provider, providerName: pName } : {}),
      summary: windowSummary ? `${retry.detail} · ${pName ?? model}: ${windowSummary}` : retry.detail,
      ...(windows ? { windows } : {}),
    };
  }

  return undefined;
}

function normalizePullState(p: GhPull): WorkerPullStatus['state'] {
  const s = p.state.toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (p.isDraft || s === 'DRAFT') return 'draft';
  if (s === 'OPEN') return 'open';
  return 'closed';
}

function toRunStatus(run: PipelineRun): WorkerRunStatus {
  return {
    id: run.id,
    number: run.number,
    workflow: run.workflow,
    state: run.state,
    status: run.status,
    event: run.event,
    branch: run.branch,
    sha: run.sha.slice(0, 12),
    url: run.url,
    ...(run.jobs ? { jobs: { ...run.jobs } } : {}),
  };
}

function sortedRuns(runs: readonly PipelineRun[]): PipelineRun[] {
  return [...runs].sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0) || b.id - a.id);
}

function prNumberFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const m = /\/(?:pull|merge_requests)\/(\d+)(?:$|[/?#])/.exec(url);
  return m ? Number(m[1]) : undefined;
}

function releaseTitleMatchesPr(title: string, prNumber: number): boolean {
  const escaped = String(prNumber);
  return new RegExp(`\\(#${escaped}\\)|Merge pull request #${escaped}\\b|See merge request [^!]*!${escaped}\\b`, 'i').test(title);
}

/**
 * Resolves a worker's PR state/checks, branch CI run, and post-merge Release/target run from the
 * floor's in-memory board and pipeline caches without spawning any subprocesses.
 */
export function inspectWorkerForge(
  worker: WorkerInfo,
  pulls: readonly GhPull[] | undefined,
  pipelines: PipelinesState | undefined,
  opts?: { reportedPrNumber?: number; reportedPrUrl?: string; mergeCommit?: string },
): WorkerForgeStatus | undefined {
  const branch = worker.worktree?.branch;
  const explicitUrl = opts?.reportedPrUrl ?? worker.pr?.url;
  const explicitNumber = opts?.reportedPrNumber ?? prNumberFromUrl(explicitUrl) ?? worker.pr?.number;
  const allPulls = pulls ?? [];

  let matchedPull: GhPull | undefined;
  if (explicitNumber !== undefined) matchedPull = allPulls.find((p) => p.number === explicitNumber);
  if (!matchedPull && branch) {
    const branchPulls = allPulls.filter((p) => p.headRefName === branch);
    matchedPull =
      branchPulls.find((p) => p.state.toUpperCase() === 'OPEN' || p.state.toUpperCase() === 'DRAFT') ??
      branchPulls.filter((p) => p.state.toUpperCase() === 'MERGED').sort((a, b) => b.number - a.number)[0] ??
      branchPulls.sort((a, b) => b.number - a.number)[0];
  }

  const pr: WorkerPullStatus | undefined = matchedPull
    ? {
        number: matchedPull.number,
        url: matchedPull.url,
        state: normalizePullState(matchedPull),
        checks: matchedPull.checks,
        ...(matchedPull.title ? { title: matchedPull.title } : {}),
        ...(matchedPull.headRefOid ? { headSha: matchedPull.headRefOid } : {}),
        ...(matchedPull.baseRefName ? { baseBranch: matchedPull.baseRefName } : {}),
      }
    : explicitNumber !== undefined && explicitUrl
      ? { number: explicitNumber, url: explicitUrl, state: 'unknown', checks: 'none' }
      : undefined;

  const runs = pipelines?.runs?.length ? sortedRuns(pipelines.runs) : [];
  const branchRun = runs.find((r) => (branch && r.branch === branch) || (pr?.headSha && r.sha === pr.headSha));
  const ci = branchRun ? toRunStatus(branchRun) : undefined;

  let releaseRun: WorkerRunStatus | undefined;
  const mergeSha = opts?.mergeCommit?.trim().toLowerCase();
  if (runs.length && (pr?.state === 'merged' || mergeSha)) {
    const targetBranch = pr?.baseBranch || pipelines?.defaultBranch || worker.worktree?.from?.replace(/^origin\//, '') || 'main';
    const candidate = runs.find((r) => {
      if (r.branch !== targetBranch) return false;
      const rSha = r.sha.toLowerCase();
      if (mergeSha && mergeSha.length >= 7 && (rSha.startsWith(mergeSha) || mergeSha.startsWith(rSha))) return true;
      if (pr?.number !== undefined && releaseTitleMatchesPr(r.title, pr.number)) return true;
      return false;
    });
    if (candidate) releaseRun = toRunStatus(candidate);
  }

  if (!pr && !ci && !releaseRun) return undefined;
  return {
    ...(pr ? { pr } : {}),
    ...(ci ? { ci } : {}),
    ...(releaseRun ? { releaseRun } : {}),
  };
}

/** Provenance, freshness timestamp, and disabled-setting staleness for a worker's task label. */
export function describeTaskLabel(worker: Pick<WorkerInfo, 'task' | 'lead'>, labelsOn = true): WorkerTaskLabel | undefined {
  const t = worker.task;
  if (!t) return undefined;
  if (t.generated) {
    return {
      source: 'generated',
      generated: true,
      ...(t.updatedAt !== undefined ? { updatedAt: iso(t.updatedAt) } : {}),
      ...(!labelsOn ? { stale: true as const } : {}),
    };
  }
  return {
    source: worker.lead ? 'lead' : 'prompt',
    generated: false,
  };
}

export function formatTaskTag(label: WorkerTaskLabel | undefined): string {
  if (!label?.generated) return '';
  const details = ['generated label', ...(label.stale ? ['stale (worker labels off)'] : []), ...(label.updatedAt ? [`updated ${label.updatedAt}`] : [])];
  return ` [${details.join(', ')}]`;
}

export interface BuildWorkerInspectionInput {
  worker: WorkerInfo;
  state?: WorkerStatus | 'blocked_on_question';
  runtime?: WorkerRuntimeSnapshot;
  availability?: ModelAvailability;
  usage?: ModelUsage;
  factory?: FactoryState;
  pulls?: readonly GhPull[];
  pipelines?: PipelinesState;
  labelsOn?: boolean;
  report?: {
    text: string;
    question: boolean;
    progress?: true;
    at: number;
    prUrl?: string;
    result?: WorkerResult;
    review?: WorkerReview;
  };
  now?: number;
}

/** Builds a structured, noise-free snapshot of what a worker is doing, its plan, quota/cooldown, and PR/CI. */
export function buildWorkerInspection(input: BuildWorkerInspectionInput): WorkerInspection {
  const now = input.now ?? Date.now();
  const { worker, runtime, report } = input;
  const model = worker.activeModel ?? worker.model;
  const effort = worker.activeEffort ?? worker.effort;
  const state = input.state ?? (worker.status === 'needs_input' && worker.ask?.kind === 'question' ? 'blocked_on_question' : worker.status);

  const retry = inspectTerminalRetry(runtime?.screenRows, worker.status, Boolean(runtime?.currentTool));
  const modelStatus = inspectFactoryModelStatus(input.factory, model, now, retry) ?? inspectModelStatus(model, input.availability, input.usage, now, retry);

  const plan: WorkerPlanStatus | undefined = worker.todos
    ? {
        ...worker.todos,
        ...(runtime?.todoSteps?.length ? { steps: runtime.todoSteps.map((s) => ({ ...s })) } : {}),
      }
    : undefined;

  const currentTool = runtime?.currentTool
    ? {
        name: runtime.currentTool.name,
        summary: runtime.currentTool.summary,
        startedAt: iso(runtime.currentTool.at),
        runningForMs: Math.max(0, now - runtime.currentTool.at),
      }
    : undefined;

  const lastTool =
    !currentTool && runtime?.lastTool
      ? {
          name: runtime.lastTool.name,
          summary: runtime.lastTool.summary,
          at: iso(runtime.lastTool.at),
          agoMs: Math.max(0, now - runtime.lastTool.at),
        }
      : undefined;

  const lastHookAt = runtime?.lastHookAt;
  const silentForMs = lastHookAt ? Math.max(0, now - lastHookAt) : undefined;
  const queuedMessages = runtime?.queuedMessages;
  const termQueued = queuedMessages?.length ?? 0;
  const noticeQueued = runtime?.queuedNotices ?? 0;
  const queued =
    termQueued > 0 || noticeQueued > 0
      ? {
          terminal: termQueued,
          notices: noticeQueued,
          ...(queuedMessages?.length ? { messages: [...queuedMessages] } : {}),
        }
      : undefined;

  const lastReport: WorkerLastReport | undefined = report
    ? {
        kind: report.question ? 'question' : report.progress ? 'progress' : 'report',
        at: iso(report.at),
        summary: clipText(report.result?.summary ?? report.text, 240),
        ...(report.result ? { status: report.result.status } : {}),
        ...(report.review ? { review: { verdict: report.review.verdict, by: report.review.by, notes: clipText(report.review.notes, 200) } } : {}),
      }
    : undefined;

  const forge = inspectWorkerForge(worker, input.pulls, input.pipelines, {
    reportedPrNumber: report?.result?.artifacts?.prNumber,
    reportedPrUrl: report?.result?.artifacts?.prUrl ?? report?.prUrl,
    mergeCommit: report?.result?.artifacts?.mergeCommit,
  });

  const task = worker.task ? (worker.task.summary ? `${worker.task.name}: ${worker.task.summary}` : worker.task.name) : worker.title;
  const taskLabel = describeTaskLabel(worker, input.labelsOn ?? true);

  return {
    id: worker.id,
    name: worker.name,
    status: worker.status,
    state,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(task ? { task } : {}),
    ...(taskLabel ? { taskLabel } : {}),
    ...(worker.activity ? { doing: worker.activity } : {}),
    ...(plan ? { plan } : {}),
    ...(currentTool ? { currentTool } : {}),
    ...(lastTool ? { lastTool } : {}),
    ...(lastHookAt ? { lastActivityAt: iso(lastHookAt), silentForMs } : {}),
    ...(runtime?.lastOutputAt ? { lastOutputAt: iso(runtime.lastOutputAt) } : {}),
    ...(queued ? { queued } : {}),
    ...(retry?.retrying
      ? {
          retryingModel: {
            ...(retry.attempt !== undefined ? { attempt: retry.attempt } : {}),
            ...(retry.maxAttempts !== undefined ? { maxAttempts: retry.maxAttempts } : {}),
            detail: retry.detail,
          },
        }
      : {}),
    ...(retry && !retry.retrying ? { modelError: retry.detail } : {}),
    ...(modelStatus ? { modelStatus } : {}),
    ...(lastReport ? { lastReport } : {}),
    ...(forge?.pr ? { pr: forge.pr } : {}),
    ...(forge?.ci ? { ci: forge.ci } : {}),
    ...(forge?.releaseRun ? { releaseRun: forge.releaseRun } : {}),
  };
}

export function briefAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return durationWords(ms);
}

export function formatForgeLines(forge: Pick<WorkerInspection, 'pr' | 'ci' | 'releaseRun'>): string[] {
  const lines: string[] = [];
  if (forge.pr) {
    if (forge.pr.state === 'unknown') {
      lines.push(`PR #${forge.pr.number}: ${forge.pr.url}`);
    } else {
      const checks = forge.pr.state === 'merged' ? 'merged' : forge.pr.checks === 'none' ? forge.pr.state : `${forge.pr.state}, checks ${forge.pr.checks}`;
      lines.push(`PR #${forge.pr.number} (${checks}): ${forge.pr.url}`);
    }
  }
  if (forge.ci) {
    const jobs = forge.ci.jobs ? ` (${forge.ci.jobs.done}/${forge.ci.jobs.total} jobs${forge.ci.jobs.failed ? `, ${forge.ci.jobs.failed} failed` : ''}${forge.ci.jobs.current ? ` · ${forge.ci.jobs.current}` : ''})` : '';
    lines.push(`CI: ${forge.ci.workflow} #${forge.ci.number} ${forge.ci.state}${jobs} on ${forge.ci.branch} (${forge.ci.url})`);
  }
  if (forge.releaseRun) {
    const jobs = forge.releaseRun.jobs ? ` (${forge.releaseRun.jobs.done}/${forge.releaseRun.jobs.total} jobs${forge.releaseRun.jobs.failed ? `, ${forge.releaseRun.jobs.failed} failed` : ''})` : '';
    lines.push(`Post-merge CI: ${forge.releaseRun.workflow} #${forge.releaseRun.number} ${forge.releaseRun.state}${jobs} on ${forge.releaseRun.branch} (${forge.releaseRun.url})`);
  }
  return lines;
}

/** Multi-line structured header for `office_look` and `worker_log` so leads see real state before raw terminal text. */
export function formatWorkerInspection(s: WorkerInspection, opts?: { includeSteps?: boolean }): string {
  const lines: string[] = [];
  const head = [`State: ${s.state}`, ...(s.model ? [`model ${s.model}${s.effort ? ` (${s.effort})` : ''}`] : []), ...(s.silentForMs !== undefined ? [`last hook ${briefAge(s.silentForMs)} ago (${s.lastActivityAt})`] : [])];
  lines.push(head.join(' · '));
  if (s.task) lines.push(`Task: ${s.task}${formatTaskTag(s.taskLabel)}`);
  if (s.modelStatus && s.modelStatus.state !== 'ok') {
    const label = s.modelStatus.state === 'cooldown' ? 'Model cooldown' : 'Model alert';
    lines.push(`${label}: ${s.modelStatus.summary}`);
  }
  if (s.retryingModel && s.modelStatus?.state !== 'retrying') {
    lines.push(`Retrying model: ${s.retryingModel.detail}`);
  } else if (s.modelError && s.modelStatus?.state !== 'rate_limited') {
    lines.push(`Model error: ${s.modelError}`);
  }
  if (s.currentTool) {
    lines.push(`Current tool: ${s.currentTool.summary} (running ${briefAge(s.currentTool.runningForMs)})`);
  } else if (s.status === 'working') {
    const prev = s.lastTool ? `; last tool ${s.lastTool.summary} (${briefAge(s.lastTool.agoMs)} ago)` : '';
    const what = s.retryingModel ? s.retryingModel.detail : 'Model thinking/streaming (no tool running)';
    lines.push(`Activity: ${what}${prev}`);
  } else if (s.doing) {
    lines.push(`Doing: ${s.doing}`);
  }
  if (s.plan) {
    lines.push(`Plan: ${todoCount(s.plan)}${s.plan.current ? ` · ${s.plan.current}` : ' done'}`);
    if (opts?.includeSteps !== false && s.plan.steps?.length) {
      for (const [idx, step] of s.plan.steps.entries()) {
        const mark = step.status === 'completed' ? '[x]' : step.status === 'in_progress' ? '[>]' : '[ ]';
        lines.push(`  ${idx + 1}. ${mark} ${step.content}`);
      }
    }
  }
  if (s.queued) {
    const parts = [
      ...(s.queued.terminal ? [`${s.queued.terminal} terminal queued${s.queued.messages?.length ? ` (${s.queued.messages.map((m) => `"${clipText(m, 60)}"`).join(', ')})` : ''}`] : []),
      ...(s.queued.notices ? [`${s.queued.notices} next-step notice${s.queued.notices === 1 ? '' : 's'}`] : []),
    ];
    lines.push(`Queued: ${parts.join(', ')}`);
  }
  if (s.lastReport) {
    const review = s.lastReport.review ? ` · review: ${s.lastReport.review.verdict} by ${s.lastReport.review.by}` : '';
    lines.push(`Last ${s.lastReport.kind}${s.lastReport.status ? ` (${s.lastReport.status})` : ''} at ${s.lastReport.at}: ${s.lastReport.summary}${review}`);
  }
  lines.push(...formatForgeLines(s));
  return lines.join('\n');
}

function inferSubscriptionProvider(model: TeamModel): SubscriptionProviderKey | undefined {
  if (model.subscriptionProvider) return model.subscriptionProvider;
  if (model.usage?.provider) return model.usage.provider;
  if (model.provider && isSubscriptionProvider(model.provider)) return model.provider;
  if (!isSubscriptionModel(model.id)) return undefined;
  const slug = model.id.toLowerCase();
  if (slug.includes('gpt-') || slug.includes('codex')) return 'codex';
  if (slug.includes('grok')) return 'grok';
  if (slug.includes('gemini') || slug.includes('ag-')) return 'antigravity';
  if (slug.includes('kimi')) return 'kimi';
  if (slug.includes('muse')) return 'meta';
  if (slug.includes('opus') || slug.includes('sonnet') || slug.includes('haiku') || slug.includes('fable') || slug.includes('claude')) return 'claude';
  return undefined;
}

/**
 * Collapses subscription-backed models into one compact quota/cooldown summary per provider
 * so leads can read 5-hour/weekly quota and reset times without scanning dozens of model blocks.
 */
export function summarizeProviderQuotas(models: readonly TeamModel[], now = Date.now()): ProviderQuotaSummary[] {
  const grouped = new Map<string, { key: SubscriptionProviderKey | string; name: string; models: TeamModel[] }>();
  for (const model of models) {
    if (!isSubscriptionModel(model.id) && !model.usage && !model.subscriptionProvider) continue;
    const key = inferSubscriptionProvider(model) ?? model.provider ?? 'subscription';
    const name = isSubscriptionProvider(key) ? providerName(key) : key;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { key, name, models: [] };
      grouped.set(key, entry);
    }
    entry.models.push(model);
  }

  const summaries: ProviderQuotaSummary[] = [];
  for (const { key, name, models: list } of grouped.values()) {
    const totalModels = list.length;
    const runnableModels = list.filter((m) => !m.cannotRun && m.enabled !== false).length;

    // Collect distinct windows across models of this provider (e.g. Claude's Weekly (Opus) + Weekly (Sonnet)).
    const windowMap = new Map<string, WorkerQuotaWindow>();
    let accounts: number | undefined;
    let unreadable: string | undefined;
    let staleAge: string | undefined;

    for (const m of list) {
      const u = m.usage;
      if (!u) continue;
      if (accounts === undefined || u.accounts > accounts) accounts = u.accounts;
      if (!u.windows.length && u.unreadable && !unreadable) unreadable = u.unreadable;
      if (u.updatedAt !== undefined && u.at - u.updatedAt > USAGE_STALE_MS && !staleAge) staleAge = durationWords(u.at - u.updatedAt);
      for (const w of u.windows) {
        const prev = windowMap.get(w.name);
        if (!prev || w.leftPercent < prev.leftPercent) {
          windowMap.set(w.name, {
            name: w.name,
            leftPercent: w.leftPercent,
            resetsAt: w.resetsAt !== null ? iso(w.resetsAt) : null,
            ...(w.resetsAt !== null && w.resetsAt > now ? { resetsIn: durationWords(w.resetsAt - now) } : {}),
          });
        }
      }
    }

    const activeCooldown = list.find((m) => m.cooldown)?.cooldown;
    const blockedReason = list.find((m) => m.cannotRun)?.cannotRun;
    let state: ProviderQuotaSummary['state'] = 'unknown';
    if (runnableModels === 0 && activeCooldown) state = 'cooldown';
    else if (runnableModels === 0 && blockedReason) state = 'unavailable';
    else if (activeCooldown) state = 'cooldown';
    else if (runnableModels > 0) state = 'ok';
    else if (list.some((m) => m.enabled === false)) state = 'unavailable';

    summaries.push({
      provider: key,
      name,
      state,
      ...(accounts !== undefined ? { accounts } : {}),
      windows: [...windowMap.values()],
      ...(activeCooldown
        ? {
            cooldownUntil: activeCooldown.until,
            ...(activeCooldown.resetsIn ? { cooldownIn: activeCooldown.resetsIn } : {}),
            cooldownWindow: activeCooldown.window,
          }
        : {}),
      ...(blockedReason && runnableModels === 0 ? { reason: blockedReason } : {}),
      ...(unreadable && !windowMap.size ? { unreadable } : {}),
      ...(staleAge ? { staleAge } : {}),
      runnableModels,
      totalModels,
    });
  }
  return summaries;
}

export function formatProviderQuotas(quotas: readonly ProviderQuotaSummary[]): string {
  if (!quotas.length) return '';
  const rows = quotas.map((q) => {
    const acct = q.accounts && q.accounts > 1 ? `best of ${q.accounts} accounts, ` : '';
    const badge = q.state === 'cooldown' ? 'COOLDOWN, ' : q.state === 'unavailable' ? 'UNAVAILABLE, ' : '';
    const counts = `${q.runnableModels}/${q.totalModels} runnable`;
    const parts: string[] = [];
    if (q.cooldownWindow && q.runnableModels === 0) {
      const reset = q.cooldownIn && q.cooldownUntil ? `resets in ${q.cooldownIn} (${q.cooldownUntil})` : q.cooldownUntil ? `reset due (${q.cooldownUntil})` : 'out of quota';
      parts.push(`out of quota on ${q.cooldownWindow}, ${reset}`);
    } else if (q.reason && q.runnableModels === 0) {
      parts.push(q.reason);
    }
    if (q.windows.length) {
      parts.push(
        q.windows
          .map((w) => {
            const reset = w.resetsAt === null ? '' : w.resetsIn ? ` (resets in ${w.resetsIn} at ${w.resetsAt})` : ` (reset due since ${w.resetsAt})`;
            return `${w.name} ${w.leftPercent}% left${reset}`;
          })
          .join(', '),
      );
    } else if (q.unreadable) {
      parts.push(`usage couldn't be read (${q.unreadable})`);
    }
    if (q.overageHint) parts.push(q.overageHint);
    const stale = q.staleAge ? `; read ${q.staleAge} ago` : '';
    return `- ${q.name} (${badge}${acct}${counts}): ${parts.join(' · ') || 'quota not reported'}${stale}`;
  });
  return `Subscription quotas:\n${rows.join('\n')}`;
}
