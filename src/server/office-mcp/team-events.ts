import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canAnswer, menuTakesText, type Menu } from '../../shared/asks.js';
import { permissionLine, questionPresentation } from '../../shared/ask-question.js';
import { DESK_BY_ID } from '../../shared/layout.js';
import type { WorkerInfo } from '../../shared/protocol.js';
import { settled, TEAM_EVENT_KINDS, type Team, type TeamEvent, type TeamEventKind, type TeamMember, type TeamViews } from '../team.js';
import type { WorkerManager } from '../workers.js';
import { officeAccess, officeError, officeResult, ownFloor, type OfficeMcpAccess, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer, type OfficeProgress } from './index.js';
import { floorNamed } from '../remote-office.js';

// Structured team state for bots that manage subagents: compact worker objects, typed events with
// ids, timestamps and cursors, a long-poll wait, and the questions waiting on the lead.

/** One floor a lead's team is on: its own floor, or every open floor for a building agent. */
export interface TeamScope {
  id: string;
  team: Pick<Team, 'handle' | TeamViews>;
  workers: Pick<WorkerManager, 'get' | 'list'> & Partial<Pick<WorkerManager, 'screenLines' | 'screenMenu' | 'write'>>;
}

/** What a filter or wait may name: every event kind, plus blocked (a subagent needs input in its own terminal). */
export const EVENT_FILTERS = [...TEAM_EVENT_KINDS, 'blocked'] as const;
const WAIT_FOR = [...EVENT_FILTERS, 'idle'] as const;
const WAIT_DEFAULT: (typeof WAIT_FOR)[number][] = ['report', 'question', 'blocked', 'idle'];
const WAIT_DEFAULT_SEC = 30;
const WAIT_MAX_SEC = 600;
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

/** A subagent as compact structured status shows it. */
export function compactWorker(m: TeamMember, floor: string) {
  return {
    id: m.id,
    name: m.name,
    floor,
    desk: m.desk,
    state: m.state,
    status: m.status,
    ...(m.task ? { task: m.task } : {}),
    ...(m.activity ? { doing: m.activity } : {}),
    ...(m.model ? { model: m.model } : {}),
    ...(m.effort ? { effort: m.effort } : {}),
    ...(m.worktree ? { branch: m.worktree.branch, worktree: m.worktree.path, ...(m.worktree.from ? { from: m.worktree.from } : {}) } : {}),
    ...(m.pr ? { pr: m.pr } : {}),
    ...(m.report ? { lastReportId: eventId(floor, m.report.seq), lastReportKind: m.report.question ? 'question' : 'report', lastReportAt: iso(m.report.at), lastReportSummary: summary(m.report.text) } : {}),
    ...(m.openQuestion !== undefined ? { openQuestionId: eventId(floor, m.openQuestion) } : {}),
  };
}

/** An event with its id and time; the full text only when asked for. */
export function compactEvent(e: Pick<TeamEvent, 'seq' | 'kind' | 'worker' | 'name' | 'at' | 'text' | 'options'>, floor: string, verbose = false) {
  return {
    id: eventId(floor, e.seq),
    kind: e.kind,
    worker: e.worker,
    name: e.name,
    floor,
    at: iso(e.at),
    ...(e.text ? { summary: summary(e.text), ...(verbose ? { text: e.text } : {}) } : {}),
    ...(e.options?.length ? { options: e.options } : {}),
  };
}

export type CompactWorker = ReturnType<typeof compactWorker>;
export type CompactEvent = ReturnType<typeof compactEvent>;

export function compactWorkerText(w: CompactWorker): string {
  return [
    `${w.name} (${w.id}) ${w.state}, ${w.desk}${w.task ? `: ${w.task}` : ''}.`,
    ...(w.doing ? [`Doing: ${w.doing}.`] : []),
    ...(w.branch ? [`Branch ${w.branch}.`] : []),
    ...(w.pr ? [`PR ${w.pr.url}.`] : []),
    ...(w.lastReportId ? [`Last ${w.lastReportKind} ${w.lastReportAt} [${w.lastReportId}]: ${w.lastReportSummary}`] : []),
  ].join(' ');
}

export function compactEventText(e: CompactEvent): string {
  return `[${e.id} ${e.at}] ${e.kind} ${e.name}${e.summary ? `: ${e.summary}` : ''}`;
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

/** Subagent ids by name or id across scopes; a name on more than one floor, or none, is an error. */
function watchedWorkers(scopes: TeamScope[], lead: string, names: readonly string[] | undefined): Set<string> | string | undefined {
  if (!names?.length) return undefined;
  const ids = new Set<string>();
  for (const name of names) {
    const want = name.trim().toLowerCase();
    const found = scopes.flatMap((s) => s.workers.list().filter((w) => w.lead === lead && (w.id === want || w.name.toLowerCase() === want || w.name.replace(/ 🐚$/, '').toLowerCase() === want)));
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

function terminalQuestion(scope: TeamScope, w: WorkerInfo): OpenQuestion | undefined {
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
      .filter((w) => w.lead === lead && (!watched || watched.has(w.id)))
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
const cursorArg = z.string().trim().min(1).max(4000).describe('A cursor from an earlier response (cursor field), or one event id: only events after it are considered, whether or not you have heard them.');
export const floorArg = z.string().trim().min(1).max(4096).optional().describe('Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building.');

/** Waiting suits a lead that hears nothing otherwise: an external bot, or one woken by notes with Wake the lead off. */
const mayWait: OfficeMcpAccess = (c) => officeAccess.team(c) ?? (c.worker.remote || !c.settings.wakeLead ? undefined : 'Wake the lead is on, so a wake note tells you when your team has news: end your turn instead of waiting.');

export function register(server: OfficeMcpServer, deps: OfficeMcpDeps): void {
  const waiting = new Map<string, number>();

  server.tool(
    {
      name: 'team_wait',
      description:
        'Wait until one of your subagents reports, asks, gets blocked in its terminal or settles, then return with what happened: typed events with ids, waiting questions and a cursor. Matching news you have not heard (or news after since) returns at once. A terminal question counts when it appears during the wait, and idle when every watched subagent settles during it; questions already waiting are listed without ending the wait. At timeoutSec it returns with matched false. The cursor moves past news that until leaves out, so reuse it with the same until. Without since, a local lead hears the news it is shown, as with team_status. Set your client timeout to cover long waits; with a progress token it reports progress every 15 s.',
      inputSchema: z.object({
        until: z
          .array(z.enum(WAIT_FOR))
          .min(1)
          .max(WAIT_FOR.length)
          .optional()
          .describe(`What to wait for. Event kinds, blocked (needs input in its own terminal), or idle (every watched subagent settles during the wait). Default ${WAIT_DEFAULT.join(', ')}.`),
        workers: z.array(z.string().trim().min(1).max(128)).min(1).max(20).optional().describe('Subagent names or ids to watch. Omit for your whole team.'),
        timeoutSec: z.number().int().min(1).max(WAIT_MAX_SEC).optional().describe(`Longest wait in seconds, default ${WAIT_DEFAULT_SEC}, at most ${WAIT_MAX_SEC}.`),
        since: cursorArg.optional(),
        floor: floorArg,
        verbose: z.boolean().optional().describe('Include each event full text, not just its summary.'),
      }),
      outputSchema: z.looseObject({ matched: z.boolean(), reason: z.string(), waitedMs: z.number(), events: z.array(eventOut), questions: z.array(questionOut), workers: statusOutput.workers, cursor: statusOutput.cursor }),
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
        // A remote lead's unheard news stays in office_inbox; without a cursor it waits for what's new from now.
        const after = new Map(scopes.map((s) => [s.id, since ? (since.get(s.id) ?? 0) : caller.worker.remote ? s.team.latest() : undefined]));
        const news = () => scopes.flatMap((s) => s.team.news(lead, { after: after.get(s.id), unread: after.get(s.id) === undefined, kinds, workers: watched }).map((e) => ({ e, floor: s.id })));
        const reasonOf = (events: Matched['events']) => (events[0].e.kind === 'needs_input' && !until.has('needs_input') ? 'blocked' : events[0].e.kind);
        const team = () => scopes.flatMap((s) => s.workers.list().filter((w) => w.lead === lead && (!watched || watched.has(w.id))));
        // From the hooks' account of the question, not the screen: its menu may draw after the last signal a wait hears.
        const asks = () => team().flatMap((w) => (w.status === 'needs_input' && w.kind === 'agent' && !w.cloud && w.ask?.kind === 'question' ? [`${w.id}:${w.waitingSince ?? 0}:${JSON.stringify(w.ask.questions)}`] : []));
        // A terminal question or a settled team counts only when it comes about during the wait: one that was
        // already so would end every default wait at once. Team questions are news, which since already orders.
        const askedBefore = new Set(asks());
        let busy = !team().every(settled);
        const started = Date.now();
        const outcome = await waitFor(scopes, {
          signal,
          progress,
          timeoutMs: (args.timeoutSec ?? WAIT_DEFAULT_SEC) * 1000,
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
        const body = { matched, reason, waitedMs: Date.now() - started, events, questions, workers, cursor };
        return officeResult(
          [
            matched ? `Matched ${reason}.` : `Nothing matched within ${args.timeoutSec ?? WAIT_DEFAULT_SEC} s.`,
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
      description:
        "Read one full report or question from your subagents, by its event id (lastReportId or a news id) or the latest from a named subagent, with that subagent's recent report history. Kept after the subagent leaves. Reading changes nothing.",
      inputSchema: z.object({
        worker: z.string().trim().min(1).max(128).optional().describe('Subagent name or id: its latest report or question. A name hired again after a dismissal means the one on your team now.'),
        id: z.string().trim().min(1).max(200).optional().describe('An event id such as team:<floor>:<seq>.'),
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
        const onTeam = new Set(scopes.flatMap((s) => s.workers.list().flatMap((w) => (w.lead === lead ? [w.id] : []))));
        const current = found.filter((x) => onTeam.has(x.e.worker));
        if (new Set(current.map((x) => x.e.worker)).size !== 1) return officeError(`${args.worker} names more than one subagent: use the worker id${scopes.length > 1 ? ' or floor' : ''}.`);
        found = current;
      }
      const pick = found.at(-1);
      if (!pick) return officeError(args.id ? `No report or question ${args.id} from your subagents.` : `${args.worker} has not reported or asked anything you can still read.`);
      const history = scopes.flatMap((s) => s.team.reports(lead, pick.e.worker).map((e) => compactEvent(e, s.id))).slice(-HISTORY_MAX);
      const report = compactEvent(pick.e, pick.floor, true);
      return officeResult(
        [`${report.kind === 'question' ? 'Question' : 'Report'} ${report.id} from ${report.name} at ${report.at}:`, pick.e.text ?? '', ...(history.length > 1 ? [`History:\n${history.map(compactEventText).join('\n')}`] : [])].join('\n'),
        { report, history },
      );
    },
  );

  server.tool(
    {
      name: 'questions_list',
      description:
        "List questions waiting on you from your subagents, like the owner's Asks inbox: team_report questions, and AskUser questions in their own terminals with numbered options. Permission prompts are listed but only the person at that desk can answer them. Answer with question_answer using the id. Reading changes nothing.",
      inputSchema: z.object({ workers: z.array(z.string().trim().min(1).max(128)).min(1).max(20).optional().describe('Subagent names or ids. Omit for your whole team.'), floor: floorArg }),
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
        'Answer one question from questions_list by its id: optionId picks a numbered option, optionIds the boxes of a multi-select question, text a typed answer (with optionIds, the typed extra). A team question gets your answer as a message, optionId and text together; a terminal question takes optionId or text, not both, and is answered in the subagent terminal only while it still shows the same question. Permission prompts are refused: only the person at the desk can approve.',
      inputSchema: z.object({
        questionId: z.string().trim().min(1).max(400).describe('The id from questions_list.'),
        optionId: z.string().trim().min(1).max(8).optional().describe('One option id.'),
        optionIds: z.array(z.string().trim().min(1).max(8)).max(9).optional().describe('Multi-select only: every option to have selected.'),
        text: z.string().trim().min(1).max(20_000).optional().describe('A typed answer.'),
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
      if (!ask || !scope || !w || w.lead !== lead) return officeError('No question with that id is waiting on you. questions_list shows the open ones.');
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
