// Droid sessions: the account's recent sessions, the office's own workers' among them
// (WorkerInfo.sessionId matches FactorySession.id), what each has cost, and the transcript's
// messages. Read by src/server/factory/sessions.ts; drawn by the lounge TV (world/factory-tv.ts),
// the Sessions window (ui/factory-sessions.ts) and the transcript (ui/factory-transcript.ts).

export type FactorySessionStatus = 'idle' | 'pending' | 'running';

/** Where the Factory web app shows a session (its own share links are `<app>/sessions/<id>`). */
export const FACTORY_APP = 'https://app.factory.ai';
export const sessionWebUrl = (id: string) => `${FACTORY_APP}/sessions/${encodeURIComponent(id)}`;

/** The settings a session takes, as the API spells them. */
export const SESSION_EFFORTS = ['none', 'dynamic', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const SESSION_MODES = ['auto', 'spec', 'agi', 'mission'] as const;
export const SESSION_AUTONOMY = ['off', 'low', 'medium', 'high'] as const;
export const SESSION_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type SessionEffort = (typeof SESSION_EFFORTS)[number];
export type SessionMode = (typeof SESSION_MODES)[number];
export type SessionAutonomy = (typeof SESSION_AUTONOMY)[number];

export const MODE_LABEL: Record<SessionMode, string> = { auto: 'Auto', spec: 'Spec', agi: 'AGI', mission: 'Mission' };

/** Something a session made: a pull request, mostly. */
export interface FactorySessionArtifact {
  id: string;
  kind: string;
  url?: string;
  title?: string;
  provider?: string;
  /** What the session did with it (`create`, `merge`…). */
  action?: string;
  /** Like `owner/repo#72`. */
  externalId?: string;
  /** ms */
  createdAt?: number;
}

export interface FactorySession {
  id: string;
  title: string;
  status: FactorySessionStatus | string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** The Factory computer it runs on; none for a session on a machine of the owner's. */
  computerId?: string;
  /** The session that started it, for a Task subagent. */
  parentId?: string;
  model?: string;
  effort?: string;
  interactionMode?: string;
  autonomyLevel?: string;
  artifacts: FactorySessionArtifact[];
  /** Factory credits used by the session and its subagents (only GET /sessions/{id} has them). */
  credits?: number;
  /** When the office last read the session by itself (ms), which is where `credits` and a fresh `status` come from. */
  fetchedAt?: number;
}

/** One of the office's own workers (on any floor, desk or cloud, guests too) and its session. */
export interface FactoryOfficeSession {
  workerId: string;
  name: string;
  floor?: string;
  color?: string;
  credits?: number;
}

export interface FactoryCreditDay {
  /** Local `YYYY-MM-DD`. */
  day: string;
  credits: number;
  /**
   * The part of `credits` that is a guess: the whole total of a session the office read for the
   * first time, put on the day it was last active, though some of it may have been spent earlier.
   */
  guessed: number;
  /** Some of the day is a guess, or it's before the office started counting. */
  estimated: boolean;
}

export interface FactoryCredits {
  /** The last CREDIT_DAYS days, oldest first; today is the last. */
  days: FactoryCreditDay[];
  today: number;
  week: number;
  /** When the office started counting credits (ms), 0 before it has seen any. */
  since: number;
  /** The sessions that used the most credits over those days. */
  top: { id: string; title: string; credits: number }[];
}

/** How many sessions one page of GET /sessions brings; the slice keeps two pages at most. */
export const SESSIONS_LIMIT = 50;
export const SESSIONS_KEPT = 100;
/** The longest title the slice keeps; Factory titles a session with its first prompt, which can be long. */
export const SESSION_TITLE_MAX = 200;
export const CREDIT_DAYS = 7;
/**
 * Factory 404s a session it just made for a while (a few seconds, sometimes longer): until it's this
 * old, a 404 for it means "not readable yet" rather than "gone".
 */
export const NEW_SESSION_GRACE_MS = 3 * 60_000;

export interface FactorySessionsState {
  items: FactorySession[];
  /** Factory has more than `items`. */
  hasMore: boolean;
  fetchedAt: number;
  error?: string;
  /** The office's own workers' sessions, by session id. */
  office: Record<string, FactoryOfficeSession>;
  credits: FactoryCredits;
}

export function emptyCredits(): FactoryCredits {
  return { days: [], today: 0, week: 0, since: 0, top: [] };
}

export function emptySessions(): FactorySessionsState {
  return { items: [], hasMore: false, fetchedAt: 0, office: {}, credits: emptyCredits() };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function artifactOf(raw: unknown): FactorySessionArtifact | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const id = optStr(r.id) ?? optStr(r.externalId) ?? optStr(r.url);
  if (!id) return undefined;
  const at = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : num(r.createdAt);
  return {
    id,
    kind: optStr(r.kind) ?? 'artifact',
    ...(optStr(r.url) ? { url: optStr(r.url) } : {}),
    ...(optStr(r.title) ? { title: optStr(r.title) } : {}),
    ...(optStr(r.provider) ? { provider: optStr(r.provider) } : {}),
    ...(optStr(r.action) ? { action: optStr(r.action) } : {}),
    ...(optStr(r.externalId) ? { externalId: optStr(r.externalId) } : {}),
    ...(Number.isFinite(at) && at > 0 ? { createdAt: at } : {}),
  };
}

/** A session from GET /sessions, GET /sessions/{id} or POST /sessions. */
export function sessionOf(raw: unknown): FactorySession | undefined {
  const r = obj(raw);
  if (!r) return undefined;
  const id = optStr(r.sessionId);
  if (!id) return undefined;
  const title = typeof r.title === 'string' ? r.title : '';
  const settings = obj(r.sessionSettings) ?? {};
  const completedAt = num(r.completedAt);
  return {
    id,
    title: title.length > SESSION_TITLE_MAX ? `${title.slice(0, SESSION_TITLE_MAX - 1)}…` : title,
    status: optStr(r.status) ?? 'idle',
    messageCount: num(r.messageCount),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
    ...(completedAt ? { completedAt } : {}),
    ...(optStr(r.computerId) ? { computerId: optStr(r.computerId) } : {}),
    ...(optStr(r.parent_session_id) ? { parentId: optStr(r.parent_session_id) } : {}),
    ...(optStr(settings.model) ? { model: optStr(settings.model) } : {}),
    ...(optStr(settings.reasoningEffort) ? { effort: optStr(settings.reasoningEffort) } : {}),
    ...(optStr(settings.interactionMode) ? { interactionMode: optStr(settings.interactionMode) } : {}),
    ...(optStr(settings.autonomyLevel) ? { autonomyLevel: optStr(settings.autonomyLevel) } : {}),
    artifacts: (Array.isArray(r.artifacts) ? r.artifacts : []).map(artifactOf).filter((a): a is FactorySessionArtifact => !!a),
    ...(typeof r.factoryCredits === 'number' && Number.isFinite(r.factoryCredits) ? { credits: r.factoryCredits } : {}),
  };
}

/** The credits the office knows for a session: its worker's, else the list's. */
export function sessionCredits(s: FactorySessionsState, sessionId: string | undefined): number | undefined {
  if (!sessionId) return undefined;
  return s.office[sessionId]?.credits ?? s.items.find((x) => x.id === sessionId)?.credits;
}

export const isLive = (s: { status: string }) => s.status === 'running' || s.status === 'pending';

/** Where a session runs: one of this office's workers, a Factory computer, or somewhere else (another machine, the web app). */
export interface SessionWhere {
  kind: 'office' | 'cloud' | 'elsewhere';
  label: string;
  /** The worker's color, for one of the office's. */
  color?: string;
}

export function sessionWhere(state: FactorySessionsState, computers: readonly { id: string; name: string }[], s: FactorySession): SessionWhere {
  const ours = state.office[s.id];
  if (ours) return { kind: 'office', label: ours.floor ? `${ours.name} · ${ours.floor}` : ours.name, ...(ours.color ? { color: ours.color } : {}) };
  if (s.computerId) return { kind: 'cloud', label: computers.find((c) => c.id === s.computerId)?.name ?? 'a Factory computer' };
  return { kind: 'elsewhere', label: 'elsewhere' };
}

/** How long, in a few characters: "40s", "12m", "2h 05m", "3d 4h". */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "⚡ 841k credits" for a worker's session, '' while the office doesn't know (or isn't connected). */
export function creditsNote(s: FactorySessionsState, sessionId: string | undefined): string {
  const n = sessionCredits(s, sessionId);
  return n === undefined ? '' : `⚡ ${compactCredits(n)} credits`;
}

/** 841059 → "841k", 4519251 → "4.5M", 950 → "950". */
export function compactCredits(n: number): string {
  const a = Math.abs(n);
  const cut = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`;
  if (a >= 1e9) return cut(n / 1e9, 'B');
  if (a >= 1e6) return cut(n / 1e6, 'M');
  if (a >= 1e3) return cut(n / 1e3, 'k');
  return String(Math.round(n));
}

/** The pull requests (and other links) sessions made, newest first, each once. */
export function latestArtifacts(items: readonly FactorySession[], max: number): { artifact: FactorySessionArtifact; session: FactorySession }[] {
  const seen = new Map<string, { artifact: FactorySessionArtifact; session: FactorySession }>();
  for (const session of items) {
    for (const artifact of session.artifacts) {
      if (artifact.action === 'view' || !artifact.url) continue;
      const key = artifact.url;
      const at = artifact.createdAt ?? session.updatedAt;
      const had = seen.get(key);
      if (!had || (had.artifact.createdAt ?? had.session.updatedAt) < at) seen.set(key, { artifact, session });
    }
  }
  return [...seen.values()].sort((a, b) => (b.artifact.createdAt ?? b.session.updatedAt) - (a.artifact.createdAt ?? a.session.updatedAt)).slice(0, max);
}

/** "owner/repo#72" for a pull request link, else its title or URL. */
export function artifactLabel(a: FactorySessionArtifact): string {
  if (a.externalId) return a.externalId;
  const m = a.url && /github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(a.url);
  if (m) return `${m[1]}#${m[2]}`;
  return a.title ?? a.url ?? a.id;
}

// ---- The transcript ----------------------------------------------------------------------------

/** One piece of a message, cut down to what the transcript shows. */
export type FactoryBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; text: string; isError: boolean; images?: number }
  | { type: 'image'; mediaType: string; data?: string }
  | { type: 'document'; name: string };

export interface FactoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | string;
  createdAt: number;
  seq?: number;
  blocks: FactoryBlock[];
  isError?: boolean;
  model?: string;
}

/** The most a block keeps: a long tool output or a huge paste is cut, with a note that it was. */
export const TEXT_MAX = 60_000;
export const RESULT_MAX = 16_000;
export const INPUT_MAX = 4_000;
/** Images bigger than this (base64 characters) aren't sent to the page: just a placeholder. */
export const IMAGE_MAX = 1_500_000;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s);

function inputOf(raw: unknown): Record<string, unknown> {
  const r = obj(raw);
  if (!r) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'string') out[k] = cut(v, INPUT_MAX);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else {
      const j = JSON.stringify(v) ?? '';
      out[k] = j.length > INPUT_MAX ? cut(j, INPUT_MAX) : v;
    }
  }
  return out;
}

function resultText(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: '', images: 0 };
  let images = 0;
  const parts: string[] = [];
  for (const c of content) {
    const o = obj(c);
    if (o?.type === 'text' && typeof o.text === 'string') parts.push(o.text);
    else if (o?.type === 'image') images++;
  }
  return { text: parts.join('\n'), images };
}

function blockOf(raw: unknown): FactoryBlock | undefined {
  const b = obj(raw);
  if (!b) return undefined;
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string' && b.text.trim() ? { type: 'text', text: cut(b.text, TEXT_MAX) } : undefined;
    case 'thinking':
      return typeof b.thinking === 'string' && b.thinking.trim() ? { type: 'thinking', text: cut(b.thinking, RESULT_MAX) } : undefined;
    case 'tool_use':
      return { type: 'tool_use', id: optStr(b.id) ?? '', name: optStr(b.name) ?? 'tool', input: inputOf(b.input) };
    case 'tool_result': {
      const { text, images } = resultText(b.content);
      return { type: 'tool_result', toolUseId: optStr(b.toolUseId) ?? '', text: cut(text, RESULT_MAX), isError: b.isError === true, ...(images ? { images } : {}) };
    }
    case 'image': {
      const src = obj(b.source) ?? {};
      const mediaType = optStr(src.mediaType) ?? 'image/png';
      const data = typeof src.data === 'string' && src.data.length <= IMAGE_MAX && (SESSION_IMAGE_TYPES as readonly string[]).includes(mediaType) ? src.data : undefined;
      return { type: 'image', mediaType, ...(data ? { data } : {}) };
    }
    case 'document': {
      const src = obj(b.source) ?? {};
      return { type: 'document', name: optStr(src.name) ?? optStr(src.path) ?? optStr(src.mediaType) ?? 'a file' };
    }
    default:
      return undefined;
  }
}

/** A message from GET /sessions/{id}/messages, or undefined for one nobody sees (system, hidden). */
export function messageOf(raw: unknown): FactoryMessage | undefined {
  const r = obj(raw);
  const id = r && optStr(r.id);
  if (!r || !id) return undefined;
  const role = optStr(r.role) ?? 'assistant';
  if (role === 'system' || r.hiddenFromUserViews === true || r.visibility === 'llm_only' || r.isUserVisible === false) return undefined;
  const blocks = (Array.isArray(r.content) ? r.content : []).map(blockOf).filter((b): b is FactoryBlock => !!b);
  if (!blocks.length) return undefined;
  return {
    id,
    role,
    createdAt: num(r.createdAt),
    ...(typeof r.seq === 'number' ? { seq: r.seq } : {}),
    blocks,
    ...(r.isError === true ? { isError: true } : {}),
    ...(optStr(r.modelId) ? { model: optStr(r.modelId) } : {}),
  };
}

const order = (a: FactoryMessage, b: FactoryMessage) => (a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : a.createdAt - b.createdAt);

/** Two pages of a transcript as one, oldest first, each message once (the later copy wins). */
export function mergeMessages(a: readonly FactoryMessage[], b: readonly FactoryMessage[]): FactoryMessage[] {
  const byId = new Map<string, FactoryMessage>();
  for (const m of a) byId.set(m.id, m);
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort(order);
}

/** Every tool result in a transcript by the call it answers, so a call's line can open onto its result. */
export function resultsByCall(messages: readonly FactoryMessage[]): Map<string, Extract<FactoryBlock, { type: 'tool_result' }>> {
  const out = new Map<string, Extract<FactoryBlock, { type: 'tool_result' }>>();
  for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_result' && b.toolUseId) out.set(b.toolUseId, b);
  return out;
}

/** What a tool call's line says after its name: the command, the file, the pattern… */
const TOOL_ARG: Record<string, string[]> = {
  Execute: ['command'],
  Read: ['file_path', 'path'],
  Edit: ['file_path', 'path'],
  MultiEdit: ['file_path', 'path'],
  Create: ['file_path', 'path'],
  ApplyPatch: ['input'],
  LS: ['directory_path', 'path'],
  Grep: ['pattern'],
  Glob: ['patterns', 'pattern'],
  FetchUrl: ['url'],
  WebSearch: ['query'],
  Task: ['description', 'prompt'],
  TodoWrite: [],
};

/** A tool call as one line: "Execute: npm test", "Read: src/main.ts", "TodoWrite". */
export function toolLine(name: string, input: Record<string, unknown>, max = 140): string {
  const keys = TOOL_ARG[name] ?? ['command', 'file_path', 'path', 'query', 'pattern', 'url', 'description', 'prompt'];
  let arg = '';
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) arg = v;
    else if (Array.isArray(v) && v.length) arg = v.filter((x) => typeof x === 'string').join(' ');
    if (arg) break;
  }
  if (!arg && !(name in TOOL_ARG)) {
    const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
    if (typeof first === 'string') arg = first;
  }
  const one = arg.replace(/\s+/g, ' ').trim();
  if (!one) return name;
  const line = `${name}: ${one}`;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
