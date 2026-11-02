import { z } from 'zod';
import type { TeamEvent, TeamMember, TeamModel, TeamReply } from '../team.js';
import { officeAccess, officeError, officeResult, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';

export const instructions = `Your team consists of real workers at nearby desks on this floor, not hidden tasks. A subagent has its own terminal and normally its own git worktree. Its lead is another worker. The owner controls hiring permissions, team size, allowed models and wake notes. Subagents cannot hire.
Split work into independent pieces that do not edit the same files. Hire one fresh subagent per task, and no more than the work needs. Write each brief like a ticket: goal, relevant context and files, boundaries, checks, and how to finish (commit in its worktree and report, or another explicitly requested deliverable). Commit anything a new worktree needs first; uncommitted changes do not follow it.
Read team_models before hiring and choose per task. A credit multiplier is relative token cost: x0.2 is a fifth, x4 four times; an owner's own API key costs no Factory credits. Use the cheapest capable model: around x0.5 or less for mechanical work, around x1 for ordinary features and fixes, and the strongest suitable model for hard design, security, concurrency or subtle debugging. Owner notes take priority; between equally capable models pick the cheaper one. Higher effort on a mid-priced model may be enough before a pricier one. Never give visual work to a no-images model. Report which model each subagent ran.
Wake notes tell you when your team has news. With Wake the lead off, use team action status for a non-blocking snapshot and unread news; do not poll in a loop. Answer questions with team action message, review the actual commits and diff, send a follow-up if incomplete, and integrate the work. A question only a person can answer goes to whoever asked you. A subagent needing permission in its own terminal needs that person at its named desk, not a message saying yes.
Dismiss a finished subagent only when both worker and worktree are no longer needed, after review and integration. Tell whoever asked what each subagent did, with checks and links. Subagents use team_report for results or questions, then end their turn; the lead's answer arrives as a later message.`;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const changesState = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const text = z.string().trim().min(1).max(20_000);

function reply(result: TeamReply, describe: (body: Record<string, unknown>) => string) {
  if (result.status >= 400) return officeError(typeof result.body.error === 'string' ? result.body.error : 'The team could not finish this action. Read team status before retrying.');
  return officeResult(describe(result.body), result.body);
}

function memberText(member: TeamMember & { terminal?: string; terminalUnavailable?: string }): string {
  return [
    `${member.name} (${member.id}), ${member.status}, ${member.desk}${member.model ? `, ${member.model}${member.effort ? ` ${member.effort}` : ''}` : ''}.`,
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
  if (event.kind === 'report' || event.kind === 'question') return `Worker ${event.kind} from ${event.name}:\n${event.text ?? ''}`;
  const status = { done: 'finished its turn without reporting', needs_input: 'needs someone to answer in its own terminal', stopped: 'stopped', left: 'left the floor' };
  return `Office status: ${event.name} ${status[event.kind]}${event.text ? `: ${event.text}` : ''}.${event.kind === 'needs_input' ? ' Tell whoever asked you; someone must answer at its desk.' : ''}`;
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

export function register(server: OfficeMcpServer, _deps: OfficeMcpDeps): void {
  server.tool(
    {
      name: 'office_whoami',
      description:
        'Read your office identity, desk, lead if you are a subagent, permission to hire and visit, team size, worktree default and wake-note setting. Use this to establish your role before coordinating work. It does not hire, message or wait.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    officeAccess.worker,
    async (_args, caller) => {
      const { body } = await caller.floor.team.handle(caller.worker, { action: 'whoami' });
      const visitRefusal = caller.floor.visits.cannotVisit(caller.worker);
      const identity = { ...body, floor: { id: caller.floor.id, name: caller.floor.name }, cwd: caller.cwd, canVisit: !visitRefusal, ...(visitRefusal ? { visitRefusal } : {}) };
      const lead = caller.worker.lead ? (caller.floor.workers.get(caller.worker.lead)?.name ?? caller.worker.lead) : undefined;
      return officeResult(
        [
          `${caller.worker.name} (${caller.worker.id}), ${caller.floor.name}, ${lead ? `subagent of ${lead}` : 'independent worker'}.`,
          `Working folder: ${caller.cwd}`,
          `May hire: ${body.canHire ? 'yes' : 'no'}. Subagents: ${body.subagents ?? 0}/${body.max ?? 0}. Wake the lead: ${body.wakeLead ? 'on' : 'off'}.`,
          ...(typeof body.why === 'string' ? [body.why] : []),
          `May visit: ${visitRefusal ? `no. ${visitRefusal}` : 'yes'}.`,
        ].join('\n'),
        identity,
      );
    },
  );
  server.tool(
    {
      name: 'team_models',
      description:
        'Read the models allowed for your subagents, including ids, providers, credit multipliers, efforts, owner notes, no-images limits, the default, and why any cannot run. Read this before choosing a model for each task. Hiring refuses blocked models, including the default, before taking a desk.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    officeAccess.mayHire,
    async (_args, caller) =>
      reply(await caller.floor.team.handle(caller.worker, { action: 'models' }), (body) =>
        [
          body.restricted ? 'Settings restrict subagent models to the listed picks and the default.' : 'Subagents may use any current Droid model.',
          ...(body.unavailable ? ['Droid could not list its models; costs and providers may be missing.'] : []),
          ...(body.models as TeamModel[]).map(modelText),
          `Default: ${body.defaultModel ?? "Droid's own default"}.`,
        ].join('\n\n'),
      ),
  );
  server.tool(
    {
      name: 'team_hire',
      description:
        'Hire one fresh subagent at the nearest free desk for an independent task. It gets your brief, its own terminal, and normally a fresh worktree. Read team_models first. Permission, capacity and model refusals explain what to do; no desk is taken for an unavailable model. Commit shared prerequisites before hiring.',
      inputSchema: z.object({
        title: z.string().trim().min(1).max(80).describe('Short task title shown over the subagent.'),
        brief: text.describe('Complete task ticket: goal, context and files, boundaries, checks, and how to finish and report. Quotes, dollar signs and backticks are preserved.'),
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
    async ({ brief, ...args }, caller) =>
      reply(await caller.floor.team.handle(caller.worker, { action: 'hire', ...args, task: brief }), (body) => `Hired ${memberText(body.worker as TeamMember)}\nIt is working on the brief. Review its report and commits before integration.`),
  );
  server.tool(
    {
      name: 'team',
      description:
        'Manage only your own subagents. Status returns one named subagent or all, with unread reports, questions, finished turns, terminal input requests, stops and departures since your last status call. News is drained per caller, even for a named snapshot; nothing waits. Message answers a question or follows up, best between turns. Dismiss only after review and integration when worker and worktree are no longer needed; worktrees with work are kept.',
      inputSchema: z.object({
        action: z.enum(['status', 'message', 'dismiss']),
        name: z.string().trim().min(1).optional().describe('Subagent name or id, case-insensitive. Status: omit for all. Required for message and dismiss.'),
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
      const result = await caller.floor.team.handle(caller.worker, { action: args.action === 'message' ? 'send' : args.action, worker: args.name, lines: args.lines, text: args.text });
      return reply(result, (body) => {
        if (args.action === 'message') return `Sent to ${(body.worker as TeamMember).name}.`;
        if (args.action === 'dismiss') return `Sent ${body.name} home.${body.note ? ` ${body.note}.` : ''}`;
        const members = body.team as TeamMember[];
        const news = body.events as TeamEvent[];
        return [...(members.length ? members.map(memberText) : ['You have no subagents.']), news.length ? `News since your last status call:\n${news.map(eventText).join('\n\n')}` : 'No unread team news.'].join('\n\n');
      });
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
      }),
      annotations: changesState,
    },
    officeAccess.subagent,
    async (args, caller) => reply(await caller.floor.team.handle(caller.worker, { action: 'report', ...args }), (body) => `${args.question ? 'Asked' : 'Reported to'} ${body.lead}. End your turn now; the answer arrives as a later message.`),
  );
}
