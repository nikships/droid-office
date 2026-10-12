import { execFile } from 'node:child_process';
import type { GhCheck, GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhReviewComment, GhState } from '../shared/protocol.js';
import { BoardList } from './board-list.js';
import type { Board, PullHost, PullRef } from './forge.js';

/** Turns gh's stderr into something a person standing at the board can act on. */
function friendly(raw: string): string {
  if (/no git remotes found|none of the git remotes/i.test(raw)) return 'This project has no GitHub remote yet. Push it to GitHub (git remote add origin <url>) to fill the boards.';
  if (/not a git repository/i.test(raw)) return "This folder isn't a git repository";
  if (/auth login|not logged in|authentication/i.test(raw)) return "gh isn't logged in on the server — run `gh auth login`";
  if (/could not resolve to a repository|not found/i.test(raw)) return "gh can't find this repository on GitHub (check the remote and access)";
  return raw;
}

export function gh(args: string[], cwd: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim().split('\n').slice(-2).join(' ');
        reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'GitHub CLI (gh) is not installed on the server' : friendly(msg)));
      } else resolve(stdout);
    });
  });
}

function labels(raw: any[]): GhLabel[] {
  return (raw ?? []).map((l) => ({ name: String(l.name), color: `#${l.color ?? '888888'}` }));
}

function checksOf(rollup: any[]): GhPull['checks'] {
  if (!rollup?.length) return 'none';
  let pending = false;
  for (const c of rollup) {
    const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
    const status = String(c.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(concl)) return 'fail';
    if (status && status !== 'COMPLETED') pending = true;
    if (concl === 'PENDING' || concl === 'EXPECTED') pending = true;
  }
  return pending ? 'pending' : 'pass';
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];

/** One entry of statusCheckRollup: a CheckRun (Actions) or a StatusContext (other CI). */
function checkOf(c: any): GhCheck {
  const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
  const status = String(c.status ?? '').toUpperCase();
  let state: GhCheck['state'] = 'pass';
  if (FAILED.includes(concl)) state = 'fail';
  else if ((status && status !== 'COMPLETED') || !concl || concl === 'PENDING' || concl === 'EXPECTED') state = 'pending';
  else if (['SKIPPED', 'NEUTRAL', 'STALE'].includes(concl)) state = 'skip';
  const name = String(c.name ?? c.context ?? 'check');
  return { name: c.workflowName ? `${c.workflowName} / ${name}` : name, state, url: c.detailsUrl ?? c.targetUrl ?? undefined };
}

function commentsOf(raw: any[]): GhComment[] {
  return (raw ?? []).map((c: any) => ({
    id: String(c.id),
    author: c.author?.login ?? 'ghost',
    body: String(c.body ?? ''),
    createdAt: c.createdAt ?? c.submittedAt ?? '',
    url: c.url,
    state: c.state,
  }));
}

/**
 * Spots pull requests that merged between two looks at the list, so the gong rings however they
 * merged: from the PR window, by a worker's `gh pr merge`, by auto-merge, or on GitHub itself.
 */
export class MergeWatch {
  /** Open at the last look; unset until the first, so starting the office up rings for nothing. */
  private open?: Set<number>;
  /** Rang for already (merged from the PR window), so the next look doesn't ring them again. */
  private rang = new Set<number>();

  /** The gong rings for `n`: false if it already has. */
  ring(n: number): boolean {
    if (this.rang.has(n)) return false;
    this.rang.add(n);
    return true;
  }

  /** A fresh list from GitHub: the pull requests that merged since the last look and haven't rung yet. */
  look(pulls: GhPull[]): GhPull[] {
    const open = this.open;
    const merged = open ? pulls.filter((p) => p.state === 'MERGED' && open.has(p.number) && !this.rang.has(p.number)) : [];
    // Once GitHub says it merged, it never shows as open again to ring twice.
    for (const p of pulls) if (p.state === 'MERGED') this.rang.delete(p.number);
    this.open = new Set(pulls.filter((p) => p.state === 'OPEN').map((p) => p.number));
    return merged;
  }
}

/** Pull requests on GitHub, opened and found with `gh` in the branch's checkout. */
export const githubPulls: PullHost = {
  async createPull(cwd, head, base, title, body) {
    const out = await gh(['pr', 'create', '--head', head, ...(base ? ['--base', base] : []), '--title', title, '--body', body], cwd, 120_000);
    const url = out.trim().split('\n').pop() ?? '';
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!number) throw new Error(`gh did not return a pull request URL (${out.trim().slice(0, 120)})`);
    return { number, url };
  },
  async findOpenPull(branch, cwd): Promise<PullRef | undefined> {
    const out = await gh(['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number,url'], cwd);
    const found = (JSON.parse(out || '[]') as PullRef[])[0];
    return found ? { number: found.number, url: found.url } : undefined;
  },
  async pullBody(ref, cwd) {
    return (await gh(['pr', 'view', ref.url, '--json', 'body', '--jq', '.body'], cwd)).trim();
  },
  async setPullBody(ref, cwd, body) {
    await gh(['pr', 'edit', ref.url, '--body', body], cwd);
  },
};

export class GitHub implements Board {
  readonly forge = 'github' as const;
  readonly createPull = githubPulls.createPull;
  readonly findOpenPull = githubPulls.findOpenPull;
  readonly pullBody = githubPulls.pullBody;
  readonly setPullBody = githubPulls.setPullBody;
  private lists: BoardList;
  private repo?: Promise<GhRepoInfo>;
  private login?: Promise<string>;

  constructor(
    private dir: string,
    onIssues: (s: GhState<GhIssue>) => void,
    onPulls: (s: GhState<GhPull>) => void,
  ) {
    this.lists = new BoardList(
      {
        listIssues: () => this.fetchIssues(),
        listPulls: () => this.fetchPulls(),
        listLabels: () => this.fetchLabels(),
        applyLabels: (kind, n, add, remove) => this.changeLabels(kind, n, add, remove),
      },
      onIssues,
      onPulls,
    );
  }

  get issues() {
    return this.lists.issues;
  }

  get pulls() {
    return this.lists.pulls;
  }

  /** Its own 90s look. Floor never calls this: the floor's timer calls refresh. */
  start() {
    this.lists.start();
  }

  stop() {
    this.lists.stop();
  }

  refresh() {
    return this.lists.refresh();
  }

  /** The repository's full name and how it lets PRs merge. Asked once (again after a failure). */
  repoInfo(): Promise<GhRepoInfo> {
    this.repo ??= gh(['repo', 'view', '--json', 'nameWithOwner,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'], this.dir).then((out) => {
      const r = JSON.parse(out);
      const methods = (['squash', 'merge', 'rebase'] as const).filter((m) => r[{ squash: 'squashMergeAllowed', merge: 'mergeCommitAllowed', rebase: 'rebaseMergeAllowed' }[m]]);
      return { nameWithOwner: String(r.nameWithOwner), methods: methods.length ? methods : ['squash', 'merge', 'rebase'] };
    });
    this.repo.catch(() => (this.repo = undefined));
    return this.repo;
  }

  /** Who gh is signed in as, which is who the office comments as. Asked once; '' when gh can't say. */
  viewer(): Promise<string> {
    this.login ??= gh(['api', 'user', '--jq', '.login'], this.dir).then((out) => out.trim());
    this.login.catch(() => (this.login = undefined));
    return this.login.catch(() => '');
  }

  /** A PR's description, conversation, line comments, checks and whether it can merge. */
  async pullDetail(n: number): Promise<GhPullDetail> {
    const fields = 'number,body,state,isDraft,reviewDecision,headRefName,baseRefName,mergeable,mergeStateStatus,commits,comments,reviews,statusCheckRollup';
    const jq = '.[] | {id, in_reply_to_id, path, line, side, body, user: .user.login, created_at, html_url}';
    const [view, lines, repo, viewer] = await Promise.all([
      gh(['pr', 'view', String(n), '--json', fields], this.dir),
      gh(['api', `repos/{owner}/{repo}/pulls/${n}/comments?per_page=100`, '--paginate', '--jq', jq], this.dir),
      this.repoInfo(),
      this.viewer(),
    ]);
    const p = JSON.parse(view);
    const reviewComments: GhReviewComment[] = lines
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .map((c: any) => ({
        id: c.id,
        replyTo: c.in_reply_to_id ?? undefined,
        author: c.user ?? 'ghost',
        body: String(c.body ?? ''),
        createdAt: c.created_at,
        url: c.html_url,
        path: c.path,
        line: c.line ?? null,
        side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      }));
    return {
      number: p.number,
      body: String(p.body ?? ''),
      state: p.state,
      isDraft: !!p.isDraft,
      reviewDecision: p.reviewDecision ?? '',
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      mergeable: p.mergeable ?? 'UNKNOWN',
      mergeStateStatus: p.mergeStateStatus ?? 'UNKNOWN',
      commits: (p.commits ?? []).length,
      comments: commentsOf(p.comments),
      // A line comment also makes an empty COMMENTED review; the comment itself is shown instead.
      reviews: commentsOf(p.reviews).filter((r) => r.body.trim() || r.state !== 'COMMENTED'),
      reviewComments,
      checks: (p.statusCheckRollup ?? []).map(checkOf),
      repo,
      viewer,
    };
  }

  /** The PR's unified diff, as `git diff` prints it. */
  pullDiff(n: number): Promise<string> {
    return gh(['pr', 'diff', String(n), '--color', 'never'], this.dir, 60_000);
  }

  async issueDetail(n: number): Promise<GhIssueDetail> {
    const [view, viewer] = await Promise.all([gh(['issue', 'view', String(n), '--json', 'number,state,body,comments'], this.dir), this.viewer()]);
    const i = JSON.parse(view);
    return { number: i.number, state: i.state, body: String(i.body ?? ''), comments: commentsOf(i.comments), viewer };
  }

  /**
   * Comments on an issue, or on a PR's conversation (to GitHub a PR is an issue too), as whoever gh
   * is signed in as. Returns the comment as GitHub saved it, or why it couldn't.
   */
  async comment(kind: 'issue' | 'pull', n: number, body: string): Promise<{ comment?: GhComment; error?: string }> {
    let comment: GhComment;
    try {
      // -f sends the body as a plain string: no @file reading, no {owner} filling in.
      const jq = '{id: .node_id, author: {login: .user.login}, body, createdAt: .created_at, url: .html_url}';
      const out = await gh(['api', '--method', 'POST', `repos/{owner}/{repo}/issues/${n}/comments`, '-f', `body=${body}`, '--jq', jq], this.dir);
      [comment] = commentsOf([JSON.parse(out)]);
    } catch (err) {
      return { error: (err as Error).message };
    }
    // The issue board counts comments; a PR's card shows when it was last updated.
    void this.lists.refreshOne(kind);
    return { comment };
  }

  /** Merges a PR, or with `auto` has GitHub merge it once its requirements pass. Returns an error. */
  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean): Promise<string | undefined> {
    try {
      const repo = await this.repoInfo();
      // --repo keeps gh out of the office's own checkout: without it, --delete-branch also deletes
      // the local branch and switches the project folder over to the base branch.
      const args = ['pr', 'merge', String(n), `--${method}`, '--repo', repo.nameWithOwner];
      if (deleteBranch) args.push('--delete-branch');
      if (auto) args.push('--auto');
      await gh(args, this.dir, 90_000);
    } catch (err) {
      return (err as Error).message;
    }
    void this.lists.refreshOne('pull');
    return undefined;
  }

  /** Closes an issue, or a pull request without merging it, optionally saying why. Returns an error. */
  async close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }): Promise<string | undefined> {
    try {
      const repo = await this.repoInfo();
      // --repo for the same reason as merge: --delete-branch must leave the office's checkout alone.
      const args = [kind === 'issue' ? 'issue' : 'pr', 'close', String(n), '--repo', repo.nameWithOwner];
      // --flag=value, so a comment starting with "-" isn't read as a flag.
      if (opts.comment) args.push(`--comment=${opts.comment}`);
      if (kind === 'issue' && opts.reason) args.push(`--reason=${opts.reason}`);
      if (kind === 'pull' && opts.deleteBranch) args.push('--delete-branch');
      await gh(args, this.dir);
    } catch (err) {
      return (err as Error).message;
    }
    this.lists.closed(kind, n);
    return undefined;
  }

  /** Assigns the issue to whoever gh is signed in as, which moves it to In progress on the board. */
  async claim(issue: number): Promise<string | undefined> {
    try {
      await gh(['issue', 'edit', String(issue), '--add-assignee', '@me'], this.dir);
    } catch (err) {
      return (err as Error).message;
    }
    void this.lists.refreshOne('issue');
    return undefined;
  }

  /** Every label the repository has, for the label picker. Asked again after a minute (or a failure). */
  repoLabels(): Promise<GhLabel[]> {
    return this.lists.repoLabels();
  }

  /**
   * Puts labels on an issue or PR and takes others off (to GitHub a PR is an issue too), as whoever
   * gh is signed in as. Returns the labels it has now, or why they didn't change.
   */
  setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[]): Promise<{ labels?: GhLabel[]; error?: string }> {
    return this.lists.setLabels(kind, n, add, remove);
  }

  /** Open issues, then the recently closed ones, so old open issues are never crowded out. */
  private async fetchIssues(): Promise<GhIssue[]> {
    const fields = 'number,title,state,url,author,labels,assignees,createdAt,updatedAt,body,comments';
    const [open, closed] = await Promise.all([gh(['issue', 'list', '--state', 'open', '--limit', '300', '--json', fields], this.dir), gh(['issue', 'list', '--state', 'closed', '--limit', '40', '--json', fields], this.dir)]);
    return [...JSON.parse(open), ...JSON.parse(closed)].map((i: any) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.url,
      author: i.author?.login ?? '',
      labels: labels(i.labels),
      assignees: (i.assignees ?? []).map((a: any) => a.login),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      body: String(i.body ?? '').slice(0, 4000),
      comments: Array.isArray(i.comments) ? i.comments.length : Number(i.comments ?? 0),
    }));
  }

  private async fetchPulls(): Promise<GhPull[]> {
    const fields = 'number,title,state,isDraft,url,author,labels,reviewDecision,headRefName,headRefOid,baseRefName,createdAt,updatedAt,additions,deletions,statusCheckRollup,body,closingIssuesReferences';
    const [open, merged, closed] = await Promise.all([
      gh(['pr', 'list', '--state', 'open', '--limit', '150', '--json', fields], this.dir),
      gh(['pr', 'list', '--state', 'merged', '--limit', '30', '--json', fields], this.dir),
      gh(['pr', 'list', '--state', 'closed', '--limit', '40', '--json', fields], this.dir),
    ]);
    // `--state closed` includes merged PRs; keep only the ones closed without merging.
    const seen = new Set<number>();
    const all = [...JSON.parse(open), ...JSON.parse(merged), ...JSON.parse(closed)].filter((p: any) => !seen.has(p.number) && seen.add(p.number));
    return all.map((p: any) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      isDraft: !!p.isDraft,
      url: p.url,
      author: p.author?.login ?? '',
      labels: labels(p.labels),
      reviewDecision: p.reviewDecision ?? '',
      headRefName: p.headRefName,
      headRefOid: typeof p.headRefOid === 'string' ? p.headRefOid : undefined,
      baseRefName: p.baseRefName,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      checks: checksOf(p.statusCheckRollup),
      body: String(p.body ?? '').slice(0, 4000),
      closes: (p.closingIssuesReferences ?? []).map((r: any) => Number(r.number)).filter((n: number) => Number.isInteger(n) && n > 0),
    }));
  }

  private fetchLabels(): Promise<GhLabel[]> {
    return gh(['api', 'repos/{owner}/{repo}/labels?per_page=100', '--paginate', '--jq', '.[] | {name, color, description}'], this.dir).then((out) =>
      out
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
        .map((l: any) => ({ name: String(l.name), color: `#${l.color ?? '888888'}`, description: l.description || undefined })),
    );
  }

  /** Puts labels on and takes others off. To GitHub a pull request is an issue too. */
  private async changeLabels(_kind: 'issue' | 'pull', n: number, add: string[], remove: string[]): Promise<GhLabel[]> {
    const path = `repos/{owner}/{repo}/issues/${n}/labels`;
    const jq = '[.[] | {name, color}]';
    let now: GhLabel[] | undefined;
    // -f labels[]=… sends a JSON array of plain strings: no @file reading, no {owner} filling in.
    if (add.length) now = labels(JSON.parse(await gh(['api', '--method', 'POST', path, ...add.flatMap((l) => ['-f', `labels[]=${l}`]), '--jq', jq], this.dir)));
    for (const l of remove) {
      try {
        now = labels(JSON.parse(await gh(['api', '--method', 'DELETE', `${path}/${encodeURIComponent(l)}`, '--jq', jq], this.dir)));
      } catch (err) {
        // Someone took it off already, which is what was asked for.
        if (!/label does not exist/i.test((err as Error).message)) throw err;
      }
    }
    now ??= labels(JSON.parse(await gh(['api', `${path}?per_page=100`, '--jq', jq], this.dir)));
    return now;
  }
}
