// The issue and pull lists both forges show on a floor's boards. GitHub (github.ts) and GitLab
// (gitlab.ts) only list and change things on their host; this keeps the lists, the way Pipelines
// sits over PipelineForge. Floor calls refresh and stop on its own cadence. It does not call start.

import type { GhIssue, GhLabel, GhPull, GhState } from '../shared/protocol.js';
import { type BoardListener, Relabels } from './forge.js';

/** How long the repository's list of labels is kept before the label picker asks the host again. */
const LABELS_MS = 60_000;
/** start()'s own look. Floor does not call start; it refreshes on its own clock. */
const REFRESH_MS = 90_000;
/** A close the list still shows as open is looked at again after this long. */
const CLOSE_AGAIN_MS = 3_000;

/** What a forge answers so the board lists can refresh, label and notice a close. */
export interface BoardSource {
  /** Open issues, then the recently closed ones, newest first within each. */
  listIssues(): Promise<GhIssue[]>;
  /** Open pulls, then merged, then closed without merging. */
  listPulls(): Promise<GhPull[]>;
  /** Every label the repository has, for the label picker. */
  listLabels(): Promise<GhLabel[]>;
  /**
   * Puts `add` on and takes `remove` off. Returns the labels it has now.
   * Throws when the host refused; a label that was already gone is not a failure.
   */
  applyLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[]): Promise<GhLabel[]>;
}

/**
 * How urgent an issue's labels say it is, 0 (critical) to 3 (low); 4 when it has no priority label.
 * Reads "priority: high", "priority/low", "P1", "critical" and the like.
 */
export function priorityRank(labels: { name: string }[]): number {
  let best = 4;
  for (const { name } of labels) {
    const n = name.toLowerCase().trim();
    const p = /^p([0-3])$/.exec(n) ?? /^priority\W*p?([0-3])$/.exec(n);
    let rank = p ? Number(p[1]) : 4;
    if (!p && (n.includes('priority') || /^(critical|urgent|blocker)$/.test(n))) {
      if (/critical|urgent|blocker|highest/.test(n)) rank = 0;
      else if (/high/.test(n)) rank = 1;
      else if (/medium|\bmed\b|normal|moderate/.test(n)) rank = 2;
      else if (/low|minor/.test(n)) rank = 3;
    }
    best = Math.min(best, rank);
  }
  return best;
}

/**
 * A floor's issue and pull lists, kept the same whichever forge lists them. The floor reads
 * `issues` and `pulls` and calls `refresh` and `stop`; it never calls `start`.
 */
export class BoardList {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  private timer?: NodeJS.Timeout;
  private labelList?: { at: number; list: Promise<GhLabel[]> };
  private relabeled = new Relabels();

  constructor(
    private source: BoardSource,
    private onIssues: BoardListener<GhIssue>,
    private onPulls: BoardListener<GhPull>,
  ) {}

  /** Its own 90s look. Floor never calls this: the floor's timer calls refresh. */
  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    await Promise.all([this.refreshIssues(), this.refreshPulls()]);
  }

  /** One side, after a comment, a merge or a claim. A look already going returns at once. */
  refreshOne(kind: 'issue' | 'pull'): Promise<void> {
    return kind === 'issue' ? this.refreshIssues() : this.refreshPulls();
  }

  /** Every label the repository has. Asked again after a minute (or a failure). */
  repoLabels(): Promise<GhLabel[]> {
    if (!this.labelList || Date.now() - this.labelList.at > LABELS_MS) {
      const list = this.source.listLabels();
      this.labelList = { at: Date.now(), list };
      list.catch(() => this.labelList?.list === list && (this.labelList = undefined));
    }
    return this.labelList.list;
  }

  /**
   * Puts labels on and takes others off. The board shows them at once, before the next look at the
   * host. Returns the labels it has now, or why they didn't change.
   */
  async setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[]): Promise<{ labels?: GhLabel[]; error?: string }> {
    let now: GhLabel[];
    try {
      now = await this.source.applyLabels(kind, n, add, remove);
    } catch (err) {
      // Some may have changed before it failed.
      void this.refreshOne(kind);
      return { error: (err as Error).message };
    }
    const at = Date.now();
    this.relabeled.set(kind, n, now, at);
    if (kind === 'issue') {
      this.issues = { ...this.issues, items: this.relabeled.apply('issue', this.issues.items, at).sort((a, b) => priorityRank(a.labels) - priorityRank(b.labels)) };
      this.onIssues(this.issues);
      void this.refreshIssues();
    } else {
      this.pulls = { ...this.pulls, items: this.relabeled.apply('pull', this.pulls.items, at) };
      this.onPulls(this.pulls);
      void this.refreshPulls();
    }
    return { labels: now };
  }

  /**
   * A close already happened on the host. Look now, and again shortly after if the list still says
   * open: a look already in flight returns at once and can still list it as open.
   */
  closed(kind: 'issue' | 'pull', n: number): void {
    const refresh = () => this.refreshOne(kind);
    void refresh().then(() => {
      if ((kind === 'issue' ? this.issues : this.pulls).items.some((i) => i.number === n && i.state === 'OPEN')) setTimeout(() => void refresh(), CLOSE_AGAIN_MS);
    });
  }

  private async refreshIssues() {
    if (this.issues.loading) return;
    this.issues = { ...this.issues, loading: true };
    this.onIssues(this.issues);
    const asked = Date.now();
    try {
      const items = this.relabeled.apply('issue', await this.source.listIssues(), asked);
      // Highest priority first, so the board (and the notes that fit on the wall) lead with it.
      // The sort is stable: within a priority, the host's newest-first order stays.
      items.sort((a, b) => priorityRank(a.labels) - priorityRank(b.labels));
      this.issues = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  private async refreshPulls() {
    if (this.pulls.loading) return;
    this.pulls = { ...this.pulls, loading: true };
    this.onPulls(this.pulls);
    const asked = Date.now();
    try {
      const items = this.relabeled.apply('pull', await this.source.listPulls(), asked);
      this.pulls = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onPulls(this.pulls);
  }
}
