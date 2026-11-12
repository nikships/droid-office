import { z } from 'zod';
import type { RosterEntry, VisitReply } from '../visits.js';
import { officeAccess, officeError, officeResult, ownFloor, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';

export const instructions = `Visit an independent worker on your floor only when your task needs to resolve an overlap or get facts only it has. Otherwise keep to your own task.
Messages steer after the current tool call or wake a sleeping worker; they never approve permission prompts or outrank the owner. Answer delivered asks with visit_reply within 30 minutes; reply to tells only when needed. Subagents coordinate through their lead, not visits.`;

const name = z.string().trim().min(1).describe('Independent worker name or id on your floor (from visit_roster).');
const peerFields = {
  worker: name.optional().describe('Independent worker name or id on your floor (from visit_roster).'),
  name: name.optional().describe('Alias for worker.'),
};
const resolvePeer = (a: { worker?: string; name?: string }) => {
  if (a.worker !== undefined && a.name !== undefined && a.worker.toLowerCase() !== a.name.toLowerCase()) return undefined;
  return a.worker ?? a.name;
};
const text = z.string().trim().min(1).max(20_000).describe('Plain-text message, question, handoff, or reply.');
const annotations = { destructiveHint: false, idempotentHint: false, openWorldHint: false };

function result(reply: VisitReply, describe: (body: Record<string, unknown>) => string) {
  return reply.status >= 400 ? officeError(String(reply.body.error ?? 'The visit could not be completed.')) : officeResult(describe(reply.body), reply.body);
}

export function register(server: OfficeMcpServer, _deps: OfficeMcpDeps): void {
  server.tool(
    {
      name: 'visit_roster',
      description: 'List independent local workers on your floor with desk, status, task, and activity (excludes subagents, shells, and cloud workers).',
      inputSchema: z.object({}),
      annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
    },
    officeAccess.visits,
    (_args, caller) =>
      result(ownFloor(caller).visits.handle(caller.worker, { action: 'roster' }), (body) => {
        const roster = body.roster as RosterEntry[];
        return [
          `${roster.length} independent workers on this floor:`,
          ...roster.map(
            (w) =>
              `${w.name}${w.you ? ' (you)' : ''} (${w.id}), ${w.desk}, ${w.busy ? 'busy' : 'idle'} (${w.status})${w.visiting ? `, visiting ${w.visiting}` : ''}${w.task ? `\n  Task: ${w.task}` : ''}${w.activity ? `\n  Doing: ${w.activity}` : ''}`,
          ),
          ...(roster.every((w) => w.you) ? ['No other independent workers on this floor.'] : []),
        ].join('\n');
      }),
  );
  server.tool(
    {
      name: 'visit_look',
      description: 'Read a current terminal snapshot of another independent worker on your floor, read-only.',
      inputSchema: z
        .object({ ...peerFields, lines: z.number().int().min(1).max(400).default(80).describe('Latest terminal lines (default 80, max 400).') })
        .refine((a) => resolvePeer(a) !== undefined, 'Pass worker or name, without conflicting values.'),
      annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
    },
    officeAccess.visits,
    (args, caller) => result(ownFloor(caller).visits.handle(caller.worker, { action: 'look', worker: resolvePeer(args)!, lines: args.lines }), (body) => `${body.host}'s screen:\n\n${body.text || '(its terminal is empty)'}`),
  );
  server.tool(
    {
      name: 'visit_message',
      description: 'Walk over and send an independent worker a tell, ask, or proposed handoff (returns v-… id immediately; ask replies arrive later within 30 minutes, so continue your work without polling).',
      inputSchema: z
        .object({
          ...peerFields,
          kind: z.enum(['tell', 'ask', 'handoff']).describe('tell: info; ask: question answered via visit_reply; handoff: optional task proposal.'),
          text,
          title: z.string().trim().min(1).max(80).optional().describe('Handoff only: short task title.'),
          urgent: z.boolean().default(false).describe('Cancels its running turn via Escape before delivery; use only when waiting would cause harm.'),
        })
        .refine((a) => resolvePeer(a) !== undefined, 'Pass worker or name, without conflicting values.'),
      annotations,
    },
    officeAccess.visits,
    (args, caller) => {
      if (args.title && args.kind !== 'handoff') return officeError('title is only for a handoff. Remove it or use kind: "handoff".');
      const { worker: _worker, name: _name, ...rest } = args;
      return result(ownFloor(caller).visits.handle(caller.worker, { ...rest, action: 'visit', worker: resolvePeer(args)! }), (body) => {
        const host = body.host as { name: string };
        return `${body.visit}: ${body.delivered ? `delivered to ${host.name}` : `queued for ${host.name}; it will be delivered after the walk when its session can take it`}.${args.kind === 'ask' ? ' Its answer will arrive later in your session. Continue your task; do not wait or poll.' : ''}`;
      });
    },
  );
  server.tool(
    {
      name: 'visit_reply',
      description: 'Answer a delivered ask addressed to you by its v-… id (once, within 30 minutes of delivery; use visit_message tell for later follow-ups).',
      inputSchema: z.object({
        visit: z
          .string()
          .regex(/^v-[a-f0-9]{8}$/)
          .describe('Exact v-… id from the question delivery.'),
        text,
      }),
      annotations,
    },
    officeAccess.visits,
    (args, caller) => result(ownFloor(caller).visits.handle(caller.worker, { action: 'reply', ...args }), (body) => `${body.visit}: answer ${body.delivered ? 'delivered' : 'queued'} for ${body.to}.`),
  );
}
