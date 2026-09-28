import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  adfToMarkdown,
  childrenJql,
  columnsOf,
  jiraKey,
  pickTransition,
  subQueryOf,
  textToAdf,
  type JiraBoardChoice,
  type JiraBoardState,
  type JiraCategory,
  type JiraColumn,
  type JiraComment,
  type JiraConnection,
  type JiraEpic,
  type JiraFloorState,
  type JiraStage,
  type JiraTicket,
  type JiraTicketDetail,
  type JiraTransition,
} from '../shared/jira.js';

const TIMEOUT_MS = 20_000;
/** The board's columns rarely change; they're read again this often. */
const COLUMNS_MS = 10 * 60_000;
/** After a 429, the board waits at least this long, doubling for each one in a row, up to MAX_BACKOFF_MS. */
const BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** The most tickets the Jira tab shows (pages of 100). */
const MAX_TICKETS = 500;
/** The most boards looked through to find the epic's project's board. */
const MAX_BOARDS = 1000;

/** Something Jira (or the way to it) turned down, in words for whoever is at the board. */
export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds, from a 429's Retry-After. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

/** The site as https://<site>.atlassian.net, from what someone typed; undefined for anything that isn't Jira Cloud. */
export function jiraSite(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  if (!s || s.length > 300) return undefined;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host.includes('.')) host += '.atlassian.net';
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(host) ? `https://${host}` : undefined;
}

/** Takes the token (and the Basic auth made from it) out of anything that's shown or logged. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out;
}

interface Credentials {
  site: string;
  email: string;
  token: string;
}

/** Why Jira said no, from its error body: {errorMessages: [...], errors: {field: msg}}. */
function jiraSays(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as { errorMessages?: unknown; errors?: unknown; message?: unknown };
  const msgs = [...(Array.isArray(b.errorMessages) ? b.errorMessages : []), ...(b.errors && typeof b.errors === 'object' ? Object.values(b.errors) : []), ...(typeof b.message === 'string' ? [b.message] : [])];
  return msgs
    .filter((m): m is string => typeof m === 'string' && !!m.trim())
    .join(' ')
    .slice(0, 300);
}

/**
 * Jira Cloud's REST and Agile APIs, as the office's one shared account: basic auth with its email and
 * API token. Nothing here logs; errors carry no token.
 */
export class JiraApi {
  private auth: string;

  constructor(
    private creds: Credentials,
    private fetchImpl: Fetch = fetch,
  ) {
    this.auth = `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`;
  }

  get site(): string {
    return this.creds.site;
  }

  private redact(text: string): string {
    return redact(text, [this.creds.token, this.auth.slice(6)]);
  }

  async request<T>(method: string, api: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.creds.site}${api}`, {
        method,
        headers: { authorization: this.auth, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const why = e.name === 'TimeoutError' ? 'it did not answer in time' : (e.cause?.code ?? e.message);
      throw new JiraError(this.redact(`Couldn't reach ${this.creds.site} (${why}). Check the site URL.`), 0);
    }
    const text = await res.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (res.ok) return parsed as T;
    const said = this.redact(jiraSays(parsed));
    if (res.status === 401) throw new JiraError("Jira didn't accept the email and API token (401). Check both, and that the token hasn't expired or been revoked.", 401);
    if (res.status === 403) throw new JiraError(`The office's Jira account has no access to that (403)${said ? `: ${said}` : ''}`, 403);
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      throw new JiraError('Jira is rate limiting the office (429). It tries again in a while.', 429, Number.isFinite(after) && after > 0 ? after : undefined);
    }
    throw new JiraError(said || `Jira answered ${res.status}${parsed === undefined && text ? ' with something that is not Jira (check the site URL)' : ''}`, res.status);
  }

  /** Who the credentials sign in as. */
  async myself(): Promise<{ accountId: string; name: string }> {
    let me: { accountId?: string; displayName?: string } | undefined;
    try {
      me = await this.request('GET', '/rest/api/3/myself');
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) throw new JiraError(`${this.creds.site} doesn't look like a Jira Cloud site (404). Check the site URL.`, 404);
      throw err;
    }
    if (!me?.accountId) throw new JiraError(`${this.creds.site} answered, but not like Jira Cloud does. Check the site URL.`, 200);
    return { accountId: me.accountId, name: me.displayName || this.creds.email };
  }

  /** An issue with the fields asked for; a 404 means it doesn't exist or the account can't see it. */
  issue(key: string, fields: string[]): Promise<RawIssue> {
    return this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`);
  }

  /** Every board that is about a project: those whose filter names it, else those that live in it. */
  async boardsFor(project: string): Promise<JiraBoardChoice[]> {
    const pick = (values: RawBoard[]) => values.map((b) => ({ id: Number(b.id), name: String(b.name ?? `Board ${b.id}`), type: String(b.type ?? '') })).filter((b) => Number.isSafeInteger(b.id));
    const named = await this.boards(`projectKeyOrId=${encodeURIComponent(project)}`);
    if (named.length) return pick(named);
    // A board whose filter reaches the project some other way (by id, a component, a label) isn't
    // returned for it, though it still lives in the project.
    const all = await this.boards('');
    return pick(all.filter((b) => b.location?.projectKey === project));
  }

  private async boards(query: string): Promise<RawBoard[]> {
    const out: RawBoard[] = [];
    for (let startAt = 0; startAt < MAX_BOARDS; ) {
      const page = await this.request<{ values?: RawBoard[]; isLast?: boolean; maxResults?: number }>('GET', `/rest/agile/1.0/board?maxResults=50&startAt=${startAt}${query ? `&${query}` : ''}`);
      const values = page?.values ?? [];
      out.push(...values);
      if (page?.isLast !== false || !values.length) break;
      startAt += values.length;
    }
    return out;
  }

  /** The board's columns and its sub-filter. */
  async board(boardId: number): Promise<{ columns: JiraColumn[]; subQuery?: string }> {
    const config = await this.request('GET', `/rest/agile/1.0/board/${boardId}/configuration`);
    return { columns: columnsOf(config), subQuery: subQueryOf(config) };
  }

  /** The epic's direct children that the board's sub-filter lets through, in the board's rank order. */
  async children(epic: string, subQuery?: string): Promise<RawIssue[]> {
    const out: RawIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{ issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }>('POST', '/rest/api/3/search/jql', {
        jql: childrenJql(epic, subQuery),
        fields: CARD_FIELDS,
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      out.push(...(page?.issues ?? []));
      nextPageToken = page?.isLast === false || page?.nextPageToken ? page?.nextPageToken : undefined;
    } while (nextPageToken && out.length < MAX_TICKETS);
    return out.slice(0, MAX_TICKETS);
  }

  async transitions(key: string): Promise<JiraTransition[]> {
    const r = await this.request<{ transitions?: RawTransition[] }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    return (r?.transitions ?? []).map((t) => ({ id: String(t.id), name: String(t.name ?? ''), to: String(t.to?.name ?? t.name ?? ''), toCategory: category(t.to?.statusCategory?.key) }));
  }

  async transition(key: string, id: string): Promise<void> {
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id } });
  }

  async comments(key: string): Promise<JiraComment[]> {
    const r = await this.request<{ comments?: RawComment[] }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`);
    return (r?.comments ?? []).map(commentOf);
  }

  async comment(key: string, text: string): Promise<JiraComment> {
    return commentOf(await this.request<RawComment>('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text) }));
  }

  async assign(key: string, accountId: string): Promise<void> {
    await this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { accountId });
  }
}

interface RawBoard {
  id?: number;
  name?: string;
  type?: string;
  location?: { projectKey?: string };
}

interface RawTransition {
  id?: string;
  name?: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

interface RawComment {
  id?: string;
  author?: { displayName?: string };
  body?: unknown;
  created?: string;
}

export interface RawIssue {
  key: string;
  fields?: Record<string, any>;
}

const CARD_FIELDS = ['summary', 'issuetype', 'priority', 'assignee', 'status', 'updated'];
const DETAIL_FIELDS = [...CARD_FIELDS, 'description', 'reporter', 'created', 'parent'];

function category(key: unknown): JiraCategory {
  return key === 'done' || key === 'new' ? key : 'indeterminate';
}

function commentOf(c: RawComment): JiraComment {
  return { id: String(c.id ?? ''), author: c.author?.displayName ?? 'someone', body: adfToMarkdown(c.body), created: c.created ?? '' };
}

/** A card for the Jira tab, from an issue as the search API returns it. */
export function ticketOf(site: string, raw: RawIssue): JiraTicket {
  const f = raw.fields ?? {};
  return {
    key: raw.key,
    summary: String(f.summary ?? ''),
    type: String(f.issuetype?.name ?? ''),
    priority: String(f.priority?.name ?? ''),
    assignee: f.assignee?.displayName ?? undefined,
    status: String(f.status?.name ?? ''),
    statusId: String(f.status?.id ?? ''),
    category: category(f.status?.statusCategory?.key),
    url: `${site}/browse/${raw.key}`,
    updated: String(f.updated ?? ''),
  };
}

/**
 * Which ticket a worker's office-jira request may touch: the one it was handed, and no other. A
 * `requested` key that isn't that one is refused.
 */
export function workerTicket(worker: { name: string; ticket?: string }, requested?: string | null): { key: string } | { status: number; error: string } {
  if (!worker.ticket) return { status: 403, error: `${worker.name} wasn't handed a Jira ticket, so there's none to update` };
  if (requested) {
    const key = jiraKey(requested);
    if (key !== worker.ticket) return { status: 403, error: `${worker.name} can only update ${worker.ticket}, the ticket it was handed (not ${key ?? requested})` };
  }
  return { key: worker.ticket };
}

// ---- The office's connection ---------------------------------------------------------------------

interface SavedConnection extends Credentials {
  accountId: string;
  name: string;
  by: string;
  at: number;
}

/** Writes JSON readable only by the office's user, whole: a temp file renamed into place. */
function writePrivate(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * The office's one Jira Cloud connection, shared by every floor: the site, the account's email and
 * its API token, kept in the office's .agent-office/jira.json (0600). The token never leaves this
 * class: state() is what browsers get, and API errors are redacted.
 */
export class JiraOffice {
  private saved?: SavedConnection;
  private api?: JiraApi;
  readonly file: string;

  constructor(
    dataDir: string,
    private fetchImpl: Fetch = fetch,
  ) {
    this.file = path.join(dataDir, 'jira.json');
    this.restore();
  }

  /** Who the office is connected as; undefined while it isn't. Never the token. */
  connection(): JiraConnection | undefined {
    const s = this.saved;
    return s ? { site: s.site, email: s.email, name: s.name, by: s.by, at: s.at } : undefined;
  }

  get accountId(): string | undefined {
    return this.saved?.accountId;
  }

  /** The API as the connected account; undefined while there's no connection. */
  client(): JiraApi | undefined {
    return this.api;
  }

  /** Checks the details with Jira (GET /myself), then saves them. Resolves to why not, if not. */
  async connect(site: string, email: string, token: string, by: string): Promise<string | undefined> {
    const s = jiraSite(site);
    if (!s) return 'The site is your Jira Cloud address, like https://your-site.atlassian.net';
    const mail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) return "That email doesn't look right. Use the Atlassian account's email.";
    const tok = token.trim();
    if (tok.length < 8 || tok.length > 2000 || /\s/.test(tok)) return "That doesn't look like an Atlassian API token. Make one at https://id.atlassian.com/manage-profile/security/api-tokens";
    const api = new JiraApi({ site: s, email: mail, token: tok }, this.fetchImpl);
    let me: { accountId: string; name: string };
    try {
      me = await api.myself();
    } catch (err) {
      return redact((err as Error).message, [tok]);
    }
    this.saved = { site: s, email: mail, token: tok, accountId: me.accountId, name: me.name, by, at: Date.now() };
    this.api = api;
    this.persist();
    return undefined;
  }

  disconnect() {
    this.saved = undefined;
    this.api = undefined;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // already gone
    }
  }

  private persist() {
    try {
      writePrivate(this.file, this.saved);
    } catch (err) {
      console.error(`agent-office: couldn't save the Jira connection: ${(err as Error).message}`);
    }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SavedConnection>;
      const site = jiraSite(s.site);
      if (!site || typeof s.email !== 'string' || typeof s.token !== 'string' || typeof s.accountId !== 'string') return;
      this.saved = { site, email: s.email, token: s.token, accountId: s.accountId, name: typeof s.name === 'string' ? s.name : s.email, by: typeof s.by === 'string' ? s.by : '?', at: typeof s.at === 'number' ? s.at : Date.now() };
      this.api = new JiraApi(this.saved, this.fetchImpl);
    } catch {
      // a broken file just means no connection
    }
  }
}

// ---- A floor's epic --------------------------------------------------------------------------------

export interface FloorJiraEvents {
  /** The floor's Jira setup changed (its epic, or the office's connection). */
  state(state: JiraFloorState): void;
  board(state: JiraBoardState | null): void;
}

/** The answer to setting a floor's epic: saved, why not, or the boards to choose between. */
export type EpicResult = { epic: JiraEpic } | { error: string } | { choose: JiraBoardChoice[] };

/**
 * One floor's Jira epic and its kanban board: the epic's direct children in the columns of its
 * project's Jira board. Kept in the floor's .agent-office/jira-epic.json. Everything it does goes
 * through the office's connection (JiraOffice), as its one account.
 */
export class FloorJira {
  epic?: JiraEpic;
  board: JiraBoardState | null = null;
  private file: string;
  private columnsAt = 0;
  /** The board's sub-filter, read with its columns. */
  private subQuery?: string;
  private backoffUntil = 0;
  private strikes = 0;
  /** Tickets already moved to Done for a merged PR, by "<key>#<pr>", so a second look doesn't comment again. */
  private finished = new Set<string>();

  constructor(
    dataDir: string,
    private office: JiraOffice,
    private events: FloorJiraEvents,
  ) {
    this.file = path.join(dataDir, 'jira-epic.json');
    this.restore();
    this.board = this.emptyBoard();
  }

  state(): JiraFloorState {
    return { connection: this.office.connection(), epic: this.epic };
  }

  /** Connected, with an epic: the Jira tab is up. */
  get on(): boolean {
    return !!this.epic && !!this.office.client();
  }

  private emptyBoard(): JiraBoardState | null {
    return this.on && this.epic ? { epic: this.epic.key, columns: [], items: [], fetchedAt: 0, loading: false } : null;
  }

  /** The office connected, reconnected or disconnected: start over. Resolves once the board is read again. */
  connectionChanged(): Promise<void> {
    this.columnsAt = 0;
    this.subQuery = undefined;
    this.backoffUntil = 0;
    this.strikes = 0;
    this.board = this.emptyBoard();
    this.events.state(this.state());
    this.events.board(this.board);
    return this.on ? this.refresh(true) : Promise.resolve();
  }

  /**
   * Maps the floor to an epic: it must exist, be an epic, and its project must have a board. With
   * more than one board and no `boardId`, the boards come back to choose from.
   */
  async setEpic(rawKey: string, boardId: number | undefined, by: string): Promise<EpicResult> {
    const api = this.office.client();
    if (!api) return { error: 'Connect the office to Jira first' };
    const key = jiraKey(rawKey);
    if (!key) return { error: 'An epic key looks like EDP-168' };
    let raw: RawIssue;
    try {
      raw = await api.issue(key, ['summary', 'issuetype', 'project']);
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return { error: `There's no ${key} in Jira, or the office's account can't see it` };
      return { error: (err as Error).message };
    }
    const f = raw.fields ?? {};
    const type = f.issuetype ?? {};
    if (type.name !== 'Epic' && type.hierarchyLevel !== 1) return { error: `${key} is a ${type.name ?? 'ticket'}, not an epic` };
    const project = String(f.project?.key ?? key.split('-')[0]);
    let boards: JiraBoardChoice[];
    try {
      boards = await api.boardsFor(project);
    } catch (err) {
      return { error: `Couldn't list the ${project} project's boards: ${(err as Error).message}` };
    }
    if (!boards.length) return { error: `The ${project} project has no Jira board the office can see, so there are no columns to show. Make one in Jira, or give the account access to it.` };
    let board = boards.length === 1 ? boards[0] : undefined;
    if (boardId !== undefined) {
      board = boards.find((b) => b.id === boardId);
      if (!board) return { error: `Board ${boardId} isn't one of the ${project} project's boards` };
    }
    if (!board) return { choose: boards };
    try {
      const config = await api.board(board.id);
      if (!config.columns.length) return { error: `The ${board.name} board has no columns with statuses in them, so there's nothing to sort the tickets into` };
    } catch (err) {
      return { error: `Couldn't read the columns of the ${board.name} board: ${(err as Error).message}` };
    }
    this.epic = { key, summary: String(f.summary ?? ''), project, boardId: board.id, boardName: board.name, by, at: Date.now() };
    const epic = this.epic;
    this.persist();
    await this.connectionChanged();
    return { epic };
  }

  clearEpic() {
    this.epic = undefined;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // already gone
    }
    void this.connectionChanged();
  }

  /** Reads the epic's children again, and the board's columns when they're due. Skipped while Jira asked the office to back off. */
  async refresh(force = false) {
    const api = this.office.client();
    const epic = this.epic;
    if (!api || !epic || !this.board || this.board.loading) return;
    if (!force && Date.now() < this.backoffUntil) return;
    this.board = { ...this.board, loading: true };
    this.events.board(this.board);
    try {
      let columns = this.board.columns;
      if (force || !columns.length || Date.now() - this.columnsAt > COLUMNS_MS) {
        const config = await api.board(epic.boardId);
        columns = config.columns;
        this.subQuery = config.subQuery;
        this.columnsAt = Date.now();
      }
      const items = (await api.children(epic.key, this.subQuery)).map((r) => ticketOf(api.site, r));
      if (this.epic !== epic) return;
      this.strikes = 0;
      this.board = { epic: epic.key, columns, items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      if (this.epic !== epic) return;
      if (err instanceof JiraError && err.status === 429) {
        this.strikes++;
        const wait = Math.max((err.retryAfter ?? 0) * 1000, Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (this.strikes - 1)));
        this.backoffUntil = Date.now() + wait;
      }
      this.board = { ...this.board, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.events.board(this.board);
  }

  get fetchedAt(): number {
    return this.board?.fetchedAt ?? 0;
  }

  /** The API, for a ticket that is one of the epic's children. Throws when there's no connection or it isn't. */
  private async child(rawKey: string): Promise<{ api: JiraApi; key: string; raw?: RawIssue }> {
    const api = this.office.client();
    if (!api || !this.epic) throw new JiraError('This floor has no Jira epic set up', 400);
    const key = jiraKey(rawKey);
    if (!key) throw new JiraError('A ticket key looks like EDP-12', 400);
    if (this.board?.items.some((t) => t.key === key)) return { api, key };
    // Not on the board yet (it was just added to the epic): Jira says whose child it is.
    let raw: RawIssue;
    try {
      raw = await api.issue(key, DETAIL_FIELDS);
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) throw new JiraError(`There's no ${key} in Jira, or the office's account can't see it`, 404);
      throw err;
    }
    if (raw.fields?.parent?.key !== this.epic.key) throw new JiraError(`${key} isn't one of ${this.epic.key}'s tickets`, 403);
    return { api, key, raw };
  }

  /** Description, comments and the moves available: what the ticket window shows. */
  async detail(rawKey: string): Promise<JiraTicketDetail> {
    const { api, key, raw: known } = await this.child(rawKey);
    const [raw, comments, transitions] = await Promise.all([known ? Promise.resolve(known) : api.issue(key, DETAIL_FIELDS), api.comments(key), api.transitions(key)]);
    const f = raw.fields ?? {};
    return {
      ...ticketOf(api.site, raw),
      description: adfToMarkdown(f.description),
      reporter: f.reporter?.displayName ?? undefined,
      created: String(f.created ?? ''),
      comments,
      transitions,
      viewer: this.office.connection()?.name ?? '',
    };
  }

  async transitions(rawKey: string): Promise<JiraTransition[]> {
    const { api, key } = await this.child(rawKey);
    return api.transitions(key);
  }

  /**
   * Moves a ticket through Jira's workflow, by transition id, the status or transition's name, or one of
   * the office's stages. Resolves to the move made, or undefined when the workflow has none from here.
   */
  async transition(rawKey: string, want: JiraStage | string): Promise<JiraTransition | undefined> {
    const { api, key } = await this.child(rawKey);
    const t = pickTransition(await api.transitions(key), want);
    if (!t) return undefined;
    await api.transition(key, t.id);
    this.soon();
    return t;
  }

  async comment(rawKey: string, text: string): Promise<JiraComment> {
    const { api, key } = await this.child(rawKey);
    const c = await api.comment(key, text);
    return c;
  }

  /** Assigns the ticket to the office's account. */
  async assign(rawKey: string): Promise<void> {
    const { api, key } = await this.child(rawKey);
    const me = this.office.accountId;
    if (!me) throw new JiraError('The office is not connected to Jira', 400);
    await api.assign(key, me);
    this.soon();
  }

  /** A worker picked the ticket up: it's assigned to the office's account and moved to In Progress, if it can go there. Resolves to what went wrong. */
  async claim(rawKey: string): Promise<string | undefined> {
    try {
      const { api, key } = await this.child(rawKey);
      const me = this.office.accountId;
      if (!me) return 'The office is not connected to Jira';
      await api.assign(key, me);
      const current = (await api.issue(key, ['status'])).fields?.status;
      const status = String(current?.name ?? '');
      // Already under way, in review (which a board like EDP's keeps in its In Progress column) or
      // finished: picking it up again doesn't send it back.
      if (!/^in[\s-]*progress$/i.test(status) && !/review/i.test(status) && current?.statusCategory?.key !== 'done') {
        const move = pickTransition(await api.transitions(key), 'progress');
        if (move && move.to !== status) await api.transition(key, move.id);
      }
      this.soon();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }

  /**
   * The ticket's PR merged: it's moved to Done, if the workflow lets it and it isn't there already,
   * and the PR's link goes on it. Once per ticket and PR.
   */
  async finish(rawKey: string, pr: { number: number; url: string; title: string }): Promise<string | undefined> {
    const id = `${rawKey}#${pr.number}`;
    if (this.finished.has(id)) return undefined;
    this.finished.add(id);
    try {
      const { api, key } = await this.child(rawKey);
      const status = (await api.issue(key, ['status'])).fields?.status;
      const done = status?.statusCategory?.key === 'done';
      const move = done ? undefined : pickTransition(await api.transitions(key), 'done');
      if (move) await api.transition(key, move.id);
      const note = done || move ? '' : "\n\nThe workflow has no move to Done from the ticket's status, so it stays where it is.";
      await api.comment(key, `Merged: ${pr.title}\n${pr.url}${note}`);
      this.soon();
      return undefined;
    } catch (err) {
      this.finished.delete(id);
      return (err as Error).message;
    }
  }

  /** Whether a key is one of the epic's children the board knows. */
  has(key: string): boolean {
    return !!this.board?.items.some((t) => t.key === key);
  }

  /** The board catches up with a change made from here a moment later. */
  private soon() {
    setTimeout(() => void this.refresh(true), 1500).unref?.();
  }

  private persist() {
    try {
      writePrivate(this.file, this.epic);
    } catch (err) {
      console.error(`agent-office: couldn't save the floor's Jira epic: ${(err as Error).message}`);
    }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<JiraEpic>;
      const key = jiraKey(s.key);
      if (!key || typeof s.boardId !== 'number') return;
      this.epic = {
        key,
        summary: typeof s.summary === 'string' ? s.summary : '',
        project: typeof s.project === 'string' ? s.project : key.split('-')[0],
        boardId: s.boardId,
        boardName: typeof s.boardName === 'string' ? s.boardName : `Board ${s.boardId}`,
        by: typeof s.by === 'string' ? s.by : '?',
        at: typeof s.at === 'number' ? s.at : Date.now(),
      };
    } catch {
      // a broken file just means no epic
    }
  }
}
