// A floor's CI: its repository's GitHub Actions runs, or its GitLab project's pipelines. Read by
// server/pipelines.ts through gh or glab, drawn on the 02 PIPELINES board on the north wall
// (world/boards.ts) and listed in the Pipelines window (ui/pipelines.ts). Both forges speak these
// shapes; what each one calls a status is kept in `status`, and `state` is the office's word for it.
// What differs between the forges (which run was just started, whether a full re-run keeps its id,
// and the words on the window, the wall and the station) is `PIPELINE_POLICIES` below.

import type { Forge } from './floors.js';

/** Where a run stands: waiting to start, running, or how it ended. */
export type RunState = 'pending' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped';

export interface PipelineRun {
  /** GitHub's run id, or GitLab's pipeline id: what the detail, re-run and cancel take. */
  id: number;
  /** As people say it: the run number on GitHub, the pipeline's iid on GitLab. */
  number: number;
  /** The workflow's name on GitHub; the pipeline's own name on GitLab, else "Pipeline". */
  workflow: string;
  /** What it ran for: a commit's or a pull request's title. */
  title: string;
  state: RunState;
  /** The forge's own word for it: `queued`, `waiting`, `in_progress`, `action_required`, `manual`… */
  status: string;
  /** What started it: `push`, `pull_request`, `workflow_dispatch`, `schedule`; on GitLab `push`, `merge_request_event`, `web`, `api`… */
  event: string;
  branch: string;
  sha: string;
  /** Who started it, by login. */
  actor?: string;
  url: string;
  createdAt: string;
  startedAt?: string;
  /** When it finished, or last changed while it runs. */
  updatedAt: string;
  /** GitHub's attempt, from 1; more after a re-run. */
  attempt?: number;
  /** GitHub: its workflow file, `.github/workflows/release.yml`. */
  path?: string;
  /** While it runs: how many of its jobs are done of how many, the one running now, and how many failed. */
  jobs?: { done: number; total: number; current?: string; failed: number };
}

export interface PipelineStep {
  number: number;
  name: string;
  state: RunState;
  startedAt?: string;
  completedAt?: string;
}

export interface PipelineJob {
  id: number;
  name: string;
  state: RunState;
  status: string;
  /** GitLab's stage; GitHub jobs have none. */
  stage?: string;
  startedAt?: string;
  completedAt?: string;
  url?: string;
  /** GitHub's steps; GitLab jobs have none. */
  steps: PipelineStep[];
  /** GitLab: a failure here doesn't fail the pipeline. */
  allowFailure?: boolean;
}

export interface PipelineDetail {
  id: number;
  jobs: PipelineJob[];
}

/** An input a workflow takes when it's started by hand (`on: workflow_dispatch: inputs:`), or a GitLab variable. */
export interface WorkflowInput {
  name: string;
  description?: string;
  required: boolean;
  default?: string;
  type: 'string' | 'choice' | 'boolean' | 'number' | 'environment';
  options?: string[];
}

export interface PipelineWorkflow {
  /** What Run takes: the workflow's file name on GitHub (`release.yml`), `pipeline` on GitLab. */
  id: string;
  name: string;
  path?: string;
  /** It can be started by hand: `workflow_dispatch` on GitHub, always on GitLab. */
  manual: boolean;
  inputs: WorkflowInput[];
  /** Not turned off on GitHub. */
  active: boolean;
}

export interface PipelinesState {
  runs: PipelineRun[];
  workflows: PipelineWorkflow[];
  /** The repository's default branch: where Run starts a workflow unless another branch is picked. */
  defaultBranch?: string;
  fetchedAt: number;
  loading: boolean;
  error?: string;
}

export const NO_PIPELINES: PipelinesState = { runs: [], workflows: [], fetchedAt: 0, loading: false };

/** A GitHub Actions run's or job's status and conclusion, as the office says it. */
export function githubState(status: string | null | undefined, conclusion: string | null | undefined): RunState {
  const s = String(status ?? '').toLowerCase();
  const c = String(conclusion ?? '').toLowerCase();
  if (s === 'in_progress') return 'running';
  if (s !== 'completed') return 'pending';
  if (c === 'success') return 'success';
  if (c === 'cancelled') return 'cancelled';
  if (c === 'skipped' || c === 'neutral' || c === 'stale') return 'skipped';
  // Waiting on someone to approve it (a first-time contributor, a protected environment).
  if (c === 'action_required') return 'pending';
  return 'failure';
}

/** A GitLab pipeline's or job's status (GraphQL's CAPITALS or REST's lowercase), as the office says it. */
export function gitlabState(status: string | null | undefined): RunState {
  switch (String(status ?? '').toLowerCase()) {
    case 'running':
    case 'canceling':
      return 'running';
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      // created, waiting_for_resource, preparing, pending, scheduled, manual, waiting_for_callback
      return 'pending';
  }
}

/** Still going: waiting to start or running. */
export function isLive(state: RunState): boolean {
  return state === 'pending' || state === 'running';
}

/** The runs the board and the window list, in their sections: running, then waiting, then the rest newest first. */
export function pipelineGroups(runs: readonly PipelineRun[]): { running: PipelineRun[]; pending: PipelineRun[]; recent: PipelineRun[] } {
  const newest = (a: PipelineRun, b: PipelineRun) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return {
    running: runs.filter((r) => r.state === 'running').sort(newest),
    pending: runs.filter((r) => r.state === 'pending').sort(newest),
    recent: runs.filter((r) => !isLive(r.state)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
  };
}

/** How long it has run so far, or ran for, in ms; 0 before it started. */
export function runTime(run: Pick<PipelineRun, 'state' | 'createdAt' | 'startedAt' | 'updatedAt'>, now: number): number {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  if (!Number.isFinite(start)) return 0;
  if (run.state === 'pending') return 0;
  const end = isLive(run.state) ? now : Date.parse(run.updatedAt);
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}

/** How long it has been waiting to start, in ms. */
export function waitTime(run: Pick<PipelineRun, 'createdAt'>, now: number): number {
  const t = Date.parse(run.createdAt);
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

/** A duration as a clock reads it: `42s`, `3m 05s`, `1h 12m`. */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** How long ago, in a few letters: `10s`, `4m`, `3h`, `2d`. */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 45) return `${Math.round(s / 60)}s`;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const EVENTS: Record<string, string> = {
  push: 'push',
  pull_request: 'PR',
  pull_request_target: 'PR',
  merge_request_event: 'MR',
  external_pull_request_event: 'PR',
  workflow_dispatch: 'by hand',
  web: 'by hand',
  api: 'API',
  schedule: 'schedule',
  release: 'release',
  workflow_run: 'after a run',
  workflow_call: 'called',
  trigger: 'trigger',
  pipeline: 'upstream',
  parent_pipeline: 'parent',
  repository_dispatch: 'dispatch',
  merge_group: 'merge queue',
  issue_comment: 'comment',
  chat: 'chat',
};

/** What started a run, in a word or two. */
export function eventLabel(event: string): string {
  return EVENTS[event] ?? event.replace(/_/g, ' ');
}

/** The verb for a run's state: `passed`, `failed`, `running`… */
export const STATE_WORD: Record<RunState, string> = {
  pending: 'waiting',
  running: 'running',
  success: 'passed',
  failure: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
};

/** A run's state for someone reading it: GitHub's `waiting` (on an approval) and GitLab's `manual` are more than "waiting". */
export function stateWord(run: Pick<PipelineRun, 'state' | 'status'>): string {
  if (run.state === 'pending') {
    const s = run.status.toLowerCase();
    if (s === 'action_required' || s === 'waiting') return 'needs approval';
    if (s === 'manual') return 'manual';
    if (s === 'scheduled') return 'scheduled';
    return 'queued';
  }
  return STATE_WORD[run.state];
}

/** The words one forge uses for its pipelines, kept as they are shown today. */
export interface PipelineCopy {
  /** Pipelines window title. */
  windowTitle: string;
  /** The header button that opens the run form. */
  runButton: string;
  /** Run form heading. */
  runTitle: string;
  /** Run form explanation. */
  runBlurb: string;
  /** Empty Pipelines window, with its period. */
  emptyWindow: string;
  /** Empty wall, without a period. */
  emptyWall: string;
  /** Wall title, mono uppercase. */
  wallTitle: string;
  /** The command in the wall's window bar. */
  wallCommand: string;
  /** Crosshair hint at the board, emoji included. */
  hint: string;
  /** ☰ menu title for the board. */
  menuTitle: string;
  /** Command palette detail for the board. */
  paletteDetail: string;
  /** Command palette title for starting one by hand. */
  runAction: string;
  /** Link under a job. */
  jobLog: string;
  /** Button that re-runs the failed jobs. */
  retryLabel: string;
  retryTitle: string;
  /** Button that runs the whole thing again. */
  rerunLabel: string;
  rerunTitle: string;
}

/**
 * How the office treats one forge's pipelines. The adapters still do the I/O; this is the policy
 * around a run the office started, a full re-run, and the words.
 */
export interface PipelinePolicy {
  /**
   * How a run started from the office is recognized, besides the branch and the time (10s of slack).
   * `workflow-file`: its path ends with `/${workflow}`. `branch`: the branch and the time are enough.
   */
  startedBy: 'workflow-file' | 'branch';
  /** A full re-run keeps the same run id. Retrying only the failed jobs keeps the id on either forge. */
  fullRerunKeepsId: boolean;
  /** The run form: CI variables for one pipeline, or a workflow and the inputs it declares. */
  form: 'variables' | 'workflow';
  copy: PipelineCopy;
}

export const GITHUB_PIPELINES: PipelinePolicy = {
  startedBy: 'workflow-file',
  fullRerunKeepsId: true,
  form: 'workflow',
  copy: {
    windowTitle: 'GitHub Actions',
    runButton: '▶ Run workflow',
    runTitle: 'Run a workflow',
    runBlurb: 'Starts a workflow that has a workflow_dispatch trigger, on a branch or tag.',
    emptyWindow: 'Runs of the workflows in .github/workflows show up here as they run.',
    emptyWall: 'Workflows in .github/workflows show up here as they run',
    wallTitle: 'GITHUB ACTIONS',
    wallCommand: 'gh run list -- 02 pipelines',
    hint: '🚀 GitHub Actions',
    menuTitle: 'GitHub Actions: running, waiting and recent',
    paletteDetail: 'GitHub Actions runs: running, waiting and recent',
    runAction: 'Run a workflow',
    jobLog: 'Logs ↗',
    retryLabel: 'Re-run failed jobs',
    retryTitle: 'Run only the jobs that failed (and what needs them) again',
    rerunLabel: 'Re-run all jobs',
    rerunTitle: 'Run every job again',
  },
};

export const GITLAB_PIPELINES: PipelinePolicy = {
  startedBy: 'branch',
  fullRerunKeepsId: false,
  form: 'variables',
  copy: {
    windowTitle: 'GitLab pipelines',
    runButton: '▶ Run pipeline',
    runTitle: 'Run a pipeline',
    runBlurb: 'Starts a new pipeline from .gitlab-ci.yml on a branch or tag.',
    emptyWindow: 'Pipelines from .gitlab-ci.yml show up here as they run.',
    emptyWall: 'Pipelines from .gitlab-ci.yml show up here as they run',
    wallTitle: 'GITLAB PIPELINES',
    wallCommand: 'glab ci list -- 02 pipelines',
    hint: '🚀 GitLab pipelines',
    menuTitle: 'GitLab pipelines: running, waiting and recent',
    paletteDetail: 'GitLab pipelines: running, waiting and recent',
    runAction: 'Run a pipeline',
    jobLog: 'Job log ↗',
    retryLabel: 'Retry failed jobs',
    retryTitle: 'Retry the jobs that failed',
    rerunLabel: 'Run again',
    rerunTitle: 'Start a new pipeline on the same commit',
  },
};

/** The two forges. An unknown forge reads as GitHub, which is what the boards did before a project loaded. */
export const PIPELINE_POLICIES: Record<Forge, PipelinePolicy> = { github: GITHUB_PIPELINES, gitlab: GITLAB_PIPELINES };

export function pipelinePolicy(forge: Forge | undefined): PipelinePolicy {
  return forge ? PIPELINE_POLICIES[forge] : PIPELINE_POLICIES.github;
}
