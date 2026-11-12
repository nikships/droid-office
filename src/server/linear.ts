import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GhPull, WorkerInfo } from '../shared/protocol.js';
import {
  AUTOPILOT_MAX,
  autopilotPicks,
  DEFAULT_AUTOPILOT,
  findState,
  guessTeam,
  LINEAR_PICKUPS,
  linearIssueRef,
  linearKey,
  linearPromptVars,
  stateForStage,
  type LinearAutopilot,
  type LinearBoardState,
  type LinearComment,
  type LinearConnection,
  type LinearFloorSetup,
  type LinearFloorState,
  type LinearPickup,
  type LinearStage,
  type LinearState,
  type LinearStateType,
  type LinearTeamRef,
  type LinearTicket,
  type LinearTicketDetail,
} from '../shared/linear.js';
import { redact } from './jira.js';
import { officePrompt, type PromptSource } from './prompts.js';

const ENDPOINT = 'https://api.linear.app/graphql';
const TIMEOUT_MS = 20_000;
/** After a rate limit, the board waits at least this long, doubling for each one in a row, up to MAX_BACKOFF_MS. */
const BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** The most tickets the Linear tab shows (pages of 100). */
const MAX_TICKETS = 300;
/** Done tickets stay on the board this long after they're completed. */
const DONE_FOR = '-P14D';
/** A team's states, labels, members and projects are read again after this long. */
const TEAM_CACHE_MS = 5 * 60_000;
/** The workspace's teams (for the floor's team picker) are read again after this long. */
const TEAMS_MS = 10 * 60_000;
/** A ticket autopilot couldn't hand out isn't tried again for this long. */
const RETRY_MS = 10 * 60_000;
/** Links whose work landed are forgotten after this long. */
const LANDED_KEEP_MS = 7 * 24 * 60 * 60_000;

/** Something Linear (or the way to it) turned down, in words for whoever asked. */
export class LinearError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Seconds, from a rate limit's reset time. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

interface GqlError {
  message?: string;
  extensions?: { code?: string; userPresentableMessage?: string; type?: string };
}

/** Fields of a ticket card, as every issue query asks for them. */
const CARD = 'id identifier title url priority priorityLabel estimate sortOrder createdAt updatedAt state { id name type color } assignee { id name } labels(first: 8) { nodes { name color } } project { name }';

export interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority?: number;
  priorityLabel?: string;
  estimate?: number | null;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
  state?: { id: string; name: string; type: string; color: string };
  assignee?: { id: string; name: string } | null;
  labels?: { nodes?: { name: string; color: string }[] };
  project?: { name: string } | null;
}

interface RawDetail extends RawIssue {
  description?: string | null;
  branchName?: string;
  creator?: { name: string } | null;
  team?: { id: string; key: string; name: string };
  parent?: { identifier: string; title: string } | null;
  children?: { nodes?: { identifier: string; title: string; state?: { name: string } }[] };
  attachments?: { nodes?: { title: string; url: string }[] };
  comments?: { nodes?: { id: string; body: string; createdAt: string; user?: { name: string } | null; botActor?: { name: string } | null }[] };
}

const stateType = (t: unknown): LinearStateType => (['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'].includes(String(t)) ? (t as LinearStateType) : 'backlog');

/** A card for the Linear tab, from an issue as the API returns it. */
export function ticketOf(raw: RawIssue): LinearTicket {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: String(raw.title ?? ''),
    url: raw.url,
    priority: Number(raw.priority ?? 0) || 0,
    priorityLabel: String(raw.priorityLabel ?? ''),
    state: { id: raw.state?.id ?? '', name: raw.state?.name ?? '', type: stateType(raw.state?.type), color: raw.state?.color ?? '#888888' },
    ...(raw.assignee?.name ? { assignee: raw.assignee.name } : {}),
    labels: (raw.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color })),
    ...(raw.project?.name ? { project: raw.project.name } : {}),
    ...(typeof raw.estimate === 'number' ? { estimate: raw.estimate } : {}),
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt ?? '',
    sortOrder: Number(raw.sortOrder ?? 0) || 0,
  };
}

export function detailOf(raw: RawDetail): LinearTicketDetail {
  const comments: LinearComment[] = (raw.comments?.nodes ?? [])
    .map((c) => ({ id: c.id, author: c.user?.name ?? c.botActor?.name ?? 'someone', body: c.body ?? '', createdAt: c.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    ...ticketOf(raw),
    description: raw.description ?? '',
    ...(raw.creator?.name ? { creator: raw.creator.name } : {}),
    branchName: raw.branchName ?? '',
    team: raw.team ?? { id: '', key: '', name: '' },
    ...(raw.parent ? { parent: { identifier: raw.parent.identifier, title: raw.parent.title } } : {}),
    children: (raw.children?.nodes ?? []).map((c) => ({ identifier: c.identifier, title: c.title, state: c.state?.name ?? '' })),
    attachments: (raw.attachments?.nodes ?? []).map((a) => ({ title: a.title, url: a.url })),
    comments,
  };
}

const DETAIL = `${CARD} description branchName creator { name } team { id key name } parent { identifier title } children(first: 50) { nodes { identifier title state { name } } } attachments(first: 30) { nodes { title url } } comments(first: 100) { nodes { id body createdAt user { name } botActor { name } } }`;

/** One team's workflow and vocabulary: what names in a tool call resolve against. */
export interface TeamContext {
  id: string;
  key: string;
  name: string;
  states: LinearState[];
  labels: { id: string; name: string; color: string }[];
  members: { id: string; name: string; displayName: string; email: string }[];
  projects: { id: string; name: string; state: string }[];
  cycle?: { id: string; number: number; name?: string };
}

/**
 * Linear's GraphQL API as the office's one account: the personal API key in the Authorization header,
 * as Linear takes it. Nothing here logs; errors carry no key.
 */
export class LinearApi {
  constructor(
    private key: string,
    private fetchImpl: Fetch = fetch,
  ) {}

  private redact(text: string): string {
    return redact(text, [this.key]);
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { authorization: this.key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const why = e.name === 'TimeoutError' ? 'it did not answer in time' : (e.cause?.code ?? e.message);
      throw new LinearError(this.redact(`Couldn't reach Linear (${why}).`), 0);
    }
    const text = await res.text().catch(() => '');
    let body: { data?: T; errors?: GqlError[] } | undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const errors = body?.errors ?? [];
    const code = errors[0]?.extensions?.code;
    const said = this.redact(
      errors
        .map((e) => e.extensions?.userPresentableMessage || e.message || '')
        .filter(Boolean)
        .join(' ')
        .slice(0, 400),
    );
    if (res.status === 401 || code === 'AUTHENTICATION_ERROR') throw new LinearError(`Linear didn't accept the API key${said ? `: ${said}` : ''}. Check that it hasn't been revoked.`, 401, code);
    if (res.status === 429 || code === 'RATELIMITED') {
      const reset = Number(res.headers.get('x-ratelimit-requests-reset'));
      const retry = res.headers.get('retry-after');
      const seconds = retry ? Number(retry) : NaN;
      const retryAt = retry && !Number.isFinite(seconds) ? Date.parse(retry) : NaN;
      const waits = [Number.isFinite(reset) && reset > Date.now() ? Math.ceil((reset - Date.now()) / 1000) : 0, Number.isFinite(seconds) ? Math.ceil(seconds) : Number.isFinite(retryAt) ? Math.ceil((retryAt - Date.now()) / 1000) : 0];
      const after = Math.max(...waits) > 0 ? Math.max(...waits) : undefined;
      throw new LinearError('Linear is rate limiting the office. It tries again in a while.', 429, code, after);
    }
    if (code === 'FORBIDDEN') throw new LinearError(`The office's Linear key may not do that${said ? `: ${said}` : ''}`, 403, code);
    if (errors.length) throw new LinearError(said || `Linear answered ${res.status}`, res.ok ? 400 : res.status, code);
    if (!res.ok || !body?.data) throw new LinearError(`Linear answered ${res.status}`, res.status || 502);
    return body.data;
  }

  /** Who the key belongs to, and its workspace. */
  me(): Promise<{ viewer: { id: string; name: string; email: string }; organization: { name: string; urlKey: string } }> {
    return this.graphql('query Me { viewer { id name email } organization { name urlKey } }');
  }

  async teams(): Promise<LinearTeamRef[]> {
    // Projects nested under teams multiply Linear's query complexity past its 10,000 limit, so they're one flat list, matched to teams here.
    const r = await this.graphql<{
      teams: { nodes: { id: string; key: string; name: string; defaultIssueState?: { type: string } | null }[] };
      projects: { nodes: { id: string; name: string; state: string; teams: { nodes: { id: string }[] } }[] };
    }>('query Teams { teams(first: 100) { nodes { id key name defaultIssueState { type } } } projects(first: 100) { nodes { id name state teams(first: 10) { nodes { id } } } } }');
    const open = r.projects.nodes.filter((p) => p.state !== 'canceled' && p.state !== 'completed');
    return r.teams.nodes
      .map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        ...(t.defaultIssueState?.type ? { defaultState: stateType(t.defaultIssueState.type) } : {}),
        projects: open.filter((p) => p.teams.nodes.some((x) => x.id === t.id)).map((p) => ({ id: p.id, name: p.name })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A team's open tickets and those done in the last two weeks, in Linear's order, up to MAX_TICKETS. */
  async board(teamId: string, projectId?: string): Promise<LinearTicket[]> {
    const filter = {
      team: { id: { eq: teamId } },
      ...(projectId ? { project: { id: { eq: projectId } } } : {}),
      or: [{ state: { type: { nin: ['completed', 'canceled', 'duplicate'] } } }, { state: { type: { eq: 'completed' } }, completedAt: { gte: DONE_FOR } }],
    };
    return (await this.issues(filter, MAX_TICKETS)).map(ticketOf);
  }

  /** Issues matching a Linear IssueFilter, newest change first, up to `limit`. */
  async issues(filter: Record<string, unknown>, limit: number): Promise<RawIssue[]> {
    const out: RawIssue[] = [];
    let after: string | undefined;
    do {
      const r = await this.graphql<{ issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor?: string } } }>(
        `query Issues($filter: IssueFilter, $first: Int, $after: String) { issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${CARD} } pageInfo { hasNextPage endCursor } } }`,
        { filter, first: Math.min(100, limit - out.length), ...(after ? { after } : {}) },
      );
      out.push(...r.issues.nodes);
      after = r.issues.pageInfo.hasNextPage ? r.issues.pageInfo.endCursor : undefined;
    } while (after && out.length < limit);
    return out.slice(0, limit);
  }

  /** One issue in full, by identifier (DOFF-12) or id; a missing one is a 404. */
  async issue(ref: string): Promise<LinearTicketDetail> {
    try {
      const r = await this.graphql<{ issue: RawDetail | null }>(`query Issue($id: String!) { issue(id: $id) { ${DETAIL} } }`, { id: ref });
      if (!r.issue) throw new LinearError(`There's no ${ref} in Linear`, 404);
      return detailOf(r.issue);
    } catch (err) {
      if (err instanceof LinearError && err.status !== 404 && /not found|could not find|entity not found/i.test(err.message)) throw new LinearError(`There's no ${ref} in Linear, or the office's key can't see it`, 404);
      throw err;
    }
  }

  async team(id: string): Promise<TeamContext> {
    const r = await this.graphql<{
      team: {
        id: string;
        key: string;
        name: string;
        states: { nodes: LinearState[] };
        labels: { nodes: { id: string; name: string; color: string }[] };
        members: { nodes: { id: string; name: string; displayName: string; email: string; active: boolean }[] };
        projects: { nodes: { id: string; name: string; state: string }[] };
        activeCycle?: { id: string; number: number; name?: string } | null;
      } | null;
      issueLabels: { nodes: { id: string; name: string; color: string; team?: { id: string } | null }[] };
    }>(
      `query Team($id: String!) { team(id: $id) { id key name states { nodes { id name type color position } } labels(first: 250) { nodes { id name color } } members(first: 250) { nodes { id name displayName email active } } projects(first: 100) { nodes { id name state } } activeCycle { id number name } } issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name color } } }`,
      { id },
    );
    const t = r.team;
    if (!t) throw new LinearError(`There's no team ${id} in Linear`, 404);
    const labels = [...t.labels.nodes, ...r.issueLabels.nodes.map(({ id, name, color }) => ({ id, name, color }))];
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      states: t.states.nodes.map((s) => ({ ...s, type: stateType(s.type) })).sort((a, b) => a.position - b.position),
      labels,
      members: t.members.nodes.filter((m) => m.active).map(({ id, name, displayName, email }) => ({ id, name, displayName, email })),
      projects: t.projects.nodes,
      ...(t.activeCycle ? { cycle: t.activeCycle } : {}),
    };
  }

  async createIssue(input: Record<string, unknown>): Promise<LinearTicketDetail> {
    const r = await this.graphql<{ issueCreate: { success: boolean; issue?: RawDetail } }>(`mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${DETAIL} } } }`, { input });
    if (!r.issueCreate.success || !r.issueCreate.issue) throw new LinearError("Linear didn't create the issue", 400);
    return detailOf(r.issueCreate.issue);
  }

  async updateIssue(id: string, input: Record<string, unknown>): Promise<LinearTicketDetail> {
    const r = await this.graphql<{ issueUpdate: { success: boolean; issue?: RawDetail } }>(`mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${DETAIL} } } }`, { id, input });
    if (!r.issueUpdate.success || !r.issueUpdate.issue) throw new LinearError("Linear didn't update the issue", 400);
    return detailOf(r.issueUpdate.issue);
  }

  async comment(issueId: string, body: string): Promise<{ id: string; url: string }> {
    const r = await this.graphql<{ commentCreate: { success: boolean; comment?: { id: string; url: string } } }>('mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }', {
      input: { issueId, body },
    });
    if (!r.commentCreate.success || !r.commentCreate.comment) throw new LinearError("Linear didn't post the comment", 400);
    return r.commentCreate.comment;
  }

  /** Shows a link (a pull request, a doc) in the issue's sidebar; linking the same URL again updates it. */
  async attach(issueId: string, url: string, title: string): Promise<void> {
    const r = await this.graphql<{ attachmentLinkURL: { success: boolean } }>('mutation Attach($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }', {
      issueId,
      url,
      title,
    });
    if (!r.attachmentLinkURL.success) throw new LinearError("Linear didn't attach the link", 400);
  }
}

// ---- Files -------------------------------------------------------------------------------------------

/** Writes JSON readable only by the office's user, whole: a temp file renamed into place. */
function writePrivate(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

// ---- The office's connection ---------------------------------------------------------------------

interface SavedConnection extends LinearConnection {
  key: string;
  /** The key's own user, whom the office assigns tickets to when a worker takes one. */
  viewerId: string;
}

/**
 * The office's one Linear workspace, shared by every floor: a personal API key (full access), kept in
 * the office's .droid-office/linear.json (0600). The key never leaves this class: connection() is what
 * browsers get, and API errors are redacted.
 */
export class LinearOffice {
  private saved?: SavedConnection;
  private api?: LinearApi;
  private teamsAt = 0;
  private teamCache = new Map<string, { at: number; ctx: Promise<TeamContext> }>();
  readonly file: string;

  constructor(
    dataDir: string,
    private fetchImpl: Fetch = fetch,
    /** The workspace's teams changed (read again, or a new connection). */
    private onChange: () => void = () => {},
  ) {
    this.file = path.join(dataDir, 'linear.json');
    this.restore();
  }

  /** Who the office works Linear as; undefined while it isn't connected. Never the key. */
  connection(): LinearConnection | undefined {
    const s = this.saved;
    return s ? { workspace: s.workspace, urlKey: s.urlKey, name: s.name, email: s.email, teams: s.teams, by: s.by, at: s.at } : undefined;
  }

  client(): LinearApi | undefined {
    return this.api;
  }

  /** The key's own user id, which a ticket a worker takes is assigned to. */
  get viewerId(): string | undefined {
    return this.saved?.viewerId;
  }

  get viewerName(): string | undefined {
    return this.saved?.name;
  }

  /** Checks the key with Linear, then saves it. Resolves to why not, if not. */
  async connect(rawKey: string, by: string): Promise<string | undefined> {
    const key = linearKey(rawKey);
    if (!key) return "That doesn't look like a Linear API key. Make one in Linear under Settings → Account → Security & access → Personal API keys; it starts with lin_api_.";
    const api = new LinearApi(key, this.fetchImpl);
    let me: Awaited<ReturnType<LinearApi['me']>>;
    let teams: LinearTeamRef[];
    try {
      [me, teams] = await Promise.all([api.me(), api.teams()]);
    } catch (err) {
      return redact((err as Error).message, [key]);
    }
    this.saved = { key, viewerId: me.viewer.id, workspace: me.organization.name, urlKey: me.organization.urlKey, name: me.viewer.name, email: me.viewer.email, teams, by, at: Date.now() };
    this.api = api;
    this.teamsAt = Date.now();
    this.teamCache.clear();
    this.persist();
    return undefined;
  }

  disconnect() {
    this.saved = undefined;
    this.api = undefined;
    this.teamCache.clear();
    try {
      rmSync(this.file, { force: true });
    } catch {
      // already gone
    }
  }

  /** Reads the workspace's teams again when they're old (or `force`), for the floor's team picker. */
  async refreshTeams(force = false): Promise<void> {
    const api = this.api;
    const saved = this.saved;
    if (!api || !saved || (!force && Date.now() - this.teamsAt < TEAMS_MS)) return;
    this.teamsAt = Date.now();
    try {
      const teams = await api.teams();
      if (this.saved !== saved || JSON.stringify(teams) === JSON.stringify(saved.teams)) return;
      saved.teams = teams;
      this.persist();
      this.onChange();
    } catch {
      // the old list stays
    }
  }

  /** A team's states, labels, members and projects, kept a few minutes. */
  teamContext(teamId: string, fresh = false): Promise<TeamContext> {
    const api = this.api;
    if (!api) return Promise.reject(new LinearError('Linear is not connected. The owner connects it in Settings → Connections → Linear.', 400));
    const hit = this.teamCache.get(teamId);
    if (hit && !fresh && Date.now() - hit.at < TEAM_CACHE_MS) return hit.ctx;
    const ctx = api.team(teamId);
    this.teamCache.set(teamId, { at: Date.now(), ctx });
    ctx.catch(() => this.teamCache.get(teamId)?.ctx === ctx && this.teamCache.delete(teamId));
    return ctx;
  }

  /** A team by its key, name or id, among the workspace's. */
  findTeam(ref: string): LinearTeamRef | undefined {
    const r = ref.trim().toLowerCase();
    return this.saved?.teams.find((t) => t.id === ref.trim() || t.key.toLowerCase() === r || t.name.toLowerCase() === r);
  }

  private persist() {
    try {
      writePrivate(this.file, this.saved);
    } catch (err) {
      console.error(`droid-office: couldn't save the Linear connection: ${(err as Error).message}`);
    }
  }

  private restore() {
    const s = readJson(this.file) as Partial<SavedConnection> | undefined;
    const key = linearKey(s?.key);
    if (!s || !key || typeof s.viewerId !== 'string') return;
    this.saved = {
      key,
      viewerId: s.viewerId,
      workspace: str(s.workspace, 'Linear'),
      urlKey: str(s.urlKey),
      name: str(s.name),
      email: str(s.email),
      teams: Array.isArray(s.teams) ? s.teams : [],
      by: str(s.by, '?'),
      at: typeof s.at === 'number' ? s.at : Date.now(),
    };
    this.api = new LinearApi(key, this.fetchImpl);
  }
}

// ---- A floor's team ------------------------------------------------------------------------------

/** A ticket a worker on this floor took on, kept past the worker so its pull request can still move it. */
export interface LinearLink {
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  workerId: string;
  workerName: string;
  /** Handed out by autopilot, so it counts against autopilot's limit. */
  auto?: boolean;
  /** Where the office has moved it: started, review once its PR opened, completed once that merged. */
  stage: LinearStage;
  pr?: { number: number; url: string };
  at: number;
}

interface SavedFloor {
  setup?: LinearFloorSetup;
  autopilot?: LinearAutopilot;
  links?: LinearLink[];
  /** Tickets autopilot couldn't hand out, and when it tried. */
  skipped?: Record<string, number>;
  /** The owner took Linear off the floor, so no team is matched to it again. */
  off?: boolean;
}

export interface FloorLinearEvents {
  state(state: LinearFloorState): void;
  board(state: LinearBoardState | null): void;
  toast(text: string, level?: 'info' | 'warn'): void;
  /**
   * Hires a worker for a ticket at the floor's first free desk, with `prompt` and the ticket linked (as
   * the Linear tab's Hand to a worker does). Resolves to the worker's id, or why not.
   */
  hire(prompt: string, identifier: string, model?: string): Promise<{ workerId?: string; error?: string }>;
  /** The floor's workers now. */
  workers(): WorkerInfo[];
  /** How this floor names a pull request: PR #12, or MR !12 on GitLab. */
  pullName(n: number): string;
}

/**
 * One floor's Linear team, shown as the issue board's Linear tab, and the tickets its workers took on.
 * A worker that takes a ticket moves it to In Progress and is assigned it (as the office's account);
 * its pull request is attached to the ticket and moves it to review, and merging moves it to done.
 * With autopilot on, every new ticket gets a worker of its own. Kept in the floor's
 * .droid-office/linear-floor.json; everything goes through the office's connection (LinearOffice).
 */
export class FloorLinear {
  setup?: LinearFloorSetup;
  autopilot: LinearAutopilot = { ...DEFAULT_AUTOPILOT };
  board: LinearBoardState | null = null;
  private links: LinearLink[] = [];
  private skipped: Record<string, number> = {};
  private off = false;
  private file: string;
  private backoffUntil = 0;
  private strikes = 0;
  private generation = 0;
  private piloting = false;
  private syncing = false;
  /** Hires autopilot started that haven't come back yet, by issue id. */
  private hiring = new Set<string>();
  /** The floor's workers as workersChanged last saw them. */
  private seen = '';

  constructor(
    dataDir: string,
    private office: LinearOffice,
    private prompts: PromptSource | undefined,
    private events: FloorLinearEvents,
    /** The floor's and its repository's names, which a team can be matched to. */
    private names: (string | undefined)[] = [],
  ) {
    this.file = path.join(dataDir, 'linear-floor.json');
    this.restore();
    this.guess();
    this.board = this.emptyBoard();
  }

  state(): LinearFloorState {
    const workers = new Set(this.events.workers().map((w) => w.id));
    return { connection: this.office.connection(), setup: this.setup, autopilot: this.autopilot, working: this.links.filter((l) => l.stage !== 'completed' && workers.has(l.workerId)).length };
  }

  /** Connected, with a team: the Linear tab is up. */
  get on(): boolean {
    return !!this.setup && !!this.office.client();
  }

  get fetchedAt(): number {
    return this.board?.fetchedAt ?? 0;
  }

  /** Autopilot is handing out tickets, so the board is read often even with nobody on the floor. */
  get piloted(): boolean {
    return this.on && this.autopilot.on;
  }

  private emptyBoard(): LinearBoardState | null {
    return this.on && this.setup ? { team: this.setup.team.key, ...(this.setup.project ? { project: this.setup.project.name } : {}), items: [], fetchedAt: 0, loading: false } : null;
  }

  /** The office's only team, or the one named like the floor, when the floor has none yet. */
  private guess(): boolean {
    if (this.setup || this.off) return false;
    const team = guessTeam(this.office.connection()?.teams ?? [], this.names);
    if (!team) return false;
    this.setup = { team: { id: team.id, key: team.key, name: team.name }, by: 'the office', at: Date.now() };
    this.persist();
    return true;
  }

  /** The office connected, reconnected or disconnected, or the teams changed: start over. */
  connectionChanged(): Promise<void> {
    this.generation++;
    this.backoffUntil = 0;
    this.strikes = 0;
    this.guess();
    this.board = this.emptyBoard();
    this.emitState();
    this.events.board(this.board);
    return this.on ? this.refresh(true) : Promise.resolve();
  }

  emitState() {
    this.events.state(this.state());
  }

  /** Points the floor at a team (and optionally one of its projects); '' takes Linear off the floor. */
  setTeam(teamRef: string, projectRef: string | undefined, by: string): string | undefined {
    if (!this.office.client()) return 'Connect the office to Linear first';
    if (!teamRef) {
      this.setup = undefined;
      this.off = true;
      this.autopilot = { ...this.autopilot, on: false };
      this.persist();
      void this.connectionChanged();
      return undefined;
    }
    const team = this.office.findTeam(teamRef);
    if (!team) return `There's no team ${teamRef} in ${this.office.connection()?.workspace ?? 'Linear'}`;
    const project = projectRef ? team.projects.find((p) => p.id === projectRef || p.name.toLowerCase() === projectRef.toLowerCase()) : undefined;
    if (projectRef && !project) return `${team.name} has no project ${projectRef}`;
    this.setup = { team: { id: team.id, key: team.key, name: team.name }, ...(project ? { project } : {}), by, at: Date.now() };
    this.off = false;
    this.persist();
    void this.connectionChanged();
    return undefined;
  }

  /** Changes autopilot. Turning it on starts its clock: by default only tickets made from now on are handed out. */
  setAutopilot(change: Partial<Pick<LinearAutopilot, 'on' | 'pickup' | 'max' | 'existing' | 'model'>>, by: string): string | undefined {
    if (change.on && !this.on) return 'Pick a Linear team for this floor first';
    const next: LinearAutopilot = { ...this.autopilot, by, at: Date.now() };
    if (typeof change.on === 'boolean') {
      if (change.on && !next.on) next.since = Date.now();
      next.on = change.on;
    }
    if (Array.isArray(change.pickup)) {
      const pickup = LINEAR_PICKUPS.filter((p) => change.pickup!.includes(p));
      if (!pickup.length) return 'Pick at least one state for autopilot to take tickets from';
      next.pickup = pickup;
    }
    if (typeof change.max === 'number' && Number.isInteger(change.max)) next.max = Math.max(1, Math.min(AUTOPILOT_MAX, change.max));
    if (typeof change.existing === 'boolean') next.existing = change.existing;
    if ('model' in change) next.model = change.model || undefined;
    if (!next.model) delete next.model;
    this.autopilot = next;
    this.persist();
    this.emitState();
    if (next.on) void this.pilot();
    return undefined;
  }

  /** Reads the team's tickets again. Skipped while Linear asked the office to back off, unless forced. Autopilot looks after each read. */
  async refresh(force = false) {
    const api = this.office.client();
    const setup = this.setup;
    if (!api || !setup || !this.board || this.board.loading) return;
    if (!force && Date.now() < this.backoffUntil) return;
    void this.office.refreshTeams();
    const generation = this.generation;
    const stale = () => generation !== this.generation || this.setup !== setup || this.office.client() !== api;
    this.board = { ...this.board, loading: true };
    this.events.board(this.board);
    try {
      const items = await api.board(setup.team.id, setup.project?.id);
      if (stale()) return;
      this.strikes = 0;
      this.board = { team: setup.team.key, ...(setup.project ? { project: setup.project.name } : {}), items: this.withWorkers(items), fetchedAt: Date.now(), loading: false };
    } catch (err) {
      if (stale()) return;
      if (err instanceof LinearError && err.status === 429) {
        this.strikes++;
        const wait = Math.max((err.retryAfter ?? 0) * 1000, Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (this.strikes - 1)));
        this.backoffUntil = Date.now() + wait;
      }
      this.board = { ...this.board, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.events.board(this.board);
    void this.pilot();
  }

  /** The board's tickets, each with the worker on this floor linked to it, if one is at a desk. */
  private withWorkers(items: LinearTicket[]): LinearTicket[] {
    const workers = new Map(this.events.workers().map((w) => [w.id, w]));
    return items.map((t) => {
      const link = this.links.find((l) => l.issueId === t.id && l.stage !== 'completed' && workers.has(l.workerId));
      const { worker: _, ...rest } = t;
      return link ? { ...rest, worker: { id: link.workerId, name: workers.get(link.workerId)?.name ?? link.workerName } } : rest;
    });
  }

  /** The floor's workers changed: the cards' worker chips follow. */
  workersChanged() {
    const who = this.events
      .workers()
      .map((w) => `${w.id}:${w.name}`)
      .join(',');
    if (who === this.seen) return;
    this.seen = who;
    if (!this.board?.fetchedAt) return this.emitState();
    const items = this.withWorkers(this.board.items);
    if (JSON.stringify(items) === JSON.stringify(this.board.items)) return;
    this.board = { ...this.board, items };
    this.events.board(this.board);
    this.emitState();
  }

  /** The ticket the worker is linked to, if any: what linear_* tools act on when no issue is named. */
  linkOf(workerId: string): LinearLink | undefined {
    return [...this.links].reverse().find((l) => l.workerId === workerId && l.stage !== 'completed');
  }

  /** Description, comments and the rest, for the ticket window: only the floor's own team's tickets. */
  async detail(rawRef: string): Promise<LinearTicketDetail> {
    const api = this.office.client();
    if (!api || !this.setup) throw new LinearError('This floor has no Linear team set up', 400);
    const ref = linearIssueRef(rawRef);
    if (!ref) throw new LinearError('An issue looks like DOFF-12', 400);
    const d = await api.issue(ref);
    if (d.team.id !== this.setup.team.id) throw new LinearError(`${d.identifier} isn't one of ${this.setup.team.name}'s tickets`, 403);
    if (this.office.client() !== api) throw new LinearError('The office’s Linear connection changed while that was read. Open the ticket again.', 409);
    const link = this.links.find((l) => l.issueId === d.id && l.stage !== 'completed');
    const worker = link && this.events.workers().find((w) => w.id === link.workerId);
    return worker ? { ...d, worker: { id: worker.id, name: worker.name } } : d;
  }

  /**
   * A worker takes a ticket: it's linked to the worker, moved to the team's In Progress and assigned to
   * the office's account when nobody has it. Resolves to the ticket as it is now, or why not.
   */
  async take(rawRef: string, worker: { id: string; name: string }, opts: { auto?: boolean } = {}): Promise<{ ticket?: LinearTicketDetail; error?: string }> {
    const api = this.office.client();
    if (!api) return { error: 'Linear is not connected' };
    const ref = linearIssueRef(rawRef);
    if (!ref) return { error: 'An issue looks like DOFF-12' };
    let ticket: LinearTicketDetail;
    try {
      ticket = await api.issue(ref);
      const team = await this.office.teamContext(ticket.team.id);
      const started = stateForStage(team.states, 'started');
      const input: Record<string, unknown> = {};
      // A ticket already further along (in review, or done and being redone) keeps its state.
      if (started && !['started', 'completed'].includes(ticket.state.type)) input.stateId = started.id;
      if (!ticket.assignee && this.office.viewerId) input.assigneeId = this.office.viewerId;
      if (Object.keys(input).length) ticket = await api.updateIssue(ticket.id, input);
    } catch (err) {
      return { error: (err as Error).message };
    }
    this.links = this.links.filter((l) => !(l.issueId === ticket.id && l.stage !== 'completed') && !(l.workerId === worker.id && l.stage === 'started' && !l.pr));
    this.links.push({
      issueId: ticket.id,
      identifier: ticket.identifier,
      title: ticket.title,
      url: ticket.url,
      teamId: ticket.team.id,
      workerId: worker.id,
      workerName: worker.name,
      ...(opts.auto ? { auto: true } : {}),
      stage: 'started',
      at: Date.now(),
    });
    delete this.skipped[ticket.id];
    this.persist();
    this.emitState();
    if (this.board && this.setup?.team.id === ticket.team.id) {
      const card: LinearTicket = { ...ticket, worker: { id: worker.id, name: worker.name } };
      const items = this.board.items.some((t) => t.id === ticket.id) ? this.board.items.map((t) => (t.id === ticket.id ? { ...t, ...pickCard(card) } : t)) : [pickCard(card), ...this.board.items];
      this.board = { ...this.board, items };
      this.events.board(this.board);
    }
    return { ticket: { ...ticket, worker: { id: worker.id, name: worker.name } } };
  }

  /**
   * The owner writes a ticket from the Linear tab: made in the floor's team (and project), in Todo by
   * default so autopilot can take it, or in Backlog to park it.
   */
  async create(input: { title: string; description?: string; priority?: number; state?: 'backlog' | 'unstarted' }): Promise<LinearTicketDetail> {
    const api = this.office.client();
    const setup = this.setup;
    if (!api || !setup) throw new LinearError('This floor has no Linear team set up', 400);
    const title = input.title.trim();
    if (!title) throw new LinearError('A ticket needs a title', 400);
    const team = await this.office.teamContext(setup.team.id);
    const state = findState(team.states, input.state ?? 'unstarted');
    const ticket = await api.createIssue({
      teamId: setup.team.id,
      title: title.slice(0, 250),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(setup.project ? { projectId: setup.project.id } : {}),
      ...(state ? { stateId: state.id } : {}),
    });
    this.changed(ticket);
    void this.pilot();
    return ticket;
  }

  /** A tool changed or made one of the floor's team's tickets: the board shows it at once. */
  changed(ticket: LinearTicketDetail) {
    if (!this.board?.fetchedAt || ticket.team.id !== this.setup?.team.id) return;
    const card = pickCard(ticket);
    const items = this.board.items.some((t) => t.id === ticket.id) ? this.board.items.map((t) => (t.id === ticket.id ? card : t)) : [card, ...this.board.items];
    this.board = { ...this.board, items: this.withWorkers(items) };
    this.events.board(this.board);
  }

  /**
   * Moves linked tickets along with their workers' pull requests: attached and to review when one opens,
   * to done (with a comment) when it merges. Links whose worker left with no pull request are forgotten,
   * so a ticket put back in Todo can be taken again. Called whenever workers or pull requests change.
   */
  async sync(pulls: GhPull[]) {
    const api = this.office.client();
    if (!api || this.syncing || !this.links.length) return;
    this.syncing = true;
    try {
      const workers = new Map(this.events.workers().map((w) => [w.id, w]));
      let dirty = false;
      for (const link of [...this.links]) {
        const worker = workers.get(link.workerId);
        if (!link.pr && worker?.pr) {
          link.pr = { ...worker.pr };
          dirty = true;
        }
        const pull = link.pr ? pulls.find((p) => p.number === link.pr!.number) : undefined;
        if (link.stage === 'started' && link.pr && pull?.state !== 'MERGED') {
          await this.advance(api, link, 'review', worker);
          dirty = true;
        }
        if (link.stage !== 'completed' && pull?.state === 'MERGED') {
          await this.advance(api, link, 'completed', worker);
          dirty = true;
        }
        const gone = !worker && !link.pr && link.stage === 'started';
        const old = link.stage === 'completed' && Date.now() - link.at > LANDED_KEEP_MS;
        if (gone || old) {
          this.links = this.links.filter((l) => l !== link);
          dirty = true;
        }
      }
      if (dirty) {
        this.persist();
        this.emitState();
        if (this.board?.fetchedAt) {
          this.board = { ...this.board, items: this.withWorkers(this.board.items) };
          this.events.board(this.board);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  private async advance(api: LinearApi, link: LinearLink, stage: 'review' | 'completed', worker?: WorkerInfo) {
    const pr = link.pr;
    try {
      const team = await this.office.teamContext(link.teamId);
      const state = stateForStage(team.states, stage);
      if (stage === 'review' && pr) await api.attach(link.issueId, pr.url, `${this.events.pullName(pr.number)} by ${worker?.name ?? link.workerName}`);
      if (state) await api.updateIssue(link.issueId, { stateId: state.id });
      if (stage === 'completed' && pr) await api.comment(link.issueId, `Merged in [${this.events.pullName(pr.number)}](${pr.url}). Done by ${link.workerName} in Droid Office.`);
      link.stage = stage;
      link.at = Date.now();
      if (stage === 'completed') this.events.toast(`✅ ${link.identifier} is done: ${this.events.pullName(pr?.number ?? 0)} merged`);
      void this.refresh();
    } catch (err) {
      // It tries again on the next change; a ticket that's gone stops trying.
      if (err instanceof LinearError && err.status === 404) link.stage = stage;
      else console.error(`droid-office: couldn't move ${link.identifier} in Linear: ${(err as Error).message}`);
    }
  }

  /** Hands the next waiting tickets to workers of their own, while autopilot has room. */
  async pilot() {
    if (!this.piloted || this.piloting || !this.board?.fetchedAt || this.board.error) return;
    this.piloting = true;
    try {
      const workers = new Set(this.events.workers().map((w) => w.id));
      const busy = this.links.filter((l) => l.auto && l.stage !== 'completed' && workers.has(l.workerId)).length + this.hiring.size;
      const linked = new Set([...this.links.filter((l) => l.stage !== 'completed' && (workers.has(l.workerId) || l.pr)).map((l) => l.issueId), ...this.hiring]);
      const now = Date.now();
      for (const [id, at] of Object.entries(this.skipped)) if (now - at > RETRY_MS) delete this.skipped[id];
      for (const id of Object.keys(this.skipped)) linked.add(id);
      const picks = autopilotPicks(this.board.items, this.autopilot, linked, this.autopilot.max - busy, this.office.viewerName);
      for (const t of picks) {
        if (!this.piloted) break;
        this.hiring.add(t.id);
        let result: { workerId?: string; error?: string };
        try {
          const detail = await this.office.client()!.issue(t.id);
          const team = await this.office.teamContext(detail.team.id);
          const prompt = officePrompt(this.prompts, 'linear.work', linearPromptVars(detail, stateForStage(team.states, 'started')?.name));
          result = await this.events.hire(prompt, detail.identifier, this.autopilot.model);
        } catch (err) {
          result = { error: (err as Error).message };
        } finally {
          this.hiring.delete(t.id);
        }
        if (result.error) {
          this.skipped[t.id] = Date.now();
          this.persist();
          this.events.toast(`🛰️ Linear autopilot couldn't start ${t.identifier}: ${result.error}`, 'warn');
          // A full floor stays full for the rest of this look.
          if (/desk|bean bag|capacity|limit/i.test(result.error)) break;
        }
      }
    } finally {
      this.piloting = false;
    }
  }

  private persist() {
    try {
      const data: SavedFloor = { setup: this.setup, autopilot: this.autopilot, links: this.links, skipped: this.skipped, ...(this.off ? { off: true } : {}) };
      writePrivate(this.file, data);
    } catch (err) {
      console.error(`droid-office: couldn't save the floor's Linear setup: ${(err as Error).message}`);
    }
  }

  private restore() {
    const s = readJson(this.file) as SavedFloor | undefined;
    if (!s || typeof s !== 'object') return;
    this.off = s.off === true;
    const t = s.setup?.team;
    if (t && typeof t.id === 'string' && typeof t.key === 'string') {
      this.setup = {
        team: { id: t.id, key: t.key, name: str(t.name, t.key) },
        ...(s.setup?.project?.id ? { project: { id: s.setup.project.id, name: str(s.setup.project.name) } } : {}),
        by: str(s.setup?.by, '?'),
        at: Number(s.setup?.at) || Date.now(),
      };
    }
    const a = s.autopilot;
    if (a && typeof a === 'object') {
      const pickup = Array.isArray(a.pickup) ? LINEAR_PICKUPS.filter((p) => (a.pickup as LinearPickup[]).includes(p)) : DEFAULT_AUTOPILOT.pickup;
      this.autopilot = {
        on: a.on === true && !!this.setup,
        pickup: pickup.length ? pickup : DEFAULT_AUTOPILOT.pickup,
        max: Math.max(1, Math.min(AUTOPILOT_MAX, Number(a.max) || DEFAULT_AUTOPILOT.max)),
        existing: a.existing === true,
        since: Number(a.since) || 0,
        ...(typeof a.model === 'string' && a.model ? { model: a.model } : {}),
        by: str(a.by),
        at: Number(a.at) || 0,
      };
    }
    if (Array.isArray(s.links)) this.links = s.links.filter((l) => l && typeof l.issueId === 'string' && typeof l.workerId === 'string' && ['started', 'review', 'completed'].includes(l.stage));
    if (s.skipped && typeof s.skipped === 'object') this.skipped = { ...s.skipped };
  }
}

/** Who autopilot hires as, in toasts and on the worker's card. */
export const AUTOPILOT_NAME = 'Linear autopilot';

/** A card's own fields, from a ticket or its detail. */
function pickCard(t: LinearTicket): LinearTicket {
  const { id, identifier, title, url, priority, priorityLabel, state, assignee, labels, project, estimate, createdAt, updatedAt, sortOrder, worker } = t;
  return {
    id,
    identifier,
    title,
    url,
    priority,
    priorityLabel,
    state,
    ...(assignee ? { assignee } : {}),
    labels,
    ...(project ? { project } : {}),
    ...(estimate !== undefined ? { estimate } : {}),
    createdAt,
    updatedAt,
    sortOrder,
    ...(worker ? { worker } : {}),
  };
}
