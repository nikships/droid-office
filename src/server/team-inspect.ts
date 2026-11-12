import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';

export interface DiffWorkerRef {
  id: string;
  name: string;
  worktree?: { path: string; branch: string; base?: string; from?: string };
  /** Set when the subagent was already sent home; uses its kept worktree or branch. */
  dismissed?: boolean;
}

const OUTPUT_MAX = 48_000;

/** No shell, external diff drivers or textconv; output and runtime are bounded even for a huge diff. */
export function inspectGit(cwd: string, args: string[], limit = OUTPUT_MAX): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', (data: Buffer) => {
      const left = Math.max(0, limit - bytes);
      chunks.push(data.subarray(0, left));
      bytes += Math.min(data.length, left);
      if (data.length > left) {
        truncated = true;
        child.kill();
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !truncated) reject(new Error('Git could not read this worker’s repository or revision.'));
      else resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated });
    });
  });
}

export async function workerDiff(dir: string, worker: DiffWorkerRef, base?: string, commits?: number) {
  if (worker.dismissed) {
    if (!worker.worktree) throw new Error(`${worker.name} was already sent home and had no isolated worktree or branch to diff.`);
    const wtPath = path.resolve(dir, worker.worktree.path);
    if (!existsSync(wtPath)) {
      const branch = worker.worktree.branch;
      let tip = '';
      if (branch && !branch.startsWith('-') && !/\s/.test(branch)) {
        try {
          tip = (await inspectGit(dir, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`], 1024)).text.trim();
        } catch {
          // branch no longer exists locally
        }
      }
      if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error(`${worker.name} was sent home and its worktree and branch (${branch || 'unknown'}) were removed.`);
      const revision = commits === undefined ? (base ?? worker.worktree.base ?? tip) : `${tip}~${commits}`;
      if (!revision || revision.startsWith('-') || revision.length > 200 || /\s/.test(revision)) throw new Error('Use a branch, tag or commit without spaces or a leading dash.');
      const resolved = await inspectGit(dir, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], 1024);
      const sha = resolved.text.trim();
      if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('The base does not resolve to a commit.');
      const options = ['--no-ext-diff', '--no-textconv', '--no-color'];
      const [stat, diff] = await Promise.all([inspectGit(dir, ['diff', ...options, '--stat', sha, tip, '--'], 8000), inspectGit(dir, ['diff', ...options, sha, tip, '--'])]);
      return { worker: worker.id, base: sha, ...(commits === undefined ? {} : { commits }), stat: stat.text, diff: diff.text, truncated: stat.truncated || diff.truncated };
    }
  }
  const cwd = worker.worktree ? path.resolve(dir, worker.worktree.path) : dir;
  const revision = commits === undefined ? (base ?? worker.worktree?.base ?? 'HEAD') : `HEAD~${commits}`;
  if (!revision || revision.startsWith('-') || revision.length > 200 || /\s/.test(revision)) throw new Error('Use a branch, tag or commit without spaces or a leading dash.');
  const resolved = await inspectGit(cwd, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], 1024);
  const sha = resolved.text.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('The base does not resolve to a commit.');
  const target = commits === undefined ? [] : ['HEAD'];
  const options = ['--no-ext-diff', '--no-textconv', '--no-color'];
  const [stat, diff] = await Promise.all([inspectGit(cwd, ['diff', ...options, '--stat', sha, ...target, '--'], 8000), inspectGit(cwd, ['diff', ...options, sha, ...target, '--'])]);
  return { worker: worker.id, base: sha, ...(commits === undefined ? {} : { commits }), stat: stat.text, diff: diff.text, truncated: stat.truncated || diff.truncated };
}

/** Report provenance is optional: no remote tracking ref is not an error. No fetch or forge request. */
export async function pushedSha(dir: string, worker: WorkerInfo): Promise<string | undefined> {
  if (!worker.worktree) return undefined;
  try {
    const cwd = path.resolve(dir, worker.worktree.path);
    const [result, head] = await Promise.all([inspectGit(cwd, ['rev-parse', '--verify', '@{upstream}'], 1024), inspectGit(cwd, ['rev-parse', '--verify', 'HEAD'], 1024)]);
    const sha = result.text.trim();
    // A stale tracking tip or an unchanged base is not evidence that this worker pushed its work.
    return /^[0-9a-f]{40,64}$/.test(sha) && sha === head.text.trim() && sha !== worker.worktree.base ? sha : undefined;
  } catch {
    return undefined;
  }
}
