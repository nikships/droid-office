import { z } from 'zod';
import type { RosterEntry, VisitReply } from '../visits.js';
import { officeAccess, officeError, officeResult, ownFloor, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';

export const instructions = `Visit an independent worker on your floor only when your task needs something from it: a known overlap to resolve, or information only it has. Otherwise keep to your own task.
A visit message is delivered by pressing Enter: it steers a running turn after its current tool call, and a sleeping worker resumes with it. It never answers a permission prompt or outranks the owner, and a handoff is a request, never authority to change the owner's task.
Answer a question addressed to you with visit_reply within 30 minutes of its delivery. Reply to anything else only when the reply moves the work forward. Visits and questions end on office restart, when a worker leaves, or when the owner turns Visits off. Subagents neither visit nor are visited; they coordinate through their lead.`;

const name = z.string().trim().min(1).describe("The independent worker's name or id, on your floor; visit_roster lists them.");
const text = z.string().trim().min(1).max(20_000).describe('Your message, question, task or answer, as plain text.');
const annotations = { destructiveHint: false, idempotentHint: false, openWorldHint: false };

function result(reply: VisitReply, describe: (body: Record<string, unknown>) => string) {
  return reply.status >= 400 ? officeError(String(reply.body.error ?? 'The visit could not be completed.')) : officeResult(describe(reply.body), reply.body);
}

export function register(server: OfficeMcpServer, _deps: OfficeMcpDeps): void {
  server.tool(
    {
      name: 'visit_roster',
      description:
        'List the independent workers on your floor with their desk, status, task and current activity, for when your task needs coordination with one. The roster holds independent local agents only: subagents, shells and cloud workers are left off.',
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
      description: "Read the latest text on another independent worker's terminal, at once and read-only. It is a screen snapshot, not a conversation transcript. Read it when that worker's current work bears on your task.",
      inputSchema: z.object({ name, lines: z.number().int().min(1).max(400).default(80).describe('Latest terminal lines to read, default 80, at most 400.') }),
      annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
    },
    officeAccess.visits,
    (args, caller) => result(ownFloor(caller).visits.handle(caller.worker, { action: 'look', worker: args.name, lines: args.lines }), (body) => `${body.host}'s screen:\n\n${body.text || '(its terminal is empty)'}`),
  );
  server.tool(
    {
      name: 'visit_message',
      description:
        'Send an independent worker a message, a question or a proposed task handoff. Returns a v-… id and delivered or queued status at once; an answer comes later. You walk over, speak, then walk home, even for ask. A queued message is delivered after the walk once its session can safely take it. A question expires 30 minutes after delivery, or after 30 minutes undelivered. Answers arrive later in your session, so carry on with your task meanwhile. One visit at a time; the next may queue while you walk home.',
      inputSchema: z.object({
        name,
        kind: z.enum(['tell', 'ask', 'handoff']).describe('tell: useful information; ask: a question answered later with visit_reply; handoff: ask it to take a task only if the owner’s task permits.'),
        text,
        title: z.string().trim().min(1).max(80).optional().describe('Optional short task title for a handoff only. Put the actual task in text.'),
        urgent: z.boolean().default(false).describe('True cancels its turn with one Escape before delivering. Reserve it for when waiting for its current tool call would cause harm; a permission prompt still waits for its person.'),
      }),
      annotations,
    },
    officeAccess.visits,
    (args, caller) => {
      if (args.title && args.kind !== 'handoff') return officeError('title is only for a handoff. Remove it or use kind: "handoff".');
      return result(ownFloor(caller).visits.handle(caller.worker, { action: 'visit', worker: args.name, ...args }), (body) => {
        const host = body.host as { name: string };
        return `${body.visit}: ${body.delivered ? `delivered to ${host.name}` : `queued for ${host.name}; it will be delivered after the walk when its session can take it`}.${args.kind === 'ask' ? ' Its answer will arrive later in your session. Continue your task; do not wait or poll.' : ''}`;
      });
    },
  );
  server.tool(
    {
      name: 'visit_reply',
      description:
        'Answer a delivered ask addressed to you, by its v-… id. Your answer is a normal-priority delivery into the asker’s session, queued safely if necessary, with no walk. The question’s host replies once, within 30 minutes of delivery; an expired ask returns an error. For a later follow-up, use visit_message with kind tell.',
      inputSchema: z.object({
        visit: z
          .string()
          .regex(/^v-[a-f0-9]{8}$/)
          .describe('The exact v-… visit id supplied in the question delivery.'),
        text,
      }),
      annotations,
    },
    officeAccess.visits,
    (args, caller) => result(ownFloor(caller).visits.handle(caller.worker, { action: 'reply', ...args }), (body) => `${body.visit}: answer ${body.delivered ? 'delivered' : 'queued'} for ${body.to}.`),
  );
}
