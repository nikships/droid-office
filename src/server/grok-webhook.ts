import { DESK_BY_ID } from '../shared/layout.js';
import type { WorkerInfo } from '../shared/protocol.js';
import type { OpenQuestion } from './office-mcp/team-events.js';
import type { TeamEvent, TeamMember, WorkerResult } from './team.js';

export interface GrokBotCredentials {
  webhookUrl: string;
  webhookToken: string;
}

export type GrokWebhookItemKind = 'report' | 'progress' | 'question' | 'blocker' | 'needs_input' | 'stopped' | 'done' | 'left' | 'sent_home' | 'update' | 'message' | 'test';

export interface GrokWebhookFloor {
  id: string;
  name: string;
  cwd: string;
}

export interface GrokWebhookWorker {
  id: string;
  name: string;
  status: string;
  state?: string;
  /** Runtime turn state, independent of whether the task has been reported complete. */
  settled?: boolean;
  desk?: string;
  task?: string;
  branch?: string;
  worktree?: string;
  prUrl?: string;
}

export interface GrokWebhookTerminalAsk {
  kind: 'terminal' | 'permission';
  question: string;
  options?: Array<{ id: string; label: string; description?: string; selected?: boolean }>;
  multiSelect?: boolean;
  takesText?: boolean;
  answerable: boolean;
  why?: string;
}

export interface GrokWebhookItem {
  id: string;
  /** Exact id to pass in office_inbox({ ack: [ackId] }) once handled; omitted on test pings. */
  ackId?: string;
  kind: GrokWebhookItemKind;
  at: string;
  floor?: GrokWebhookFloor;
  worker?: GrokWebhookWorker;
  text?: string;
  options?: string[];
  /** Exact questionId for question_answer when answerable via Office MCP. */
  questionId?: string;
  terminalAsk?: GrokWebhookTerminalAsk;
  pushedSha?: string;
  prUrl?: string;
  result?: WorkerResult;
  /** Full original report is available using this durable report id. */
  reportId?: string;
  reportPhase?: 'progress' | 'final' | 'question' | 'blocked';
  /** Reported task outcome, not the terminal's live status. */
  taskComplete?: boolean;
  actionHint: string;
}

export interface GrokWebhookPayload {
  source: 'droid-office';
  version: 1;
  event: GrokWebhookItemKind;
  test?: true;
  summary: string;
  sentAt: string;
  lead: { id: string; name: string };
  items: GrokWebhookItem[];
}

export interface GrokWebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const TEXT_MAX = 12_000;
const ERROR_MAX = 240;

const PRIORITY: Record<GrokWebhookItemKind, number> = {
  question: 7,
  blocker: 6,
  needs_input: 5,
  stopped: 4,
  report: 4,
  progress: 3,
  update: 3,
  message: 3,
  sent_home: 2,
  left: 2,
  done: 1,
  test: 0,
};

/** Scrubs bearer credentials so tokens never appear in logs, UI status or tool errors. */
function scrubWebhookText(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    for (const token of [secret, secret ? encodeURIComponent(secret) : undefined]) {
      if (token) out = out.split(token).join('[redacted]');
    }
  }
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return out.replace(/\bcrsr_[A-Za-z0-9_-]+/g, '[redacted]');
}

export function redactWebhookSecret(text: string, secret?: string): string {
  return scrubWebhookText(text, [secret]).replace(/\s+/g, ' ').trim().slice(0, ERROR_MAX);
}

function clipText(text: string | undefined, reportEventId?: string): string | undefined {
  if (!text) return undefined;
  if (text.length <= TEXT_MAX) return text;
  const more = reportEventId ? `full report available by report id ${reportEventId}` : 'full text in the inbox';
  return `${text.slice(0, TEXT_MAX)}\n… [truncated; ${more}]`;
}

export function webhookWorkerFromMember(m: TeamMember | undefined, w?: WorkerInfo, fallback?: { id: string; name: string }): GrokWebhookWorker | undefined {
  if (m) {
    return {
      id: m.id,
      name: m.name,
      status: m.status,
      state: m.state,
      settled: m.settled,
      desk: m.desk,
      ...(m.task ? { task: m.task } : {}),
      ...(m.worktree ? { branch: m.worktree.branch, worktree: m.worktree.path } : {}),
      ...(m.pr ? { prUrl: m.pr.url } : {}),
    };
  }
  if (w) {
    return {
      id: w.id,
      name: w.name,
      status: w.status,
      settled: !['starting', 'working', 'idle'].includes(w.status),
      desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId,
      ...(w.task?.name ? { task: w.task.name } : {}),
      ...(w.worktree ? { branch: w.worktree.branch } : {}),
      ...(w.pr ? { prUrl: w.pr.url } : {}),
    };
  }
  return fallback ? { id: fallback.id, name: fallback.name, status: 'exited', settled: true } : undefined;
}

function teamActionHint(item: { kind: GrokWebhookItemKind; questionId?: string; terminalAsk?: GrokWebhookTerminalAsk }): string {
  const ack = 'Acknowledge the ackId after handling this item.';
  if (item.kind === 'question' && item.questionId) {
    return `Answer the question identified by questionId, or send guidance to this worker on this floor. ${ack}`;
  }
  if (item.kind === 'needs_input') {
    if (item.terminalAsk?.answerable && item.questionId) {
      return `Answer the waiting terminal question identified by questionId. ${ack}`;
    }
    return `Worker is waiting on a terminal prompt only the person at the desk can approve${item.terminalAsk?.why ? ` (${item.terminalAsk.why})` : ''}: notify the owner. ${ack}`;
  }
  if (item.kind === 'report') {
    return `Review this worker's changes and checks, and record a review before merging or dismissing it. ${ack}`;
  }
  if (item.kind === 'progress') return `The task is not finished. Follow its progress and step in if help is needed; do not merge or dismiss it yet. ${ack}`;
  if (item.kind === 'stopped' || item.kind === 'blocker') {
    return `Inspect this worker's recent activity and blocker, then help it resume or send guidance. ${ack}`;
  }
  return `Check this worker's status on this floor if action is needed. ${ack}`;
}

export function buildTeamWebhookItem(args: { event: TeamEvent; floor: GrokWebhookFloor; member?: TeamMember; worker?: WorkerInfo; openQuestion?: OpenQuestion }): GrokWebhookItem {
  const { event, floor, member, worker, openQuestion } = args;
  const id = `team:${floor.id}:${event.seq}`;
  const kind: GrokWebhookItemKind = event.kind === 'report' ? (event.result?.status === 'blocked' || event.result?.status === 'failed' ? 'blocker' : event.progress || event.result?.status === 'partial' ? 'progress' : 'report') : event.kind;
  const isReport = event.kind === 'report' || event.kind === 'question';
  const reportPhase = kind === 'question' ? 'question' : kind === 'blocker' ? 'blocked' : kind === 'progress' ? 'progress' : 'final';
  const terminalAsk: GrokWebhookTerminalAsk | undefined =
    openQuestion && (openQuestion.kind === 'terminal' || openQuestion.kind === 'permission')
      ? {
          kind: openQuestion.kind,
          question: openQuestion.question,
          ...(openQuestion.options.length ? { options: openQuestion.options } : {}),
          ...(openQuestion.multiSelect ? { multiSelect: true } : {}),
          ...(openQuestion.takesText ? { takesText: true } : {}),
          answerable: openQuestion.answerable,
          ...(openQuestion.why ? { why: openQuestion.why } : {}),
        }
      : undefined;
  const questionId = event.kind === 'question' ? id : terminalAsk?.answerable ? openQuestion?.id : undefined;
  const prUrl = event.prUrl ?? event.result?.artifacts?.prUrl ?? member?.pr?.url ?? worker?.pr?.url;
  return {
    id,
    ackId: id,
    kind,
    at: new Date(event.at).toISOString(),
    floor,
    worker: webhookWorkerFromMember(member, worker, { id: event.worker, name: event.name }),
    // Structured results carry the summary and artifacts once. Keep original prose in the durable report.
    ...(event.text && (event.kind !== 'report' || !event.result) ? { text: clipText(event.text, isReport ? id : undefined) } : {}),
    ...(isReport ? { reportId: id, reportPhase, taskComplete: kind === 'report' && (!event.result || event.result.status === 'ok') } : {}),
    ...(event.options?.length ? { options: [...event.options] } : {}),
    ...(questionId ? { questionId } : {}),
    ...(terminalAsk ? { terminalAsk } : {}),
    ...(event.pushedSha ? { pushedSha: event.pushedSha } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(event.result ? { result: event.result } : {}),
    actionHint: teamActionHint({ kind, questionId, terminalAsk }),
  };
}

function itemHeadline(item: GrokWebhookItem, leadName: string): string {
  const who = item.worker ? `${item.worker.name}${item.floor ? ` (${item.floor.name})` : ''}` : item.floor ? item.floor.name : 'Droid Office';
  // Headlines describe the event, never a clipped fragment of the worker's prose.
  switch (item.kind) {
    case 'question':
      return `${who} asked ${leadName} a question.`;
    case 'blocker':
      return `${who} reported a blocker to ${leadName}.`;
    case 'report':
      return `${who} sent a final report to ${leadName}.`;
    case 'progress':
      return `${who} reported progress to ${leadName}; the task is not finished.`;
    case 'needs_input':
      return `${who} needs terminal input.`;
    case 'stopped':
      return `${who} stopped.`;
    case 'done':
      return `${who} finished its turn without reporting.`;
    case 'sent_home':
      return `${who} was sent home by the owner.`;
    case 'left':
      return `${who} left the floor.`;
    case 'update':
      return `${who} sent an update to ${leadName}.`;
    case 'message':
      return `Message for ${leadName}${item.floor ? ` from ${item.floor.name}` : ''}.`;
    case 'test':
      return `[TEST] Droid Office webhook verification for ${leadName}.`;
  }
}

export function buildGrokWebhookPayload(lead: { id: string; name: string }, items: GrokWebhookItem[], now = Date.now()): GrokWebhookPayload {
  const primary = items.reduce((best, cur) => (PRIORITY[cur.kind] > PRIORITY[best.kind] ? cur : best), items[0]);
  const test = items.length === 1 && primary.kind === 'test';
  const summary =
    items.length === 1
      ? itemHeadline(primary, lead.name)
      : `${items.length} Droid Office updates for ${lead.name}: ${items
          .slice(0, 3)
          .map((item) => itemHeadline(item, lead.name))
          .join('; ')}${items.length > 3 ? ` (+${items.length - 3} more)` : ''}`;
  return {
    source: 'droid-office',
    version: 1,
    event: primary.kind,
    ...(test ? { test: true as const } : {}),
    summary,
    sentAt: new Date(now).toISOString(),
    lead,
    items,
  };
}

/** POSTs a JSON wake payload to a Grok Bot's webhook with its bearer token; never follows redirects or leaks secrets. */
export async function sendGrokWebhook(target: GrokBotCredentials, payload: GrokWebhookPayload, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<GrokWebhookResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetchImpl(target.webhookUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.webhookToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'droid-office/1.0',
      },
      // Scrub every string, including nested summaries/artifacts, without changing payload structure.
      body: JSON.stringify(payload, (_key, value: unknown) => (typeof value === 'string' ? scrubWebhookText(value, [target.webhookToken, target.webhookUrl]) : value)),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 200 && res.status < 300) {
      await res.arrayBuffer().catch(() => undefined);
      return { ok: true, status: res.status };
    }
    const raw = (await res.text().catch(() => '')).slice(0, 2048);
    const clean = redactWebhookSecret(scrubWebhookText(raw, [target.webhookUrl]), target.webhookToken);
    return { ok: false, status: res.status, error: clean ? `HTTP ${res.status}: ${clean}` : `HTTP ${res.status}` };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const why = e.name === 'TimeoutError' ? 'Webhook timed out' : (e.cause?.code ?? e.cause?.message ?? e.message ?? 'Webhook request failed');
    return { ok: false, error: redactWebhookSecret(scrubWebhookText(String(why), [target.webhookUrl]), target.webhookToken) || 'Webhook request failed' };
  }
}
