import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PullHost, PullRef } from './forge.js';
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
 * An open pull request for `head`. `known` null means the caller already looked and there isn't one;
 * left out, the forge is asked once.
 */
export async function existingPull(pulls: PullHost, head: string, cwd: string, known?: PullRef | null): Promise<PullRef | undefined> {
  if (known) return known;
  if (known === null) return undefined;
  return pulls.findOpenPull(head, cwd);
}

/** `origin` when the checkout has it, otherwise its first remote. Undefined when it has none. */
export async function pushRemote(cwd: string): Promise<string | undefined> {
  const remotes = (await git(['remote'], cwd)).split('\n').filter(Boolean);
  return remotes.includes('origin') ? 'origin' : remotes[0];
}

/** Pushes `head` and sets it to track `remote`. Rejects with the remote's complaint. */
export function pushHead(cwd: string, remote: string, head: string, timeoutMs: number): Promise<void> {
  return git(['push', '-u', remote, head], cwd, timeoutMs).then(() => undefined);
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
