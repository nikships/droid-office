import { forgeOf, normalizeRepo, repoWebUrl } from './floors.js';

// AutoWiki: a wiki Factory keeps for a repository, made by a Droid session running /wiki in a
// checkout of it, which then uploads the pages (POST /wiki). Each upload is a run: a snapshot of the
// pages at one commit. Read by src/server/factory/wiki.ts and shown on each floor's bookshelf
// (ui/factory-wiki.ts). The API's schemas are empty; the shapes come from the droid CLI's own
// schemas and real answers.

/** One page in a run's page tree. Pages with children are sections; a section may be a page itself. */
export interface FactoryWikiNode {
  pageId: string;
  title: string;
  /** Like `overview/architecture`. */
  path: string;
  order: number;
  children: FactoryWikiNode[];
}

export type FactoryWikiPrivacy = 'private' | 'organization';
export const WIKI_PRIVACY: readonly FactoryWikiPrivacy[] = ['private', 'organization'];

/** A run as the slice carries it: everything but the page tree. */
export interface FactoryWikiRun {
  id: string;
  /** The repository URL it was uploaded with. */
  repoUrl: string;
  /** The same repository as the office names them (owner/repo, host/group/project), when it parses. */
  repo?: string;
  /** ms. */
  createdAt: number;
  commitHash?: string;
  branch?: string;
  /** The checkout it was made from had uncommitted changes, or commits that weren't pushed. */
  hasLocalChanges?: boolean;
  hasNonRemoteCommits?: boolean;
  pageCount: number;
  privacyLevel?: FactoryWikiPrivacy;
  /** Whether this key may change its privacy. */
  canUpdatePrivacy?: boolean;
  model?: string;
  droidVersion?: string;
  /** The Droid session that wrote it. */
  sessionId?: string;
}

/** GET /wiki/{id}: a run with its page tree. */
export interface FactoryWikiRunDetail extends FactoryWikiRun {
  pageTree: FactoryWikiNode[];
}

/** GET /wiki/{id}/pages/{pageId}. */
export interface FactoryWikiPage {
  pageId: string;
  path: string;
  title: string;
  /** Markdown. */
  content: string;
  order: number;
}

/** One result of GET /wiki/{id}/search. */
export interface FactoryWikiHit {
  pageId: string;
  title: string;
  path: string;
  snippet: string;
  matchCount: number;
}

/**
 * The office's own /wiki run for a floor (`droid exec "/wiki"` in a worktree of its default
 * branch). Factory only hears of a run when its upload lands, so while it's being made it exists
 * only here. `lost`: the office stopped while it ran, which ends it.
 */
export type FactoryWikiJobState = 'starting' | 'running' | 'done' | 'failed' | 'cancelled' | 'lost';

export interface FactoryWikiJob {
  state: FactoryWikiJobState;
  by: string;
  startedAt: number;
  endedAt?: number;
  /** The last lines of what it's doing (tool calls, what it says), oldest first. */
  lines: string[];
  /** Why it failed: its last lines, or what stopped it. */
  error?: string;
  /** The Droid session it runs in, once it's said. */
  sessionId?: string;
  /** The run its upload made, once it's said. */
  runId?: string;
  /** The commit it documents. */
  commit?: string;
}

/** What a floor's bookshelf shows of its repository's AutoWiki. */
export interface FactoryWikiFloor {
  /** The repository URL a run of this floor's repository is uploaded with and looked up by. */
  repoUrl?: string;
  /** Why this floor can't have one: no origin remote, or not on GitHub or GitLab. */
  why?: string;
  /** The newest run, if it has one. */
  latest?: FactoryWikiRun;
  /** Its runs, newest first (GET /wiki/history). */
  history: FactoryWikiRun[];
  /** When the history was read (ms, 0 for never). Named so broadcasts don't count it as a change. */
  fetchedAt: number;
  /**
   * Factory's answer when it won't read this repository's history (a 403, "You do not have access
   * to this repository"): its GitHub or GitLab integration doesn't cover the repository.
   */
  noAccess?: string;
  job?: FactoryWikiJob;
}

export interface FactoryWikiState {
  /** The newest run of each repository the account has one for. */
  runs: FactoryWikiRun[];
  /** Each floor's, by floor id. */
  floors: Record<string, FactoryWikiFloor>;
  fetchedAt: number;
  error?: string;
}

export function emptyWiki(): FactoryWikiState {
  return { runs: [], floors: {}, fetchedAt: 0 };
}

/** How many of a floor's runs the slice keeps. */
export const WIKI_HISTORY_MAX = 20;
/** How many lines of a job's output the slice keeps, and how many make the error of a failed one. */
export const WIKI_JOB_LINES = 6;
export const WIKI_JOB_ERROR_LINES = 20;
/** How long the search box asks for, at most. */
export const WIKI_SEARCH_LIMIT = 30;

/**
 * The URL a floor's repository's AutoWiki goes by, from its origin remote as the office names it
 * (owner/repo, host/group/project), or why it can't have one.
 */
export function wikiRepoOf(repo: string | undefined): { repoUrl: string } | { why: string } {
  if (!repo) return { why: 'This floor’s checkout has no origin remote on GitHub or GitLab, so Factory can’t keep a wiki for it.' };
  if (!forgeOf(repo)) return { why: 'AutoWiki needs a repository on GitHub or GitLab.' };
  return { repoUrl: repoWebUrl(repo) };
}

/** Whether a run's repository URL is this repository, however either was written (https, ssh, .git). */
export function sameRepo(a: string | undefined, b: string | undefined): boolean {
  const x = normalizeRepo(a);
  const y = normalizeRepo(b);
  return !!x && !!y && x.toLowerCase() === y.toLowerCase();
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
/** ms from a number or an ISO string. */
const timeOf = (v: unknown) => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
};
const intOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/** A node of a page tree, and its children, dropping what isn't one. Deeper than 8 is cut. */
export function wikiNodeOf(raw: unknown, depth = 0): FactoryWikiNode | undefined {
  if (!raw || typeof raw !== 'object' || depth > 8) return undefined;
  const r = raw as Record<string, unknown>;
  const pageId = str(r.pageId);
  const path = str(r.path) ?? '';
  if (!pageId) return undefined;
  const children = Array.isArray(r.children) ? r.children.map((c) => wikiNodeOf(c, depth + 1)).filter((c): c is FactoryWikiNode => !!c) : [];
  children.sort((a, b) => a.order - b.order);
  return { pageId, title: str(r.title) ?? (path.split('/').pop() || pageId), path, order: intOf(r.order), children };
}

/** A run from GET /wiki's `wikiRuns`, GET /wiki/history or GET /wiki/{id}, without its tree. */
export function wikiRunOf(raw: unknown): FactoryWikiRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = str(r.wikiRunId) ?? str(r.id);
  if (!id) return undefined;
  const repoUrl = str(r.repoUrl) ?? '';
  const model = r.modelUsed && typeof r.modelUsed === 'object' ? str((r.modelUsed as { id?: unknown }).id) : str(r.modelUsed);
  const privacy = WIKI_PRIVACY.find((p) => p === r.privacyLevel);
  const run: FactoryWikiRun = { id, repoUrl, createdAt: timeOf(r.createdAt) ?? 0, pageCount: intOf(r.pageCount) };
  const repo = normalizeRepo(repoUrl);
  if (repo) run.repo = repo;
  if (str(r.commitHash)) run.commitHash = str(r.commitHash);
  if (str(r.branch)) run.branch = str(r.branch);
  if (bool(r.hasLocalChanges) !== undefined) run.hasLocalChanges = bool(r.hasLocalChanges);
  if (bool(r.hasNonRemoteCommits) !== undefined) run.hasNonRemoteCommits = bool(r.hasNonRemoteCommits);
  if (privacy) run.privacyLevel = privacy;
  if (bool(r.canUpdatePrivacy) !== undefined) run.canUpdatePrivacy = bool(r.canUpdatePrivacy);
  if (model) run.model = model;
  if (str(r.droidVersion)) run.droidVersion = str(r.droidVersion);
  if (str(r.sourceSessionId)) run.sessionId = str(r.sourceSessionId);
  return run;
}

/** A run with its page tree, in order. */
export function wikiRunDetailOf(raw: unknown): FactoryWikiRunDetail | undefined {
  const run = wikiRunOf(raw);
  if (!run) return undefined;
  const tree = (raw as { pageTree?: unknown }).pageTree;
  const pageTree = Array.isArray(tree) ? tree.map((n) => wikiNodeOf(n)).filter((n): n is FactoryWikiNode => !!n) : [];
  pageTree.sort((a, b) => a.order - b.order);
  return { ...run, pageTree };
}

export function wikiPageOf(raw: unknown): FactoryWikiPage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const pageId = str(r.pageId);
  if (!pageId) return undefined;
  const path = str(r.path) ?? '';
  return { pageId, path, title: str(r.title) ?? (path || pageId), content: typeof r.content === 'string' ? r.content : '', order: intOf(r.order) };
}

export function wikiHitOf(raw: unknown): FactoryWikiHit | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const pageId = str(r.pageId);
  if (!pageId) return undefined;
  return { pageId, title: str(r.title) ?? pageId, path: str(r.path) ?? '', snippet: typeof r.snippet === 'string' ? r.snippet : '', matchCount: intOf(r.matchCount) };
}

/** Every page of a tree, depth first in order, with how deep it sits. */
export function flattenWiki(tree: readonly FactoryWikiNode[], depth = 0, out: { node: FactoryWikiNode; depth: number }[] = []): { node: FactoryWikiNode; depth: number }[] {
  for (const node of tree) {
    out.push({ node, depth });
    flattenWiki(node.children, depth + 1, out);
  }
  return out;
}

/** A path as pages and links write it: no leading ./ or /, no .md, no trailing /index. */
function pagePath(p: string): string {
  return p
    .replace(/^\.?\/+/, '')
    .replace(/\.(md|markdown)$/i, '')
    .replace(/(^|\/)index$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Which page a link in the page at `from` (a path like `overview/architecture`) goes to, with any
 * #anchor apart. Pages link to each other by relative Markdown paths (`../modules/queue.md`), by
 * paths from the wiki's root (`/overview`), or by page id. Undefined for links elsewhere.
 */
export function resolveWikiLink(tree: readonly FactoryWikiNode[], from: string, href: string): { pageId: string; hash: string } | undefined {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return undefined;
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt + 1) : '';
  let rel = (hashAt >= 0 ? href.slice(0, hashAt) : href).replace(/\?.*$/, '');
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  const pages = flattenWiki(tree).map((x) => x.node);
  if (!rel) {
    const self = pages.find((p) => p.path === from);
    return self ? { pageId: self.pageId, hash } : undefined;
  }
  const byId = pages.find((p) => p.pageId === rel);
  if (byId) return { pageId: byId.pageId, hash };
  const candidates: string[] = [];
  if (rel.startsWith('/')) candidates.push(rel);
  else {
    // Relative to the page's folder, as a Markdown file would be. A section's own page was its
    // folder's index.md, so its links start from that folder.
    const self = pages.find((p) => p.path === from);
    const folder = from.split('/').slice(0, -1);
    const own = from.split('/');
    for (const base of self?.children.length ? [own, folder] : [folder, own]) {
      const parts = [...base];
      let ok = true;
      for (const seg of rel.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
          if (!parts.length) ok = false;
          parts.pop();
        } else parts.push(seg);
      }
      if (ok) candidates.push(parts.join('/'));
    }
    candidates.push(rel);
  }
  for (const c of candidates) {
    const want = pagePath(c);
    const hit = pages.find((p) => pagePath(p.path) === want);
    if (hit) return { pageId: hit.pageId, hash };
  }
  return undefined;
}

/** What the hint at the bookshelf says of a floor's AutoWiki. */
export function wikiShelfLine(floor: FactoryWikiFloor | undefined): string {
  const job = floor?.job;
  if (job && (job.state === 'starting' || job.state === 'running')) return 'AutoWiki: writing…';
  if (floor?.latest) return `AutoWiki: ${floor.latest.pageCount} page${floor.latest.pageCount === 1 ? '' : 's'}`;
  if (floor?.why) return '';
  return 'Generate AutoWiki';
}
