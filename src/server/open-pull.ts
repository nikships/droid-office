import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Worktrees } from './worktrees.js';

const execFileP = promisify(execFile);

/**
 * Where a pull request's base comes from. Blanks are dropped. Desk O and the Changes window both
 * pass these, and `choosePullBase` asks `Worktrees.pushedBranch` once.
 */
export interface PullBaseFacts {
  /** The branch the work was cut from (`wt.from`, or the Changes target's recorded base). */
  from?: string;
  /** The floor's configured base: the branch the checkout was on when the office opened it. */
  configured?: string;
  /** The checkout's current branch. */
  current?: string;
  /** The repository's default branch. */
  defaultBranch?: string;
}

/** The first candidate that exists on origin and is not `head`. Undefined: the forge picks its default. */
export function choosePullBase(trees: Worktrees, head: string, facts: PullBaseFacts): Promise<string | undefined> {
  return trees.pushedBranch([facts.from, facts.configured, facts.current, facts.defaultBranch], head);
}

/** Whether the checkout has uncommitted changes. One status read. */
export async function checkoutDirty(cwd: string): Promise<boolean> {
  return (await git(['status', '--porcelain=v1', '-z', '-uall'], cwd)) !== '';
}

/**
 * Pushes `head` and sets it to track `origin`, or the checkout's first remote when it has no origin.
 * Rejects when there is no remote, or with the remote's complaint.
 */
export async function pushBranch(cwd: string, head: string, timeoutMs: number): Promise<void> {
  const remotes = (await git(['remote'], cwd)).split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) throw new Error('This project has no git remote to push to');
  await git(['push', '-u', remote, head], cwd, timeoutMs);
}

/** The last line git printed, which is the one that says what's wrong. */
function git(args: string[], cwd: string, timeout = 30_000): Promise<string> {
  return execFileP('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }).then(
    ({ stdout }) => stdout.replace(/\n$/, ''),
    (err: { stderr?: string; message?: string; killed?: boolean }) => {
      if (err.killed) throw new Error(`git ${args[0]} took more than ${Math.round(timeout / 1000)}s and was stopped`);
      const line = String(err.stderr || err.message || err)
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop();
      throw new Error(line || `git ${args[0]} failed`);
    },
  );
}
