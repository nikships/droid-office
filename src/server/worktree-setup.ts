import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { INCLUDE_FILE, SETUP_FILE, detectSetup, parsePatterns, parseSetupFile, resolveSetup, type ResolvedSetup, type WorktreeSetupFile, type WorktreeSetupOverride, type WorktreeSetupState } from '../shared/worktree-setup.js';

/** A floor's own setup, in its checkout's .droid-office/. */
const OVERRIDE_FILE = 'worktree-setup.json';
/** The script a worker's terminal runs before its agent (see SETUP_SCRIPT), in the data dir. */
const SCRIPT_FILE = 'worktree-setup.cjs';
/** Where the plans for terminals that haven't run theirs yet wait, in the data dir. */
const PLANS_DIR = 'setup';

/** Making one worktree ready: what the setup script does in it. */
export interface SetupStep {
  /** The new worktree. */
  dir: string;
  /** The checkout it was cut from, where the files to copy are. */
  root: string;
  /** The repository's folder in a workspace across repositories; none for a worker's only worktree. */
  label?: string;
  setup?: string;
  /** Where the command came from, in words. */
  from?: string;
  copy: string[];
}

export function readOverride(dataDir: string): WorktreeSetupOverride | undefined {
  try {
    const o = JSON.parse(readFileSync(path.join(dataDir, OVERRIDE_FILE), 'utf8')) as Partial<WorktreeSetupOverride>;
    if (typeof o.setup !== 'string' || !Array.isArray(o.copy)) return undefined;
    return { setup: o.setup, copy: o.copy.filter((p): p is string => typeof p === 'string'), by: typeof o.by === 'string' ? o.by : undefined, at: typeof o.at === 'number' ? o.at : undefined };
  } catch {
    return undefined;
  }
}

/** Saves a floor's own setup; null goes back to the repository's or the detected one. */
export function writeOverride(dataDir: string, override: WorktreeSetupOverride | null) {
  const file = path.join(dataDir, OVERRIDE_FILE);
  if (!override) return rmSync(file, { force: true });
  writeFileSync(file, JSON.stringify(override, null, 2), { mode: 0o600 });
}

/** What a checkout itself says about its worktrees: its SETUP_FILE, its INCLUDE_FILE and its lockfiles. */
export function inspectCheckout(dir: string): Pick<WorktreeSetupState, 'repo' | 'include' | 'detected'> {
  const read = (name: string) => {
    try {
      return readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return undefined;
    }
  };
  const out: Pick<WorktreeSetupState, 'repo' | 'include' | 'detected'> = {};
  const file = read(SETUP_FILE);
  if (file !== undefined) out.repo = parseSetupFile(file);
  const include = read(INCLUDE_FILE);
  if (include !== undefined) out.include = parsePatterns(include);
  const detected = detectSetup((f) => existsSync(path.join(dir, f)));
  if (detected) out.detected = detected;
  return out;
}

/** What `inspected` and the floor's own setup add up to; a SETUP_FILE that can't be read counts as none. */
function resolve(inspected: Pick<WorktreeSetupState, 'repo' | 'include' | 'detected'>, override: WorktreeSetupOverride | undefined): ResolvedSetup {
  const repo: WorktreeSetupFile | undefined = inspected.repo && !('error' in inspected.repo && inspected.repo.error) ? inspected.repo : undefined;
  return resolveSetup({ override, repo, include: inspected.include, detected: inspected.detected });
}

/** A floor's worktree setup as Settings shows it, read from its checkout now. */
export function setupState(floor: string, checkout: string, dataDir: string, git: boolean): WorktreeSetupState {
  const inspected = inspectCheckout(checkout);
  const override = readOverride(dataDir);
  return { floor, git, ...inspected, ...(override ? { override } : {}), resolved: resolve(inspected, override) };
}

/**
 * Making the new worktree `dir`, cut from `root`, ready. The repository's files are read from the
 * worktree, which is on the branch the work starts from; the floor's own setup from `dataDir`.
 * Nothing when there's nothing to run or copy.
 */
export function setupStep(root: string, dir: string, dataDir: string, label?: string): SetupStep | undefined {
  const inspected = inspectCheckout(dir);
  const r = resolve(inspected, readOverride(dataDir));
  // Nothing to run and nothing to copy: the agent starts the way it always did.
  if (!r.setup && !copiesFrom(root, r.copy).length) return undefined;
  const from = r.setupFrom === 'office' ? 'set for this floor in Settings' : r.setupFrom === 'repo' ? `from ${SETUP_FILE}` : r.setupFrom === 'detected' ? `from ${r.detectedFrom?.join(' and ')}` : undefined;
  return { dir, root, ...(label ? { label } : {}), ...(r.setup ? { setup: r.setup, from } : {}), copy: r.copy };
}

/**
 * The untracked files and folders in `root` that match `patterns`, the way the setup script finds
 * them (git's gitignore matching, a folder as one entry), without the office's own data.
 */
export function copiesFrom(root: string, patterns: string[]): string[] {
  if (!patterns.length) return [];
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--others', '--ignored', '--directory', ...patterns.map((p) => `--exclude=${p}`)], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\0')
      .map((e) => e.replace(/\/$/, ''))
      .filter((e) => e && e !== '.droid-office' && !e.startsWith('.droid-office/'));
  } catch {
    return [];
  }
}

/** Writes the plan a worker's terminal runs before its agent; the script deletes it once read. */
export function writePlan(dataDir: string, workerId: string, steps: SetupStep[]): string {
  const dir = path.join(dataDir, PLANS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${workerId}.json`);
  writeFileSync(file, JSON.stringify({ steps }), { mode: 0o600 });
  return file;
}

/** Writes SETUP_SCRIPT into the data dir (again on every start, so an upgrade runs the new one). */
export function writeSetupScript(dataDir: string): string {
  const file = path.join(dataDir, SCRIPT_FILE);
  writeFileSync(file, SETUP_SCRIPT, { mode: 0o600 });
  return file;
}

/**
 * Runs in a worker's terminal ahead of its agent, with the office's own node: for each step of the
 * plan file it's given, copies the checkout's untracked files that match the step's patterns into
 * the worktree (clones where the file system can, never over a file that's there), then runs the
 * step's command there with DROID_OFFICE_ROOT_PATH and DROID_OFFICE_WORKTREE_PATH set. It tells the
 * office when it starts and how it went through the worker's own hook URL. It always exits 0: the
 * agent starts either way. Plain CommonJS with no dependencies, so any node can run it.
 */
export const SETUP_SCRIPT = `'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const dim = (s) => '\\x1b[2m' + s + '\\x1b[0m';
const say = (s) => process.stdout.write(s + '\\n');

function report(body) {
  return new Promise((done) => {
    const { DROID_OFFICE_HOOK_URL: base, DROID_OFFICE_WORKER_ID: worker, DROID_OFFICE_HOOK_TOKEN: token } = process.env;
    if (!base || !worker || !token) return done();
    const url = new URL(base + '/hooks/droid');
    url.searchParams.set('worker', worker);
    url.searchParams.set('event', 'WorktreeSetup');
    const req = http.request(url, { method: 'POST', timeout: 3000, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', done);
    });
    req.on('error', () => done());
    req.on('timeout', () => req.destroy());
    req.end(JSON.stringify({ hook_event_name: 'WorktreeSetup', ...body }));
  });
}

function copy(step) {
  if (!step.copy.length) return;
  let listed = [];
  try {
    const args = ['ls-files', '-z', '--others', '--ignored', '--directory'];
    for (const p of step.copy) args.push('--exclude=' + p);
    listed = execFileSync('git', args, { cwd: step.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\\0').filter(Boolean);
  } catch (err) {
    say('Could not list the files to copy from ' + step.root + ': ' + err.message);
    return;
  }
  const copied = [];
  for (const entry of listed) {
    const rel = entry.replace(/\\/$/, '');
    if (rel === '.droid-office' || rel.startsWith('.droid-office/')) continue;
    const to = path.join(step.dir, rel);
    if (fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(path.join(step.root, rel), to, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
      copied.push(rel);
    } catch (err) {
      say('Could not copy ' + rel + ': ' + err.message);
    }
  }
  if (copied.length) say(dim('Copied from the checkout: ' + copied.join(', ')));
}

// Piped rather than inherited so the end of what it printed can go to the office: Droid clears the
// terminal when it starts.
function run(step, env) {
  return new Promise((done) => {
    let tail = '';
    const keep = (chunk) => {
      process.stdout.write(chunk);
      tail = (tail + chunk.toString()).slice(-6000);
    };
    const child = spawn(step.setup, { cwd: step.dir, env, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => done({ code: 127, tail: tail + String(err.message) }));
    child.on('close', (code) => done({ code: code === null ? 1 : code, tail }));
  });
}

async function main() {
  const file = process.argv[2];
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
  } catch {
    return;
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const commands = steps.filter((s) => s.setup).map((s) => s.setup);
  await report({ phase: 'start', commands });
  const failed = [];
  for (const step of steps) {
    if (step.label) say('\\x1b[1m' + step.label + '\\x1b[0m');
    copy(step);
    if (!step.setup) continue;
    say('\\x1b[1;38;5;208m› Setting up this worktree:\\x1b[0m ' + step.setup + (step.from ? dim(' (' + step.from + ')') : ''));
    const started = Date.now();
    const env = { ...process.env, DROID_OFFICE_ROOT_PATH: step.root, DROID_OFFICE_WORKTREE_PATH: step.dir };
    delete env.ELECTRON_RUN_AS_NODE;
    const { code, tail } = await run(step, env);
    const took = Math.round((Date.now() - started) / 1000) + 's';
    if (code === 0) say('\\x1b[32m✓ Set up in ' + took + '\\x1b[0m');
    else {
      const output = tail.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '').replace(/\\r/g, '').trim().split('\\n').slice(-40).join('\\n');
      failed.push({ command: step.setup, code, label: step.label, output });
      say('\\x1b[31m✗ Setup failed with exit code ' + code + ' after ' + took + '. The agent starts anyway.\\x1b[0m');
    }
  }
  say('');
  await report({ phase: 'done', failed });
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
`;
