// CI automations: Droid running in GitHub Actions. The Droid workflows Factory found in the account's
// GitHub repositories (GET /automations/ci/scan), their GitHub Actions runs (GET /automations/ci/runs),
// the workflow pull requests opened through Factory (GET /automations/ci/jobs), and how a workflow is
// added, changed or removed (POST /automations/ci/edit). Read by src/server/factory/ci.ts and drawn by
// world/factory-ci.ts and ui/factory-ci.ts. The API's schemas for all of these are empty, so the
// shapes come from real answers. Runs had none yet when this was written: a run reads the fields
// GitHub Actions runs have, under either spelling, and keeps `raw`.

export interface FactoryCiWorkflow {
  /** `owner/repo` */
  repo: string;
  /** `.github/workflows/droid-review.yml` */
  path: string;
  name: string;
  /** GitHub events, as the workflow's `on:` names them (`pull_request`, `schedule`…). */
  triggers: string[];
  cron?: string;
  /** Which Factory template it is (`code-review`, `wiki`, `qa`, `security-audit`), when Factory knows. */
  templateId?: string;
  model?: string;
  /** The droid-action's other inputs, as the scan read them (`automaticReview`, `depth`, `actionRef`…). */
  inputs: Record<string, string | number | boolean>;
  url?: string;
  sha?: string;
  /** Who wrote it, by GitHub login, and their name. */
  author?: string;
  authorName?: string;
  /** What the key's account may do in the repository (`admin`, `write`…). */
  permission?: string;
}

export interface FactoryCiRun {
  id: string;
  repo?: string;
  /** The workflow's name, and its file when the run says. */
  workflow?: string;
  path?: string;
  /** GitHub's: `queued`, `in_progress`, `completed`… */
  status?: string;
  /** Once completed: `success`, `failure`, `cancelled`, `skipped`… */
  conclusion?: string;
  url?: string;
  /** The event that started it (`pull_request`, `schedule`…). */
  event?: string;
  branch?: string;
  sha?: string;
  /** The run's own title: a pull request's or a commit's. */
  title?: string;
  /** The pull request it ran for, if one. */
  pr?: { number: number; url?: string };
  createdAt?: number;
  startedAt?: number;
  updatedAt?: number;
  durationMs?: number;
  raw: Record<string, unknown>;
}

/** A workflow pull request Factory opened (POST /automations/ci/edit), newest state per repository and file. */
export interface FactoryCiJob {
  id: string;
  action: string;
  repo: string;
  path: string;
  prUrl?: string;
  status?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface FactoryCiState {
  /** Whether Factory's GitHub integration is connected; null before it's known. */
  github: boolean | null;
  /** The GitHub accounts and organizations it can see. */
  owners: { login: string; type: string }[];
  workflows: FactoryCiWorkflow[];
  /** When Factory last scanned the repositories (ms). */
  scannedAt?: number;
  runs: FactoryCiRun[];
  jobs: FactoryCiJob[];
  fetchedAt: number;
  error?: string;
}

export function emptyCi(): FactoryCiState {
  return { github: null, owners: [], workflows: [], runs: [], jobs: [], fetchedAt: 0 };
}

/** The newest runs the slice keeps. */
export const CI_RUNS_MAX = 50;

const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
/** ms from a number or an ISO string. */
const timeOf = (v: unknown) => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t > 0 ? t : undefined;
};
/** Only the fields that are there. */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** A workflow from the scan's `workflows`. */
export function workflowOf(raw: unknown): FactoryCiWorkflow | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const repo = optStr(r.repoFullName);
  const path = optStr(r.filePath);
  if (!repo || !path) return undefined;
  const given = obj(r.droidActionInputs) ?? {};
  const inputs: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(given)) if (k !== 'model' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && v !== '') inputs[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  const author = obj(r.authoredBy);
  return defined({
    repo,
    path,
    name: optStr(r.workflowName) ?? path.split('/').pop() ?? path,
    triggers: Array.isArray(r.triggerEvents) ? r.triggerEvents.filter((t): t is string => typeof t === 'string') : [],
    cron: optStr(r.scheduleCron),
    templateId: optStr(r.templateId),
    model: optStr(given.model),
    inputs,
    url: optStr(r.githubUrl),
    sha: optStr(r.fileSha),
    author: optStr(author?.login),
    authorName: optStr(author?.name),
    permission: optStr(r.userPermission),
  });
}

/** A run from GET /automations/ci/runs' `runs`: Factory's camelCase or GitHub's snake_case. */
export function ciRunOf(raw: unknown): FactoryCiRun | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const id = r.id ?? r.runId;
  if ((typeof id !== 'string' && typeof id !== 'number') || id === '') return undefined;
  const repoObj = obj(r.repository);
  const createdAt = timeOf(r.createdAt ?? r.created_at);
  const startedAt = timeOf(r.startedAt ?? r.run_started_at);
  const updatedAt = timeOf(r.updatedAt ?? r.updated_at ?? r.completedAt ?? r.completed_at);
  const given = typeof r.durationMs === 'number' && r.durationMs >= 0 ? r.durationMs : undefined;
  const status = optStr(r.status);
  const done = status === 'completed';
  const from = startedAt ?? createdAt;
  const durationMs = given ?? (done && from !== undefined && updatedAt !== undefined && updatedAt >= from ? updatedAt - from : undefined);
  const prs = Array.isArray(r.pull_requests) ? r.pull_requests : Array.isArray(r.pullRequests) ? r.pullRequests : [];
  const firstPr = obj(prs[0]) ?? obj(r.pullRequest);
  const prNumber = typeof firstPr?.number === 'number' ? firstPr.number : typeof r.prNumber === 'number' ? r.prNumber : undefined;
  const prUrl = optStr(firstPr?.html_url ?? firstPr?.htmlUrl ?? firstPr?.url ?? r.prUrl);
  const commit = obj(r.head_commit ?? r.headCommit);
  return defined({
    id: String(id),
    repo: optStr(r.repoFullName ?? repoObj?.full_name ?? repoObj?.fullName),
    workflow: optStr(r.workflowName ?? r.name),
    path: optStr(r.filePath ?? r.workflowPath ?? r.path),
    status,
    conclusion: optStr(r.conclusion),
    url: optStr(r.htmlUrl ?? r.html_url ?? r.url),
    event: optStr(r.event),
    branch: optStr(r.headBranch ?? r.head_branch),
    sha: optStr(r.headSha ?? r.head_sha),
    title: optStr(r.displayTitle ?? r.display_title ?? commit?.message)
      ?.split('\n')[0]
      .slice(0, 200),
    pr: prNumber !== undefined ? defined({ number: prNumber, url: prUrl }) : undefined,
    createdAt,
    startedAt,
    updatedAt,
    durationMs,
    raw: r,
  });
}

/** A job from GET /automations/ci/jobs' `jobs`. */
export function ciJobOf(raw: unknown): FactoryCiJob | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const repo = optStr(r.repoFullName);
  const path = optStr(r.filePath);
  if (!repo || !path) return undefined;
  return defined({
    id: optStr(r.id) ?? `${repo}::${path}`,
    action: optStr(r.action) ?? 'create',
    repo,
    path,
    prUrl: optStr(r.prUrl),
    status: optStr(r.status),
    error: optStr(r.error)?.slice(0, 300),
    createdAt: timeOf(r.createdAt),
    updatedAt: timeOf(r.updatedAt),
  });
}

// ---- What a workflow is -------------------------------------------------------------------------

export type CiKind = 'review' | 'security' | 'tag' | 'wiki' | 'qa' | 'scheduled' | 'custom';

/** What a workflow does, in a word, from its template, its inputs, its file name and its triggers. */
export function ciKindOf(w: Pick<FactoryCiWorkflow, 'path' | 'templateId' | 'triggers' | 'inputs' | 'cron'>): CiKind {
  const file = w.path.split('/').pop()?.toLowerCase() ?? '';
  if (w.templateId === 'wiki' || file.startsWith('droid-wiki')) return 'wiki';
  if (w.templateId === 'qa' || file.startsWith('qa.')) return 'qa';
  if (w.templateId === 'security-audit' || file.includes('security')) return 'security';
  if (w.inputs.automaticSecurityReview === true && w.inputs.automaticReview !== true) return 'security';
  if (w.inputs.automaticReview === true || file.includes('review')) return 'review';
  // The @droid workflow (droid.yml): it answers comments that tag it.
  if (w.triggers.some((t) => t === 'issue_comment' || t === 'pull_request_review_comment')) return 'tag';
  if (w.cron || w.triggers.includes('schedule')) return 'scheduled';
  return 'custom';
}

export const CI_KIND_LABEL: Record<CiKind, string> = {
  review: 'Code review',
  security: 'Security review',
  tag: '@droid',
  wiki: 'Wiki refresh',
  qa: 'QA',
  scheduled: 'Scheduled',
  custom: 'Droid job',
};

/** A GitHub event as a few words for a chip. */
export function triggerLabel(t: string): string {
  const words: Record<string, string> = {
    pull_request: 'PRs',
    pull_request_target: 'PRs',
    pull_request_review: 'reviews',
    pull_request_review_comment: 'review comments',
    issue_comment: 'comments',
    issues: 'issues',
    push: 'pushes',
    schedule: 'schedule',
    workflow_dispatch: 'manual',
    check_run: 'checks',
  };
  return words[t] ?? t.replace(/_/g, ' ');
}

/** How a run ended, or where it's at: 'pass', 'fail', 'running', 'skipped' or 'unknown'. */
export type CiOutcome = 'pass' | 'fail' | 'running' | 'skipped' | 'unknown';

export function ciOutcome(r: Pick<FactoryCiRun, 'status' | 'conclusion'>): CiOutcome {
  const c = r.conclusion?.toLowerCase();
  if (c === 'success') return 'pass';
  if (c === 'failure' || c === 'timed_out' || c === 'startup_failure' || c === 'action_required') return 'fail';
  if (c === 'cancelled' || c === 'skipped' || c === 'neutral' || c === 'stale') return 'skipped';
  const s = r.status?.toLowerCase();
  if (s && s !== 'completed') return 'running';
  return 'unknown';
}

const repoKey = (repo: string) => repo.toLowerCase();

/** Whether a run is one of `w`'s: the same repository, and the same file or else the same name. */
export function runOfWorkflow(r: FactoryCiRun, w: Pick<FactoryCiWorkflow, 'repo' | 'path' | 'name'>): boolean {
  if (!r.repo || repoKey(r.repo) !== repoKey(w.repo)) return false;
  if (r.path) return r.path === w.path || r.path.endsWith(`/${w.path}`);
  return !!r.workflow && r.workflow === w.name;
}

/** When a run happened, for ordering: its start, else when it was made, else its last change. */
export const runTime = (r: FactoryCiRun) => r.startedAt ?? r.createdAt ?? r.updatedAt ?? 0;

export interface CiRepoGroup {
  repo: string;
  /** This floor's repository. */
  here: boolean;
  workflows: { workflow: FactoryCiWorkflow; kind: CiKind; latest?: FactoryCiRun }[];
  /** The repository's runs, newest first. */
  runs: FactoryCiRun[];
  /** Workflow pull requests Factory opened here. */
  jobs: FactoryCiJob[];
}

/**
 * The workflows by repository: this floor's first (`floorRepo`, `owner/repo`, matched whatever the
 * case), then the rest by name. A repository with only runs or workflow PRs gets a group too, and
 * this floor's repository always has one, so there's somewhere to add the first workflow.
 */
export function groupCi(state: Pick<FactoryCiState, 'workflows' | 'runs' | 'jobs'>, floorRepo?: string): CiRepoGroup[] {
  const groups = new Map<string, CiRepoGroup>();
  const here = floorRepo ? repoKey(floorRepo) : undefined;
  const group = (repo: string) => {
    const k = repoKey(repo);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { repo, here: k === here, workflows: [], runs: [], jobs: [] }));
    return g;
  };
  if (floorRepo) group(floorRepo);
  const runs = [...state.runs].sort((a, b) => runTime(b) - runTime(a));
  for (const w of state.workflows) {
    const latest = runs.find((r) => runOfWorkflow(r, w));
    group(w.repo).workflows.push({ workflow: w, kind: ciKindOf(w), ...(latest ? { latest } : {}) });
  }
  for (const r of runs) if (r.repo) group(r.repo).runs.push(r);
  for (const j of state.jobs) group(j.repo).jobs.push(j);
  for (const g of groups.values()) g.workflows.sort((a, b) => a.workflow.path.localeCompare(b.workflow.path));
  return [...groups.values()].sort((a, b) => Number(b.here) - Number(a.here) || a.repo.localeCompare(b.repo));
}

export interface CiTotals {
  workflows: number;
  repos: number;
  /** Runs started in the last 7 days, and how those that finished went. */
  week: number;
  passed: number;
  failed: number;
  running: number;
}

export const WEEK_MS = 7 * 24 * 3600_000;

export function ciTotals(state: Pick<FactoryCiState, 'workflows' | 'runs'>, now: number): CiTotals {
  const week = state.runs.filter((r) => now - runTime(r) <= WEEK_MS);
  const count = (o: CiOutcome) => week.filter((r) => ciOutcome(r) === o).length;
  return {
    workflows: state.workflows.length,
    repos: new Set(state.workflows.map((w) => repoKey(w.repo))).size,
    week: week.length,
    passed: count('pass'),
    failed: count('fail'),
    running: count('running'),
  };
}

// ---- Adding, changing and removing a workflow (POST /api/factory/ci/edit) --------------------------

export type CiAction = 'create' | 'edit' | 'delete';

/**
 * The GitHub events a Droid workflow can run on, as Factory names them in an edit (`githubEvents`).
 * The schedule is its own field (a cron) and `workflow_dispatch` is always on.
 */
export const CI_EVENTS = [
  { id: 'pull-request', label: 'PR opened or updated', on: 'pull_request: opened, synchronize, ready_for_review' },
  { id: 'pr-opened', label: 'PR opened', on: 'pull_request: opened' },
  { id: 'comment-added', label: 'Comment', on: 'issue_comment: created (members only)' },
  { id: 'push', label: 'Push', on: 'push: every branch' },
  { id: 'label-change', label: 'Label change', on: 'pull_request: labeled, unlabeled' },
  { id: 'checks-completed', label: 'Checks completed', on: 'check_run: completed' },
] as const;
export type CiEvent = (typeof CI_EVENTS)[number]['id'];

/** The templates the office adds: Droid code review (Factory's own), or a Droid job of your own. */
export type CiTemplate = 'code-review' | 'custom';

/** What the office's window sends to add, change or remove a workflow. */
export interface CiEditRequest {
  action: CiAction;
  /** `owner/repo` */
  repo: string;
  /** The workflow's file: required to change or remove one; made up from the template to add one. */
  path?: string;
  template?: CiTemplate;
  name?: string;
  events?: CiEvent[];
  /** A 5-field cron (UTC); '' for none. */
  cron?: string;
  model?: string;
  effort?: string;
  /** What a Droid job does each time it runs. */
  prompt?: string;
  /** Code review: deep (default) or shallow. */
  depth?: 'deep' | 'shallow';
  /** Code review: add Droid's security review too. */
  security?: boolean;
}

/** What it answered: the pull request Factory opened, or what it did without one. */
export interface CiEditResult {
  repo: string;
  path: string;
  prUrl?: string;
  message?: string;
}

/** Where the code review template's file goes (Factory's own name for it). */
export const CI_REVIEW_PATH = '.github/workflows/droid-review.yml';
const GH_REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/;
const CRON_FIELD = /^[\d*/,\-A-Za-z]+$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export const isGithubRepo = (v: unknown): v is string => typeof v === 'string' && GH_REPO.test(v) && !v.endsWith('/.') && !v.endsWith('/..');
export const isWorkflowPath = (v: unknown): v is string => typeof v === 'string' && WORKFLOW_PATH.test(v);
/** Five space-separated cron fields, the way GitHub's `schedule` takes them. */
export const isCron = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.trim().split(/\s+/).length === 5 &&
  v
    .trim()
    .split(/\s+/)
    .every((f) => CRON_FIELD.test(f));

/** The file a new Droid job of its own goes in: `factory-<name, in kebab case>.yml`, as Factory names it. */
export function customWorkflowPath(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'droid';
  return `.github/workflows/factory-${slug}.yml`;
}

/** The droid-action inputs (YAML lines under `with:`) the code review template sets. */
export function reviewParams(r: Pick<CiEditRequest, 'depth' | 'security' | 'model' | 'effort'>): string {
  const lines = ['automatic_review: true', `review_depth: ${r.depth === 'shallow' ? 'shallow' : 'deep'}`];
  if (r.security) lines.push('automatic_security_review: true');
  if (r.model) lines.push(`review_model: ${r.model}`);
  if (r.effort) lines.push(`reasoning_effort: ${r.effort}`);
  return `${lines.join('\n')}\n`;
}

/** Why `req` can't go to Factory, or undefined when it can. */
export function ciEditProblem(req: CiEditRequest): string | undefined {
  if (!['create', 'edit', 'delete'].includes(req.action)) return 'Say whether to add, change or remove a workflow';
  if (!isGithubRepo(req.repo)) return 'Pick a GitHub repository (owner/repo)';
  if (req.action !== 'create' && !isWorkflowPath(req.path)) return 'Say which workflow file (.github/workflows/…)';
  if (req.path !== undefined && !isWorkflowPath(req.path)) return 'A workflow file is .github/workflows/<name>.yml';
  if (req.action === 'delete') return undefined;
  if (req.template && !['code-review', 'custom'].includes(req.template)) return 'Unknown template';
  if (req.events?.some((e) => !CI_EVENTS.some((c) => c.id === e))) return 'Unknown trigger';
  if (req.cron && !isCron(req.cron)) return 'A schedule is five cron fields, like "0 9 * * 1"';
  if (req.depth && req.depth !== 'deep' && req.depth !== 'shallow') return 'Review depth is deep or shallow';
  // Both go into the workflow's YAML as they are.
  if (req.model && !MODEL_ID.test(req.model)) return 'A model is an id like openai-latest-premium';
  if (req.effort && !MODEL_ID.test(req.effort)) return 'A reasoning effort is a word like high';
  if (req.name && /[\r\n]/.test(req.name)) return 'A name is one line';
  if ((req.template ?? 'code-review') === 'custom' && req.action === 'create' && !req.prompt?.trim()) return 'Say what the Droid job does each time it runs';
  if (!req.events?.length && !req.cron && (req.template ?? 'code-review') === 'custom') return 'Pick a trigger or a schedule';
  return undefined;
}

/**
 * The body of Factory's POST /automations/ci/edit for `req` (undocumented; found from its validation
 * errors and the Factory web app): `action`, `repos` [{repoFullName, filePath}] and, to add or change
 * one, `changes`. `id` is the new automation's id (a UUID).
 */
export function ciEditBody(req: CiEditRequest, id: string): Record<string, unknown> {
  const review = (req.template ?? 'code-review') === 'code-review';
  const path = req.path ?? (review ? CI_REVIEW_PATH : customWorkflowPath(req.name ?? 'Droid job'));
  const name = req.name?.trim() || (review ? 'Droid Code Review' : 'Droid job');
  const repos = [{ repoFullName: req.repo, filePath: path }];
  if (req.action === 'delete') return { action: 'delete', repos };
  const changes: Record<string, unknown> = {
    name,
    yamlParams: review ? reviewParams(req) : '',
    customPrompt: review ? '' : (req.prompt ?? '').trim(),
    schedule: req.cron?.trim() ?? '',
    ...(req.events?.length ? { githubEvents: req.events } : {}),
    ...(!review && req.model ? { customCIModel: req.model } : {}),
    ...(!review && req.effort ? { customCIReasoningEffort: req.effort } : {}),
  };
  return {
    action: req.action,
    automationName: name,
    factoryAutomationId: id,
    ...(review ? { modeId: 'code-review' } : {}),
    repos,
    changes,
  };
}

/**
 * Factory's answer to an edit: `sessions`, one per repository, each with the `prUrl` it opened, a
 * `message` when it did without one, or an `error`. Throws the error.
 */
export function ciEditResultOf(raw: unknown, req: CiEditRequest, path: string): CiEditResult {
  const sessions = Array.isArray(obj(raw)?.sessions) ? (obj(raw)!.sessions as unknown[]) : [];
  const s = sessions.map(obj).find((x) => x && repoKey(optStr(x.repoFullName) ?? '') === repoKey(req.repo)) ?? obj(sessions[0]);
  if (!s) throw new Error('Factory didn’t say what it did');
  const error = optStr(s.error);
  if (error && !optStr(s.prUrl)) throw new Error(error.slice(0, 300));
  return defined({ repo: req.repo, path, prUrl: optStr(s.prUrl), message: optStr(s.message) });
}

/** A repository Factory can see, from GET /automations/ci/repositories. */
export interface CiRepository {
  fullName: string;
  private: boolean;
  defaultBranch?: string;
  /** The key's account's permission there. */
  permission?: string;
  /** Factory's GitHub app may write to it, so it can open a workflow PR. */
  writable: boolean;
}

export function ciRepositoryOf(raw: unknown): CiRepository | undefined {
  const r = obj(raw);
  const fullName = optStr(r?.fullName);
  if (!r || !fullName) return undefined;
  return defined({ fullName, private: r.isPrivate === true, defaultBranch: optStr(r.defaultBranch), permission: optStr(r.userPermission), writable: r.factoryAppWritable !== false });
}
