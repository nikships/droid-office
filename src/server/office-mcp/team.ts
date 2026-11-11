import path from 'node:path';
import { z } from 'zod';
import type { TeamEvent, TeamMember, TeamModel, TeamReply, WorkerReview } from '../team.js';
import { teamBoardText, type TeamBoardMember } from '../team.js';
import { modelUsageWords } from '../../shared/subscriptions.js';
import { hasOwnerAccess } from './owner.js';
import { officeAccess, officeError, officeResult, ownFloor, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';
import { compactEvent, compactEventText, compactWorker, compactWorkerText, cursorOf, EVENT_FILTERS, eventKinds, floorArg, parseCursor, resultDetailLines } from './team-events.js';

export const instructions = `Subagents are real workers with their own terminals and (by default) git worktrees reporting to you, their lead. Subagents cannot hire.
Have task-authored prerequisites committed BEFORE hiring (worktrees see committed state only; leave unrelated changes untouched). Read team_models once per hiring batch, then hire one fresh subagent per task, only as many as independent scopes need. Independent scopes touch separate files: assign single-writer edit ownership in each brief, plus goal, dependency context, boundaries, checks and delivery; sibling files can be referenced as read-only context. Subagents share areas/findings via team_board and team_note. Continue a subagent's committed work via from / task.baseBranch set to worker:<name/id> or its absolute worktree path; floor leads omit from for their own current HEAD.
Owner notes take priority when picking an exact model id from team_models. Multipliers show relative cost (custom/subscription models use no Factory credits; prefer subscriptions with ample quota and keep a nearly spent one off long tasks). Pick <=x0.5 for mechanical work, ~x1 for standard tasks, and top models for hard design, security, or concurrency; never give visual tasks to a no-images model.
Hiring and waiting is not enough: run the team as its connective tissue. On wakes/check-ins read team_status and questions_list, inspect relevant worker_diff/worker_log and full reports with team_report_get. Steer drift and relay contract changes via team_message (queue: true steers at the next step; workers/all: true broadcasts; inspect per-recipient errors). Answer technical questions within the owner's intent; escalate unclear decisions and leave workers at permission prompts untouched for the owner. Record team_review approve before merging (a lead workflow gate, not a server-enforced lock; request_changes routes fixes back). Integrate via team_merge (building agents name target), land foundations first, then have dependent siblings rebase/align and re-verify. Resolve returned conflict hunks in the reported worktree and run combined target checks after review and integration, before team_dismiss. team_pr requires authorization and a pushed branch. With Wake the lead on, end your turn when nothing else remains; otherwise use team_wait.`;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const changesState = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const text = z.string().trim().min(1).max(20_000);

/** `main` and `origin/main` are one base: hiring fetches origin and resolves both to the branch `main`. */
const sameBase = (a: string, b: string) => a.replace(/^origin\//, '') === b.replace(/^origin\//, '');

function reply(result: TeamReply, describe: (body: Record<string, unknown>) => string) {
  if (result.status >= 400) {
    const error = officeError(
      typeof result.body.error === 'string' ? result.body.error : 'The team could not finish this action. Read team status before retrying.',
      result.status === 404 || result.status === 410 ? 'unknown_worker' : result.status === 403 ? 'permission_denied' : result.status === 409 ? 'conflict' : 'bad_argument',
    );
    return { ...error, structuredContent: { ...(error.structuredContent as Record<string, unknown>), ...result.body } };
  }
  return officeResult(describe(result.body), result.body);
}

function integrationReply(result: TeamReply) {
  if (result.status < 400 || !result.body.status) return reply(result, (body) => String(body.summary));
  const body = result.body;
  const hint = (body.remaining as string[] | undefined)?.join('\n') ?? String(body.summary);
  const code = (body.conflicts as unknown[] | undefined)?.length ? 'merge_conflict' : body.status === 'blocked' ? 'integration_blocked' : 'integration_failed';
  return { ...officeResult(`${body.summary}\n${hint}`, { ...body, code, hint }), isError: true };
}

/** At rest after a progress report: done in status only. */
const PROGRESS_REST = 'Not finished: its turn ended after a progress report, and it waits on its own background work (such as a long job) to wake it. If that has run far longer than the report expects, check it with worker_log.';

function memberText(member: TeamMember & { terminal?: string; terminalUnavailable?: string }): string {
  return [
    `${member.name} (${member.id}), ${member.status}, ${member.desk}${member.model ? `, ${member.model}${member.effort ? ` ${member.effort}` : ''}` : ''}.`,
    ...(member.idleForMs !== undefined ? [`Idle for ${Math.floor(member.idleForMs / 60_000)} minutes.`] : []),
    ...(member.awaitingJob ? [PROGRESS_REST] : []),
    ...(member.task ? [`Task: ${member.task}`] : []),
    ...(member.activity ? [`Doing: ${member.activity}`] : []),
    ...(member.areas?.length ? [`Areas: ${member.areas.join(', ')}`] : []),
    ...(member.note ? [`Note: ${member.note.text}`] : []),
    member.worktree ? `Worktree: ${member.worktree.path} on ${member.worktree.branch}${member.worktree.from ? ` from ${member.worktree.from}` : ''}.` : 'Working in the main checkout.',
    ...(member.pr ? [`Pull request: ${member.pr.url}`] : []),
    ...(member.report ? [`Last ${member.report.question ? 'question' : member.report.progress ? 'progress report' : 'report'}:\n${member.report.text}`, ...resultDetailLines(member.report.result, member.report.review)] : []),
    ...(member.terminal !== undefined ? [`Terminal:\n${member.terminal || '(empty)'}`] : []),
    ...(member.terminalUnavailable ? [member.terminalUnavailable] : []),
  ].join('\n');
}

function eventText(event: TeamEvent): string {
  const at = `[${new Date(event.at).toISOString()}]`;
  if (event.progress) return `${at} Worker progress report from ${event.name} (not finished; its turn ended waiting on its own background work, which wakes it):\n${event.text ?? ''}`;
  if (event.kind === 'report' || event.kind === 'question') return `${at} Worker ${event.kind} from ${event.name}:\n${event.text ?? ''}`;
  const status = { done: 'finished its turn without reporting', needs_input: 'needs someone to answer in its own terminal', stopped: 'stopped', left: 'left the floor', sent_home: 'was sent home by the owner' };
  return `${at} Office status: ${event.name} ${status[event.kind]}${event.text ? `: ${event.text}` : ''}.${event.kind === 'needs_input' ? ' Tell whoever asked you; someone must answer at its desk.' : ''}`;
}

function modelText(model: TeamModel): string {
  return [
    `${model.id}${model.default ? ' (default)' : ''}: ${model.name}`,
    [
      model.provider,
      model.custom ? "owner's API key, no Factory credits" : model.multiplier !== undefined ? `x${model.multiplier} credits` : 'credit cost unknown',
      ...(model.noImages ? ['no images'] : []),
      ...(model.efforts ? [`effort ${model.efforts.join('/')}`] : []),
      ...(model.defaultEffort ? [`default effort ${model.defaultEffort}`] : []),
      ...(model.unlisted ? ['not currently listed by Droid'] : []),
      model.promo,
    ]
      .filter(Boolean)
      .join(', '),
    ...(model.usage ? [`Subscription usage: ${modelUsageWords(model.usage)}`] : []),
    ...(model.note ? [`Owner's note: ${model.note}`] : []),
    ...(model.cannotRun ? [`Cannot run: ${model.cannotRun}`] : []),
  ].join('\n');
}

export function register(server: OfficeMcpServer, deps: OfficeMcpDeps): void {
  const command = (caller: OfficeMcpCaller, args: { action: string; worker?: string; floor?: string; [key: string]: unknown }) =>
    caller.building && deps.remote ? deps.remote.team(caller.worker, args) : ownFloor(caller).team.handle(caller.worker, args);
  /** The team that answers for the office's models: the caller's floor, or for a building agent the first open one. */
  const modelsTeam = (caller: OfficeMcpCaller) => caller.floor?.team ?? deps.remote?.floors()[0]?.team;
  const statusText = (body: Record<string, unknown>) => {
    const members = body.team as TeamMember[];
    const news = body.events as TeamEvent[];
    return [...(members.length ? members.map(memberText) : ['You have no subagents.']), news.length ? `News since your last status call:\n${news.map(eventText).join('\n\n')}` : 'No unread team news.'].join('\n\n');
  };
  const statusOptions = {
    verbose: z.boolean().optional().describe('false for compact summaries; omit/true for full text.'),
    since: z.string().trim().min(1).max(4000).optional().describe('Cursor or team:<floor>:<seq> id.'),
    kinds: z.array(z.enum(EVENT_FILTERS)).min(1).max(EVENT_FILTERS.length).optional().describe('Event kind filter (reuse cursor with same kinds).'),
  };
  const status = async (caller: OfficeMcpCaller, args: { worker?: string; floor?: string; lines?: number; verbose?: boolean; since?: string; kinds?: (typeof EVENT_FILTERS)[number][] }) => {
    const own = caller.floor?.id ?? '';
    const cursor = args.since === undefined ? undefined : parseCursor(args.since, caller.floor?.id);
    if (args.since !== undefined && !cursor) return officeError('since takes the cursor from an earlier team status or team_wait, or one team:<floor>:<seq> event id.');
    const kinds = eventKinds(args.kinds);
    const request = { action: 'status', worker: args.worker, lines: args.lines, floor: args.floor, ...(kinds ? { kinds: [...kinds] } : {}) };
    const remote = caller.building ? deps.remote : undefined;
    const result = remote
      ? await remote.team(caller.worker, { ...request, ...(cursor ? { since: Object.fromEntries(cursor) } : {}) })
      : await ownFloor(caller).team.handle(caller.worker, { ...request, ...(cursor ? { since: cursor.get(own) ?? 0 } : {}) });
    if (result.status >= 400) return reply(result, statusText);
    const { team, events, latest, ...rest } = result.body as { team: (TeamMember & { floor?: string })[]; events: (TeamEvent & { floor?: string })[]; latest: number | Record<string, number> };
    const workers = team.map((m) => compactWorker(m, m.floor ?? own));
    const news = events.map((e) => compactEvent(e, e.floor ?? own, args.verbose === true));
    const position = cursorOf(typeof latest === 'number' ? { [own]: latest } : latest);
    if (args.verbose === false)
      return officeResult([...(workers.length ? workers.map(compactWorkerText) : ['You have no subagents.']), ...(news.length ? news.map(compactEventText) : ['No team news.']), `Cursor: ${position}`].join('\n'), {
        ...rest,
        workers,
        news,
        cursor: position,
      });
    return officeResult(statusText(result.body), { ...result.body, workers, news, cursor: position });
  };
  const worker = z.string().trim().min(1).max(200).describe('Subagent name or id.');
  server.tool(
    {
      name: 'team_board',
      description: 'Subagents only: read sibling context (tasks, status, branches, edit areas, notes, report summaries) without reading terminals or consuming lead news.',
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    officeAccess.subagent,
    async (_args, caller) => reply(await ownFloor(caller).team.handle(caller.worker, { action: 'board' }), (body) => teamBoardText(body.members as TeamBoardMember[]) || 'No teammates yet.'),
  );
  server.tool(
    {
      name: 'team_note',
      description: 'Subagents only: post a short finding and optionally update edit areas ([] clears). Active siblings receive notes at tool steps when possible; others read team_board. Never replaces team_report.',
      inputSchema: z.strictObject({
        text: z.string().trim().min(1).max(1000).describe('Short finding (1–1000 chars).'),
        areas: z.array(z.string().trim().min(1).max(200)).max(20).optional().describe('Files or edit areas ([] clears).'),
      }),
      annotations: changesState,
    },
    officeAccess.subagent,
    async (args, caller) => reply(await ownFloor(caller).team.handle(caller.worker, { action: 'note', ...args }), () => 'Shared with your siblings. Continue your task; report results to your lead with team_report.'),
  );
  server.tool(
    {
      name: 'team_merge',
      description:
        'Integrate a reviewed subagent’s committed branch into your branch or local target (building agents MUST pass target; uncommitted files excluded). Returns landed summary or structured conflict hunks while keeping Git state open. Land foundational branches first; never merge before team_review approve.',
      inputSchema: z.strictObject({
        worker,
        floor: floorArg,
        target: z.string().trim().min(1).max(200).optional().describe('Local target branch (REQUIRED for building agents; omit for floor lead).'),
        mode: z.enum(['merge', 'cherry-pick']).optional().describe('Default merge; cherry-pick replays non-merge commits.'),
        commits: z.array(z.string().trim().min(1).max(200)).min(1).max(1000).optional().describe('Cherry-pick commits in order.'),
      }),
      annotations: changesState,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      return integrationReply(await command(caller, { action: 'merge', ...args }));
    },
  );
  server.tool(
    {
      name: 'team_pr',
      description: 'Open a GitHub PR or GitLab MR from a subagent’s pushed branch (call only when owner-authorized; does not push or merge).',
      inputSchema: z.strictObject({
        worker,
        floor: floorArg,
        title: z.string().trim().min(1).max(200),
        body: z.string().max(20_000).optional().describe('PR description and checks.'),
        base: z.string().trim().min(1).max(200).optional().describe('Forge base branch (omit for recorded/floor branch).'),
      }),
      annotations: { ...changesState, openWorldHint: true },
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      return integrationReply(await command(caller, { action: 'pr', ...args }));
    },
  );
  server.tool(
    {
      name: 'team_status',
      description:
        'Snapshot subagents (edit areas, notes, results, reviews) and unread news (verbose: false for compact; team_report_get for full). Pair with worker_diff/worker_log on check-ins to verify claims, steer drift early, and spot contract changes for siblings.',
      inputSchema: z.strictObject({ worker: worker.optional(), floor: floorArg, lines: z.number().int().min(1).max(400).optional(), ...statusOptions }),
      annotations: readOnly,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      return status(caller, args);
    },
  );
  server.tool(
    {
      name: 'team_message',
      description:
        'Choose exactly one target: worker, workers, or all: true. Send course corrections, contract updates or rebase instructions. queue: true (default) delivers at the next step without interrupting (or resumes idle workers). Inspect per-recipient errors, even on partial success. Never message workers at permission prompts.',
      inputSchema: z.strictObject({
        worker: worker.optional(),
        workers: z.array(worker).min(1).max(100).optional(),
        all: z.literal(true).optional(),
        text,
        floor: floorArg,
        queue: z.boolean().default(true).describe('Default true: steer at next step without interrupting; false submits normally.'),
      }),
      annotations: changesState,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      if ([args.worker !== undefined, args.workers !== undefined, args.all === true].filter(Boolean).length !== 1) return officeError('Choose exactly one of worker, workers, or all: true.');
      return reply(await command(caller, { action: 'send', ...args }), (body) =>
        body.results ? (body.results as Record<string, unknown>[]).map((r) => `${r.name ?? r.id}${r.floor ? ` (${r.floor})` : ''}: ${r.error ?? r.delivery}`).join('\n') : `${(body.worker as TeamMember).name}: ${body.delivery}`,
      );
    },
  );
  server.tool(
    {
      name: 'team_dismiss',
      description: 'Dismiss a subagent after review and integration (keeps worktree/branch by default; pruneWorktree: true removes clean worktree; keepBranch: false deletes merged branch). Keep workers alive while fixes or rebases remain.',
      inputSchema: z.strictObject({ worker, floor: floorArg, pruneWorktree: z.boolean().optional(), keepBranch: z.boolean().optional() }),
      annotations: { ...changesState, destructiveHint: true },
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      if (args.keepBranch === false && !args.pruneWorktree) return officeError('keepBranch: false requires pruneWorktree: true.');
      return reply(await command(caller, { action: 'dismiss', ...args, pruneWorktree: args.pruneWorktree ?? false }), (body) => `Sent ${body.name} home.${body.note ? ` ${body.note}.` : ''}`);
    },
  );
  server.tool(
    {
      name: 'models_list',
      description: 'Read the full model catalogue including disabled or disallowed models (enabled: false), quota, and restrictions. To choose a subagent model, call team_models instead.',
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    officeAccess.mayHire,
    async (_args, caller) => {
      const team = modelsTeam(caller);
      if (!team) return officeError('No floor is open, so the office cannot list models yet.');
      return reply(await team.handle(caller.worker, { action: 'models_list' }), (body) =>
        (body.models as TeamModel[]).map((model) => `${model.enabled === false ? (model.cannotRun ? 'Unavailable: ' : 'Not allowed: ') : ''}${modelText(model)}`).join('\n\n'),
      );
    },
  );
  server.tool(
    {
      name: 'worker_diff',
      description: 'Read your subagent’s bounded Git stat and diff (recorded base vs tracked working tree, or pass base or commits). Inspect during check-ins and before accepting "done", relaying contract changes, or merging.',
      inputSchema: z.strictObject({ worker, floor: floorArg, base: z.string().trim().min(1).max(200).optional(), commits: z.number().int().min(1).max(1000).optional() }),
      annotations: readOnly,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      if (args.base !== undefined && args.commits !== undefined) return officeError('Choose base or commits, not both.');
      return reply(await command(caller, { action: 'diff', ...args }), (body) => `${body.stat}\n${body.diff}${body.truncated ? '\n[Truncated: diff exceeds the output limit.]' : ''}`);
    },
  );
  server.tool(
    {
      name: 'worker_log',
      description: 'Read your subagent’s recent terminal output (1–400 lines, capped at 48 KB) and current tool activity, read-only.',
      inputSchema: z.strictObject({ worker, floor: floorArg, tail: z.number().int().min(1).max(400) }),
      annotations: readOnly,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      return reply(await command(caller, { action: 'log', ...args }), (body) => `${body.activity ? `Doing: ${body.activity}\n` : ''}${body.terminal ?? 'Terminal unavailable.'}${body.truncated ? '\n[Truncated]' : ''}`);
    },
  );
  server.tool(
    {
      name: 'office_whoami',
      description: 'Read your office identity, floor/room, permissions (hire, visit, owner), team count, worktree default, and wake setting. Skip when your role is already known.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    officeAccess.worker,
    async (_args, caller) => {
      if (caller.building) return buildingWhoami(caller);
      const floor = ownFloor(caller);
      const { body } = await floor.team.handle(caller.worker, { action: 'whoami' });
      const visitRefusal = floor.visits.cannotVisit(caller.worker);
      const identity = { ...body, floor: { id: floor.id, name: floor.name }, cwd: caller.cwd, canVisit: !visitRefusal, ...(visitRefusal ? { visitRefusal } : {}), ownerAccess: false };
      const lead = caller.worker.lead ? (floor.workers.get(caller.worker.lead)?.name ?? caller.worker.lead) : undefined;
      return officeResult(
        [
          `${caller.worker.name} (${caller.worker.id}), ${floor.name}, ${lead ? `subagent of ${lead}` : 'independent worker'}.`,
          `Working folder: ${caller.cwd}`,
          `May hire: ${body.canHire ? 'yes' : 'no'}. Subagents: ${body.subagents ?? 0}${typeof body.max === 'number' ? `/${body.max}` : ', no limit'}. Wake the lead: ${body.wakeLead ? 'on' : 'off'}.`,
          ...(typeof body.why === 'string' ? [body.why] : []),
          `May visit: ${visitRefusal ? `no. ${visitRefusal}` : 'yes'}.`,
        ].join('\n'),
        identity,
      );
    },
  );
  /** A building agent: Mission Control, no floor or desk, its teams across every floor and the owner's access. */
  const buildingWhoami = (caller: OfficeMcpCaller) => {
    const s = caller.settings;
    const floors = deps.remote?.floors() ?? [];
    const teams = floors.map((f) => ({ floor: f.id, name: f.def.name, subagents: f.workers.list().filter((w) => w.lead === caller.worker.id).length })).filter((t) => t.subagents);
    const subagents = teams.reduce((n, t) => n + t.subagents, 0);
    const owner = hasOwnerAccess(caller, deps.owner);
    const kind = caller.worker.remote ? 'external' : 'orchestrator';
    const identity = {
      you: { id: caller.worker.id, name: caller.worker.name, role: subagents ? 'lead' : 'worker', building: kind },
      room: 'Mission Control',
      floor: null,
      ...(caller.cwd ? { cwd: caller.cwd } : {}),
      canHire: true,
      subagents,
      teams,
      worktree: s.worktree,
      wakeLead: !caller.worker.remote && s.wakeLead,
      canVisit: false,
      ownerAccess: owner,
    };
    return officeResult(
      [
        `${caller.worker.name} (${caller.worker.id}), ${kind === 'external' ? 'an external bot' : "the office's Orchestrator"} in Mission Control: no floor or desk.`,
        ...(caller.cwd ? [`Working folder: ${caller.cwd} (scratch space, not a checkout).`] : []),
        `May hire: yes, on any open floor, with no team size limit. Subagents: ${subagents}${teams.length ? ` (${teams.map((t) => `${t.subagents} on ${t.name}`).join(', ')})` : ''}.`,
        caller.worker.remote ? 'Wake notes: none; poll office_inbox or team_wait.' : `Wake notes: ${s.wakeLead ? 'on' : 'off'}.`,
        'May visit: no. Reach any worker with office_worker_prompt.',
        ...(owner ? ['Owner access: yes. Focused office_* tools act across the building as the owner does. Use team_* for your subagents.'] : []),
      ].join('\n'),
      identity,
    );
  };
  server.tool(
    {
      name: 'team_models',
      description: 'List runnable subagent models: exact ids, multipliers, efforts, image support, owner notes, quota left, and blocked reasons. Call once per hiring batch.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    officeAccess.mayHire,
    async (_args, caller) => {
      const team = modelsTeam(caller);
      if (!team) return officeError('No floor is open, so the office cannot list models yet.');
      return reply(await team.handle(caller.worker, { action: 'models' }), (body) =>
        [
          body.restricted ? 'Settings restrict subagent models to the listed picks and the default.' : 'Subagents may use any current Droid model.',
          ...(body.unavailable ? ['Droid could not list its models; costs and providers may be missing.'] : []),
          ...(body.models as TeamModel[]).map(modelText),
          `Default: ${body.defaultModel ?? "Droid's own default"}.`,
        ].join('\n\n'),
      );
    },
  );
  server.tool(
    {
      name: 'team_hire',
      description:
        'Hire a fresh subagent in its own terminal and usually a worktree. Read team_models once per batch and commit task-authored prerequisites first. Give each independent scope single-writer edit ownership, dependency context and checks (building agents set floor or task.repo). Actively check in, relay changes, unblock questions and review before integration.',
      inputSchema: z.strictObject({
        title: z.string().trim().min(1).max(80).optional().describe('Short task title.'),
        brief: text.optional().describe('Ticket: goal, context, exact owned files, checks, and delivery.'),
        floor: z.string().trim().min(1).max(4096).optional().describe('Building agents only (floor workers omit): floor id, name, or path.'),
        task: z
          .strictObject({
            title: z.string().trim().min(1).max(80),
            brief: text,
            repo: z.string().trim().min(1).max(4096).describe('Exact floor checkout path (never "."), or floor id/name/path for building agents.'),
            baseBranch: z.string().trim().min(1).max(4096).optional().describe('The same setting as from: ref, your subagent as worker:<name/id>, or its absolute worktree path; committed state only. Omit for lead HEAD/floor base.'),
            branch: z.string().trim().min(1).max(200).optional().describe('New local branch name.'),
            prNumber: z.number().int().positive().optional(),
            acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).max(30).optional(),
          })
          .optional()
          .describe('Structured ticket (overrides title/brief).'),
        model: z.string().trim().min(1).optional().describe('Exact model id from team_models (match owner notes, difficulty, images, quota).'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Effort from team_models.'),
        from: z
          .string()
          .trim()
          .min(1)
          .max(4096)
          .optional()
          .describe('The same setting as task.baseBranch: ref, your subagent as worker:<name/id>, or its absolute worktree path. Pins committed HEAD without moving the source; requires a worktree. Omit for lead HEAD/floor base.'),
        worktree: z.boolean().optional().describe('Structured task defaults true; otherwise follows owner settings. True: isolated worktree; false: shared checkout for read-only/non-git (omit baseBranch/branch/from).'),
      }),
      annotations: changesState,
    },
    officeAccess.mayHire,
    async ({ brief, task, ...args }, caller) => {
      const title = task?.title ?? args.title;
      const ticket = task?.brief ?? brief;
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      if (caller.building && !task && !args.floor) {
        return officeError('A building agent names the floor to hire on: pass floor with the open floor’s id, name or path from office_floors, or use a structured task whose repo names it.');
      }
      if (!title || !ticket) return officeError('team_hire needs title and brief, either at the top level or in task.');
      if (task && args.from && task.baseBranch && !sameBase(args.from, task.baseBranch)) {
        return officeError(`from (${args.from}) and task.baseBranch (${task.baseBranch}) name different bases. They set the same thing, so give only one.`);
      }
      if (task && args.worktree === false && (task.baseBranch || task.branch))
        return officeError('A structured task with baseBranch or branch requires a fresh worktree: leave worktree out, or omit baseBranch and branch for read-only work in the checkout.');
      if (task && !caller.building && path.resolve(task.repo) !== path.resolve(ownFloor(caller).dir)) return officeError('task.repo must name your floor repository.');
      const prompt = task
        ? `${ticket}\n\nRepository: ${task.repo}${task.baseBranch ? `\nBase branch: ${task.baseBranch}` : ''}${task.branch ? `\nTask branch: ${task.branch}` : ''}${task.prNumber ? `\nPull request: #${task.prNumber}` : ''}${task.acceptanceCriteria?.length ? `\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : ''}`
        : ticket;
      if (prompt.length > 20_000) return officeError('The complete structured task ticket must fit in 20,000 characters.');
      // A structured task gets a fresh worktree unless the caller asks for the checkout.
      const worktree = task ? (args.worktree ?? true) : args.worktree;
      return reply(
        await command(caller, { action: 'hire', ...args, title, task: prompt, ...(task ? { repo: task.repo, from: task.baseBranch ?? args.from, branch: task.branch } : {}), worktree }),
        (body) => `Hired ${memberText(body.worker as TeamMember)}\nIt is working on the brief. Review its report and commits before integration.`,
      );
    },
  );
  server.tool(
    {
      name: 'team',
      description: 'Deprecated alias: prefer team_status, team_message and team_dismiss.',
      inputSchema: z.object({
        action: z.enum(['status', 'message', 'dismiss']),
        floor: floorArg,
        name: z.string().trim().min(1).optional().describe('Subagent name or id (omit on status for all; required for message/dismiss).'),
        verbose: z.boolean().optional().describe('Status only: false for compact lines.'),
        since: z.string().trim().min(1).max(4000).optional().describe('Status only: event cursor or id.'),
        kinds: z.array(z.enum(EVENT_FILTERS)).min(1).max(EVENT_FILTERS.length).optional().describe('Status only: event kind filter.'),
        lines: z.number().int().min(1).max(400).optional().describe('Status only: recent terminal lines (1–400).'),
        text: text.optional().describe('Message only: message text.'),
      }),
      annotations: { ...changesState, destructiveHint: true },
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.action !== 'status' && !args.name) return officeError(`team action ${args.action} needs name. Read team with action status to see your subagents.`);
      if (args.action === 'message' && !args.text) return officeError('team action message needs text: provide the answer or follow-up.');
      if (args.action !== 'status' && args.lines !== undefined) return officeError('lines is only for team action status. Leave it out for message or dismiss.');
      if (args.action !== 'message' && args.text !== undefined) return officeError('text is only for team action message. Leave it out for status or dismiss.');
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      if (args.action !== 'status' && (args.verbose !== undefined || args.since !== undefined || args.kinds !== undefined)) return officeError('verbose, since and kinds are only for team action status.');
      if (args.action === 'status') return status(caller, { worker: args.name, floor: args.floor, lines: args.lines, verbose: args.verbose, since: args.since, kinds: args.kinds });
      return reply(await command(caller, { action: args.action === 'message' ? 'send' : args.action, worker: args.name, text: args.text, floor: args.floor }), (body) =>
        args.action === 'message' ? `Sent to ${(body.worker as TeamMember).name}.` : `Sent ${body.name} home.${body.note ? ` ${body.note}.` : ''}`,
      );
    },
  );
  const resultSchema = z
    .strictObject({
      status: z.enum(['ok', 'blocked', 'failed', 'partial']).describe('ok: finished and verified; partial: incomplete/mid-progress; blocked: waiting on blocker; failed: checks/execution failed.'),
      summary: z.string().trim().min(1).max(2000).describe('Short summary of changes, checks, and outcome.'),
      artifacts: z
        .strictObject({
          prUrl: z.url().max(2000).optional(),
          prNumber: z.number().int().positive().optional(),
          mergeCommit: z
            .string()
            .regex(/^[0-9a-f]{7,64}$/i)
            .optional(),
          commits: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
          files: z.array(z.string().trim().min(1).max(1024)).max(500).optional(),
        })
        .optional()
        .describe('Produced PR, commits, and changed files.'),
      remaining: z.array(z.string().trim().min(1).max(1000)).max(100).optional().describe('Remaining work or open risks.'),
      conflicts: z
        .array(
          z.strictObject({
            path: z.string().trim().min(1).max(1024),
            hunks: z
              .array(
                z.strictObject({
                  header: z.string().max(400).optional(),
                  ours: z.string().max(4000).optional(),
                  theirs: z.string().max(4000).optional(),
                }),
              )
              .max(50)
              .optional(),
          }),
        )
        .max(200)
        .optional()
        .describe('Unresolved merge/rebase conflicts.'),
    })
    .describe('Structured task outcome (inferred when omitted: question -> blocked, progress -> partial, else ok).');
  server.tool(
    {
      name: 'team_review',
      description:
        'Record approve, request_changes or comment on a subagent’s latest report after checking worker_diff. request_changes notifies it by default to fix and re-report; approve/comment do not wake it by default. Approval is the lead’s workflow gate, not a server-enforced merge lock. Re-review changed work.',
      inputSchema: z.strictObject({
        worker,
        verdict: z.enum(['approve', 'request_changes', 'comment']).describe('approve: verified ready; request_changes: fixes needed; comment: notes.'),
        notes: text.describe('Review findings, verified checks, or rationale.'),
        notify: z.boolean().optional().describe('Notify subagent (default true on request_changes).'),
        floor: floorArg,
      }),
      annotations: changesState,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      return reply(await command(caller, { action: 'review', ...args }), (body) => {
        const member = body.worker as TeamMember;
        const review = body.review as WorkerReview;
        const delivery = body.notified ? ` Sent findings to ${member.name} to address.` : typeof body.notifyNote === 'string' ? ` Not sent to ${member.name} (${body.notifyNote}).` : '';
        return `Recorded ${review.verdict} review on ${member.name}'s report.${delivery}`;
      });
    },
  );
  server.tool(
    {
      name: 'team_report',
      description:
        'Subagents only: send your lead results, checks, remaining work, links, structured result, and any schema/contract changes siblings need (or set question: true for a blocking question, or progress: true before ending your turn while a background job runs), then end your turn.',
      inputSchema: z.object({
        text: text.describe('Results, checks, contract changes, remaining work and links, or the blocking question.'),
        question: z.boolean().optional().describe('True for a blocking question to your lead; omit or false for a report.'),
        options: z.array(z.string().trim().min(1).max(200)).min(2).max(9).optional().describe('Questions only: ordered choices.'),
        progress: z.boolean().optional().describe('True only when ending your turn while a background job you started will wake you on exit; omit on final reports and questions.'),
        pushedSha: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .optional()
          .describe('Full pushed commit SHA (inferred from upstream ref when omitted).'),
        prUrl: z.url().max(2000).optional().describe('Pull request URL (inferred when omitted).'),
        result: resultSchema.optional(),
      }),
      annotations: changesState,
    },
    officeAccess.subagent,
    async (args, caller) =>
      reply(await ownFloor(caller).team.handle(caller.worker, { action: 'report', ...args }), (body) =>
        args.question
          ? `Asked ${body.lead}. End your turn now; the answer arrives as a later message.`
          : args.progress
            ? `Sent ${body.lead} a progress report: ${body.lead} sees you are not finished. End your turn now; your background job wakes you when it exits. Then check its result, carry on, and finish with a final report (progress left out).`
            : `Reported to ${body.lead}. End your turn now; any reply arrives as a later message.`,
      ),
  );
}
