// CI automations: the Droid workflows in the account's GitHub repositories (GET /automations/ci/scan)
// and their recent runs (GET /automations/ci/runs). Read by src/server/factory/ci.ts. The API's
// schemas for these are empty, so the shapes come from real answers; runs had none yet when this
// was written, so a run keeps `raw` beside the fields GitHub Actions runs usually have.

export interface FactoryCiWorkflow {
  /** `owner/repo` */
  repo: string;
  /** `.github/workflows/droid-review.yml` */
  path: string;
  name: string;
  triggers: string[];
  cron?: string;
  /** Which Factory template it was made from (`code-review`, `security-review`…), if one. */
  templateId?: string;
  model?: string;
  url?: string;
  sha?: string;
  /** Who wrote it, by GitHub login. */
  author?: string;
}

export interface FactoryCiRun {
  id: string;
  repo?: string;
  workflow?: string;
  status?: string;
  conclusion?: string;
  url?: string;
  createdAt?: number;
  raw: Record<string, unknown>;
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
  fetchedAt: number;
  error?: string;
}

export function emptyCi(): FactoryCiState {
  return { github: null, owners: [], workflows: [], runs: [], fetchedAt: 0 };
}

const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
/** ms from a number or an ISO string. */
const timeOf = (v: unknown) => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** A workflow from the scan's `workflows`. */
export function workflowOf(raw: unknown): FactoryCiWorkflow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const repo = optStr(r.repoFullName);
  const path = optStr(r.filePath);
  if (!repo || !path) return undefined;
  const inputs = r.droidActionInputs && typeof r.droidActionInputs === 'object' ? (r.droidActionInputs as Record<string, unknown>) : {};
  const author = r.authoredBy && typeof r.authoredBy === 'object' ? optStr((r.authoredBy as Record<string, unknown>).login) : undefined;
  return {
    repo,
    path,
    name: optStr(r.workflowName) ?? path,
    triggers: Array.isArray(r.triggerEvents) ? r.triggerEvents.filter((t): t is string => typeof t === 'string') : [],
    ...(optStr(r.scheduleCron) ? { cron: optStr(r.scheduleCron) } : {}),
    ...(optStr(r.templateId) ? { templateId: optStr(r.templateId) } : {}),
    ...(optStr(inputs.model) ? { model: optStr(inputs.model) } : {}),
    ...(optStr(r.githubUrl) ? { url: optStr(r.githubUrl) } : {}),
    ...(optStr(r.fileSha) ? { sha: optStr(r.fileSha) } : {}),
    ...(author ? { author } : {}),
  };
}

/** A run from GET /automations/ci/runs' `runs`. */
export function ciRunOf(raw: unknown): FactoryCiRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = r.id ?? r.runId;
  if ((typeof id !== 'string' && typeof id !== 'number') || id === '') return undefined;
  const createdAt = timeOf(r.createdAt ?? r.created_at);
  return {
    id: String(id),
    ...(optStr(r.repoFullName) ? { repo: optStr(r.repoFullName) } : {}),
    ...(optStr(r.workflowName ?? r.name) ? { workflow: optStr(r.workflowName ?? r.name) } : {}),
    ...(optStr(r.status) ? { status: optStr(r.status) } : {}),
    ...(optStr(r.conclusion) ? { conclusion: optStr(r.conclusion) } : {}),
    ...(optStr(r.htmlUrl ?? r.html_url ?? r.url) ? { url: optStr(r.htmlUrl ?? r.html_url ?? r.url) } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    raw: r,
  };
}
