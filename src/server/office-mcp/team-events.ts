import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canAnswer, menuTakesText, type Menu } from '../../shared/asks.js';
import { permissionLine, questionPresentation } from '../../shared/ask-question.js';
import { DESK_BY_ID } from '../../shared/layout.js';
import type { WorkerInfo } from '../../shared/protocol.js';
import { settled, TEAM_EVENT_KINDS, type Team, type TeamEvent, type TeamEventKind, type TeamMember, type TeamViews, type WorkerResult, type WorkerReview } from '../team.js';
import { briefAge, formatForgeLines, formatTaskTag } from '../worker-status.js';
import type { WorkerManager } from '../workers.js';
import { formatBlockingSummary, formatQueueBrief } from '../worker-queue.js';
import { officeAccess, officeError, officeResult, ownFloor, type OfficeMcpAccess, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer, type OfficeProgress } from './index.js';
import { floorNamed } from '../remote-office.js';

// Structured team state for bots that manage subagents: compact worker objects, typed events with
// ids, timestamps and cursors, a long-poll wait, and the questions waiting on the lead.

/** One floor a lead's team is on: its own floor, or every open floor for a building agent. */
export interface TeamScope {
  id: string;
  team: Pick<Team, 'handle' | Exclude<TeamViews, 'isWatching'>> & Partial<Pick<Team, 'isWatching'>>;
  workers: Pick<WorkerManager, 'get' | 'list'> & Partial<Pick<WorkerManager, 'screenLines' | 'screenMenu' | 'write'>>;
}

/** What a filter or wait may name: every event kind, plus blocked (a subagent needs input in its own terminal). */
export const EVENT_FILTERS = [...TEAM_EVENT_KINDS, 'blocked'] as const;
const WAIT_FOR = [...EVENT_FILTERS, 'idle'] as const;
const WAIT_DEFAULT: (typeof WAIT_FOR)[number][] = ['report', 'question', 'pr', 'blocked', 'idle'];
const WAIT_DEFAULT_SEC = 30;
const WAIT_MAX_SEC = 600;
/** Single-call hold cap so long waits return cleanly with a cursor before ~120–240s HTTP/MCP client timeouts (-32001). */
export const WAIT_HOLD_MAX_SEC = 90;
/** Open waits one caller may hold at once, so a looping client can't pile up held requests. */
const WAITS_PER_CALLER = 4;
const BEAT_MS = 15_000;
const SUMMARY_MAX = 240;
const HISTORY_MAX = 20;
const EVENT_ID = /^team:([a-z0-9-]+):(\d+)$/;
const ASK_ID = /^ask:([a-z0-9-]+):(.+):([0-9a-f]{12}|permission|terminal)$/;

export const eventId = (floor: string, seq: number) => `team:${floor}:${seq}`;
const iso = (at: number) => new Date(at).toISOString();
export function summary(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/** The event kinds a filter names; blocked is needs_input. */
export function eventKinds(filters: readonly string[] | undefined): Set<TeamEventKind> | undefined {
  if (!filters) return undefined;
  const kinds = new Set<TeamEventKind>();
  for (const f of filters) {
    if (f === 'blocked') kinds.add('needs_input');
    else if ((TEAM_EVENT_KINDS as string[]).includes(f)) kinds.add(f as TeamEventKind);
  }
  return kinds;
}

/**
 * A status cursor: comma-separated event ids, one per floor (`team:<floor>:<seq>`). A bare number is a
 * seq on `own`, the caller's floor, which a building agent doesn't have. Undefined when it isn't one.
 */
export function parseCursor(value: string, own: string | undefined): Map<string, number> | undefined {
  const cursor = new Map<string, number>();
  for (const part of value.split(',').map((p) => p.trim())) {
    const m = EVENT_ID.exec(part);
    const seq = m ? Number(m[2]) : /^\d+$/.test(part) ? Number(part) : NaN;
    const floor = m ? m[1] : own;
    if (!Number.isSafeInteger(seq) || floor === undefined) return undefined;
    cursor.set(floor, Math.max(seq, cursor.get(floor) ?? 0));
  }
  return cursor.size ? cursor : undefined;
}

export function cursorOf(latest: Record<string, number>): string {
  return Object.entries(latest)
    .map(([floor, seq]) => eventId(floor, seq))
    .join(',');
}

/** A subagent (or watched floor worker) as compact structured status shows it. */
export function compactWorker(m: TeamMember, floor: string) {
  return {
    id: m.id,
    name: m.name,
    floor,
    desk: m.desk,
    state: m.state,
    status: m.status,
    ...(m.watched ? { watched: true as const } : {}),
    ...(m.task ? { task: m.task } : {}),
    ...(m.taskLabel ? { taskLabel: m.taskLabel } : {}),
    ...(m.activity ? { doing: m.activity } : {}),
    ...(m.plan ? { plan: { done: m.plan.done, total: m.plan.total, ...(m.plan.current ? { current: m.plan.current } : {}) } } : {}),
    ...(m.currentTool ? { currentTool: m.currentTool } : {}),
    ...(m.lastTool ? { lastTool: m.lastTool } : {}),
    ...(m.lastActivityAt ? { lastActivityAt: m.lastActivityAt, silentForMs: m.silentForMs } : {}),
    ...(m.queued ? { queued: m.queued } : {}),
    ...(m.retryingModel ? { retryingModel: m.retryingModel } : {}),
    ...(m.modelError ? { modelError: m.modelError } : {}),
    ...(m.modelStatus ? { modelStatus: m.modelStatus } : {}),
    ...(m.areas?.length ? { areas: [...m.areas] } : {}),
    ...(m.note ? { note: { text: summary(m.note.text), at: m.note.at } } : {}),
    ...(m.model ? { model: m.model } : {}),
    ...(m.effort ? { effort: m.effort } : {}),
    ...(m.cwd ? { cwd: m.cwd } : {}),
    ...(m.worktree ? { branch: m.worktree.branch, worktree: m.worktree.path, ...(m.worktree.from ? { from: m.worktree.from } : {}) } : {}),
    ...(!m.worktree && m.branch ? { branch: m.branch } : {}),
    ...(m.sharedCheckout ? { sharedCheckout: true as const } : {}),
    ...(m.warnings?.length ? { warnings: [...m.warnings] } : {}),
    ...(m.pr ? { pr: m.pr } : {}),
    ...(m.prStatus ? { prStatus: m.prStatus } : {}),
    ...(m.ci ? { ci: m.ci } : {}),
    ...(m.releaseRun ? { releaseRun: m.releaseRun } : {}),
    ...(m.report
      ? {
          lastReportId: eventId(floor, m.report.seq),
          lastReportKind: m.report.question ? 'question' : m.report.progress ? 'progress' : 'report',
          lastReportAt: iso(m.report.at),
          lastReportSummary: summary(m.report.result?.summary ?? m.report.text),
          ...(m.report.result ? { result: m.report.result } : {}),
          ...(m.report.review ? { review: m.report.review } : {}),
        }
      : {}),
    ...(m.openQuestion !== undefined ? { openQuestionId: eventId(floor, m.openQuestion) } : {}),
    ...(m.awaitingJob ? { awaitingJob: true as const } : {}),
    ...(m.queuedMessages?.count ? { queuedMessages: m.queuedMessages } : {}),
    ...(m.blockingTool ? { blockingTool: m.blockingTool } : {}),
  };
}

/** An event with its id and time; the full text only when asked for. */
export function compactEvent(e: Pick<TeamEvent, 'seq' | 'kind' | 'worker' | 'name' | 'at' | 'text' | 'options' | 'progress' | 'watched' | 'result' | 'review'>, floor: string, verbose = false) {
  return {
    id: eventId(floor, e.seq),
    kind: e.kind,
    worker: e.worker,
    name: e.name,
    floor,
    at: iso(e.at),
    ...(e.text ? { summary: summary(e.text), ...(verbose ? { text: e.text } : {}) } : {}),
    ...(e.options?.length ? { options: e.options } : {}),
    ...(e.progress ? { progress: true as const } : {}),
    ...(e.watched ? { watched: true as const } : {}),
    ...(e.result ? { result: e.result } : {}),
    ...(e.review ? { review: e.review } : {}),
  };
}

export type CompactWorker = ReturnType<typeof compactWorker>;
export type CompactEvent = ReturnType<typeof compactEvent>;

export function resultDetailLines(result: WorkerResult | undefined, review?: WorkerReview): string[] {
  const lines: string[] = [];
  if (result) {
    const a = result.artifacts;
    const parts = [
      ...(a?.prUrl ? [`PR ${a.prUrl}`] : a?.prNumber !== undefined ? [`PR #${a.prNumber}`] : []),
      ...(a?.mergeCommit ? [`merge ${a.mergeCommit.slice(0, 12)}`] : []),
      ...(a?.commits?.length ? [`commits: ${a.commits.map((c) => c.slice(0, 12)).join(', ')}`] : []),
      ...(a?.files?.length ? [`files (${a.files.length}): ${a.files.slice(0, 8).join(', ')}${a.files.length > 8 ? '…' : ''}`] : []),
    ];
    lines.push(`Result (${result.status}): ${result.summary}${parts.length ? ` [${parts.join('; ')}]` : ''}`);
    if (result.remaining?.length) lines.push(`Remaining: ${result.remaining.join('; ')}`);
    if (result.conflicts?.length) lines.push(`Conflicts (${result.conflicts.length}): ${result.conflicts.map((c) => c.path).join(', ')}`);
  }
  if (review) lines.push(`Review (${review.verdict} by ${review.by}): ${review.notes}`);
  return lines;
}

export function compactWorkerText(w: CompactWorker): string {
  const forgeLines = formatForgeLines({ pr: w.prStatus, ci: w.ci, releaseRun: w.releaseRun });
  const queueBrief = w.queuedMessages ? formatQueueBrief(w.queuedMessages) : undefined;
  return [
    `${w.name} (${w.id})${w.watched ? ' [watching]' : ''} ${w.state}${w.awaitingJob ? ' (not finished: its progress report says it waits on its own background work)' : ''}, ${w.desk}${w.task ? `: ${w.task}${formatTaskTag(w.taskLabel)}` : ''}.`,
    ...(w.modelStatus && w.modelStatus.state !== 'ok' ? [`${w.modelStatus.state === 'cooldown' ? 'Model cooldown' : 'Model alert'}: ${w.modelStatus.summary}.`] : []),
    ...(w.retryingModel && w.modelStatus?.state !== 'retrying' ? [`Retrying: ${w.retryingModel.detail}.`] : []),
    ...(w.modelError && w.modelStatus?.state !== 'rate_limited' ? [`Model error: ${w.modelError}.`] : []),
    ...(w.plan ? [`Plan ${w.plan.done}/${w.plan.total}${w.plan.current ? ` (${w.plan.current})` : ''}.`] : []),
    ...(w.currentTool ? [`Tool: ${w.currentTool.summary} (${briefAge(w.currentTool.runningForMs)}).`] : []),
    ...(w.doing && !w.currentTool ? [`Doing: ${w.doing}.`] : []),
    ...(w.blockingTool ? [`Blocking: ${formatBlockingSummary(w.blockingTool)}.`] : []),
    ...(w.silentForMs !== undefined && w.silentForMs >= 30_000 ? [`Last hook ${briefAge(w.silentForMs)} ago.`] : []),
    ...(queueBrief ? [`${queueBrief}.`] : w.queued ? [`Queued: ${w.queued.terminal} terminal message${w.queued.terminal === 1 ? '' : 's'}, ${w.queued.notices} next-step notice${w.queued.notices === 1 ? '' : 's'}.`] : []),
    ...(w.areas?.length ? [`Areas: ${w.areas.join(', ')}.`] : []),
    ...(w.note ? [`Note: ${w.note.text}`] : []),
    ...(w.cwd && !w.worktree ? [`Directory ${w.cwd}${w.sharedCheckout ? ' (no worktree)' : ''}.`] : []),
    ...(w.branch ? [`Branch ${w.branch}.`] : []),
    ...(forgeLines.length ? forgeLines.map((l) => `${l}.`) : w.pr ? [`PR ${w.pr.url}.`] : []),
    ...(w.warnings?.length ? [`Warning: ${w.warnings.join('; ')}.`] : []),
    ...(w.lastReportId ? [`Last ${w.lastReportKind}${w.result ? ` (${w.result.status})` : ''} ${w.lastReportAt} [${w.lastReportId}]: ${w.lastReportSummary}`] : []),
    ...(w.review ? [`Review: ${w.review.verdict} by ${w.review.by} (${summary(w.review.notes)}).`] : []),
  ].join(' ');
}

export function compactEventText(e: CompactEvent): string {
  const statusTag = e.result && e.result.status !== 'ok' && !e.progress && e.kind !== 'question' ? ` [${e.result.status}]` : '';
  const reviewTag = e.review ? ` [review: ${e.review.verdict}]` : '';
  return `[${e.id} ${e.at}] ${e.progress ? 'progress report (not finished)' : e.kind} ${e.name}${e.summary ? `: ${e.summary}` : ''}${statusTag}${reviewTag}`;
}

/** The floors whose teams a caller's team tools cover: its own, or for a building agent every open floor (or the one named). */
export function teamScopes(caller: OfficeMcpCaller, deps: OfficeMcpDeps, floor?: string): TeamScope[] | string {
  if (caller.building && deps.remote) {
    const all = deps.remote.floors();
    if (floor === undefined) return all.length ? all : 'No floor is open.';
    const named = floorNamed(all, floor);
    return typeof named === 'string' ? named : [named];
  }
  const own = ownFloor(caller);
  if (floor && floor !== own.id) return 'Floor workers manage only their own floor';
  return [own];
}

/** Subagent or watched-worker ids by name or id across scopes; a name on more than one floor, or none, is an error. */
function watchedWorkers(scopes: TeamScope[], lead: string, names: readonly string[] | undefined): Set<string> | string | undefined {
  if (!names?.length) return undefined;
  const ids = new Set<string>();
  for (const name of names) {
    const want = name.trim().toLowerCase();
    const found = scopes.flatMap((s) => s.workers.list().filter((w) => (w.lead === lead || s.team.isWatching?.(lead, w.id)) && (w.id === want || w.name.toLowerCase() === want || w.name.replace(/ 🐚$/, '').toLowerCase() === want)));
    if (found.length !== 1) return found.length ? `${name} names subagents on several floors: use the worker id` : `No subagent called ${name} in your team: team status lists them`;
    ids.add(found[0].id);
  }
  return ids;
}

const deskLabel = (w: WorkerInfo) => DESK_BY_ID.get(w.deskId)?.label ?? w.deskId;
const desk = (w: WorkerInfo | undefined) => (w ? { desk: deskLabel(w) } : {});

function menuHash(menu: Menu): string {
  const shape = { q: menu.question ?? '', m: !!menu.multiSelect, f: menu.freeText, c: menu.choices.map((c) => [c.number, c.label, c.description ?? '']), ...(menu.review ? { review: menu.review } : {}) };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 12);
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  selected?: boolean;
}

/** A question waiting on the lead, as questions_list shows it, like the phone's Asks inbox. */
export interface OpenQuestion {
  id: string;
  /** team: asked with team_report. terminal: an AskUser menu in its terminal. permission: a permission prompt only the person at the desk can answer. */
  kind: 'team' | 'terminal' | 'permission';
  worker: string;
  name: string;
  floor: string;
  desk?: string;
  at?: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  takesText: boolean;
  answerable: boolean;
  why?: string;
}

export function terminalQuestion(scope: TeamScope, w: WorkerInfo): OpenQuestion | undefined {
  if (w.status !== 'needs_input' || w.kind !== 'agent' || w.cloud) return undefined;
  const base = { worker: w.id, name: w.name, floor: scope.id, desk: deskLabel(w), ...(w.waitingSince ? { at: iso(w.waitingSince) } : {}) };
  const atDesk = `Someone has to answer it at ${w.name}'s desk: tell whoever asked you.`;
  if (w.ask?.kind === 'permission')
    return { ...base, id: `ask:${scope.id}:${w.id}:permission`, kind: 'permission', question: permissionLine(w.ask), options: [], multiSelect: false, takesText: false, answerable: false, why: `A permission prompt. ${atDesk}` };
  const lines = scope.workers.screenLines?.(w.id);
  const menu = w.ask?.kind === 'question' && canAnswer(w, lines) ? scope.workers.screenMenu?.(w.id) : undefined;
  if (!menu || !scope.workers.write)
    return {
      ...base,
      id: `ask:${scope.id}:${w.id}:terminal`,
      kind: 'terminal',
      question: w.activity ?? 'Waiting for input in its terminal',
      options: [],
      multiSelect: false,
      takesText: false,
      answerable: false,
      // The hook says it asks before the menu has drawn.
      why: w.ask?.kind === 'question' ? `Its menu is not on screen yet: list questions again in a moment. ${atDesk}` : atDesk,
    };
  const shown = questionPresentation(menu, [], w.ask);
  return {
    ...base,
    id: `ask:${scope.id}:${w.id}:${menuHash(menu)}`,
    kind: 'terminal',
    question: menu.review ? `${shown.question}\n${menu.review.join('\n')}` : shown.question,
    options: shown.choices.map((c) => ({ id: String(c.number), label: c.label, ...(c.description ? { description: c.description } : {}), ...(c.selected !== undefined ? { selected: c.selected } : {}) })),
    multiSelect: !!menu.multiSelect,
    takesText: menuTakesText(menu),
    answerable: true,
  };
}

/** Every question waiting on `lead` across scopes: its subagents' team_report questions and their terminal questions. */
export function openQuestions(scopes: TeamScope[], lead: string, watched?: ReadonlySet<string>): OpenQuestion[] {
  return scopes.flatMap((s) => {
    const asked = s.team
      .questions(lead)
      .filter((e) => !watched || watched.has(e.worker))
      .map(
        (e): OpenQuestion => ({
          id: eventId(s.id, e.seq),
          kind: 'team',
          worker: e.worker,
          name: e.name,
          floor: s.id,
          ...desk(s.workers.get(e.worker)),
          at: iso(e.at),
          question: e.text ?? '',
          options: (e.options ?? []).map((label, i) => ({ id: String(i + 1), label })),
          multiSelect: false,
          takesText: true,
          answerable: true,
        }),
      );
    const terminal = s.workers
      .list()
      .filter((w) => (w.lead === lead || s.team.isWatching?.(lead, w.id)) && (!watched || watched.has(w.id)))
      .flatMap((w) => terminalQuestion(s, w) ?? []);
    return [...asked, ...terminal];
  });
}

function questionText(q: OpenQuestion): string {
  return [
    `[${q.id}] ${q.name} (${q.kind}${q.at ? `, ${q.at}` : ''}): ${q.question}`,
    ...q.options.map((o) => `  ${o.id}. ${o.label}${o.description ? ` (${o.description})` : ''}${o.selected ? ' [selected]' : ''}`),
    ...(q.answerable ? [] : [`  Not answerable here: ${q.why}`]),
  ].join('\n');
}

const workerOut = z.looseObject({
  id: z.string(),
  name: z.string(),
  floor: z.string(),
  desk: z.string(),
  state: z.string(),
  status: z.string(),
  task: z.string().optional(),
  doing: z.string().optional(),
  areas: z.array(z.string()).optional(),
  note: z.object({ text: z.string(), at: z.number() }).optional(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  lastReportId: z.string().optional(),
  lastReportAt: z.string().optional(),
  lastReportSummary: z.string().optional(),
  openQuestionId: z.string().optional(),
});
const eventOut = z.looseObject({ id: z.string(), kind: z.string(), worker: z.string(), name: z.string(), floor: z.string(), at: z.string(), summary: z.string().optional(), text: z.string().optional() });
const questionOut = z.looseObject({
  id: z.string(),
  kind: z.enum(['team', 'terminal', 'permission']),
  worker: z.string(),
  name: z.string(),
  floor: z.string(),
  question: z.string(),
  options: z.array(z.looseObject({ id: z.string(), label: z.string() })),
  multiSelect: z.boolean(),
  takesText: z.boolean(),
  answerable: z.boolean(),
  why: z.string().optional(),
});
export const statusOutput = { workers: z.array(workerOut), news: z.array(eventOut), cursor: z.string() };

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const cursorArg = z.string().trim().min(1).max(4000).describe('Cursor or team:<floor>:<seq> id; considers events after it.');
export const floorArg = z.string().trim().min(1).max(4096).optional().describe('Building agents only (floor workers omit): floor id, name, or path.');

/** Waiting suits a lead that hears nothing otherwise: an external bot, or one woken by notes with Wake the lead off. */
const mayWait: OfficeMcpAccess = (c) => officeAccess.team(c) ?? (c.worker.remote || !c.settings.wakeLead ? undefined : 'Wake the lead is on, so a wake note tells you when your team has news: end your turn instead of waiting.');

export function register(server: OfficeMcpServer, deps: OfficeMcpDeps): void {
  const waiting = new Map<string, number>();

  server.tool(
    {
      name: 'team_wait',
      description:
        'Wait (when Wake the lead is off or as an external bot) until a subagent reports, asks, blocks, or settles; returns matched events, waiting questions, workers, and cursor (holds up to 90s per call to stay under MCP client timeouts, returning matched: false with cursor; reuse cursor only with same until). On return, inspect worker_diff, answer technical questions via question_answer, and relay contract changes via team_message.',
      inputSchema: z.object({
        until: z
          .array(z.enum(WAIT_FOR))
          .min(1)
          .max(WAIT_FOR.length)
          .optional()
          .describe(`Event kinds, blocked, or idle. Default ${WAIT_DEFAULT.join(', ')}.`),
        workers: z.array(z.string().trim().min(1).max(128)).min(1).max(20).optional().describe('Subagent names or ids; omit for all.'),
        timeoutSec: z
          .number()
          .int()
          .min(1)
          .max(WAIT_MAX_SEC)
          .optional()
          .describe(`Max seconds (default ${WAIT_DEFAULT_SEC}, max ${WAIT_MAX_SEC}; holds up to ${WAIT_HOLD_MAX_SEC}s per call under client timeouts, returning matched: false + cursor to continue).`),
        since: cursorArg.optional(),
        floor: floorArg,
        verbose: z.boolean().optional().describe('Full event text instead of summaries.'),
      }),
      outputSchema: z.looseObject({
        matched: z.boolean(),
        reason: z.string(),
        waitedMs: z.number(),
        capped: z.boolean().optional(),
        events: z.array(eventOut),
        questions: z.array(questionOut),
        workers: statusOutput.workers,
        cursor: statusOutput.cursor,
      }),
      annotations: readOnly,
    },
    mayWait,
    async (args, caller, signal, progress) => {
      const scopes = teamScopes(caller, deps, args.floor);
      if (typeof scopes === 'string') return officeError(scopes);
      const lead = caller.worker.id;
      const watched = watchedWorkers(scopes, lead, args.workers);
      if (typeof watched === 'string') return officeError(watched);
      const since = args.since === undefined ? undefined : parseCursor(args.since, caller.floor?.id);
      if (args.since !== undefined && !since) return officeError('since takes a cursor from an earlier team status or team_wait, or one team:<floor>:<seq> event id.');
      const open = waiting.get(lead) ?? 0;
      if (open >= WAITS_PER_CALLER) return officeError(`You already have ${open} team_wait calls open: let one return before starting another.`);
      waiting.set(lead, open + 1);
      try {
        const until = new Set(args.until ?? WAIT_DEFAULT);
        const kinds = eventKinds([...until]);
        // A remote lead's unheard news stays in office_inbox; without a cursor for that floor it waits for what's new from now.
        const after = new Map(scopes.map((s) => [s.id, since?.has(s.id) ? since.get(s.id)! : caller.worker.remote ? s.team.latest() : undefined]));
        const news = () => scopes.flatMap((s) => s.team.news(lead, { after: after.get(s.id), unread: after.get(s.id) === undefined, kinds, workers: watched }).map((e) => ({ e, floor: s.id })));
        const reasonOf = (events: Matched['events']) => (events[0].e.kind === 'needs_input' && !until.has('needs_input') ? 'blocked' : events[0].e.kind);
        const team = () => scopes.flatMap((s) => s.workers.list().filter((w) => (w.lead === lead || s.team.isWatching?.(lead, w.id)) && (!watched || watched.has(w.id))));
        // From the hooks' account of the question, not the screen: its menu may draw after the last signal a wait hears.
        const asks = () => team().flatMap((w) => (w.status === 'needs_input' && w.kind === 'agent' && !w.cloud && w.ask?.kind === 'question' ? [`${w.id}:${w.waitingSince ?? 0}:${JSON.stringify(w.ask.questions)}`] : []));
        // A terminal question or a settled team counts only when it comes about during the wait: one that was
        // already so would end every default wait at once. Team questions are news, which since already orders.
        const askedBefore = new Set(asks());
        let busy = !team().every(settled);
        const requestedSec = args.timeoutSec ?? WAIT_DEFAULT_SEC;
        const requestedMs = requestedSec * 1000;
        const overrideMs = deps.waitHoldMaxMs;
        const maxHoldMs = overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : WAIT_HOLD_MAX_SEC * 1000;
        const holdMs = Math.min(requestedMs, maxHoldMs);
        const capped = requestedMs > holdMs;
        const started = Date.now();
        const outcome = await waitFor(scopes, {
          signal,
          progress,
          timeoutMs: holdMs,
          check: () => {
            const events = news();
            if (events.length) return { reason: reasonOf(events), events };
            if (until.has('question') && asks().some((q) => !askedBefore.has(q))) return { reason: 'question', events: [] };
            if (until.has('idle')) {
              if (!team().every(settled)) busy = true;
              else if (busy) return { reason: 'idle', events: [] };
            }
            return undefined;
          },
        });
        if (signal.aborted) return officeError('Wait cancelled.');
        // Read the news again beside the cursor: a later signal may have added events after the match, and the
        // cursor must not pass any event this response leaves out.
        const found = news();
        const cursor = cursorOf(Object.fromEntries(scopes.map((s) => [s.id, s.team.latest()])));
        const matched = !!outcome || found.length > 0;
        const reason = outcome?.reason ?? (found.length ? reasonOf(found) : 'timeout');
        if (!caller.worker.remote)
          for (const s of scopes)
            s.team.markSeen(
              lead,
              found.filter((x) => x.floor === s.id).map((x) => x.e.seq),
            );
        const events = found.map(({ e, floor }) => compactEvent(e, floor, args.verbose));
        const questions = openQuestions(scopes, lead, watched);
        const workers = scopes.flatMap((s) =>
          s.team
            .roster(lead)
            .filter((m) => !watched || watched.has(m.id))
            .map((m) => compactWorker(m, s.id)),
        );
        const body = { matched, reason, waitedMs: Date.now() - started, ...(capped && !matched ? { capped: true } : {}), events, questions, workers, cursor };
        let headline = `Nothing matched within ${requestedSec} s.`;
        if (matched) headline = `Matched ${reason}.`;
        else if (capped) headline = `Nothing matched within ${Math.max(1, Math.round(holdMs / 1000))} s (capped from ${requestedSec} s to stay under MCP client timeouts; call team_wait again with since set to Cursor to keep waiting).`;
        return officeResult(
          [
            headline,
            ...events.map(compactEventText),
            ...(questions.length ? [`Questions waiting on you:\n${questions.map(questionText).join('\n')}`] : []),
            ...(workers.length ? workers.map(compactWorkerText) : ['You have no subagents.']),
            `Cursor: ${cursor}`,
          ].join('\n'),
          body,
        );
      } finally {
        const left = (waiting.get(lead) ?? 1) - 1;
        if (left > 0) waiting.set(lead, left);
        else waiting.delete(lead);
      }
    },
  );

  server.tool(
    {
      name: 'team_report_get',
      description: 'Read one full subagent report or question (by id or worker’s latest) plus recent history, read-only.',
      inputSchema: z.object({
        worker: z.string().trim().min(1).max(128).optional().describe('Subagent name or id.'),
        id: z.string().trim().min(1).max(200).optional().describe('Event id (team:<floor>:<seq>).'),
        floor: floorArg,
      }),
      outputSchema: z.looseObject({ report: eventOut, history: z.array(eventOut) }),
      annotations: readOnly,
    },
    officeAccess.team,
    (args, caller) => {
      if (!args.worker && !args.id) return officeError('Name the subagent with worker, or give a report id.');
      const scopes = teamScopes(caller, deps, args.floor);
      if (typeof scopes === 'string') return officeError(scopes);
      const lead = caller.worker.id;
      const wanted = args.id === undefined ? undefined : parseCursor(args.id, caller.floor?.id);
      if (args.id !== undefined && (wanted?.size !== 1 || args.id.includes(','))) return officeError('id takes one event id, such as team:<floor>:<seq> from lastReportId.');
      const [floor, seq] = wanted ? [...wanted][0] : [];
      let found = scopes.flatMap((s) =>
        s.team
          .reports(lead, args.worker)
          .filter((e) => seq === undefined || (s.id === floor && e.seq === seq))
          .map((e) => ({ e, floor: s.id })),
      );
      if (!args.id && new Set(found.map((x) => x.e.worker)).size > 1) {
        // Reports outlive their subagent, so a name hired again after a dismissal means the one on the team now.
        const onTeam = new Set(scopes.flatMap((s) => s.workers.list().flatMap((w) => (w.lead === lead || s.team.isWatching?.(lead, w.id) ? [w.id] : []))));
        const current = found.filter((x) => onTeam.has(x.e.worker));
        if (new Set(current.map((x) => x.e.worker)).size !== 1) return officeError(`${args.worker} names more than one subagent: use the worker id${scopes.length > 1 ? ' or floor' : ''}.`);
        found = current;
      }
      const pick = found.at(-1);
      if (!pick) return officeError(args.id ? `No report or question ${args.id} from your subagents.` : `${args.worker} has not reported or asked anything you can still read.`);
      const history = scopes.flatMap((s) => s.team.reports(lead, pick.e.worker).map((e) => compactEvent(e, s.id))).slice(-HISTORY_MAX);
      const report = compactEvent(pick.e, pick.floor, true);
      return officeResult(
        [
          `${report.kind === 'question' ? 'Question' : report.progress ? 'Progress report (not finished)' : 'Report'} ${report.id} from ${report.name} at ${report.at}:`,
          pick.e.text ?? '',
          ...resultDetailLines(pick.e.result, pick.e.review),
          ...(history.length > 1 ? [`History:\n${history.map(compactEventText).join('\n')}`] : []),
        ].join('\n'),
        { report, history },
      );
    },
  );

  server.tool(
    {
      name: 'questions_list',
      description: 'List open subagent questions (team_report questions and AskUser menus), read-only. Answer technical questions immediately with question_answer; permission prompts show answerable: false (desk approval only).',
      inputSchema: z.object({ workers: z.array(z.string().trim().min(1).max(128)).min(1).max(20).optional().describe('Subagent names or ids; omit for all.'), floor: floorArg }),
      outputSchema: z.looseObject({ questions: z.array(questionOut) }),
      annotations: readOnly,
    },
    officeAccess.team,
    (args, caller) => {
      const scopes = teamScopes(caller, deps, args.floor);
      if (typeof scopes === 'string') return officeError(scopes);
      const watched = watchedWorkers(scopes, caller.worker.id, args.workers);
      if (typeof watched === 'string') return officeError(watched);
      const questions = openQuestions(scopes, caller.worker.id, watched);
      return officeResult(questions.length ? questions.map(questionText).join('\n\n') : 'No questions are waiting on you.', { questions });
    },
  );

  server.tool(
    {
      name: 'question_answer',
      description:
        'Answer a questions_list id. Team questions accept optionId and/or text as one message. Terminal menus accept optionId OR text, or optionIds with optional text for multi-select, only while the same menu remains. Refuses permission prompts. Combine related updates in the answer rather than sending duplicate messages.',
      inputSchema: z.object({
        questionId: z.string().trim().min(1).max(400).describe('Question id from questions_list.'),
        optionId: z.string().trim().min(1).max(8).optional().describe('Single option id.'),
        optionIds: z.array(z.string().trim().min(1).max(8)).max(9).optional().describe('Multi-select option ids.'),
        text: z.string().trim().min(1).max(20_000).optional().describe('Typed answer.'),
      }),
      outputSchema: z.looseObject({ answered: z.boolean(), questionId: z.string(), worker: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    officeAccess.team,
    async (args, caller, signal) => {
      if (args.optionId !== undefined && args.optionIds !== undefined) return officeError('Give optionId for one option or optionIds for a multi-select, not both.');
      if (args.optionId === undefined && args.optionIds === undefined && args.text === undefined) return officeError('Give optionId, optionIds or text.');
      const scopes = teamScopes(caller, deps);
      if (typeof scopes === 'string') return officeError(scopes);
      const lead = caller.worker.id;
      const done = (name: string, worker: string) => officeResult(`Answered ${name}'s question.`, { answered: true, questionId: args.questionId, worker });
      const team = parseCursor(args.questionId, caller.floor?.id);
      if (args.questionId.startsWith('team:') && !args.questionId.includes(',') && team?.size === 1) {
        const [floor, seq] = [...team][0];
        const scope = scopes.find((s) => s.id === floor);
        const asked = scope?.team.questions(lead).find((e) => e.seq === seq);
        if (!scope || !asked) return officeError('That question is no longer open: it was answered, or the subagent moved on. questions_list shows what is.');
        if (args.optionIds !== undefined) return officeError('A team question takes one optionId or text.');
        const option = args.optionId === undefined ? undefined : asked.options?.[Number(args.optionId) - 1];
        if (args.optionId !== undefined && !option) return officeError(`${args.optionId} is not one of this question's options.`);
        const text = [option, args.text].filter(Boolean).join('\n\n');
        const result = await scope.team.handle(caller.worker, { action: 'send', worker: asked.worker, text });
        if (result.status >= 400) return officeError(typeof result.body.error === 'string' ? result.body.error : 'The answer could not be sent.');
        return done(asked.name, asked.worker);
      }
      const ask = ASK_ID.exec(args.questionId);
      const scope = ask ? scopes.find((s) => s.id === ask[1]) : undefined;
      const w = ask && scope?.workers.get(ask[2]);
      if (!ask || !scope || !w || (w.lead !== lead && !(caller.building && scope.team.isWatching?.(lead, w.id)))) return officeError('No question with that id is waiting on you. questions_list shows the open ones.');
      const now = terminalQuestion(scope, w);
      if (now?.kind === 'permission') return officeError(now.why ?? 'Only the person at its desk can answer a permission prompt.');
      if (!now?.answerable || now.id !== args.questionId) return officeError('The question changed or was already answered, so nothing was sent. questions_list shows the current one.');
      if (args.optionId !== undefined && args.text !== undefined) return officeError('A terminal question takes optionId or text, not both: text alone types your own answer, and a multi-select takes optionIds with text.');
      const shown = scope.workers.screenMenu?.(w.id);
      // The menu answered must be the one the id names, not one that replaced it since.
      if (!shown || menuHash(shown) !== args.questionId.slice(args.questionId.lastIndexOf(':') + 1)) return officeError('The question changed or was already answered, so nothing was sent.');
      const number = (id: string) => (/^\d+$/.test(id) ? Number(id) : NaN);
      const reply = args.optionId !== undefined ? { choice: number(args.optionId) } : { ...(args.optionIds !== undefined ? { choices: args.optionIds.map(number) } : {}), ...(args.text !== undefined ? { text: args.text } : {}) };
      if (reply.choice !== undefined && !shown.choices.some((c) => c.number === reply.choice)) return officeError(`${args.optionId} is not one of this question's options.`);
      const unknown = args.optionIds?.find((id) => !shown.choices.some((c) => c.number === number(id)));
      if (unknown !== undefined) return officeError(`${unknown} is not one of this question's options.`);
      const error = await deps.answers.answer(w.id, shown, reply, {
        worker: () => scope.workers.get(w.id),
        lines: () => scope.workers.screenLines?.(w.id),
        menu: () => scope.workers.screenMenu?.(w.id),
        write: (data) => scope.workers.write?.(w.id, data),
        live: () => !signal.aborted,
      });
      return error ? officeError(error) : done(w.name, w.id);
    },
  );
}

interface Matched {
  reason: string;
  events: { e: TeamEvent; floor: string }[];
}

/** Resolves with what `check` finds, at once or on the next team signal that makes it true; undefined on timeout or abort. Always unsubscribes. */
export function waitFor(scopes: TeamScope[], opts: { check(): Matched | undefined; timeoutMs: number; signal: AbortSignal; progress: OfficeProgress }): Promise<Matched | undefined> {
  const first = opts.check();
  if (first || opts.signal.aborted) return Promise.resolve(first);
  return new Promise((resolve) => {
    const started = Date.now();
    let unsubscribe: (() => void)[] = [];
    const finish = (value: Matched | undefined) => {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      clearTimeout(timer);
      clearInterval(beat);
      opts.signal.removeEventListener('abort', aborted);
      resolve(value);
    };
    const aborted = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), opts.timeoutMs);
    const beat = setInterval(() => opts.progress(Math.round((Date.now() - started) / 1000), 'Waiting for your team'), BEAT_MS);
    opts.signal.addEventListener('abort', aborted, { once: true });
    unsubscribe = scopes.map((s) =>
      s.team.subscribe(() => {
        const found = opts.check();
        if (found) finish(found);
      }),
    );
  });
}
