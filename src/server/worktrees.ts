import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LostBranch, WorktreeState } from '../shared/protocol.js';

export type { WorktreeCleanup, WorktreeState } from '../shared/protocol.js';

const execFileP = promisify(execFile);

/** Where the office keeps its workers' worktrees, relative to the project. */
export const WORKTREES_DIR = path.join('.droid-office', 'worktrees');
/** Their branches are office/<worker>-<id>. */
export const BRANCH_PREFIX = 'office/';
/** A fetch this recent is fresh enough for the next worktree: a burst of hires shares one. */
const FETCH_FRESH_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
/** What the office writes into a worker's workspace (see WorkerInfo.repos), besides the worktrees. */
export const WORKSPACE_FILES = new Set(['AGENTS.md']);

export interface WorktreeRef {
  /** Folder relative to the project dir; missing for a branch whose worktree is already gone. */
  path?: string;
  branch: string;
  /** The commit it was branched from, when known. */
  base?: string;
  /** The branch the office made for it, when the worker has since switched to `branch`, one of its own. */
  made?: string;
}

/** Where a new worktree starts (see Worktrees.create). */
export type WorktreeStart =
  /** The latest of origin's default branch, whatever the project's checkout is on. */
  | 'main'
  /** The latest of the branch the project's checkout is on. */
  | 'checkout'
  /** A commit someone picked (a lead's HEAD, say), and the branch it's on, which its pull request targets. */
  | { commit: string; branch?: string };

/** What Worktrees.freshen did to the project's checkout. */
export interface Freshened {
  /** It was on this other branch, and is on the default branch now. */
  switchedFrom?: string;
  /** It isn't on the latest of the default branch, and why. */
  kept?: string;
  /** The branch it's on afterwards. */
  branch?: string;
  /** The default branch it was brought to (or meant to be). */
  main?: string;
}

export interface WorktreeOwnership {
  branch: string;
  existing: string[];
  createdAt: number;
}

export interface ListedWorktree {
  /** Relative to the project dir. */
  path: string;
  branch?: string;
  head: string;
}

/** Git plumbing for the worktrees the office makes for its workers: hiring, sending home and pruning. */
export class Worktrees {
  /** The project dir with symlinks resolved, so it compares with the paths git prints. */
  private readonly root: string;
  /** When each branch was last fetched, and the fetches under way, by branch. */
  private fetchedAt = new Map<string, number>();
  private fetching = new Map<string, Promise<void>>();
  /** The last fetch's error, so the office's log says it once rather than on every hire. */
  private fetchError?: string;

  constructor(private dir: string) {
    this.root = real(dir);
  }

  /**
   * A new branch and worktree, from where `start` says (see startOf). `from` is the branch it was
   * cut from, which the worker's pull request targets; `note` says when commits the project has were
   * left out. Returns what went wrong as a string. Does not move the project's checkout.
   *
   * For a worker across repositories, `sub` puts it in the folder of that name in the workspace
   * `slug`, which is in `root` (the worker's own floor, when that isn't this project). The path it
   * returns is relative to `root`.
   */
  create(slug: string, sub?: string, root = this.dir, start: WorktreeStart = 'checkout'): (Required<Omit<WorktreeRef, 'made'>> & { from?: string; note?: string }) | string {
    try {
      const { base, from, note } = this.startOf(start);
      const rel = path.join(WORKTREES_DIR, slug, sub ?? '');
      const branch = `${BRANCH_PREFIX}${slug}`;
      this.gitSync(['worktree', 'add', '-b', branch, path.resolve(root, rel), base]);
      return { path: rel, branch, base, from, note };
    } catch (err) {
      return `Could not create a git worktree: ${gitError(err)}`;
    }
  }

  /** The branch a worktree made from `start` is cut from: the default branch for 'main' (the checkout's when there's none). */
  private branchFor(start: 'main' | 'checkout'): string | undefined {
    return start === 'main' ? (this.defaultBranch() ?? this.currentBranch()) : this.currentBranch();
  }

  private startOf(start: WorktreeStart): { base: string; from?: string; note?: string } {
    if (typeof start === 'object') return { base: start.commit, from: start.branch };
    const from = this.branchFor(start);
    return { from, ...this.startPoint(from) };
  }

  /**
   * Brings origin's copy of the branch a worktree made from `start` is cut from up to date, so it
   * starts from what's on the forge now (a pull request merged since, say) rather than from a checkout
   * nobody pulled. Resolves either way: offline, or with no origin, worktrees start from what's here.
   * Undefined when there's nothing to wait for (a fetch this recent, or no branch to fetch). Never
   * checks out or clones.
   */
  fetch(start: 'main' | 'checkout' = 'checkout'): Promise<void> | undefined {
    const from = this.branchFor(start);
    if (!from) return undefined;
    const under = this.fetching.get(from);
    if (under) return under;
    if (Date.now() - (this.fetchedAt.get(from) ?? 0) < FETCH_FRESH_MS || !this.hasOrigin()) return undefined;
    // Never stop to ask for a password: there's nobody at the office's terminal to type it.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const fetching = execFileP('git', ['fetch', '--quiet', '--no-tags', 'origin', from], { cwd: this.dir, env, timeout: FETCH_TIMEOUT_MS })
      .then(
        () => {
          this.fetchError = undefined;
        },
        (err) => {
          // Its first complaint says what's wrong; the last line is advice about access rights.
          const why =
            String((err as { stderr?: string }).stderr ?? '')
              .split('\n')
              .find((l) => /^(fatal|error):/.test(l)) ?? gitError(err);
          if (why !== this.fetchError) console.warn(`droid-office: couldn't fetch origin/${from} in ${this.dir}, so new workers start from what's here: ${why}`);
          this.fetchError = why;
        },
      )
      .then(() => {
        this.fetchedAt.set(from, Date.now());
        this.fetching.delete(from);
      });
    this.fetching.set(from, fetching);
    return fetching;
  }

  /**
   * origin's default branch (what origin/HEAD points at), else main or master, on origin or here.
   * Undefined when the project has none of those.
   */
  defaultBranch(): string | undefined {
    try {
      const head = this.gitSync(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      if (head.startsWith('origin/') && head.length > 'origin/'.length) return head.slice('origin/'.length);
    } catch {
      // origin/HEAD is only set by a clone (or `git remote set-head`)
    }
    return ['main', 'master'].find((b) => this.commitOf(`refs/remotes/origin/${b}`) || this.commitOf(`refs/heads/${b}`));
  }

  /**
   * A branch, tag or commit as a worktree's start, read in `cwd` (a lead's worktree, whose HEAD is
   * its own): the commit, and the branch when it names one (`origin/x` and a branch only on origin
   * count, as x). Undefined when there's no such thing.
   */
  resolve(ref: string, cwd = this.dir): { commit: string; branch?: string } | undefined {
    const at = (r: string) => {
      try {
        return this.gitSync(['rev-parse', '--verify', '--quiet', `${r}^{commit}`], cwd);
      } catch {
        return undefined;
      }
    };
    if (ref === 'HEAD') {
      const commit = at('HEAD');
      if (!commit) return undefined;
      const b = this.gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      return { commit, ...(b && b !== 'HEAD' ? { branch: b } : {}) };
    }
    const candidates: [string, string | undefined][] = [
      [`refs/heads/${ref}`, ref],
      [`refs/remotes/${ref}`, ref.startsWith('origin/') ? ref.slice('origin/'.length) : undefined],
      [`refs/remotes/origin/${ref}`, ref],
      [ref, undefined],
    ];
    for (const [r, branch] of candidates) {
      const commit = at(r);
      if (commit) return { commit, ...(branch ? { branch } : {}) };
    }
    return undefined;
  }

  /**
   * Brings the project's checkout to the latest of the default branch, for a worker about to start in
   * it: switches over from another branch, then fast-forwards to origin's copy (fetched beforehand,
   * see fetch). Leaves it as it is, and says why, whenever that could get in someone's way: `busy`
   * names whoever else is working in it, and uncommitted changes on another branch, a merge or rebase
   * under way, a detached HEAD, commits on the default branch that origin doesn't have, or anything
   * git refuses (an untracked file in the way, say) keep it too. Never stashes, resets or discards.
   */
  freshen(busy: string[] = []): Freshened {
    const main = this.defaultBranch();
    if (!main) return {};
    const current = this.currentBranch();
    const latest = this.commitOf(`refs/remotes/origin/${main}`);
    const head = this.commitOf('HEAD');
    if (current === main && (!latest || (head && this.isAncestor(latest, head)))) return { branch: main, main };
    const kept = (why: string, branch = current): Freshened => ({ kept: why, main, ...(branch ? { branch } : {}) });
    if (busy.length) {
      const who = busy.length === 1 ? busy[0] : `${busy.slice(0, -1).join(', ')} and ${busy[busy.length - 1]}`;
      return kept(`${who} ${busy.length === 1 ? 'is' : 'are'} working in it`);
    }
    if (this.midOperation()) return kept('a merge, rebase or cherry-pick is under way there');
    if (!current) return kept("it isn't on a branch");
    const local = this.commitOf(`refs/heads/${main}`);
    // The local branch can simply move up to origin's: nothing on it would be left behind.
    const behind = !!latest && (!local || this.isAncestor(local, latest));
    let switchedFrom: string | undefined;
    if (current !== main) {
      const dirty = this.gitSync(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean).length;
      if (dirty) return kept(`it has ${dirty} uncommitted change${dirty === 1 ? '' : 's'} on ${current}`);
      try {
        // One checkout straight to where it ends up, so git refusing leaves everything as it was.
        if (behind && local) this.gitSync(['switch', '--quiet', '-C', main, `refs/remotes/origin/${main}`]);
        else if (behind) this.gitSync(['switch', '--quiet', '--create', main, '--track', `origin/${main}`]);
        else if (local) this.gitSync(['switch', '--quiet', main]);
        else return kept(`it has no ${main} branch`);
      } catch (err) {
        return kept(`git wouldn't switch it to ${main}: ${gitRefusal(err)}`);
      }
      switchedFrom = current;
    }
    const done: Freshened = { main, branch: main, ...(switchedFrom ? { switchedFrom } : {}) };
    const now = this.commitOf('HEAD');
    if (!latest || !now || this.isAncestor(latest, now)) return done;
    if (!this.isAncestor(now, latest)) {
      const n = Number(this.gitSync(['rev-list', '--count', now, '--not', latest]));
      return { ...done, kept: `${main} here has ${n} commit${n === 1 ? '' : 's'} that origin doesn't have, so it wasn't brought up to origin/${main}` };
    }
    try {
      this.gitSync(['merge', '--ff-only', '--quiet', `refs/remotes/origin/${main}`]);
    } catch (err) {
      return { ...done, kept: `git wouldn't bring ${main} up to origin/${main}: ${gitRefusal(err)}` };
    }
    return done;
  }

  /** A merge, rebase, cherry-pick, revert or bisect is under way in the project's checkout. */
  private midOperation(): boolean {
    return ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'].some((p) => {
      try {
        return existsSync(path.resolve(this.dir, this.gitSync(['rev-parse', '--git-path', p])));
      } catch {
        return false;
      }
    });
  }

  private commitOf(ref: string): string | undefined {
    try {
      return this.gitSync(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    } catch {
      return undefined;
    }
  }

  private hasOrigin(): boolean {
    try {
      return !!this.gitSync(['remote', 'get-url', 'origin']);
    } catch {
      return false;
    }
  }

  /**
   * Where a worktree cut from `from` starts: origin's copy of it, which its pull request goes to, so
   * it has every PR merged there even if nobody pulled them into the project. The project's own copy
   * instead when it already has all of that (it's ahead with commits not pushed yet), or when origin
   * doesn't have the branch; HEAD when neither has it.
   */
  private startPoint(from: string | undefined): { base: string; note?: string } {
    const head = this.gitSync(['rev-parse', 'HEAD']);
    if (!from) return { base: head };
    const local = from === this.currentBranch() ? head : this.commitOf(`refs/heads/${from}`);
    const remote = this.commitOf(`refs/remotes/origin/${from}`);
    if (!remote) return { base: local ?? head };
    if (!local || this.isAncestor(local, remote)) return { base: remote };
    if (this.isAncestor(remote, local)) return { base: local };
    // Both moved on: the PR goes to origin's, so start there and say what's left behind.
    const n = Number(this.gitSync(['rev-list', '--count', local, '--not', remote]));
    return { base: remote, note: `starts from origin/${from}, without the ${n} commit${n === 1 ? '' : 's'} on ${from} that origin doesn't have` };
  }

  private isAncestor(a: string, b: string): boolean {
    try {
      this.gitSync(['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  }

  /** The git folder every worktree of this project shares, to tell two checkouts of one repository apart from two repositories. */
  commonDir(): string | undefined {
    try {
      return real(path.resolve(this.dir, this.gitSync(['rev-parse', '--git-common-dir'])));
    } catch {
      return undefined;
    }
  }

  /** The branch the project is on, or undefined when HEAD is detached. */
  currentBranch(): string | undefined {
    try {
      const b = this.gitSync(['rev-parse', '--abbrev-ref', 'HEAD']);
      return b === 'HEAD' ? undefined : b;
    } catch {
      return undefined;
    }
  }

  /**
   * The branch a worktree is on now, which may be one the worker made itself; undefined when HEAD
   * is detached (mid-rebase, say) or the folder is gone.
   */
  async branchOf(wt: WorktreeRef): Promise<string | undefined> {
    if (!wt.path) return undefined;
    const abs = path.join(this.dir, wt.path);
    if (!existsSync(abs)) return undefined;
    const b = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], abs).catch(() => '');
    return b && b !== 'HEAD' ? b : undefined;
  }

  /**
   * Whether `branch` was made since `than` was, going by the first line of each one's reflog: a
   * worker's own branch, made after the office made it one. False when git can't say.
   */
  async madeSince(branch: string, than: string): Promise<boolean> {
    const [a, b] = await Promise.all([this.createdAt(branch), this.createdAt(than)]);
    return a !== undefined && b !== undefined && a >= b;
  }

  /** When a branch was made (seconds), while its reflog still starts there. */
  private async createdAt(branch: string): Promise<number | undefined> {
    const log = await this.git(['log', '-g', '--date=unix', '--format=%gd %gs', `refs/heads/${branch}`, '--']).catch(() => '');
    const first = /@\{(\d+)\} branch: Created from /.exec(log.split('\n').filter(Boolean).pop() ?? '');
    return first ? Number(first[1]) : undefined;
  }

  /** Where a branch still is: in the project, only on origin (it was pushed), or nowhere. */
  branchState(branch: string): LostBranch {
    const has = (ref: string) => {
      try {
        this.gitSync(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    };
    return has(`refs/heads/${branch}`) ? 'here' : has(`refs/remotes/origin/${branch}`) ? 'origin' : 'gone';
  }

  /**
   * Puts back a worktree whose folder was deleted outside the office, where it was: on its branch
   * while that's still here, else on origin's copy of it, else on the branch made again from where it
   * started (`base`, or HEAD when even that commit is gone). Says which, or what went wrong.
   */
  async restore(wt: WorktreeRef): Promise<{ from: LostBranch } | { error: string }> {
    if (!wt.path) return { error: 'it has no folder to put back' };
    const abs = path.join(this.dir, wt.path);
    try {
      // Git still lists the deleted folder, and won't check its branch out anywhere else while it does.
      await this.git(['worktree', 'prune']);
      const from = this.branchState(wt.branch);
      if (from === 'here') await this.git(['worktree', 'add', abs, wt.branch]);
      else if (from === 'origin') await this.git(['worktree', 'add', '-b', wt.branch, abs, `refs/remotes/origin/${wt.branch}`]);
      else {
        const base =
          wt.base &&
          (await this.git(['cat-file', '-e', `${wt.base}^{commit}`]).then(
            () => true,
            () => false,
          ))
            ? wt.base
            : 'HEAD';
        await this.git(['worktree', 'add', '-b', wt.branch, abs, base]);
      }
      return { from };
    } catch (err) {
      return { error: gitError(err) };
    }
  }

  /** Whether a branch is still there: not once it's deleted, or renamed (`git branch -m`). */
  async hasBranch(branch: string): Promise<boolean> {
    return this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(
      () => true,
      () => false,
    );
  }

  /** Recorded before the agent starts, so same-second reflogs cannot make a pre-existing branch its own. */
  ownership(branch: string): WorktreeOwnership {
    return {
      branch,
      existing: this.gitSync(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
        .split('\n')
        .filter((b) => b && b !== branch),
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Whether `from` was renamed to `branch` (`git branch -m`), going by the reflog that moved with it.
   * Only the rename line counts. "Created from" and a deleted branch are not a rename: git can't say
   * the branch the worktree is on is the office's, so send-home must leave that branch alone.
   */
  async renamedTo(from: string, branch: string): Promise<boolean> {
    const log = await this.git(['log', '-g', '--format=%gs', `refs/heads/${branch}`, '--']).catch(() => '');
    return log.split('\n').includes(`Branch: renamed refs/heads/${from} to refs/heads/${branch}`);
  }

  /**
   * What deleting `branch` would lose that no remote, the project's checkout or the `besides`
   * branches have, as describeWork says it; '' when nothing.
   */
  async wouldLose(branch: string, besides: string[] = []): Promise<string> {
    const state: WorktreeState = { exists: false, dirty: 0, ahead: 0, unpushed: 0 };
    try {
      state.unpushed = Number(await this.git(['rev-list', '--count', branch, '--not', 'HEAD', '--remotes', ...besides, '--']));
    } catch (err) {
      state.error = gitError(err);
    }
    return describeWork(state);
  }

  /**
   * What a worktree holds: uncommitted changes, commits since it was made, and the commits only it has.
   * `landed` is a commit already delivered (the head of its merged pull request): it and the commits
   * before it don't count as unpushed, even once the forge has deleted the branch.
   */
  async inspect(wt: WorktreeRef, landed?: string): Promise<WorktreeState> {
    const abs = wt.path ? path.join(this.dir, wt.path) : undefined;
    const exists = !!abs && existsSync(abs);
    const state: WorktreeState = { exists, dirty: 0, ahead: 0, unpushed: 0 };
    try {
      if (exists) state.dirty = (await this.git(['status', '--porcelain'], abs)).split('\n').filter(Boolean).length;
      // A commit this checkout never fetched (the forge updated the branch itself) can't be left out.
      const known =
        landed &&
        /^[0-9a-f]{40,64}$/.test(landed) &&
        (await this.git(['cat-file', '-e', `${landed}^{commit}`]).then(
          () => true,
          () => false,
        ));
      // The office's own branch, when the worker has moved to another, holds its work too.
      const made = wt.made && wt.made !== wt.branch && (await this.hasBranch(wt.made)) ? [wt.made] : [];
      // On no remote and not in the project's own checkout either: what deleting the branch would lose.
      state.unpushed = Number(await this.git(['rev-list', '--count', wt.branch, ...made, '--not', 'HEAD', '--remotes', ...(known ? [landed] : [])]));
      state.ahead = Number(await this.git(['rev-list', '--count', wt.branch, ...made, '--not', wt.base ?? 'HEAD']).catch(() => state.unpushed));
    } catch (err) {
      state.error = gitError(err);
    }
    return state;
  }

  /** Deletes the worktree folder, and the branch too for 'all'. Returns what went wrong, if anything. */
  async remove(wt: WorktreeRef, cleanup: 'worktree' | 'all'): Promise<string | undefined> {
    try {
      if (wt.path) {
        const abs = path.join(this.dir, wt.path);
        if (existsSync(abs)) {
          try {
            await this.git(['worktree', 'remove', '--force', '--force', abs]);
          } catch (err) {
            // Git won't (a lock, a submodule), but it is the office's own folder: take it out ourselves.
            if (!this.owns(abs)) throw err;
            await rm(abs, { recursive: true, force: true });
          }
        }
      }
      // Forget worktrees whose folders are gone: this one, and any someone rm -rf'd by hand.
      await this.git(['worktree', 'prune']);
      if (cleanup === 'all') {
        // The office's own branch, left behind when the worker made one of its own: it goes too,
        // unless it has commits that no remote, the project's checkout or that one has.
        const made = wt.made && wt.made !== wt.branch && !(await this.wouldLose(wt.made, [wt.branch])) ? wt.made : undefined;
        await this.git(['branch', '-D', wt.branch]);
        if (made) await this.git(['branch', '-D', made]).catch(() => undefined);
      }
      return undefined;
    } catch (err) {
      return gitError(err);
    }
  }

  /** Gun dismissal: discard owned work, never a project checkout or a branch that predates this worker. */
  async dismiss(wt: WorktreeRef, home = this.dir, ownership?: WorktreeOwnership): Promise<string | undefined> {
    try {
      if (!wt.path) throw new Error('the worker has no owned worktree folder');
      const abs = path.resolve(this.dir, wt.path);
      if (!within(path.join(real(home), WORKTREES_DIR), real(abs))) throw new Error('refusing to delete a worktree outside the owning office');
      if (existsSync(abs) && real(path.resolve(abs, await this.git(['rev-parse', '--git-common-dir'], abs))) !== this.commonDir()) throw new Error('the worktree belongs to a different repository');
      const original = ownership?.branch ?? wt.made ?? wt.branch;
      const branches = new Set<string>();
      if (original.startsWith(BRANCH_PREFIX)) branches.add(original);
      const candidates = new Set([wt.branch]);
      if (existsSync(abs)) {
        const live = await this.branchOf(wt);
        if (live) candidates.add(live);
        // Includes earlier branches the worker created and left behind, not just the active one.
        const log = await this.git(['reflog', 'show', '--format=%gs', 'HEAD'], abs);
        for (const line of log.split('\n')) {
          const checkout = /^checkout: moving from (\S+) to (\S+)$/.exec(line);
          if (checkout) {
            candidates.add(checkout[1]);
            candidates.add(checkout[2]);
          }
        }
      }
      for (const branch of candidates) {
        if (branch === this.currentBranch() || ownership?.existing.includes(branch) || !(await this.hasBranch(branch))) continue;
        if (await this.renamedTo(original, branch)) branches.add(branch);
        else if (ownership) {
          const createdAt = await this.createdAt(branch);
          if (createdAt !== undefined && createdAt >= ownership.createdAt) branches.add(branch);
        } else if (branch !== original && (await this.madeSince(branch, original))) {
          // Old state has no branch inventory: ties cannot prove that a branch wasn't already there.
          const [createdAt, originalAt] = await Promise.all([this.createdAt(branch), this.createdAt(original)]);
          if (createdAt !== undefined && originalAt !== undefined && createdAt > originalAt) branches.add(branch);
        }
      }
      branches.delete(this.currentBranch() ?? '');
      // Unlike ordinary send-home, this does not consult dirty/unpushed or wouldLose protections.
      if (existsSync(abs)) {
        try {
          await this.git(['worktree', 'remove', '--force', '--force', abs]);
        } catch (err) {
          // Across repositories this folder is inside the owning office, not this repository's office.
          if (!within(path.join(real(home), WORKTREES_DIR), real(abs))) throw err;
          await rm(abs, { recursive: true, force: true });
        }
      }
      await this.git(['worktree', 'prune']);
      const errors: string[] = [];
      for (const branch of branches) {
        if (!(await this.hasBranch(branch))) continue;
        try {
          await this.git(['branch', '-D', branch]);
        } catch (err) {
          errors.push(`${branch}: ${gitError(err)}`);
        }
      }
      return errors.length ? errors.join('; ') : undefined;
    } catch (err) {
      return gitError(err);
    }
  }

  /**
   * The worktrees git has under .droid-office/worktrees, every office/* branch, and folders there git
   * doesn't know. A workspace (a worker across repositories) is a folder there with worktrees in it,
   * not a stray. `elsewhere` are office/* branches checked out somewhere else: in another floor's
   * workspace, by a worker across repositories that this project's office doesn't list.
   */
  async list(): Promise<{ worktrees: ListedWorktree[]; branches: string[]; strays: string[]; elsewhere: Map<string, string> }> {
    const home = path.join(this.root, WORKTREES_DIR);
    const worktrees: ListedWorktree[] = [];
    const elsewhere = new Map<string, string>();
    let cur: ListedWorktree | undefined;
    let abs = '';
    for (const line of (await this.git(['worktree', 'list', '--porcelain'])).split('\n')) {
      if (line.startsWith('worktree ')) {
        abs = real(line.slice('worktree '.length));
        cur = within(home, abs) ? { path: path.relative(this.root, abs), head: '' } : undefined;
        if (cur) worktrees.push(cur);
      } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) {
        const branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        if (cur) cur.branch = branch;
        else if (branch.startsWith(BRANCH_PREFIX)) elsewhere.set(branch, abs);
      }
    }
    const branches = (await this.git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${BRANCH_PREFIX}`])).split('\n').filter(Boolean);
    const known = worktrees.map((w) => path.join(this.root, w.path));
    const strays = existsSync(home)
      ? readdirSync(home)
          .map((n) => path.join(home, n))
          .filter((p) => !known.some((k) => k === p || within(p, k)) && isDir(p))
          .map((p) => path.relative(this.root, p))
      : [];
    return { worktrees, branches, strays, elsewhere };
  }

  /** True for a folder inside .droid-office/worktrees, the only place this class deletes on its own. */
  owns(abs: string): boolean {
    return within(path.join(this.root, WORKTREES_DIR), real(abs));
  }

  private gitSync(args: string[], cwd = this.dir): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
  }

  private async git(args: string[], cwd = this.dir): Promise<string> {
    const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  }
}

/**
 * Where a worker works: its worktree, or for a worker across repositories the workspace folder its
 * worktrees are in. Relative to its floor's dir; undefined for the floor's own checkout.
 */
export function workspaceOf(info: { worktree?: { path: string }; repos?: unknown[] }): string | undefined {
  if (!info.worktree) return undefined;
  return info.repos?.length ? path.dirname(info.worktree.path) : info.worktree.path;
}

/** Why deleting this would lose something ("2 uncommitted changes, 1 unpushed commit"), or '' when it wouldn't. */
export function describeWork(s: WorktreeState): string {
  if (s.error) return `could not check it (${s.error})`;
  const parts: string[] = [];
  if (s.dirty) parts.push(`${s.dirty} uncommitted change${s.dirty === 1 ? '' : 's'}`);
  if (s.unpushed) parts.push(`${s.unpushed} unpushed commit${s.unpushed === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** The last line git printed, which is the one that says what's wrong. */
export function gitError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (
    String(e.stderr || e.message || err)
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop() ?? 'git failed'
  );
}

/**
 * Why git refused a checkout or merge, and the files it named: its last line is only "Aborting".
 */
function gitRefusal(err: unknown): string {
  const lines = String((err as { stderr?: string }).stderr ?? '').split('\n');
  const i = lines.findIndex((l) => /^(error|fatal):/.test(l));
  if (i < 0) return gitError(err);
  const why = lines[i].replace(/^(error|fatal):\s*/, '').replace(/:$/, '');
  const files = lines
    .slice(i + 1)
    .filter((l) => l.startsWith('\t'))
    .map((l) => l.trim());
  if (!files.length) return why;
  return `${why}: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
