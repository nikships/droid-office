import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPullDetail, GhPull, GhRepoInfo, GhState } from '../shared/protocol.js';
import type { Forge } from '../shared/floors.js';

/** An open pull (or merge) request: its number on the board and its page. */
export interface PullRef {
  number: number;
  url: string;
}

/** What workers and the Changes window need to open a pull request for a branch they pushed. */
export interface PullHost {
  /** Opens a pull request from `head` (already pushed) into `base` (the default branch when unset). */
  createPull(cwd: string, head: string, base: string | undefined, title: string, body: string): Promise<PullRef>;
  /** The open pull request whose head is `branch`, if there is one. */
  findOpenPull(branch: string, cwd: string): Promise<PullRef | undefined>;
  /** The description of an open pull request, so a worker across repositories can list the others in it. */
  pullBody?(ref: PullRef, cwd: string): Promise<string>;
  /** Replaces that description. */
  setPullBody?(ref: PullRef, cwd: string, body: string): Promise<void>;
}

/**
 * A floor's issue and pull request boards, backed by its repository's host: GitHub through `gh`
 * (github.ts) or GitLab through `glab` (gitlab.ts). The lists themselves (refresh, the label overlay,
 * priority, the label cache and the close recheck) are one module over both (board-list.ts). Both
 * speak the same shapes, so the boards and the PR window don't care which one it is.
 */
export interface Board extends PullHost {
  readonly forge: Forge;
  issues: GhState<GhIssue>;
  pulls: GhState<GhPull>;
  stop(): void;
  refresh(): Promise<void>;
  repoInfo(): Promise<GhRepoInfo>;
  /** Who the CLI is signed in as, which is who the office comments as; '' when it can't say. */
  viewer(): Promise<string>;
  pullDetail(n: number): Promise<GhPullDetail>;
  pullDiff(n: number): Promise<string>;
  issueDetail(n: number): Promise<GhIssueDetail>;
  comment(kind: 'issue' | 'pull', n: number, body: string): Promise<{ comment?: GhComment; error?: string }>;
  merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean): Promise<string | undefined>;
  close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }): Promise<string | undefined>;
  claim(issue: number): Promise<string | undefined>;
  /** Every label the repository has, for the label picker. */
  repoLabels(): Promise<GhLabel[]>;
  /** Puts labels on an issue or PR and takes others off. Returns the labels it has now, or why they didn't change. */
  setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[]): Promise<{ labels?: GhLabel[]; error?: string }>;
}

const NOT_GIT = 'This floor is a plain folder, not a git checkout, so it has no issues or pull requests';
const notGit = () => Promise.reject(new Error(NOT_GIT));

/** A plain folder's floor: no repository, so the lists stay empty and nothing asks gh or glab. */
export class NoBoard implements Board {
  readonly forge = 'github' as const;
  issues: GhState<GhIssue> = { items: [], fetchedAt: Date.now(), loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: Date.now(), loading: false };
  stop(): void {
    // nothing runs
  }
  refresh(): Promise<void> {
    return Promise.resolve();
  }
  repoInfo(): Promise<GhRepoInfo> {
    return notGit();
  }
  viewer(): Promise<string> {
    return Promise.resolve('');
  }
  pullDetail(): Promise<GhPullDetail> {
    return notGit();
  }
  pullDiff(): Promise<string> {
    return notGit();
  }
  issueDetail(): Promise<GhIssueDetail> {
    return notGit();
  }
  comment(): Promise<{ comment?: GhComment; error?: string }> {
    return Promise.resolve({ error: NOT_GIT });
  }
  merge(): Promise<string | undefined> {
    return Promise.resolve(NOT_GIT);
  }
  close(): Promise<string | undefined> {
    return Promise.resolve(NOT_GIT);
  }
  claim(): Promise<string | undefined> {
    return Promise.resolve(NOT_GIT);
  }
  repoLabels(): Promise<GhLabel[]> {
    return Promise.resolve([]);
  }
  setLabels(): Promise<{ labels?: GhLabel[]; error?: string }> {
    return Promise.resolve({ error: NOT_GIT });
  }
  createPull(): Promise<PullRef> {
    return notGit();
  }
  findOpenPull(): Promise<PullRef | undefined> {
    return Promise.resolve(undefined);
  }
}

export type BoardListener<T> = (s: GhState<T>) => void;

/**
 * Labels just changed from the office, by "issue:N" or "pull:N". A list asked for before the change
 * still has the old labels, so the new ones are kept over it; a list asked for after the change is
 * believed, and the change forgotten.
 */
export class Relabels {
  private changed = new Map<string, { labels: GhLabel[]; at: number }>();

  set(kind: 'issue' | 'pull', n: number, labels: GhLabel[], at = Date.now()) {
    this.changed.set(`${kind}:${n}`, { labels, at });
  }

  /** `items` as a list asked for at `asked` should show them. */
  apply<T extends GhIssue | GhPull>(kind: 'issue' | 'pull', items: T[], asked: number): T[] {
    return items.map((it) => {
      const key = `${kind}:${it.number}`;
      const r = this.changed.get(key);
      if (!r) return it;
      if (r.at < asked) {
        this.changed.delete(key);
        return it;
      }
      return { ...it, labels: r.labels };
    });
  }
}
