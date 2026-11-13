import path from 'node:path';
import { z } from 'zod';
import { PROMPT_IMAGE_ID, PROMPT_IMAGES_MAX } from '../../shared/drops.js';
import { floorNamed } from '../remote-office.js';
import type { TeamEvent, TeamMember, TeamModel, TeamReply, WorkerReview } from '../team.js';
import { teamBoardText, type TeamBoardMember } from '../team.js';
import { formatOtherFloorWorkers, type OtherFloorWorker } from '../floor-watch.js';
import { formatImageLines, OfficeImageStore, type StoredImageMeta } from '../office-images.js';
import { isSubscriptionModel, modelUsageWords } from '../../shared/subscriptions.js';
import { briefAge, formatForgeLines, formatProviderQuotas, formatTaskTag, formatWorkerInspection, type ProviderQuotaSummary, type WorkerInspection } from '../worker-status.js';
import { hasOwnerAccess } from './owner.js';
import { formatBlockingSummary, formatQueueBrief } from '../worker-queue.js';
import { enrichTeamReplyBody, floorDeepLink, mcpDeepLinkBase, withCompactWorkerDeepLink, withMemberDeepLink, withOtherWorkerDeepLink, workerDeepLink } from './deep-links.js';
import { officeAccess, officeError, officeResult, ownFloor, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';
import { compactEvent, compactEventText, compactWorker, compactWorkerText, cursorOf, EVENT_FILTERS, eventKinds, floorArg, parseCursor, resultDetailLines, withImageOrigin } from './team-events.js';

export const instructions = `Subagents are real workers with their own terminals and (by default) git worktrees reporting to you, their lead. Subagents cannot hire.
Have task-authored prerequisites committed BEFORE hiring (worktrees see committed state only; leave unrelated changes untouched). Read team_models once per hiring batch, then hire one fresh subagent per task, only as many as independent scopes need. Independent scopes touch separate files: assign single-writer edit ownership in each brief, plus goal, dependency context, boundaries, checks and delivery; sibling files can be referenced as read-only context. Subagents share areas/findings via team_board and team_note. Continue a subagent's committed work via from / task.baseBranch set to worker:<name/id> or its absolute worktree path; floor leads omit from for their own current HEAD.
Owner notes take priority when picking an exact model id from team_models. Multipliers show relative cost (custom/subscription models use no Factory credits; prefer subscriptions with ample quota and keep a nearly spent one off long tasks). Pick <=x0.5 for mechanical work, ~x1 for standard tasks, and top models for hard design, security, or concurrency; never give visual tasks to a no-images model.
Hiring and waiting is not enough: run the team as its connective tissue. On wakes/check-ins read team_status and questions_list, inspect relevant worker_diff/worker_log and full reports with team_report_get. Steer drift and relay contract changes via team_message (default queue: false steers at the next step; queue: true queues behind the turn; urgent: true interrupts blocking commands; images attaches uploaded image ids; worker_queue lists/clears/promotes queued items; workers/all: true broadcasts; inspect per-recipient errors). Answer technical questions within the owner's intent; escalate unclear decisions and leave workers at permission prompts untouched for the owner. Record team_review approve before merging (a lead workflow gate, not a server-enforced lock; request_changes routes fixes back). Integrate via team_merge (building agents name target), land foundations first, then have dependent siblings rebase/align and re-verify. Resolve returned conflict hunks in the reported worktree and run combined target checks after review and integration, before team_dismiss. team_pr requires authorization and a pushed branch. With Wake the lead on, end your turn when nothing else remains; otherwise use team_wait. Subagents attach produced screenshots/images (or Whiteboard card ids) via images on team_report and lead_notify so leads receive downloadable image ids and Tailnet URLs. When your lead is a Grok Bot (office_whoami shows leadPush: true), team_report pushes straight to its webhook on turn end and lead_notify sends immediate mid-turn updates, questions, blockers, or test pings without ending your turn.`;

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

function memberText(member: TeamMember & { terminal?: string; terminalUnavailable?: string }, imageOrigin?: string): string {
  const forgeLines = formatForgeLines({ pr: member.prStatus, ci: member.ci, releaseRun: member.releaseRun });
  const queueBrief = member.queuedMessages ? formatQueueBrief(member.queuedMessages) : undefined;
  return [
    `${member.name} (${member.id})${member.watched ? ' [watching]' : ''}, ${member.status}, ${member.desk}${member.model ? `, ${member.model}${member.effort ? ` ${member.effort}` : ''}` : ''}.`,
    ...(member.idleForMs !== undefined ? [`Idle for ${Math.floor(member.idleForMs / 60_000)} minutes.`] : []),
    ...(member.awaitingJob ? [PROGRESS_REST] : []),
    ...(member.task ? [`Task: ${member.task}${formatTaskTag(member.taskLabel)}`] : []),
    ...(member.modelStatus && member.modelStatus.state !== 'ok' ? [`${member.modelStatus.state === 'cooldown' ? 'Model cooldown' : 'Model alert'}: ${member.modelStatus.summary}`] : []),
    ...(member.retryingModel && member.modelStatus?.state !== 'retrying' ? [`Retrying model: ${member.retryingModel.detail}`] : []),
    ...(member.modelError && member.modelStatus?.state !== 'rate_limited' ? [`Model error: ${member.modelError}`] : []),
    ...(member.plan ? [`Plan: ${member.plan.done}/${member.plan.total} completed${member.plan.current ? ` — current: ${member.plan.current}` : ''}`] : []),
    ...(member.currentTool ? [`Current tool: ${member.currentTool.summary} (running ${briefAge(member.currentTool.runningForMs)})`] : []),
    ...(member.activity ? [`Doing: ${member.activity}`] : []),
    ...(member.silentForMs !== undefined
      ? [`Last hook: ${briefAge(member.silentForMs)} ago (${member.lastActivityAt})${member.lastTool && !member.currentTool ? `; last tool ${member.lastTool.summary} (${briefAge(member.lastTool.agoMs)} ago)` : ''}`]
      : []),
    ...(member.blockingTool ? [`Blocking command: ${formatBlockingSummary(member.blockingTool)} (steers wait until this finishes; pass urgent: true to interrupt).`] : []),
    ...(member.queued ? [`Queued: ${member.queued.terminal} terminal message${member.queued.terminal === 1 ? '' : 's'}, ${member.queued.notices} next-step notice${member.queued.notices === 1 ? '' : 's'}`] : []),
    ...(queueBrief ? [queueBrief] : []),
    ...(member.areas?.length ? [`Areas: ${member.areas.join(', ')}`] : []),
    ...(member.note ? [`Note: ${member.note.text}`] : []),
    member.worktree
      ? `Worktree: ${member.worktree.path} on ${member.worktree.branch}${member.worktree.from ? ` from ${member.worktree.from}` : ''}.`
      : `Working in the main checkout${member.cwd ? ` (${member.cwd})` : ''}${member.branch ? ` on ${member.branch}` : ''}.`,
    ...(member.warnings?.length ? [`Warning: ${member.warnings.join('; ')}`] : []),
    ...(forgeLines.length ? forgeLines : member.pr ? [`Pull request: ${member.pr.url}`] : []),
    ...(member.report
      ? [
          `Last ${member.report.question ? 'question' : member.report.progress ? 'progress report' : 'report'}:\n${member.report.text}`,
          ...resultDetailLines(member.report.result, member.report.review),
          ...formatImageLines(withImageOrigin(member.report.images, imageOrigin)),
        ]
      : []),
    ...(member.terminal !== undefined ? [`Terminal:\n${member.terminal || '(empty)'}`] : []),
    ...(member.terminalUnavailable ? [member.terminalUnavailable] : []),
  ].join('\n');
}

function eventText(event: TeamEvent, imageOrigin?: string): string {
  const at = `[${new Date(event.at).toISOString()}]`;
  const imgSuffix = event.images?.length ? `\n${formatImageLines(withImageOrigin(event.images, imageOrigin)).join('\n')}` : '';
  if (event.progress) return `${at} Worker progress report from ${event.name} (not finished; its turn ended waiting on its own background work, which wakes it):\n${event.text ?? ''}${imgSuffix}`;
  if (event.kind === 'report' || event.kind === 'question') return `${at} Worker ${event.kind} from ${event.name}:\n${event.text ?? ''}${imgSuffix}`;
  if (event.kind === 'pr') return `${at} Pull request update from ${event.name}:\n${event.text ?? ''}`;
  const status = {
    done: event.watched ? 'finished its turn' : 'finished its turn without reporting',
    needs_input: 'needs someone to answer in its own terminal',
    stopped: 'stopped',
    left: 'left the floor',
    sent_home: 'was sent home by the owner',
  };
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
    ...(model.cooldown?.until ? [`Cooldown resets at: ${model.cooldown.until} (${model.cooldown.window})`] : []),
  ].join('\n');
}

export function register(server: OfficeMcpServer, deps: OfficeMcpDeps): void {
  const command = (caller: OfficeMcpCaller, args: { action: string; worker?: string; floor?: string; [key: string]: unknown }) =>
    caller.building && deps.remote ? deps.remote.team(caller.worker, args) : ownFloor(caller).team.handle(caller.worker, args);
  const replyFor = (caller: OfficeMcpCaller, result: TeamReply, describe: (body: Record<string, unknown>) => string) =>
    result.status >= 400 ? reply(result, describe) : reply({ ...result, body: enrichTeamReplyBody(result.body, caller.floor?.id, mcpDeepLinkBase(deps)) }, describe);
  /** The team that answers for the office's models: the caller's floor, or for a building agent the first open one. */
  const modelsTeam = (caller: OfficeMcpCaller) => caller.floor?.team ?? deps.remote?.floors()[0]?.team;
  const statusText = (body: Record<string, unknown>, imageOrigin?: string) => {
    const members = body.team as TeamMember[];
    const otherWorkers = body.otherWorkers as OtherFloorWorker[] | undefined;
    const news = body.events as TeamEvent[];
    const otherBlock = otherWorkers?.length ? [formatOtherFloorWorkers(otherWorkers, true).join('\n')] : [];
    return [
      ...(members.length ? members.map((m) => memberText(m, imageOrigin)) : ['You have no subagents.']),
      ...otherBlock,
      news.length ? `News since your last status call:\n${news.map((e) => eventText(e, imageOrigin)).join('\n\n')}` : 'No unread team news.',
    ].join('\n\n');
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
    const imageOrigin = caller.remoteOrigin ?? (deps.images ?? deps.remote?.images)?.origin();
    const result = remote
      ? await remote.team(caller.worker, { ...request, ...(cursor ? { since: Object.fromEntries(cursor) } : {}) })
      : await ownFloor(caller).team.handle(caller.worker, { ...request, ...(cursor ? { since: cursor.get(own) } : {}) });
    if (result.status >= 400) return reply(result, (b) => statusText(b, imageOrigin));
    const { team, events, latest, otherWorkers, ...rest } = result.body as {
      team: (TeamMember & { floor?: string })[];
      otherWorkers?: OtherFloorWorker[];
      events: (TeamEvent & { floor?: string })[];
      latest: number | Record<string, number>;
    };
    const linkBase = mcpDeepLinkBase(deps);
    const enrichedTeam = team.map((m) => {
      const withImages = m.report?.images?.length ? { ...m, report: { ...m.report, images: withImageOrigin(m.report.images, imageOrigin) } } : m;
      return withMemberDeepLink(withImages, own || undefined, linkBase);
    });
    const enrichedEvents = events.map((e) => (e.images?.length ? { ...e, images: withImageOrigin(e.images, imageOrigin) } : e));
    const workers = team.map((m) => withCompactWorkerDeepLink(compactWorker(m, m.floor ?? own, imageOrigin), linkBase));
    const enrichedFloorWorkers = otherWorkers?.map((o) => withOtherWorkerDeepLink(o, own || undefined, linkBase));
    const news = events.map((e) => compactEvent(e, e.floor ?? own, args.verbose === true, imageOrigin));
    const position = cursorOf(typeof latest === 'number' ? { [own]: latest } : latest);
    if (args.verbose === false)
      return officeResult(
        [
          ...(workers.length ? workers.map(compactWorkerText) : ['You have no subagents.']),
          ...(otherWorkers?.length ? formatOtherFloorWorkers(otherWorkers, false) : []),
          ...(news.length ? news.map(compactEventText) : ['No team news.']),
          `Cursor: ${position}`,
        ].join('\n'),
        {
          ...rest,
          workers,
          ...(enrichedFloorWorkers?.length ? { floorWorkers: enrichedFloorWorkers } : {}),
          news,
          cursor: position,
        },
      );
    const enrichedBody = { ...result.body, team: enrichedTeam, events: enrichedEvents };
    return officeResult(statusText(enrichedBody, imageOrigin), { ...enrichedBody, workers, ...(enrichedFloorWorkers?.length ? { floorWorkers: enrichedFloorWorkers } : {}), news, cursor: position });
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
    async (args, caller) =>
      reply(await ownFloor(caller).team.handle(caller.worker, { action: 'note', ...args }), (body) =>
        body.blocked
          ? String(body.coach)
          : body.traffic === 'record_silently'
            ? 'Posted on the team board without interrupting working siblings (the noise gate read it as a routine update). Continue your task; report results to your lead with team_report.'
            : 'Shared with your siblings. Continue your task; report results to your lead with team_report.',
      ),
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
      name: 'team_watch',
      description:
        'Follow or unfollow independent floor workers without re-hiring or interrupting them. Watched workers appear in team_status, team_wait and questions_list, and wake you on turn completion, terminal questions, stops, departures, and PR updates.',
      inputSchema: z.strictObject({
        worker: worker.optional(),
        workers: z.array(worker).min(1).max(100).optional(),
        all: z.literal(true).optional().describe('Watch (or unwatch) every independent worker on the floor.'),
        watch: z.boolean().default(true).describe('Default true to watch; false to stop watching.'),
        floor: floorArg,
      }),
      annotations: changesState,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      if ([args.worker !== undefined, args.workers !== undefined, args.all === true].filter(Boolean).length !== 1) return officeError('Choose exactly one of worker, workers, or all: true.');
      return replyFor(caller, await command(caller, { action: 'watch', ...args }), (body) => {
        const results = (body.results as Array<Record<string, unknown>> | undefined) ?? [];
        if (!results.length) return String(body.note ?? (args.watch === false ? 'Stopped watching.' : 'No workers matched.'));
        return results
          .map((r) => {
            const label = `${r.name ?? r.id}${r.floor ? ` (${r.floor})` : ''}`;
            if (r.error) return `${label}: ${r.error}`;
            if (r.note) return `${label}: ${r.note}`;
            const w = r.worker as TeamMember | undefined;
            return r.watching === false
              ? `${label}: stopped watching`
              : `${label}: watching${w ? ` (${w.status}${w.cwd ? `, ${w.cwd}` : ''}${w.branch ? ` on ${w.branch}` : ''}${w.pr ? `, PR ${w.pr.url}` : ''}${w.warnings?.length ? `; Warning: ${w.warnings.join('; ')}` : ''})` : ''}`;
          })
          .join('\n');
      });
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
  const attachImagesSchema = z.array(z.string().regex(PROMPT_IMAGE_ID)).max(PROMPT_IMAGES_MAX).optional().describe('Uploaded image ids from POST /office/images to attach for the subagent.');
  server.tool(
    {
      name: 'team_message',
      description:
        'Choose exactly one target: worker, workers, or all: true. Send course corrections, contract updates or rebase instructions (plus optional uploaded image ids in images). Default queue: false steers during the running turn (next step via hook or Enter); queue: true queues via Ctrl+Enter for after the turn ends; urgent: true interrupts a running turn or blocking command via Escape and delivers immediately. Inspect per-recipient errors and blocking warnings. Never message workers at permission prompts.',
      inputSchema: z
        .strictObject({
          worker: worker.optional(),
          workers: z.array(worker).min(1).max(100).optional(),
          all: z.literal(true).optional(),
          text,
          images: attachImagesSchema,
          floor: floorArg,
          queue: z.boolean().default(false).describe('Default false: steer now during the running turn; true queues via Ctrl+Enter for after the turn ends.'),
          urgent: z.boolean().optional().describe('True: interrupt a running turn or blocking command via Escape and deliver immediately (not with queue: true).'),
        })
        .refine((a) => !(a.queue && a.urgent), 'Choose either queue: true (after turn) or urgent: true (interrupt and steer now), not both.'),
      annotations: changesState,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      if ([args.worker !== undefined, args.workers !== undefined, args.all === true].filter(Boolean).length !== 1) return officeError('Choose exactly one of worker, workers, or all: true.');
      return replyFor(caller, await command(caller, { action: 'send', ...args }), (body) =>
        body.results
          ? (body.results as Record<string, unknown>[]).map((r) => `${r.name ?? r.id}${r.floor ? ` (${r.floor})` : ''}: ${r.error ?? r.delivery}${r.warning ? ` — Warning: ${r.warning}` : ''}`).join('\n')
          : `${(body.worker as TeamMember).name}: ${body.delivery}${body.warning ? `\nWarning: ${body.warning}` : ''}`,
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
      return reply(await team.handle(caller.worker, { action: 'models_list' }), (body) => {
        const quotas = body.quotas as ProviderQuotaSummary[] | undefined;
        return [...(quotas?.length ? [formatProviderQuotas(quotas)] : []), ...(body.models as TeamModel[]).map((model) => `${model.enabled === false ? (model.cannotRun ? 'Unavailable: ' : 'Not allowed: ') : ''}${modelText(model)}`)].join(
          '\n\n',
        );
      });
    },
  );
  server.tool(
    {
      name: 'worker_diff',
      description:
        'Read your subagent’s bounded Git stat and diff (recorded base vs tracked working tree, or pass base or commits; also works after dismissal while its worktree or branch exists). Inspect during check-ins and before accepting "done", relaying contract changes, or merging.',
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
      description: 'Read your subagent’s structured state (plan, tool, model cooldown, PR/CI) and recent terminal output (0–400 lines, capped at 48 KB; pass tail: 0 for structured state only), read-only.',
      inputSchema: z.strictObject({
        worker,
        floor: floorArg,
        tail: z.number().int().min(0).max(400).default(80).describe('Recent terminal lines (default 80, max 400; 0 for structured worker state only).'),
      }),
      annotations: readOnly,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      return replyFor(caller, await command(caller, { action: 'log', ...args }), (body) => {
        const state = body.inspection as WorkerInspection | undefined;
        if (body.tail === 0 && state) return formatWorkerInspection(state, { includeSteps: true });
        if (state) return `${formatWorkerInspection(state)}\n\nTerminal:\n${body.terminal ?? 'Terminal unavailable.'}${body.truncated ? '\n[Truncated]' : ''}`;
        return `${body.activity ? `Doing: ${body.activity}\n` : ''}${body.terminal ?? 'Terminal unavailable.'}${body.truncated ? '\n[Truncated]' : ''}`;
      });
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
      const leadPush = Boolean(caller.worker.lead && deps.remote?.store.isGrokBot(caller.worker.lead));
      const linkBase = mcpDeepLinkBase(deps);
      const identity = {
        ...body,
        floor: { id: floor.id, name: floor.name },
        deepLink: workerDeepLink(caller.worker.id, floor.id, linkBase),
        floorDeepLink: floorDeepLink(floor.id, linkBase),
        cwd: caller.cwd,
        canVisit: !visitRefusal,
        ...(visitRefusal ? { visitRefusal } : {}),
        ...(leadPush ? { leadPush: true } : {}),
        ownerAccess: false,
      };
      const lead = caller.worker.lead ? (floor.workers.get(caller.worker.lead)?.name ?? deps.remote?.store.identity(caller.worker.lead)?.name ?? caller.worker.lead) : undefined;
      return officeResult(
        [
          `${caller.worker.name} (${caller.worker.id}), ${floor.name}, ${lead ? `subagent of ${lead}` : 'independent worker'}.`,
          `Working folder: ${caller.cwd}`,
          `May hire: ${body.canHire ? 'yes' : 'no'}. Subagents: ${body.subagents ?? 0}${typeof body.max === 'number' ? `/${body.max}` : ', no limit'}. Wake the lead: ${body.wakeLead ? 'on' : 'off'}.`,
          ...(leadPush ? [`Grok Bot push: on (team_report and lead_notify wake ${lead} immediately by webhook).`] : []),
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
    const grokBot = Boolean(caller.worker.remote && deps.remote?.store.isGrokBot(caller.worker.id));
    const linkBase = mcpDeepLinkBase(deps);
    const identity = {
      you: { id: caller.worker.id, name: caller.worker.name, role: subagents ? 'lead' : 'worker', building: kind },
      room: 'Mission Control',
      floor: null,
      deepLink: workerDeepLink(caller.worker.id, undefined, linkBase),
      ...(caller.cwd ? { cwd: caller.cwd } : {}),
      canHire: true,
      subagents,
      teams,
      worktree: s.worktree,
      wakeLead: (!caller.worker.remote && s.wakeLead) || grokBot,
      ...(grokBot ? { grokBot: true } : {}),
      canVisit: false,
      ownerAccess: owner,
    };
    return officeResult(
      [
        `${caller.worker.name} (${caller.worker.id}), ${kind === 'external' ? (grokBot ? 'a Grok Bot' : 'an external bot') : "the office's Orchestrator"} in Mission Control: no floor or desk.`,
        ...(caller.cwd ? [`Working folder: ${caller.cwd} (scratch space, not a checkout).`] : []),
        `May hire: yes, on any open floor, with no team size limit. Subagents: ${subagents}${teams.length ? ` (${teams.map((t) => `${t.subagents} on ${t.name}`).join(', ')})` : ''}.`,
        caller.worker.remote
          ? grokBot
            ? 'Wake webhook: on (subagent reports, questions, terminal blockers and lead_notify push JSON to your webhook and remain in office_inbox until acknowledged).'
            : 'Wake notes: none; poll office_inbox or team_wait.'
          : `Wake notes: ${s.wakeLead ? 'on' : 'off'}.`,
        'May visit: no. Reach any worker with office_worker_prompt.',
        ...(owner ? ['Owner access: yes. Focused office_* tools act across the building as the owner does. Use team_* for your subagents.'] : []),
      ].join('\n'),
      identity,
    );
  };
  server.tool(
    {
      name: 'team_models',
      description: 'List runnable subagent models and compact subscription provider quotas (5-hour/weekly remaining, reset time, cooldowns). Pass only: "quotas" | "subscriptions" | "available" to filter. Call once per hiring batch.',
      inputSchema: z.strictObject({
        only: z
          .enum(['all', 'subscriptions', 'available', 'quotas'])
          .optional()
          .describe('Filter output: quotas (compact provider summary only), subscriptions (subscription models only), available (runnable models only), or all (default).'),
      }),
      annotations: readOnly,
    },
    officeAccess.mayHire,
    async ({ only }, caller) => {
      const team = modelsTeam(caller);
      if (!team) return officeError('No floor is open, so the office cannot list models yet.');
      const res = await team.handle(caller.worker, { action: 'models' });
      if (res.status >= 400) return reply(res, () => '');
      const allModels = res.body.models as TeamModel[];
      const quotas = res.body.quotas as ProviderQuotaSummary[] | undefined;
      const defaultLine = `Default: ${res.body.defaultModel ?? (res.body.restricted ? 'none on the allowed list (pass model explicitly)' : "Droid's own default")}.`;
      const mode = only ?? 'all';
      if (mode === 'quotas') {
        const text = [quotas?.length ? formatProviderQuotas(quotas) : 'Subscription quotas: no subscription providers configured.', defaultLine].join('\n\n');
        return officeResult(text, {
          restricted: res.body.restricted,
          models: [],
          quotas: quotas ?? [],
          only: mode,
          ...(res.body.defaultModel ? { defaultModel: res.body.defaultModel } : {}),
          ...(res.body.unavailable ? { unavailable: true } : {}),
        });
      }
      const filtered = mode === 'subscriptions' ? allModels.filter((m) => Boolean(m.subscriptionProvider || m.usage || isSubscriptionModel(m.id))) : mode === 'available' ? allModels.filter((m) => !m.cannotRun) : allModels;
      const body = mode === 'all' ? res.body : { ...res.body, models: filtered, only: mode };
      return officeResult(
        [
          ...(quotas?.length ? [formatProviderQuotas(quotas)] : []),
          body.restricted ? 'Settings restrict subagent models to the listed picks.' : 'Subagents may use any current Droid model.',
          ...(body.unavailable ? ['Droid could not list its models; costs and providers may be missing.'] : []),
          ...filtered.map(modelText),
          defaultLine,
        ].join('\n\n'),
        body,
      );
    },
  );
  server.tool(
    {
      name: 'team_hire',
      description:
        'Hire a fresh subagent in its own terminal (and isolated Git worktree on Git floors). Read team_models once per batch and commit task-authored prerequisites first. Pass top-level title + brief for a simple hire, or structured task when pinning baseBranch, branch, prNumber, or acceptanceCriteria (building agents set floor or task.repo; task.repo is optional). Give each independent scope single-writer edit ownership, dependency context and checks. Actively check in, relay changes, unblock questions and review before integration.',
      inputSchema: z.strictObject({
        title: z.string().trim().min(1).max(80).optional().describe('Short task title (use with top-level brief; omit when passing task).'),
        brief: text.optional().describe('Ticket: goal, context, exact owned files, checks, and delivery (omit when passing task).'),
        floor: z.string().trim().min(1).max(4096).optional().describe('Building agents only (floor workers omit): floor id, name, or path.'),
        task: z
          .strictObject({
            title: z.string().trim().min(1).max(80),
            brief: text,
            repo: z.string().trim().min(1).max(4096).optional().describe('Optional floor checkout path (never "."), or floor id/name/path for building agents; omit to use your floor or top-level floor.'),
            baseBranch: z.string().trim().min(1).max(4096).optional().describe('The same setting as from: ref, your subagent as worker:<name/id>, or its absolute worktree path; committed state only. Omit for lead HEAD/floor base.'),
            branch: z.string().trim().min(1).max(200).optional().describe('New local branch name.'),
            prNumber: z.number().int().positive().optional(),
            acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).max(30).optional(),
          })
          .optional()
          .describe('Structured ticket with optional branch/PR/criteria metadata (overrides top-level title/brief; repo is optional and works on non-git floors too).'),
        model: z.string().trim().min(1).optional().describe('Exact model id from team_models (match owner notes, difficulty, images, quota).'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Effort from team_models.'),
        from: z
          .string()
          .trim()
          .min(1)
          .max(4096)
          .optional()
          .describe('The same setting as task.baseBranch: ref, your subagent as worker:<name/id>, or its absolute worktree path. Pins committed HEAD without moving the source; requires a worktree. Omit for lead HEAD/floor base.'),
        images: attachImagesSchema,
        worktree: z.boolean().optional().describe('Structured task defaults true on Git floors (false on non-Git floors); otherwise follows owner settings. True: isolated worktree; false: shared checkout (omit baseBranch/branch/from).'),
      }),
      annotations: changesState,
    },
    officeAccess.mayHire,
    async ({ brief, task, ...args }, caller) => {
      const title = task?.title ?? args.title;
      const ticket = task?.brief ?? brief;
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      if (caller.building && !args.floor && !task?.repo) {
        return officeError('A building agent names the floor to hire on: pass floor with the open floor’s id, name or path from office_floors, or set task.repo.');
      }
      if (!title || !ticket) return officeError('team_hire needs title and brief, either at the top level or in task.');
      if (task && args.from && task.baseBranch && !sameBase(args.from, task.baseBranch)) {
        return officeError(`from (${args.from}) and task.baseBranch (${task.baseBranch}) name different bases. They set the same thing, so give only one.`);
      }
      if (task && args.worktree === false && (task.baseBranch || task.branch))
        return officeError('A structured task with baseBranch or branch requires a fresh worktree: leave worktree out, or omit baseBranch and branch for read-only work in the checkout.');
      if (task?.repo !== undefined && !caller.building && path.resolve(task.repo) !== path.resolve(ownFloor(caller).dir)) return officeError('task.repo must name your floor repository.');
      const pickedFloor = task && caller.building && deps.remote ? floorNamed(deps.remote.floors(), task.repo ?? args.floor!) : undefined;
      const repoLabel = task ? (typeof pickedFloor === 'object' ? pickedFloor.dir : (task.repo ?? (caller.building ? args.floor : ownFloor(caller).dir))) : undefined;
      const prompt = task
        ? `${ticket}${repoLabel ? `\n\nRepository: ${repoLabel}` : ''}${task.baseBranch ? `\nBase branch: ${task.baseBranch}` : ''}${task.branch ? `\nTask branch: ${task.branch}` : ''}${task.prNumber ? `\nPull request: #${task.prNumber}` : ''}${task.acceptanceCriteria?.length ? `\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : ''}`
        : ticket;
      if (prompt.length > 20_000) return officeError('The complete structured task ticket must fit in 20,000 characters.');
      return replyFor(
        caller,
        await command(caller, {
          action: 'hire',
          ...args,
          title,
          task: prompt,
          ...(task ? { structured: true, ...(task.repo ? { repo: task.repo } : {}), from: task.baseBranch ?? args.from, branch: task.branch } : {}),
          worktree: args.worktree,
        }),
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
      return replyFor(caller, await command(caller, { action: args.action === 'message' ? 'send' : args.action, worker: args.name, text: args.text, floor: args.floor }), (body) =>
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
        'Record approve, request_changes or comment on a subagent’s latest report after checking worker_diff (also works after the subagent was dismissed). request_changes notifies an active subagent by default to fix and re-report; approve/comment do not wake it by default. Approval is the lead’s workflow gate, not a server-enforced merge lock. Re-review changed work.',
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
      return replyFor(caller, await command(caller, { action: 'review', ...args }), (body) => {
        const member = body.worker as TeamMember;
        const review = body.review as WorkerReview;
        const delivery = body.notified ? ` Sent findings to ${member.name} to address.` : typeof body.notifyNote === 'string' ? ` Not sent to ${member.name} (${body.notifyNote}).` : '';
        return `Recorded ${review.verdict} review on ${member.name}'s report.${delivery}`;
      });
    },
  );
  const grokSubagent = (caller: OfficeMcpCaller): string | undefined => {
    const why = officeAccess.subagent(caller);
    if (why) return why;
    if (!caller.worker.lead || !deps.remote?.store.isGrokBot(caller.worker.lead)) {
      return 'Only subagents whose lead is a Grok Bot with webhook push enabled use lead_notify; report with team_report instead.';
    }
    return undefined;
  };
  const reportImagesSchema = z
    .array(z.string().trim().min(1).max(1024))
    .max(PROMPT_IMAGES_MAX)
    .optional()
    .describe('Optional produced image file paths, uploaded image ids, or Whiteboard card ids to return as downloadable Tailnet URLs and ids.');
  const fallbackStores = new WeakMap<object, OfficeImageStore>();
  const resolveSubagentImages = (caller: OfficeMcpCaller, explicit: readonly string[] | undefined, reportText: string | undefined): { ok: true; images: StoredImageMeta[]; store: OfficeImageStore } | { ok: false; error: string } => {
    const floor = ownFloor(caller);
    let store = deps.images ?? deps.remote?.images ?? fallbackStores.get(floor);
    if (!store) {
      store = new OfficeImageStore(path.join(floor.dir, '.droid-office'));
      fallbackStores.set(floor, store);
    }
    const drops = floor.workers.stagedPicture ? { stagedPicture: (id: string) => floor.workers.stagedPicture!(id) } : undefined;
    const res = store.ingestWorkerReportImages({
      explicit,
      text: reportText,
      cwd: caller.cwd ?? floor.dir,
      floorDir: floor.dir,
      workerId: caller.worker.id,
      drops,
      whiteboard: floor.whiteboard,
    });
    return res.ok ? { ok: true, images: res.images, store } : res;
  };
  server.tool(
    {
      name: 'lead_notify',
      description:
        'Grok Bot subagents only: push a direct JSON notification to your Grok Bot lead’s webhook immediately without ending your turn (mid-turn checkpoints, early artifact links, screenshots/images, blockers, questions, or a clearly marked test ping). Use team_report for your turn-ending final report or blocking question.',
      inputSchema: z.strictObject({
        text: text.describe('Message, blocker details, question, or test note pushed directly to your Grok Bot lead.'),
        kind: z
          .enum(['update', 'question', 'blocker', 'test'])
          .default('update')
          .describe('update: mid-turn heads-up or artifact; question: non-stopping question; blocker: urgent obstacle; test: connectivity check (not saved in office_inbox).'),
        options: z.array(z.string().trim().min(1).max(200)).min(2).max(9).optional().describe('For kind "question" only: ordered answer choices.'),
        pushedSha: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .optional()
          .describe('Optional full pushed commit SHA.'),
        prUrl: z.url().max(2000).optional().describe('Optional pull request URL.'),
        images: reportImagesSchema,
      }),
      annotations: changesState,
    },
    grokSubagent,
    async (args, caller) => {
      if (args.options !== undefined && args.kind !== 'question') return officeError('options are only for kind "question": set kind: "question" or omit options.');
      const { images: rawImages, ...notifyArgs } = args;
      if (rawImages?.length && notifyArgs.kind === 'test') return officeError('images are not attached to kind "test" connectivity pings.');
      if (!deps.remote) return officeError('Remote office is not available for lead_notify.');
      const floor = ownFloor(caller);
      const ingested = notifyArgs.kind === 'test' ? { ok: true as const, images: [] as StoredImageMeta[], store: deps.remote.images } : resolveSubagentImages(caller, rawImages, notifyArgs.text);
      if (!ingested.ok) return officeError(ingested.error);
      let quiet = false;
      const leadId = caller.worker.lead;
      if (notifyArgs.kind === 'update' && leadId && deps.wakeFilter?.active() && floor.team.wakeContext) {
        const verdict = await deps.wakeFilter
          .decide({
            channel: 'lead_notify',
            ...floor.team.wakeContext(leadId, caller.worker),
            message: {
              text: notifyArgs.text,
              kind: 'update',
              ...(notifyArgs.pushedSha ? { pushedSha: notifyArgs.pushedSha } : {}),
              ...(notifyArgs.prUrl ? { prUrl: notifyArgs.prUrl } : {}),
              ...(ingested.images.length ? { images: ingested.images.length } : {}),
            },
          })
          .catch(() => undefined);
        if (verdict?.traffic === 'block_and_coach') return officeResult(verdict.coach ?? 'Not delivered: the noise gate read this as chatter.', { kind: args.kind, pushed: false, blocked: true });
        quiet = verdict?.traffic === 'record_silently' || verdict?.traffic === 'hold_for_batch';
      }
      const sent = await deps.remote.notifyLead(
        { worker: caller.worker, floor: { id: floor.id, name: floor.name, dir: floor.dir } },
        { ...notifyArgs, ...(ingested.images.length ? { images: ingested.images } : {}), ...(quiet ? { quiet } : {}) },
      );
      if (sent.deferred) {
        return officeResult(`Recorded in ${sent.lead}'s office_inbox (${sent.ackId}) without waking it: the noise gate read this as a routine update, so it rides along with the next webhook push. Continue your task.`, {
          lead: sent.lead,
          kind: args.kind,
          pushed: false,
          deferred: true,
          ...(sent.ackId ? { ackId: sent.ackId } : {}),
          ...(sent.images?.length ? { images: sent.images } : {}),
        });
      }
      if (!sent.ok) {
        const saved = sent.ackId ? ` Saved in ${sent.lead}'s office_inbox (${sent.ackId}), so nothing was lost.` : '';
        return officeError(`Webhook push to ${sent.lead} failed (${sent.error ?? 'delivery failed'}).${saved}`, 'webhook_failed');
      }
      const statusPart = sent.status !== undefined ? ` (HTTP ${sent.status})` : '';
      return officeResult(args.kind === 'test' ? `Sent [TEST] webhook ping to ${sent.lead}${statusPart}.` : `Pushed ${args.kind} to ${sent.lead}'s webhook${statusPart}${sent.ackId ? ` and saved in office_inbox (${sent.ackId})` : ''}.`, {
        lead: sent.lead,
        kind: args.kind,
        pushed: true,
        ...(sent.status !== undefined ? { status: sent.status } : {}),
        ...(sent.ackId ? { ackId: sent.ackId } : {}),
        ...(sent.images?.length ? { images: sent.images } : {}),
      });
    },
  );
  server.tool(
    {
      name: 'team_report',
      description:
        'Subagents only: send your lead results, checks, remaining work, links, screenshots/images, structured result, and any schema/contract changes siblings need (or set question: true for a blocking question, or progress: true before ending your turn while a background job runs), then end your turn.',
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
        images: reportImagesSchema,
        result: resultSchema.optional(),
      }),
      annotations: changesState,
    },
    officeAccess.subagent,
    async (args, caller) => {
      const floor = ownFloor(caller);
      const { images: rawImages, ...reportArgs } = args;
      const ingested = resolveSubagentImages(caller, rawImages, reportArgs.text);
      if (!ingested.ok) return officeError(ingested.error);
      const result = await floor.team.handle(caller.worker, { action: 'report', ...reportArgs, ...(ingested.images.length ? { images: ingested.images } : {}) });
      if (result.status >= 400) return reply(result, () => '');
      if (ingested.images.length) {
        result.body.images = ingested.store.withUrls(ingested.images, caller.remoteOrigin);
      }
      const leadId = caller.worker.lead;
      let webhookNote = '';
      if (leadId && deps.remote?.store.isGrokBot(leadId)) {
        const latest = floor.team.reports(leadId, caller.worker.id).at(-1);
        const receipt = await deps.remote.pushTeamReport(floor.id, leadId, latest);
        if (receipt) {
          result.body.webhook = {
            pushed: receipt.ok,
            ...(receipt.status !== undefined ? { status: receipt.status } : {}),
            ...(receipt.error ? { error: receipt.error } : {}),
          };
          webhookNote = receipt.ok ? ' Pushed to its Grok Bot webhook.' : ` Saved in its inbox (webhook push failed: ${receipt.error ?? 'delivery failed'}).`;
        }
      }
      return reply(result, (body) =>
        args.question
          ? `Asked ${body.lead}.${webhookNote} End your turn now; the answer arrives as a later message.`
          : args.progress
            ? `Sent ${body.lead} a progress report: ${body.lead} sees you are not finished.${webhookNote} End your turn now; your background job wakes you when it exits. Then check its result, carry on, and finish with a final report (progress left out).`
            : `Reported to ${body.lead}.${webhookNote} End your turn now; any reply arrives as a later message.`,
      );
    },
  );
}
