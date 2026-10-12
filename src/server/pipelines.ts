// A floor's CI, for the 02 PIPELINES board and the Pipelines window: its repository's GitHub Actions
// runs through `gh`, or its GitLab project's pipelines through `glab`, in the shapes of
// shared/pipelines.ts. Each floor polls its own (see Floor), quickly while a run is going and someone
// is there to watch, and starts, re-runs and cancels runs for the window and the Pipeline agent's board.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gitlabParts, type Forge } from '../shared/floors.js';
import { githubState, gitlabState, isLive, NO_PIPELINES, type PipelineDetail, type PipelineJob, type PipelineRun, type PipelinesState, type PipelineWorkflow, type WorkflowInput } from '../shared/pipelines.js';
import { gh } from './github.js';
import { gitlabApi, glab } from './gitlab.js';

/** How many runs the board and the window know about. */
const RUNS = 30;
/** While a run is going and someone is on the floor: how often to look again. */
const LIVE_MS = 8_000;
/** Someone is on the floor and nothing is running. */
const ACTIVE_MS = 60_000;
/** Nobody is on the floor. */
const IDLE_MS = 10 * 60_000;
/** The workflow list (and which can be started by hand) changes seldom. */
const WORKFLOWS_MS = 5 * 60_000;
/** At most this many live runs get their jobs counted on each look. */
const LIVE_JOBS = 6;
const TICK_MS = 2_000;

export interface PipelineEvents {
  state(state: PipelinesState): void;
  /** A run the office saw going has ended; `ours` when it was started or re-run from the office. */
  finished(run: PipelineRun, ours: boolean): void;
}

/** What a forge has to answer for the floor's pipelines; Pipelines does the rest. */
export interface PipelineForge {
  readonly forge: Forge;
  runs(): Promise<PipelineRun[]>;
  jobs(id: number): Promise<PipelineJob[]>;
  workflows(): Promise<PipelineWorkflow[]>;
  defaultBranch(): Promise<string | undefined>;
  rerun(run: PipelineRun, failedOnly: boolean): Promise<void>;
  cancel(run: PipelineRun): Promise<void>;
  run(workflow: PipelineWorkflow, ref: string, inputs: Record<string, string>): Promise<void>;
}

/**
 * A floor's runs, kept fresh: `tick` (every couple of seconds, from the floor) decides whether it's
 * time to look again, by whether anyone is on the floor and anything is running.
 */
export class Pipelines {
  state: PipelinesState = { ...NO_PIPELINES };
  private lastLook = 0;
  private workflowsAt = 0;
  /** Live at the last look, by id: one that isn't any more has finished. */
  private live = new Set<number>();
  private seen = false;
  private timer?: NodeJS.Timeout;
  private looking?: Promise<void>;
  /** Runs started or re-run from the office, by id. */
  private ours = new Set<number>();
  /** Workflows started from the office whose run hasn't been listed yet. */
  private started: { workflow: string; branch: string; at: number }[] = [];

  constructor(
    private source: PipelineForge,
    private events: PipelineEvents,
  ) {}

  get forge(): Forge {
    return this.source.forge;
  }

  /** `active`: someone is on the floor. `watching`: something acts on runs ending even when nobody is. */
  start(active: () => boolean, watching: () => boolean = () => false) {
    this.timer = setInterval(() => {
      const wait = this.state.runs.some((r) => isLive(r.state)) && active() ? LIVE_MS : active() || watching() ? ACTIVE_MS : IDLE_MS;
      if (Date.now() - this.lastLook >= wait) void this.refresh();
    }, TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Looks again now; a look already under way counts. */
  refresh(): Promise<void> {
    this.looking ??= this.look().finally(() => (this.looking = undefined));
    return this.looking;
  }

  private async look() {
    this.lastLook = Date.now();
    this.state = { ...this.state, loading: true };
    this.events.state(this.state);
    try {
      const wantWorkflows = Date.now() - this.workflowsAt > WORKFLOWS_MS || !this.state.workflows.length;
      const [runs, workflows, defaultBranch] = await Promise.all([
        this.source.runs(),
        wantWorkflows ? this.source.workflows().catch(() => this.state.workflows) : this.state.workflows,
        this.state.defaultBranch ? this.state.defaultBranch : this.source.defaultBranch().catch(() => undefined),
      ]);
      if (wantWorkflows) this.workflowsAt = Date.now();
      // The board shows how far along a running one is: count its jobs.
      await Promise.all(
        runs
          .filter((r) => isLive(r.state))
          .slice(0, LIVE_JOBS)
          .map(async (r) => {
            try {
              r.jobs = jobCount(await this.source.jobs(r.id));
            } catch {
              // the run still shows, without its progress
            }
          }),
      );
      this.noticeFinished(runs);
      this.state = { runs, workflows, defaultBranch, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.state = { ...this.state, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.events.state(this.state);
  }

  private noticeFinished(runs: PipelineRun[]) {
    const live = new Set(runs.filter((r) => isLive(r.state)).map((r) => r.id));
    // The first look only learns what's going; nothing has finished in front of anyone yet.
    // A run of a workflow the office just started: that workflow, on that branch, made since.
    for (const s of this.started.splice(0)) {
      const run = runs.find((r) => !this.ours.has(r.id) && (r.path?.endsWith(`/${s.workflow}`) || this.source.forge === 'gitlab') && r.branch === s.branch && Date.parse(r.createdAt) >= s.at - 10_000);
      if (run) this.ours.add(run.id);
      else if (Date.now() - s.at < 5 * 60_000) this.started.push(s);
    }
    if (this.seen) {
      for (const r of runs) {
        if (!this.live.has(r.id) || live.has(r.id)) continue;
        this.events.finished(r, this.ours.has(r.id));
        this.ours.delete(r.id);
      }
    }
    this.seen = true;
    this.live = live;
  }

  detail(id: number): Promise<PipelineDetail> {
    return this.source.jobs(id).then((jobs) => ({ id, jobs }));
  }

  /** Re-runs a finished run: only its failed jobs, or all of it. Returns why it couldn't. */
  async rerun(id: number, failedOnly: boolean): Promise<string | undefined> {
    const run = this.state.runs.find((r) => r.id === id);
    if (!run) return 'That run is no longer on the list';
    if (isLive(run.state)) return 'It is still going: cancel it first, or wait for it to finish';
    const err = await this.act(() => this.source.rerun(run, failedOnly));
    // GitHub and GitLab's retry run the same run again; GitLab's run-it-all is a new pipeline.
    if (!err && (failedOnly || this.source.forge === 'github')) this.ours.add(run.id);
    else if (!err) this.started.push({ workflow: 'pipeline', branch: run.branch, at: Date.now() });
    return err;
  }

  async cancel(id: number): Promise<string | undefined> {
    const run = this.state.runs.find((r) => r.id === id);
    if (!run) return 'That run is no longer on the list';
    if (!isLive(run.state)) return 'It has already finished';
    return this.act(() => this.source.cancel(run));
  }

  /** Starts a workflow (on GitLab, a pipeline) on `ref`, with `inputs` for its inputs or variables. */
  async run(workflowId: string, ref: string, inputs: Record<string, string>): Promise<string | undefined> {
    const wf = this.state.workflows.find((w) => w.id === workflowId);
    if (!wf) return 'There is no such workflow';
    if (!wf.manual) return `${wf.name} can't be started by hand: it has no workflow_dispatch trigger`;
    const branch = ref.trim() || this.state.defaultBranch;
    if (!branch) return 'Pick a branch to run it on';
    if (!/^[\w./-]{1,250}$/.test(branch) || branch.startsWith('-')) return `“${branch}” isn't a branch name`;
    for (const input of wf.inputs) if (input.required && !(inputs[input.name] ?? input.default ?? '').trim()) return `${input.name} is required`;
    const at = Date.now();
    const err = await this.act(() => this.source.run(wf, branch, inputs));
    if (!err) this.started.push({ workflow: wf.id, branch, at });
    return err;
  }

  /** Does it, then looks again at once and once more shortly: the forge takes a moment to list a new run. */
  private async act(what: () => Promise<void>): Promise<string | undefined> {
    try {
      await what();
    } catch (err) {
      return (err as Error).message;
    }
    void this.refresh();
    setTimeout(() => void this.refresh(), 4_000).unref?.();
    return undefined;
  }
}

/** How far along a run's jobs are. */
export function jobCount(jobs: PipelineJob[]): PipelineRun['jobs'] {
  const done = jobs.filter((j) => !isLive(j.state)).length;
  const current = jobs.find((j) => j.state === 'running')?.name;
  return { done, total: jobs.length, failed: jobs.filter((j) => j.state === 'failure' && !j.allowFailure).length, ...(current ? { current } : {}) };
}

// --- GitHub Actions -----------------------------------------------------------------------------

type Json = Record<string, any>;

/** A run as GitHub's REST API has it (GET /repos/{owner}/{repo}/actions/runs). */
export function githubRun(r: Json): PipelineRun {
  const workflow = String(r.name ?? 'Workflow');
  const commit = typeof r.head_commit?.message === 'string' ? r.head_commit.message.split('\n')[0] : '';
  // A run started by hand is titled with its workflow's name, which the row already shows.
  const title = r.display_title && (r.display_title !== workflow || !commit) ? String(r.display_title) : commit;
  return {
    id: Number(r.id),
    number: Number(r.run_number ?? 0),
    workflow,
    title,
    state: githubState(r.status, r.conclusion),
    status: String(r.conclusion && r.status === 'completed' ? r.conclusion : (r.status ?? '')),
    event: String(r.event ?? ''),
    branch: String(r.head_branch ?? ''),
    sha: String(r.head_sha ?? ''),
    actor: r.triggering_actor?.login ?? r.actor?.login ?? undefined,
    url: String(r.html_url ?? ''),
    createdAt: String(r.created_at ?? ''),
    startedAt: r.run_started_at ?? undefined,
    updatedAt: String(r.updated_at ?? r.created_at ?? ''),
    attempt: Number(r.run_attempt ?? 1),
    path: typeof r.path === 'string' ? r.path.replace(/@.*$/, '') : undefined,
  };
}

/** A job as GitHub's REST API has it (GET …/actions/runs/{id}/jobs). */
export function githubJob(j: Json): PipelineJob {
  return {
    id: Number(j.id),
    name: String(j.name ?? 'job'),
    state: githubState(j.status, j.conclusion),
    status: String(j.conclusion && j.status === 'completed' ? j.conclusion : (j.status ?? '')),
    startedAt: j.started_at ?? undefined,
    completedAt: j.completed_at ?? undefined,
    url: j.html_url ?? undefined,
    steps: (j.steps ?? []).map((s: Json) => ({
      number: Number(s.number ?? 0),
      name: String(s.name ?? ''),
      state: githubState(s.status, s.conclusion),
      startedAt: s.started_at ?? undefined,
      completedAt: s.completed_at ?? undefined,
    })),
  };
}

class GitHubActions implements PipelineForge {
  readonly forge = 'github' as const;

  constructor(private dir: string) {}

  private api(route: string, args: string[] = []) {
    return gh(['api', ...args, route], this.dir, 45_000);
  }

  async runs(): Promise<PipelineRun[]> {
    const out = JSON.parse(await this.api(`repos/{owner}/{repo}/actions/runs?per_page=${RUNS}`));
    return (out.workflow_runs ?? []).map(githubRun);
  }

  async jobs(id: number): Promise<PipelineJob[]> {
    // filter=latest: a re-run's jobs, not the attempts before it.
    const out = JSON.parse(await this.api(`repos/{owner}/{repo}/actions/runs/${id}/jobs?per_page=100&filter=latest`));
    return (out.jobs ?? []).map(githubJob);
  }

  async workflows(): Promise<PipelineWorkflow[]> {
    const out = JSON.parse(await this.api('repos/{owner}/{repo}/actions/workflows?per_page=100'));
    const list = (out.workflows ?? []).filter((w: Json) => typeof w.path === 'string' && w.path.startsWith('.github/workflows/'));
    return Promise.all(
      list.map(async (w: Json): Promise<PipelineWorkflow> => {
        const file = String(w.path);
        const yaml = await this.workflowFile(file);
        const { manual, inputs } = yaml === undefined ? { manual: false, inputs: [] } : workflowDispatch(yaml);
        return { id: path.posix.basename(file), name: String(w.name ?? file), path: file, manual, inputs, active: w.state === 'active' };
      }),
    );
  }

  /** The workflow as this checkout has it, else as the default branch has it on GitHub. */
  private async workflowFile(file: string): Promise<string | undefined> {
    const local = path.join(this.dir, file);
    if (existsSync(local)) {
      try {
        return readFileSync(local, 'utf8');
      } catch {
        // read it from GitHub instead
      }
    }
    try {
      const b64 = await this.api(`repos/{owner}/{repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}`, ['--jq', '.content']);
      return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }

  async defaultBranch(): Promise<string | undefined> {
    return (await gh(['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], this.dir)).trim() || undefined;
  }

  async rerun(run: PipelineRun, failedOnly: boolean): Promise<void> {
    await gh(['run', 'rerun', String(run.id), ...(failedOnly ? ['--failed'] : [])], this.dir);
  }

  async cancel(run: PipelineRun): Promise<void> {
    await gh(['run', 'cancel', String(run.id)], this.dir);
  }

  async run(wf: PipelineWorkflow, ref: string, inputs: Record<string, string>): Promise<void> {
    const fields = wf.inputs.filter((i) => inputs[i.name] !== undefined && inputs[i.name] !== '').flatMap((i) => ['-f', `${i.name}=${inputs[i.name]}`]);
    await gh(['workflow', 'run', wf.id, '--ref', ref, ...fields], this.dir, 60_000);
  }
}

// --- GitLab pipelines ---------------------------------------------------------------------------

const PIPELINE_FIELDS = 'id iid status source ref sha name createdAt startedAt finishedAt updatedAt path user { username } commit { title }';

/** A pipeline as GitLab's GraphQL API has it. `host` makes its page's address from its path. */
export function gitlabPipeline(p: Json, host: string): PipelineRun {
  const id = Number(/(\d+)$/.exec(String(p.id ?? ''))?.[1] ?? 0);
  const state = gitlabState(p.status);
  return {
    id,
    number: Number(p.iid ?? id),
    workflow: String(p.name || 'Pipeline'),
    title: String(p.commit?.title ?? ''),
    state,
    status: String(p.status ?? '').toLowerCase(),
    event: String(p.source ?? '').toLowerCase(),
    branch: String(p.ref ?? ''),
    sha: String(p.sha ?? ''),
    actor: p.user?.username ?? undefined,
    url: p.path ? `https://${host}${p.path}` : '',
    createdAt: String(p.createdAt ?? ''),
    startedAt: p.startedAt ?? undefined,
    updatedAt: String((isLive(state) ? p.updatedAt : (p.finishedAt ?? p.updatedAt)) ?? p.createdAt ?? ''),
  };
}

/** A job as GitLab's REST API has it (GET /projects/:id/pipelines/:pid/jobs). */
export function gitlabJob(j: Json): PipelineJob {
  return {
    id: Number(j.id),
    name: String(j.name ?? 'job'),
    state: gitlabState(j.status),
    status: String(j.status ?? ''),
    stage: j.stage ?? undefined,
    startedAt: j.started_at ?? undefined,
    completedAt: j.finished_at ?? undefined,
    url: j.web_url ?? undefined,
    steps: [],
    allowFailure: j.allow_failure === true,
  };
}

/** GitLab's own order of a pipeline's jobs: by stage as the pipeline runs them, then by id. */
function stageOrder(jobs: PipelineJob[]): PipelineJob[] {
  const first = new Map<string, number>();
  for (const j of jobs) first.set(j.stage ?? '', Math.min(first.get(j.stage ?? '') ?? Infinity, j.id));
  return [...jobs].sort((a, b) => (first.get(a.stage ?? '') ?? 0) - (first.get(b.stage ?? '') ?? 0) || a.id - b.id);
}

class GitLabPipelines implements PipelineForge {
  readonly forge = 'gitlab' as const;
  private host: string;
  private path: string;
  private id: string;
  private projectUrl: string;

  constructor(
    private dir: string,
    repo: string,
  ) {
    const { host, path } = gitlabParts(repo);
    this.host = host;
    this.path = path;
    this.id = encodeURIComponent(path);
    this.projectUrl = `https://${host}/${path}`;
  }

  private api(route: string, args: string[] = []) {
    return gitlabApi(this.host, this.dir, route, args, 45_000);
  }

  async runs(): Promise<PipelineRun[]> {
    const query = `query($path: ID!, $first: Int!) { project(fullPath: $path) { pipelines(first: $first) { nodes { ${PIPELINE_FIELDS} } } } }`;
    const res = JSON.parse(await this.api('graphql', ['-f', `query=${query}`, '-f', `path=${this.path}`, '-F', `first=${RUNS}`]));
    if (res.errors?.length) throw new Error(res.errors.map((e: Json) => e.message).join('; '));
    if (!res.data?.project) throw new Error("glab can't find this project on GitLab (check the remote and access)");
    return (res.data.project.pipelines?.nodes ?? []).map((p: Json) => gitlabPipeline(p, this.host));
  }

  async jobs(id: number): Promise<PipelineJob[]> {
    const out = JSON.parse(await this.api(`projects/${this.id}/pipelines/${id}/jobs?per_page=100&include_retried=false`));
    return stageOrder((Array.isArray(out) ? out : []).map(gitlabJob));
  }

  /** A GitLab project has one pipeline, which can always be started by hand, with any variables. */
  async workflows(): Promise<PipelineWorkflow[]> {
    return [{ id: 'pipeline', name: 'Pipeline', path: '.gitlab-ci.yml', manual: true, inputs: [], active: true }];
  }

  async defaultBranch(): Promise<string | undefined> {
    return String(JSON.parse(await this.api(`projects/${this.id}`)).default_branch ?? '') || undefined;
  }

  async rerun(run: PipelineRun, failedOnly: boolean): Promise<void> {
    // Retry runs its failed and cancelled jobs again; all of it again is a new pipeline on the same ref.
    if (failedOnly) await this.api(`projects/${this.id}/pipelines/${run.id}/retry`, ['--method', 'POST']);
    else await this.api(`projects/${this.id}/pipeline`, ['--method', 'POST', '-f', `ref=${run.branch}`]);
  }

  async cancel(run: PipelineRun): Promise<void> {
    await this.api(`projects/${this.id}/pipelines/${run.id}/cancel`, ['--method', 'POST']);
  }

  async run(_wf: PipelineWorkflow, ref: string, inputs: Record<string, string>): Promise<void> {
    const vars = Object.entries(inputs).filter(([k, v]) => /^\w{1,255}$/.test(k) && v !== '');
    await glab(['ci', 'run', '--repo', this.projectUrl, '--branch', ref, ...vars.flatMap(([k, v]) => ['--variables', `${k}:${v}`])], this.dir, 60_000);
  }
}

/** A floor's pipelines: its GitLab project's on a GitLab floor, else its GitHub repository's Actions. */
export function floorPipelines(dir: string, forge: Forge, repo: string | undefined, events: PipelineEvents): Pipelines {
  return new Pipelines(forge === 'gitlab' && repo ? new GitLabPipelines(dir, repo) : new GitHubActions(dir), events);
}

// --- Which workflows can be started by hand -----------------------------------------------------

type Yaml = string | Yaml[] | { [key: string]: Yaml } | null;

interface YamlLine {
  indent: number;
  text: string;
}

/** Cuts a `# comment` off a line, unless the # is inside quotes. */
function uncomment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (/^(["']).*\1$/.test(s)) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']'))
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => scalar(x))
      .filter((x) => x !== '');
  if (s === '{}') return {};
  return s;
}

/** Splits `key: value` (the key maybe quoted), or undefined when the line isn't one. */
function keyValue(text: string): [string, string] | undefined {
  const m = /^("[^"]*"|'[^']*'|[^\s:'"][^:]*?)\s*:(?:\s+(.*)|$)/.exec(text);
  if (!m) return undefined;
  return [String(scalar(m[1])), m[2] ?? ''];
}

/** The block of lines at `indent` from `i`: a map or a list, and where it ends. */
function block(lines: YamlLine[], i: number, indent: number): [Yaml, number] {
  if (lines[i]?.text.startsWith('- ') || lines[i]?.text === '-') {
    const list: Yaml[] = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      list.push(scalar(lines[i].text.slice(1)));
      i++;
      // A list item's own children (maps in a list) aren't anything the office reads.
      while (i < lines.length && lines[i].indent > indent) i++;
    }
    return [list, i];
  }
  const map: { [key: string]: Yaml } = {};
  while (i < lines.length && lines[i].indent >= indent) {
    const line = lines[i];
    if (line.indent > indent) {
      i++;
      continue;
    }
    const kv = keyValue(line.text);
    i++;
    if (!kv) continue;
    const [key, rest] = kv;
    if (/^[|>][+-]?$/.test(rest.trim())) {
      const text: string[] = [];
      while (i < lines.length && lines[i].indent > indent) text.push(lines[i++].text);
      map[key] = text.join(rest.trim().startsWith('>') ? ' ' : '\n');
    } else if (rest.trim()) map[key] = scalar(rest);
    else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text.startsWith('-')))) {
      [map[key], i] = block(lines, i, lines[i].indent);
    } else map[key] = null;
  }
  return [map, i];
}

/** As much of a workflow file as the office reads: maps, lists and scalars by indentation. */
export function parseYaml(src: string): Yaml {
  const lines: YamlLine[] = [];
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    const text = uncomment(raw).trimEnd();
    if (!text.trim() || text.trim() === '---') continue;
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim() });
  }
  return lines.length ? block(lines, 0, lines[0].indent)[0] : null;
}

const INPUT_TYPES = new Set<WorkflowInput['type']>(['string', 'choice', 'boolean', 'number', 'environment']);

/** Whether a workflow file can be started by hand (`on: workflow_dispatch`), and the inputs it takes. */
export function workflowDispatch(yaml: string): { manual: boolean; inputs: WorkflowInput[] } {
  const doc = parseYaml(yaml);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { manual: false, inputs: [] };
  // YAML 1.1 reads a bare `on` as true, so some files spell it "on" or true.
  const on = doc.on ?? doc.true;
  if (typeof on === 'string') return { manual: on === 'workflow_dispatch', inputs: [] };
  if (Array.isArray(on)) return { manual: on.includes('workflow_dispatch'), inputs: [] };
  if (!on || typeof on !== 'object' || !('workflow_dispatch' in on)) return { manual: false, inputs: [] };
  const dispatch = on.workflow_dispatch;
  const raw = dispatch && typeof dispatch === 'object' && !Array.isArray(dispatch) ? dispatch.inputs : undefined;
  const inputs: WorkflowInput[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, def] of Object.entries(raw)) {
      const d = def && typeof def === 'object' && !Array.isArray(def) ? def : {};
      const type = String(d.type ?? 'string') as WorkflowInput['type'];
      const options = Array.isArray(d.options) ? d.options.map(String) : undefined;
      inputs.push({
        name,
        description: typeof d.description === 'string' && d.description ? d.description : undefined,
        required: String(d.required ?? 'false') === 'true',
        default: d.default === undefined || d.default === null ? undefined : String(d.default),
        type: INPUT_TYPES.has(type) ? type : 'string',
        ...(options?.length ? { options } : {}),
      });
    }
  }
  return { manual: true, inputs };
}
