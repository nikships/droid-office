import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

export function canonicalPath(cwd: string): string {
  return realpathSync(cwd);
}

export async function registeredWorktrees(dir: string) {
  return (await git(dir, ['worktree', 'list', '--porcelain', '-z']))
    .split('\0\0')
    .filter(Boolean)
    .map((entry) => {
      const fields = entry.split('\0');
      return {
        path: fields.find((line) => line.startsWith('worktree '))!.slice(9),
        branch: fields.find((line) => line.startsWith('branch refs/heads/'))?.slice(18),
      };
    });
}

export async function handoffStart(dir: string, cwd: string, worker?: WorkerInfo) {
  const registered = (await registeredWorktrees(dir)).find((tree) => existsSync(tree.path) && canonicalPath(tree.path) === canonicalPath(cwd));
  if (!registered) throw new Error('The handoff path must name a registered Git worktree of this repository.');
  const commit = await commitAt(registered.path, 'HEAD');
  const branch = registered.branch ?? worker?.worktree?.branch ?? commit.slice(0, 8);
  return { ...(worker ? { worker: worker.id } : {}), name: worker?.name ?? path.basename(registered.path), branch, commit };
}

export async function verifyPushed(dir: string, worker: WorkerInfo, branch: string) {
  const cwd = workerCwd(dir, worker);
  const head = await commitAt(cwd, 'HEAD');
  const remote = (await git(cwd, ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`])).trim().split(/\s/)[0];
  if (remote !== head) throw new Error(`Push ${branch} to origin first: its remote branch does not match local HEAD ${head.slice(0, 8)}.`);
}

async function midOperations(cwd: string) {
  const names = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG', 'sequencer'];
  const paths = (await git(cwd, ['rev-parse', ...names.flatMap((name) => ['--git-path', name])])).trim().split('\n');
  return names.filter((_name, i) => existsSync(path.resolve(cwd, paths[i])));
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
      let header = '';
      let side: 'ours' | 'theirs' | undefined;
      for (const line of diff.text.split('\n')) {
        if (line.startsWith('\\ No newline at end of file')) continue;
        if (line.startsWith('@@')) {
          header = line;
          side = undefined;
        } else if (header) {
          const content = line.slice(2);
          if (/^<{7,} /.test(content)) {
            hunks.push({ header, ours: '', theirs: '' });
            side = 'ours';
          } else if (/^\|{7,} /.test(content) || /^>{7,} /.test(content)) side = undefined;
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
  lead?: string;
  workers?: WorkerInfo[];
}

/** Integrate committed work without switching any existing checkout to another branch. */
export async function integrateWorker(dir: string, worker: WorkerInfo, options: IntegrationOptions) {
  const source = await workerBranch(dir, worker);
  const sourceCwd = workerCwd(dir, worker);
  const sourceSha = await commitAt(sourceCwd, 'HEAD');
  const target = options.target.replace(/^refs\/heads\//, '');
  await git(dir, ['check-ref-format', '--branch', target]);
  const before = await commitAt(dir, `refs/heads/${target}`);
  let cwd = (await registeredWorktrees(dir)).find((tree) => tree.branch === target)?.path;
  const blocked = (summary: string, remaining: string) => ({
    status: 'blocked' as const,
    summary,
    remaining: [remaining],
    worktree: cwd ?? dir,
    source,
    sourceSha,
    target,
    before,
    head: before,
    mode: options.mode,
  });
  if (source === target) return blocked(`Cannot integrate ${source} into itself.`, 'Choose a different target branch.');
  if (cwd) {
    const owner = options.workers?.find(
      (w) =>
        w.id !== options.lead &&
        (w.worktree ? existsSync(workerCwd(dir, w)) && canonicalPath(workerCwd(dir, w)) === canonicalPath(cwd!) : canonicalPath(cwd!) === canonicalPath(dir) && ['starting', 'working', 'needs_input'].includes(w.status)),
    );
    if (owner) return blocked(`Target ${target} is occupied by ${owner.name} (${owner.id}).`, `Ask ${owner.name} to finish or release this checkout before integration.`);
  }
  const temporary = !cwd;
  if (!cwd) {
    const parent = path.join(dir, '.droid-office', 'worktrees');
    await mkdir(parent, { recursive: true });
    cwd = await mkdtemp(path.join(parent, 'integration-'));
    try {
      await git(dir, ['worktree', 'add', cwd, target]);
    } catch (err) {
      await git(dir, ['worktree', 'remove', '--force', cwd]).catch(() => rm(cwd!, { recursive: true, force: true }));
      throw err;
    }
  }
  let retain = false;
  try {
    const operations = await midOperations(cwd);
    if (operations.length) return blocked(`Target ${target} has a Git operation in progress (${operations.join(', ')}).`, `Finish or abort the existing operation in ${cwd} before integrating.`);
    if ((await git(cwd, ['status', '--porcelain'])).trim()) return blocked(`Target ${target} has uncommitted changes in ${cwd}.`, 'Commit or move these changes before integrating.');
    let picks: string[] = [];
    if (options.mode === 'cherry-pick') {
      const base = worker.worktree?.base ?? (await git(dir, ['merge-base', before, sourceSha])).trim();
      picks = options.commits
        ? await Promise.all(options.commits.map((ref) => commitAt(sourceCwd, ref)))
        : (await git(dir, ['rev-list', '--reverse', '--topo-order', '--no-merges', '--cherry-pick', '--right-only', `${before}...${sourceSha}`, `^${await commitAt(dir, base)}`])).trim().split('\n').filter(Boolean);
    }
    try {
      if (options.mode === 'merge') await git(cwd, ['merge', '--no-edit', '-m', `Merge ${source} into ${target}`, sourceSha]);
      else if (picks.length) await git(cwd, ['cherry-pick', ...picks]);
    } catch (err) {
      const files = await conflicts(cwd);
      retain = files.length > 0;
      const command = options.mode === 'merge' ? 'merge' : 'cherry-pick';
      if (!retain && (await midOperations(cwd)).length) {
        try {
          await git(cwd, [command, '--abort']);
        } catch {
          await git(cwd, [command, '--quit']);
        }
      }
      const hint = retain ? `Resolve in ${cwd}, git add the files, then git ${command} --continue; or git ${command} --abort.` : `Git's operation was cleared. Correct the Git error before trying again: ${(err as Error).message}`;
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
        ...(retain || !temporary ? { worktree: cwd } : {}),
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
    return {
      status: 'ok' as const,
      summary,
      artifacts: { ...(head !== before && options.mode === 'merge' ? { mergeCommit: head } : {}), commits: commits.map((c) => c.sha), files },
      source,
      sourceSha,
      target,
      before,
      head,
      mode: options.mode,
      commits,
      stat,
    };
  } finally {
    if (temporary && !retain) await git(dir, ['worktree', 'remove', '--force', cwd]);
  }
}
