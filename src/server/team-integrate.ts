import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkerInfo } from '../shared/protocol.js';
import { inspectGit } from './team-inspect.js';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 120_000, maxBuffer: 2_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' } });
    return stdout;
  } catch (err) {
    const failure = err as Error & { stderr?: string; stdout?: string };
    throw new Error((failure.stderr || failure.stdout || failure.message).trim());
  }
}

export const workerCwd = (dir: string, worker: WorkerInfo) => (worker.worktree ? path.resolve(dir, worker.worktree.path) : dir);

export async function commitAt(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
}

/** Read the branch actually checked out, not the worker's last observed branch label. */
export async function workerBranch(dir: string, worker: WorkerInfo): Promise<string> {
  if (!worker.worktree) throw new Error(`${worker.name} has no isolated worktree branch.`);
  return currentBranch(workerCwd(dir, worker));
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ['symbolic-ref', '--short', 'HEAD'])).trim();
}

export interface ConflictFile {
  path: string;
  stages: { stage: number; mode: string; sha: string }[];
  hunks: { header: string; ours: string; theirs: string }[];
  truncated: boolean;
}

async function conflicts(cwd: string): Promise<ConflictFile[]> {
  const names = (await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
  return Promise.all(
    names.map(async (file) => {
      const stages = (await git(cwd, ['ls-files', '-u', '-z', '--', file]))
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const [mode, sha, stage] = entry.slice(0, entry.indexOf('\t')).split(' ');
          return { mode, sha, stage: Number(stage) };
        });
      const diff = await inspectGit(cwd, ['diff', '--cc', '--no-ext-diff', '--no-textconv', '--no-color', '--', file]);
      const hunks: ConflictFile['hunks'] = [];
      let side: 'ours' | 'theirs' | undefined;
      for (const line of diff.text.split('\n')) {
        if (line.startsWith('@@')) {
          hunks.push({ header: line, ours: '', theirs: '' });
          side = undefined;
        } else if (hunks.length) {
          const content = line.slice(2);
          if (/^<{7,} /.test(content)) side = 'ours';
          else if (/^\|{7,} /.test(content) || /^>{7,} /.test(content)) side = undefined;
          else if (/^={7,}$/.test(content)) side = 'theirs';
          else if (side) hunks[hunks.length - 1][side] += `${content}\n`;
        }
      }
      return { path: file, stages, hunks, truncated: diff.truncated };
    }),
  );
}

export interface IntegrationOptions {
  target: string;
  mode: 'merge' | 'cherry-pick';
  commits?: string[];
}

/** Integrate committed work without switching any existing checkout to another branch. */
export async function integrateWorker(dir: string, worker: WorkerInfo, options: IntegrationOptions) {
  const source = await workerBranch(dir, worker);
  const sourceSha = await commitAt(dir, `refs/heads/${source}`);
  const target = options.target.replace(/^refs\/heads\//, '');
  await git(dir, ['check-ref-format', '--branch', target]);
  const before = await commitAt(dir, `refs/heads/${target}`);
  const listing = (await git(dir, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  const existing = listing.find((entry) => entry.split('\0').includes(`branch refs/heads/${target}`));
  let cwd = existing
    ?.split('\0')
    .find((line) => line.startsWith('worktree '))
    ?.slice(9);
  const temporary = !cwd;
  if (!cwd) {
    const parent = path.join(dir, '.droid-office', 'worktrees');
    await mkdir(parent, { recursive: true });
    cwd = await mkdtemp(path.join(parent, 'integration-'));
    await git(dir, ['worktree', 'add', cwd, target]);
  }
  let retain = false;
  try {
    if ((await git(cwd, ['status', '--porcelain'])).trim()) throw new Error(`Target ${target} has uncommitted changes in ${cwd}. Commit or move them before integrating.`);
    let picks: string[] = [];
    if (options.mode === 'cherry-pick') {
      const base = worker.worktree?.base ?? (await git(dir, ['merge-base', before, sourceSha])).trim();
      picks = options.commits
        ? await Promise.all(options.commits.map((ref) => commitAt(dir, ref)))
        : (await git(dir, ['rev-list', '--reverse', '--topo-order', '--no-merges', sourceSha, `^${before}`, `^${await commitAt(dir, base)}`])).trim().split('\n').filter(Boolean);
    }
    try {
      if (options.mode === 'merge') await git(cwd, ['merge', '--no-edit', '-m', `Merge ${source} into ${target}`, sourceSha]);
      else if (picks.length) await git(cwd, ['cherry-pick', ...picks]);
    } catch (err) {
      const files = await conflicts(cwd);
      // Keep Git's state, including partially applied cherry-picks, for a worker to resolve.
      retain = true;
      const hint = `Resolve in ${cwd}, git add the files, then git ${options.mode === 'merge' ? 'merge' : 'cherry-pick'} --continue; or git ${options.mode === 'merge' ? 'merge' : 'cherry-pick'} --abort.`;
      const head = await commitAt(cwd, 'HEAD');
      const landed = (await git(cwd, ['rev-list', '--reverse', `${before}..${head}`])).trim().split('\n').filter(Boolean);
      const summary = files.length ? `Blocked integrating ${source} into ${target}: ${files.map((f) => f.path).join(', ')}.` : `Integration of ${source} into ${target} failed: ${(err as Error).message}`;
      return {
        status: files.length ? ('blocked' as const) : landed.length ? ('partial' as const) : ('failed' as const),
        summary,
        artifacts: { commits: landed, files: files.map((f) => f.path) },
        remaining: [hint],
        conflicts: files,
        source,
        sourceSha,
        target,
        before,
        head,
        mode: options.mode,
        worktree: cwd,
        temporaryWorktree: temporary,
      };
    }
    const head = await commitAt(cwd, 'HEAD');
    const stat = (await git(cwd, ['diff', '--shortstat', before, head, '--'])).trim();
    const commits = (await git(cwd, ['log', '--format=%H%x09%s', `${before}..${head}`]))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
    const summary = head === before ? `${source} has no new commits to land on ${target}.` : `Landed ${source} on ${target} at ${head.slice(0, 8)} (${options.mode}; ${stat || `${commits.length} commits`}).`;
    const files = (await git(cwd, ['diff', '--name-only', '-z', before, head, '--'])).split('\0').filter(Boolean);
    return { status: 'ok' as const, summary, artifacts: { mergeCommit: head, commits: commits.map((c) => c.sha), files }, source, sourceSha, target, before, head, mode: options.mode, commits, stat };
  } finally {
    if (temporary && !retain) await git(dir, ['worktree', 'remove', cwd]);
  }
}
