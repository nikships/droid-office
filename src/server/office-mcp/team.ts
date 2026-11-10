import path from 'node:path';
import { z } from 'zod';
import type { TeamEvent, TeamMember, TeamModel, TeamReply } from '../team.js';
import { hasOwnerAccess } from './owner.js';
import { officeAccess, officeError, officeResult, ownFloor, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';
import { compactEvent, compactEventText, compactWorker, compactWorkerText, cursorOf, EVENT_FILTERS, eventKinds, parseCursor } from './team-events.js';

export const instructions = `Your team is real workers at nearby desks on this floor, not hidden tasks. A subagent has its own terminal and normally its own git worktree; its lead is another worker. The owner controls hiring permission, team size, allowed models and wake notes. Subagents cannot hire.
Split work into independent pieces that touch separate files. Hire one fresh subagent per task, and only as many as the work needs. Write each brief like a ticket: goal, relevant context and files, boundaries, checks, and how to finish (commit in its worktree and report, or another deliverable you name). Commit anything a new worktree needs first: uncommitted changes stay behind.
Read team_models before hiring and choose per task. A credit multiplier is relative token cost: x0.2 is a fifth, x4 four times; an owner's own API key costs no Factory credits. Use the cheapest capable model: around x0.5 or less for mechanical work, around x1 for ordinary features and fixes, and the strongest suitable model for hard design, security, concurrency or subtle debugging. Owner notes take priority; between equally capable models pick the cheaper one. Higher effort on a mid-priced model may be enough before a pricier one. Visual work goes to a model that reads images, never a no-images model. Report which model each subagent ran.
Wake notes tell you when your team has news. With Wake the lead off, team_status gives a non-blocking snapshot and unread news, and team_wait waits for news, so a polling loop is never needed. team_status with verbose: false returns one compact line per subagent and per event; team_report_get reads a full report. questions_list and question_answer handle questions waiting on you, and team_message sends an answer or a follow-up. Review the actual commits and diff (worker_diff), send a follow-up if the work is incomplete, and integrate it. A question only a person can answer goes to whoever asked you. A subagent stopped at a permission prompt in its own terminal needs that person at its named desk; a message saying yes cannot answer it.
Dismiss a subagent with team_dismiss once its work is through review and integration and neither it nor its worktree is still needed. Tell whoever asked what each subagent did, with checks and links. Subagents use team_report for results or questions, then end their turn; the lead's answer arrives as a later message.`;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const changesState = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const text = z.string().trim().min(1).max(20_000);

function reply(result: TeamReply, describe: (body: Record<string, unknown>) => string) {
  if (result.status >= 400)
    return officeError(
      typeof result.body.error === 'string' ? result.body.error : 'The team could not finish this action. Read team status before retrying.',
      result.status === 404 || result.status === 410 ? 'unknown_worker' : result.status === 403 ? 'permission_denied' : result.status === 409 ? 'conflict' : 'bad_argument',
    );
  return officeResult(describe(result.body), result.body);
}

function memberText(member: TeamMember & { terminal?: string; terminalUnavailable?: string }): string {
  return [
    `${member.name} (${member.id}), ${member.status}, ${member.desk}${member.model ? `, ${member.model}${member.effort ? ` ${member.effort}` : ''}` : ''}.`,
    ...(member.idleForMs !== undefined ? [`Idle for ${Math.floor(member.idleForMs / 60_000)} minutes.`] : []),
    ...(member.task ? [`Task: ${member.task}`] : []),
    ...(member.activity ? [`Doing: ${member.activity}`] : []),
    member.worktree ? `Worktree: ${member.worktree.path} on ${member.worktree.branch}${member.worktree.from ? ` from ${member.worktree.from}` : ''}.` : 'Working in the main checkout.',
    ...(member.pr ? [`Pull request: ${member.pr.url}`] : []),
    ...(member.report ? [`Last ${member.report.question ? 'question' : 'report'}:\n${member.report.text}`] : []),
    ...(member.terminal !== undefined ? [`Terminal:\n${member.terminal || '(empty)'}`] : []),
    ...(member.terminalUnavailable ? [member.terminalUnavailable] : []),
  ].join('\n');
}

function eventText(event: TeamEvent): string {
  const at = `[${new Date(event.at).toISOString()}]`;
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
    verbose: z.boolean().optional().describe('false for one compact line per subagent and per event, with summaries instead of whole reports. Omit or true for the full text.'),
    since: z.string().trim().min(1).max(4000).optional().describe('A cursor from an earlier status (cursor field) or one event id. News is everything after it, heard or not, instead of only unread news.'),
    kinds: z
      .array(z.enum(EVENT_FILTERS))
      .min(1)
      .max(EVENT_FILTERS.length)
      .optional()
      .describe('Just these news kinds (blocked is needs_input). Other news stays unread, but the cursor moves past it: reuse a filtered cursor only with the same kinds.'),
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
  const worker = z.string().trim().min(1).max(200).describe('Your subagent’s name or id, case-insensitive.');
  const floor = z.string().trim().min(1).max(4096).optional().describe('Building agents only: just this open floor, by id, name or checkout path.');
  server.tool(
    {
      name: 'team_status',
      description:
        'Read your subagents and unread team news without waiting. Optionally select a worker and recent terminal lines. structuredContent has workers (one compact object each, with state blocked_on_question while a question waits on an answer), news (typed events with ids and times) and a cursor for since. verbose: false makes the text compact too; team_report_get reads a full report. Does not message or dismiss.',
      inputSchema: z.strictObject({ worker: worker.optional(), floor, lines: z.number().int().min(1).max(400).optional(), ...statusOptions }),
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
      description: 'Send an answer or follow-up to one of your subagents. Cannot answer a permission prompt in its terminal.',
      inputSchema: z.strictObject({ worker, text, floor }),
      annotations: changesState,
    },
    officeAccess.team,
    async (args, caller) => {
      if (args.floor && !caller.building) return officeError('Floor workers manage only their own floor');
      return reply(await command(caller, { action: 'send', ...args }), (body) => `Sent to ${(body.worker as TeamMember).name}.`);
    },
  );
  server.tool(
    {
      name: 'team_dismiss',
      description:
        'Dismiss a reviewed subagent. Defaults to keeping its worktree and branch. pruneWorktree removes only a clean, owned worktree after its worker finishes, never the main checkout. keepBranch defaults true; false requests safe local branch deletion, which Git may refuse. No force option.',
      inputSchema: z.strictObject({ worker, floor, pruneWorktree: z.boolean().optional(), keepBranch: z.boolean().optional() }),
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
      description:
        'Read the full Droid/Subscriptions/DroidProxy model catalogue, including switched-off or disallowed models (enabled: false), availability, allowed-model restrictions and the default. team_models still lists the allowed subagent picks.',
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
      description:
        'Read a size-capped Git diff and stat for your subagent. Defaults to its recorded base versus the tracked working tree (no untracked files). base selects another revision. commits selects the last N commits through HEAD, excluding uncommitted changes. Never runs external diff drivers or textconv.',
      inputSchema: z.strictObject({ worker, floor, base: z.string().trim().min(1).max(200).optional(), commits: z.number().int().min(1).max(1000).optional() }),
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
      description: 'Read recent terminal output and current tool activity for your subagent without writing to or attaching its terminal. At most 400 lines and 48,000 characters.',
      inputSchema: z.strictObject({ worker, floor, tail: z.number().int().min(1).max(400) }),
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
      description:
        'Read your office identity, desk, lead if you are a subagent, permission to hire and visit, owner access, team size, worktree default and wake-note setting. Use this to establish your role before coordinating work. It does not hire, message or wait.',
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
        ...(caller.cwd ? [`Working folder: ${caller.cwd} (read-only planning; workers you hire make every change).`] : []),
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
      description:
        'Read the models allowed for your subagents, including ids, providers, credit multipliers, efforts, owner notes, no-images limits, the default, and why any cannot run. Read this before choosing a model for each task. Hiring refuses blocked models, including the default, before taking a desk.',
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
        'Hire one fresh subagent at the nearest free desk (to you, or for a building agent to Mission Control on the floor it names with floor or task.repo) for an independent task. It gets your brief, its own terminal, and normally a fresh worktree. Read team_models first. Permission, capacity and model refusals explain what to do; no desk is taken for an unavailable model. Commit shared prerequisites before hiring.',
      inputSchema: z.strictObject({
        title: z.string().trim().min(1).max(80).optional().describe('Short task title, required unless task supplies it.'),
        brief: text.optional().describe('Complete task ticket, required unless task supplies it. Quotes, dollar signs and backticks are preserved.'),
        floor: z.string().trim().min(1).max(4096).optional().describe('Building agents only: the open floor to hire on, by id, name or checkout path. A structured task names it in task.repo instead.'),
        task: z
          .strictObject({
            title: z.string().trim().min(1).max(80),
            brief: text,
            repo: z.string().trim().min(1).max(4096).describe('Your floor repository path. A building agent names any open floor: its path, id or name.'),
            baseBranch: z.string().trim().min(1).max(200).optional().describe('Base for the fresh worktree; omit for where its lead is now.'),
            branch: z.string().trim().min(1).max(200).optional().describe('Name for the new local branch; must not already exist.'),
            prNumber: z.number().int().positive().optional(),
            acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).max(30).optional(),
          })
          .optional()
          .describe('Structured task ticket. Its title/brief take precedence; baseBranch controls the fresh worktree base.'),
        model: z.string().trim().min(1).optional().describe('Id from team_models. Omit for the Subagents setting, else the office default, else Droid default. Pick by owner notes, task difficulty and credit multiplier.'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort; choose a value this model supports according to team_models. Omit to inherit its configured effort.'),
        from: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Branch, tag or commit for the fresh worktree, without spaces or a leading dash. Origin is fetched first. Omit to start on your branch at HEAD, refreshed if behind origin. Uncommitted changes do not follow. Requires worktree: true.',
          ),
        worktree: z
          .boolean()
          .optional()
          .describe(
            "Omit to follow the owner's Subagents setting (office_whoami shows it). True: isolated git worktree. False: use the project main checkout without switching its branch, only for read-only work or when your uncommitted changes must be visible. Non-git floors require false.",
          ),
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
      if (task && args.from && task.baseBranch && args.from !== task.baseBranch) return officeError('from and task.baseBranch disagree; provide one base.');
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
      description:
        'Deprecated alias: prefer team_status, team_message and team_dismiss. Manage only your own subagents. Status returns one named subagent or all, with unread news since your last status call, and the same structuredContent (workers, news, cursor), verbose, since and kinds as team_status. Message answers a question or follows up. Dismiss uses the legacy cleanup policy: worktrees with work are kept.',
      inputSchema: z.object({
        action: z.enum(['status', 'message', 'dismiss']),
        floor: z.string().min(1).max(128).optional().describe('Building agents only: restrict team operations to this floor. Omit for all your teams across the building.'),
        name: z.string().trim().min(1).optional().describe('Subagent name or id, case-insensitive. Status: omit for all. Required for message and dismiss.'),
        verbose: z.boolean().optional().describe('Status only: false for one compact line per subagent and per event, with summaries instead of whole reports. Omit or true for the full text.'),
        since: z.string().trim().min(1).max(4000).optional().describe('Status only: a cursor from an earlier status (cursor field) or one event id. News is everything after it, heard or not, instead of only unread news.'),
        kinds: z
          .array(z.enum(EVENT_FILTERS))
          .min(1)
          .max(EVENT_FILTERS.length)
          .optional()
          .describe('Status only: just these news kinds (blocked is needs_input). Other news stays unread, but the cursor moves past it: reuse a filtered cursor only with the same kinds.'),
        lines: z.number().int().min(1).max(400).optional().describe('Status only: include this many recent terminal lines per selected subagent, at most 400. Omit to leave terminals out.'),
        text: text.optional().describe('Message only: answer or follow-up to type into the subagent session. Cannot answer a permission prompt in its own terminal.'),
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
  server.tool(
    {
      name: 'team_report',
      description:
        'For a subagent: send results and checks, remaining work and commit or PR links to your lead, or ask a blocking question with question: true. Then end your turn. The lead replies as a later message. A question only a person can answer must be passed to whoever asked your lead. This does not block for the reply.',
      inputSchema: z.object({
        text: text.describe('Results, checks, remaining work and links, or the blocking question with relevant context.'),
        question: z.boolean().optional().describe('True for a question to your lead; omit or false for a report.'),
        options: z.array(z.string().trim().min(1).max(200)).min(2).max(9).optional().describe('Questions only: the answers your lead may pick from, in order.'),
        pushedSha: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .optional()
          .describe('Full pushed commit SHA. Otherwise read from the locally known upstream ref when available, without fetching.'),
        prUrl: z.url().max(2000).optional().describe('Pull request URL. Otherwise use the worker’s linked PR or a GitHub/GitLab PR URL in the report.'),
      }),
      annotations: changesState,
    },
    officeAccess.subagent,
    async (args, caller) =>
      reply(await ownFloor(caller).team.handle(caller.worker, { action: 'report', ...args }), (body) => `${args.question ? 'Asked' : 'Reported to'} ${body.lead}. End your turn now; the answer arrives as a later message.`),
  );
}
