import { execFile, execFileSync, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WIKI_DEFAULT_MODEL, WIKI_JOB_ERROR_LINES, WIKI_JOB_LINES, type DroidModel, type FactoryWikiJob } from '../../shared/factory-wiki.js';
import { redact } from '../jira.js';
import { HttpError } from './feature.js';

// The office's own AutoWiki runs: `droid exec --auto high "/wiki"`, the command Factory's own CI
// template runs, in a clean detached worktree of a floor's default branch. /wiki writes the pages and
// uploads them (POST /wiki, and only there: WIKI_UPLOAD_RULE) as its last step, so Factory only hears of the run when it's done; until
// then it lives here. The office's Factory key goes into that one child's environment (so the run
// lands in the connected account), never into a log or a line anyone sees.

/** What the runner needs of a floor. */
export interface WikiFloorDef {
  id: string;
  /** The floor's checkout. */
  dir: string;
  /** owner/repo, or host/group/project. */
  repo?: string;
  name: string;
}

type Spawn = (command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess;
type Git = (args: string[], cwd: string, timeoutMs?: number) => Promise<string>;

export interface WikiRunnerOptions {
  /** The office's Droid command, resolved (resolveCommand(cfg.agentCmd)), or null when there's none. */
  command: () => string | null;
  /** The environment for it: the office's own, minus what marks a nested session (childEnv()). */
  env: () => Record<string, string>;
  /** A job's state or its lines changed. */
  onChange(floorId: string, what: 'state' | 'lines'): void;
  /** A job ended, with how. */
  onEnd?(floorId: string, job: FactoryWikiJob): void;
  spawn?: Spawn;
  git?: Git;
  /** What `<command> exec --help` prints, for the model list. */
  help?: (command: string) => Promise<string>;
  /** Signals a process group (Unix) or a process tree (Windows). */
  killTree?: (pid: number, signal: NodeJS.Signals) => void;
  /** Whether `pid` is still a /wiki run (after a crash its number may have gone to something else). */
  isWikiProcess?: (pid: number) => boolean;
  now?: () => number;
  /** How long a cancelled run gets to stop before it's killed. */
  graceMs?: number;
  platform?: NodeJS.Platform;
}

/** The worktree a floor's run works in, and the note that one is running, both in the floor's .droid-office/. */
export const WIKI_WORKTREE = 'wiki-run';
const MARKER = 'wiki-run.json';
/** The run's `--settings` file, beside its worktree. */
const SETTINGS = 'wiki-run-settings.json';
/** Which model wrote each run the office uploaded for the floor: Factory's run doesn't always say. */
const RUN_MODELS = 'wiki-run-models.json';
const RUN_MODELS_MAX = 50;
/** How long the model list from `droid exec --help` is kept. */
const MODELS_MS = 10 * 60_000;
const GRACE_MS = 10_000;
const FETCH_TIMEOUT_MS = 120_000;
/** The longest line kept. */
const LINE_MAX = 240;

interface Live {
  job: FactoryWikiJob;
  floor: WikiFloorDef;
  child?: ChildProcess;
  cancelled?: boolean;
  /** The office is stopping: the run ends with it and is left for the next office to call lost. */
  abandoned?: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  /** Every line so far, for the error of a failed run. */
  tail: string[];
  partial: string;
}

const defaultGit: Git = (args, cwd, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop() || err.message));
      else resolve(stdout.trim());
    });
  });

function defaultKillTree(platform: NodeJS.Platform): (pid: number, signal: NodeJS.Signals) => void {
  return (pid, signal) => {
    if (platform === 'win32') {
      // Windows has no process groups to signal: taskkill /T ends the tree, and only by force.
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  };
}

function defaultIsWikiProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // Synchronous on purpose: this runs once per floor, the first time the office sees it.
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    return /\bexec\b/.test(args) && args.includes('/wiki');
  } catch {
    return false;
  }
}

const clipLine = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 1)}…` : one;
};

/** What a tool call is doing, in a few words: `Read src/server/docs.ts`. */
function describeTool(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const detail = [i.command, i.file_path, i.path, i.pattern, i.url, i.description, i.query].find((v) => typeof v === 'string' && v.trim());
  return detail ? `${name} ${detail}` : name;
}

/**
 * The lines worth showing from one line of `droid exec --output-format stream-json`, and anything
 * it says about its session or the run it uploaded. A line that isn't JSON is shown as it is.
 */
export function readWikiEvent(line: string): { lines: string[]; sessionId?: string; runId?: string; error?: boolean } {
  const out: { lines: string[]; sessionId?: string; runId?: string; error?: boolean } = { lines: [] };
  const text = line.trim();
  if (!text) return out;
  const runIn = (s: string) => /Wiki run ID:\s*([\w-]{6,})/i.exec(s)?.[1] ?? /app\.factory\.ai\/wiki\/([\w-]{6,})/i.exec(s)?.[1];
  let e: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an event');
    e = parsed as Record<string, unknown>;
  } catch {
    out.lines.push(clipLine(text));
    const id = runIn(text);
    if (id) out.runId = id;
    return out;
  }
  if (typeof e.session_id === 'string' && e.session_id) out.sessionId = e.session_id;
  const body = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  switch (e.type) {
    case 'tool_call':
      out.lines.push(clipLine(describeTool(String(e.toolName ?? e.toolId ?? 'tool'), e.parameters)));
      break;
    case 'tool_result': {
      const v = body(e.value ?? e.content ?? e.result);
      out.runId = runIn(v);
      if (out.runId) out.lines.push(`Uploaded wiki run ${out.runId}`);
      if (e.isError === true || e.is_error === true) out.lines.push(clipLine(`✗ ${v.split('\n').find((l) => l.trim()) ?? 'a tool failed'}`));
      break;
    }
    case 'message':
      if (e.role !== 'user') {
        const first = body(e.text)
          .split('\n')
          .find((l) => l.trim());
        if (first) out.lines.push(clipLine(first));
        out.runId = runIn(body(e.text));
      }
      break;
    case 'completion': {
      const final = body(e.finalText);
      out.runId = runIn(final);
      const first = final.split('\n').find((l) => l.trim());
      if (first) out.lines.push(clipLine(first));
      break;
    }
    case 'error':
      out.error = true;
      out.lines.push(clipLine(`✗ ${body(e.message ?? e.error ?? 'error')}`));
      break;
    default:
      break;
  }
  if (!out.runId) delete out.runId;
  return out;
}

/**
 * The models in `droid exec --help`: its "Available Models" and "Custom Models" lists (`id  Name`),
 * with each one's reasoning efforts from "Model details" (matched by name). Deprecated ones are left out.
 */
export function parseDroidModels(help: string): DroidModel[] {
  const details = new Map<string, { efforts?: string[]; defaultEffort?: string }>();
  const models: DroidModel[] = [];
  let section: 'factory' | 'custom' | 'details' | undefined;
  for (const raw of help.split('\n')) {
    const line = raw.trimEnd();
    if (/^\S/.test(line)) {
      section = /^Available Models:/i.test(line) ? 'factory' : /^Custom Models:/i.test(line) ? 'custom' : /^Model details:/i.test(line) ? 'details' : undefined;
      continue;
    }
    if (!section || !line.trim()) continue;
    if (section === 'details') {
      const m = /^\s*-\s*(.+?):\s*supports reasoning:\s*\w+;\s*supported:\s*\[([^\]]*)\];\s*default:\s*([\w-]+)/i.exec(line);
      if (m)
        details.set(m[1].trim(), {
          efforts: m[2]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          defaultEffort: m[3],
        });
      continue;
    }
    const m = /^\s+(\S+)\s{2,}(.+)$/.exec(line);
    if (!m || /\[Deprecated\]/i.test(m[2])) continue;
    models.push({ id: m[1], name: m[2].replace(/\s*\(default\)\s*$/i, '').trim(), ...(section === 'custom' ? { custom: true } : {}) });
  }
  return models.map((m) => {
    const d = details.get(m.name);
    return d ? { ...m, ...d } : m;
  });
}

/**
 * The runtime settings (`droid exec --settings`) that put /wiki's subagents on its own model.
 * Without them a subagent goes by the owner's per-complexity subagent models (subagentModelSettings
 * in their Droid settings), which override `-m`: a "light" one could run on another, dearer model.
 * The settings file is merged over theirs key by key, so every tier names a model and an effort.
 */
export function wikiRunSettings(model: Pick<DroidModel, 'id' | 'defaultEffort'>) {
  const s: Record<string, string> = {};
  for (const tier of ['light', 'medium', 'heavy']) {
    s[`${tier}Model`] = model.id;
    if (model.defaultEffort) s[`${tier}ReasoningEffort`] = model.defaultEffort;
  }
  return { subagentModelSettings: s };
}

/**
 * Where the office's /wiki uploads go. In exec mode /wiki's skill sends a GitHub repository's pages to
 * both Factory and the repository's GitHub wiki tab (`--upload-to factory,github`), and Droid has no
 * flag or setting that turns the GitHub half off, so this is said in /wiki's prompt and system prompt,
 * and wikiGitBlock() makes git refuse the wiki repository if the model goes ahead anyway.
 */
export const WIKI_UPLOAD_RULE = 'Upload targets are already decided: Factory cloud yes, GitHub wiki tab no. Run droid wiki-upload with --upload-to factory, never with github in --upload-to, and do not push to the repository’s GitHub wiki.';

/** Not a git transport: a URL rewritten to it fails at once, without touching the network. */
const NO_WIKI_URL = 'droid-office-no-github-wiki://blocked/';

/**
 * Git configuration, as GIT_CONFIG_* environment variables after any `env` already has, that points
 * the GitHub wiki repository of `origin` (the URL /wiki passes as --repo-url) at NO_WIKI_URL. Droid's
 * GitHub wiki sync checks, clones and pushes that repository with git, so with these the sync stops at
 * its first `git ls-remote`. Empty when origin isn't on GitHub (there's no GitHub wiki to reach).
 */
export function wikiGitBlock(origin: string, env: Record<string, string | undefined> = {}): Record<string, string> {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(origin.trim());
  if (!m) return {};
  const slug = `${m[1]}/${m[2]}`;
  // The forms Droid builds the wiki's URL in (https or scp-style ssh), and ssh:// for a model that rewrites it.
  const wikis = [`https://github.com/${slug}.wiki`, `http://github.com/${slug}.wiki`, `git@github.com:${slug}.wiki`, `ssh://git@github.com/${slug}.wiki`];
  const from = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10) || 0;
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(from + wikis.length) };
  wikis.forEach((url, i) => {
    out[`GIT_CONFIG_KEY_${from + i}`] = `url.${NO_WIKI_URL}.insteadOf`;
    out[`GIT_CONFIG_VALUE_${from + i}`] = url;
  });
  return out;
}

/** An argument for cmd.exe, which gets the command line as one string when a .cmd shim runs through the shell. */
const cmdArg = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/** Each floor's /wiki run, at most one at a time per floor. */
export class WikiRunner {
  private live = new Map<string, Live>();
  /** Floors whose leftovers from a run the office didn't see end have been looked at. */
  private adopted = new Set<string>();
  private spawn: Spawn;
  private git: Git;
  private killTree: (pid: number, signal: NodeJS.Signals) => void;
  private isWikiProcess: (pid: number) => boolean;
  private now: () => number;
  private platform: NodeJS.Platform;
  private help: (command: string) => Promise<string>;
  private modelList?: { at: number; models: Promise<DroidModel[]> };
  /** Each floor's RUN_MODELS, once read. */
  private runModels = new Map<string, Record<string, { model: string; modelName?: string }>>();

  constructor(private opts: WikiRunnerOptions) {
    this.spawn = opts.spawn ?? (nodeSpawn as Spawn);
    this.git = opts.git ?? defaultGit;
    this.platform = opts.platform ?? process.platform;
    this.help =
      opts.help ??
      ((command) =>
        new Promise((resolve, reject) => {
          const shell = this.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
          execFile(command, ['exec', '--help'], { env: this.opts.env(), encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
        }));
    this.killTree = opts.killTree ?? defaultKillTree(this.platform);
    this.isWikiProcess = opts.isWikiProcess ?? defaultIsWikiProcess;
    this.now = opts.now ?? Date.now;
  }

  job(floorId: string): FactoryWikiJob | undefined {
    return this.live.get(floorId)?.job;
  }

  /** The models the office's Droid takes (empty when it can't say), read again every 10 minutes. */
  models(): Promise<DroidModel[]> {
    const command = this.opts.command();
    if (!command) return Promise.resolve([]);
    if (!this.modelList || this.now() - this.modelList.at > MODELS_MS) {
      this.modelList = {
        at: this.now(),
        models: this.help(command).then(parseDroidModels, () => []),
      };
    }
    return this.modelList.models;
  }

  /** The model that wrote `runId`, when the office ran it on `floor`. */
  modelOf(floor: WikiFloorDef, runId: string): { model: string; modelName?: string } | undefined {
    return this.modelsOf(floor)[runId];
  }

  private modelsOf(floor: WikiFloorDef): Record<string, { model: string; modelName?: string }> {
    let m = this.runModels.get(floor.id);
    if (!m) {
      try {
        const raw = JSON.parse(readFileSync(path.join(this.dataDir(floor), RUN_MODELS), 'utf8'));
        m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      } catch {
        m = {};
      }
      this.runModels.set(floor.id, m ?? {});
    }
    return m ?? {};
  }

  private rememberModel(live: Live) {
    const { runId, model, modelName } = live.job;
    if (!runId || !model) return;
    const all = { ...this.modelsOf(live.floor), [runId]: { model, ...(modelName ? { modelName } : {}) } };
    const kept = Object.fromEntries(Object.entries(all).slice(-RUN_MODELS_MAX));
    this.runModels.set(live.floor.id, kept);
    try {
      writeFileSync(path.join(this.dataDir(live.floor), RUN_MODELS), JSON.stringify(kept));
    } catch {
      // It's a label: without the file the run just doesn't say which model wrote it after a restart.
    }
  }

  /** A run is starting or running on some floor. */
  busy(): boolean {
    for (const l of this.live.values()) if (l.job.state === 'starting' || l.job.state === 'running') return true;
    return false;
  }

  private dataDir(floor: WikiFloorDef) {
    return path.join(floor.dir, '.droid-office');
  }

  /**
   * The first time the office sees a floor: a run the last office left behind (it stopped or
   * crashed mid-run) is over. Its process is ended if it's still going, its worktree removed, and
   * the floor says what happened.
   */
  adopt(floor: WikiFloorDef) {
    if (this.adopted.has(floor.id)) return;
    this.adopted.add(floor.id);
    const marker = path.join(this.dataDir(floor), MARKER);
    let left: { pid?: number; startedAt?: number; by?: string; model?: string; modelName?: string } | undefined;
    try {
      left = JSON.parse(readFileSync(marker, 'utf8'));
    } catch {
      left = undefined;
    }
    const worktree = path.join(this.dataDir(floor), WIKI_WORKTREE);
    if (!left && !existsSync(worktree)) return;
    if (left?.pid && this.isWikiProcess(left.pid)) this.killTree(left.pid, 'SIGKILL');
    void this.removeWorktree(floor);
    rmSync(marker, { force: true });
    rmSync(path.join(this.dataDir(floor), SETTINGS), { force: true });
    if (left && !this.live.has(floor.id)) {
      this.live.set(floor.id, {
        floor,
        tail: [],
        partial: '',
        job: {
          state: 'lost',
          by: typeof left.by === 'string' ? left.by : 'Someone',
          startedAt: typeof left.startedAt === 'number' ? left.startedAt : 0,
          endedAt: this.now(),
          lines: [],
          ...(typeof left.model === 'string' ? { model: left.model } : {}),
          ...(typeof left.modelName === 'string' ? { modelName: left.modelName } : {}),
          error: 'The office stopped while /wiki was running, which ended that run. Generate it again.',
        },
      });
      this.opts.onChange(floor.id, 'state');
    }
  }

  /**
   * Starts /wiki on `floor`'s default branch with `key` as FACTORY_API_KEY, on `model` (it and its
   * subagents). Throws an HttpError when it can't.
   */
  start(floor: WikiFloorDef, by: string, key: string, model: DroidModel = { id: WIKI_DEFAULT_MODEL, name: WIKI_DEFAULT_MODEL }): FactoryWikiJob {
    this.adopt(floor);
    const was = this.live.get(floor.id);
    if (was && (was.job.state === 'starting' || was.job.state === 'running')) throw new HttpError(409, `/wiki is already running for ${floor.name}, started by ${was.job.by}.`);
    const command = this.opts.command();
    if (!command) throw new HttpError(409, 'The office can’t find its Droid command, so it can’t run /wiki. Install the Droid CLI, or say where it is with --agent.');
    const live: Live = { floor, tail: [], partial: '', job: { state: 'starting', by, startedAt: this.now(), lines: ['Fetching the default branch…'], model: model.id, modelName: model.name } };
    this.live.set(floor.id, live);
    this.opts.onChange(floor.id, 'state');
    void this.run(live, command, key, model);
    return live.job;
  }

  /** Stops `floorId`'s run: SIGTERM to its whole tree, then SIGKILL after the grace period. */
  cancel(floorId: string, by: string): boolean {
    const live = this.live.get(floorId);
    if (!live || (live.job.state !== 'starting' && live.job.state !== 'running')) return false;
    live.cancelled = true;
    live.job = { ...live.job, lines: [...live.job.lines, `Stopping (${by})…`].slice(-WIKI_JOB_LINES) };
    this.opts.onChange(floorId, 'lines');
    const pid = live.child?.pid;
    if (pid) {
      this.killTree(pid, 'SIGTERM');
      live.killTimer = setTimeout(() => this.killTree(pid, 'SIGKILL'), this.opts.graceMs ?? GRACE_MS);
      live.killTimer.unref?.();
    }
    // Still fetching or making the worktree: run() sees `cancelled` and stops before spawning.
    return true;
  }

  /** The office is stopping: every run ends with it (and the next office says so, from the marker). */
  stopAll() {
    for (const live of this.live.values()) {
      if (live.job.state !== 'starting' && live.job.state !== 'running') continue;
      live.abandoned = true;
      if (live.child?.pid) this.killTree(live.child.pid, 'SIGKILL');
    }
  }

  private async run(live: Live, command: string, key: string, model: DroidModel) {
    const { floor } = live;
    const worktree = path.join(this.dataDir(floor), WIKI_WORKTREE);
    let ref: string;
    try {
      try {
        await this.git(['fetch', '--quiet', 'origin'], floor.dir, FETCH_TIMEOUT_MS);
      } catch (err) {
        this.lines(live, [`Couldn’t fetch origin (${(err as Error).message}); using what’s here.`]);
      }
      ref = await this.defaultRef(floor.dir);
      if (live.cancelled) return this.end(live, 'cancelled');
      await this.removeWorktree(floor);
      await this.git(['worktree', 'add', '--detach', '--force', worktree, ref], floor.dir);
      live.job.commit = (await this.git(['rev-parse', '--short', 'HEAD'], worktree).catch(() => '')) || undefined;
    } catch (err) {
      return this.end(live, 'failed', `Couldn’t make a clean checkout of the default branch: ${(err as Error).message}`);
    }
    if (live.cancelled || live.abandoned) return this.end(live, 'cancelled');
    const origin = await this.git(['remote', 'get-url', 'origin'], worktree).catch(() => '');
    if (live.cancelled || live.abandoned) return this.end(live, 'cancelled');
    const settings = path.join(this.dataDir(floor), SETTINGS);
    const args = ['exec', '--auto', 'high', '-m', model.id, '--settings', settings, '--append-system-prompt', WIKI_UPLOAD_RULE, '--output-format', 'stream-json', '--tag', 'droid-office-wiki', '--cwd', worktree, `/wiki ${WIKI_UPLOAD_RULE}`];
    // A .cmd shim on Windows only runs through the shell.
    const shell = this.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const env = this.opts.env();
    const note = { startedAt: live.job.startedAt, by: live.job.by, model: model.id, modelName: model.name };
    let child: ChildProcess;
    try {
      writeFileSync(settings, JSON.stringify(wikiRunSettings(model)));
      writeFileSync(path.join(this.dataDir(floor), MARKER), JSON.stringify(note));
      child = this.spawn(command, shell ? args.map(cmdArg) : args, {
        cwd: worktree,
        env: { ...env, ...wikiGitBlock(origin, env), FACTORY_API_KEY: key },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a cancel ends everything /wiki started too.
        detached: this.platform !== 'win32',
        windowsHide: true,
        shell,
      });
    } catch (err) {
      return this.end(live, 'failed', `Couldn’t start ${path.basename(command)}: ${(err as Error).message}`);
    }
    live.child = child;
    if (child.pid) writeFileSync(path.join(this.dataDir(floor), MARKER), JSON.stringify({ pid: child.pid, ...note }));
    live.job = { ...live.job, state: 'running', lines: [...live.job.lines, `Running /wiki on ${ref}${live.job.commit ? ` (${live.job.commit})` : ''} with ${model.name}…`].slice(-WIKI_JOB_LINES) };
    this.opts.onChange(floor.id, 'state');
    const read = (chunk: Buffer | string) => {
      const text = redact(live.partial + chunk.toString(), [key]);
      const parts = text.split('\n');
      live.partial = parts.pop() ?? '';
      const shown: string[] = [];
      for (const p of parts) {
        const ev = readWikiEvent(p);
        if (ev.sessionId && !live.job.sessionId) live.job.sessionId = ev.sessionId;
        if (ev.runId) live.job.runId = ev.runId;
        shown.push(...ev.lines);
      }
      if (shown.length) this.lines(live, shown);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    let ended = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, err?: Error) => {
      if (ended) return;
      ended = true;
      if (live.killTimer) clearTimeout(live.killTimer);
      // Its marker and worktree stay, so the next office says what happened to it.
      if (live.abandoned) return;
      if (live.partial) read('\n');
      if (live.cancelled) return this.end(live, 'cancelled');
      if (err) return this.end(live, 'failed', `Couldn’t run ${path.basename(command)}: ${redact(err.message, [key])}`);
      if (code === 0) return this.end(live, 'done');
      const why = signal ? `it was stopped (${signal})` : `it exited with ${code}`;
      this.end(live, 'failed', [`/wiki didn’t finish: ${why}.`, ...live.tail.slice(-WIKI_JOB_ERROR_LINES)].join('\n'));
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal));
  }

  /** origin's default branch (origin/HEAD), else origin/main or origin/master. */
  private async defaultRef(dir: string): Promise<string> {
    const head = await this.git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], dir).catch(() => '');
    if (head && head !== 'origin/HEAD') return head;
    for (const ref of ['origin/main', 'origin/master']) {
      const known = await this.git(['rev-parse', '--verify', '--quiet', ref], dir).then(
        () => true,
        () => false,
      );
      if (known) return ref;
    }
    throw new Error('origin has no default branch the office can find (origin/HEAD, main or master)');
  }

  private async removeWorktree(floor: WikiFloorDef) {
    const worktree = path.join(this.dataDir(floor), WIKI_WORKTREE);
    await this.git(['worktree', 'remove', '--force', worktree], floor.dir).catch(() => undefined);
    // Not a worktree git knows of any more (or never was): the folder goes anyway.
    rmSync(worktree, { recursive: true, force: true });
    await this.git(['worktree', 'prune'], floor.dir).catch(() => undefined);
  }

  private lines(live: Live, more: string[]) {
    // /wiki's last message and its completion say the same thing.
    const add = more.filter((l, i) => l !== (i ? more[i - 1] : live.job.lines.at(-1)));
    if (!add.length) return;
    live.tail = [...live.tail, ...add].slice(-WIKI_JOB_ERROR_LINES);
    live.job = { ...live.job, lines: [...live.job.lines, ...add].slice(-WIKI_JOB_LINES) };
    this.opts.onChange(live.floor.id, 'lines');
  }

  private end(live: Live, state: 'done' | 'failed' | 'cancelled', error?: string) {
    if (this.live.get(live.floor.id) !== live || live.abandoned) return;
    const lines = state === 'cancelled' ? [...live.job.lines, 'Stopped.'] : state === 'done' ? [...live.job.lines, 'Done: the wiki is uploaded.'] : live.job.lines;
    live.job = { ...live.job, state, endedAt: this.now(), lines: lines.slice(-WIKI_JOB_LINES), ...(error ? { error } : {}) };
    live.child = undefined;
    if (state === 'done') this.rememberModel(live);
    rmSync(path.join(this.dataDir(live.floor), MARKER), { force: true });
    rmSync(path.join(this.dataDir(live.floor), SETTINGS), { force: true });
    void this.removeWorktree(live.floor);
    this.opts.onChange(live.floor.id, 'state');
    this.opts.onEnd?.(live.floor.id, live.job);
  }
}
