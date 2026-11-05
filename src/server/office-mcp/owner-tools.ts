import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClientMsg } from '../../shared/protocol.js';
import { AUTO_DESK } from '../../shared/protocol.js';
import type { OfficeMcpServer } from './index.js';
import { officeError } from './index.js';
import { findWorker, pickFloor, remoteOnly, ownerResult, type OwnerAction, type OwnerOffice } from './owner.js';
import { cloud, effort, floorRef, id, images, menu, model, text, workerRef } from './owner-schemas.js';

type Input<A extends OwnerAction> = Omit<Extract<ClientMsg, { t: A }>, 't' | 'request' | 'requestId' | 'requestFloor' | 'floor'> & { floor?: string };
type Scope = 'floor' | 'worker';
type Effect = 'read' | 'write' | 'delete';

/**
 * Every entry is a separate MCP tool, not a model-facing action dispatcher. Its schema is checked
 * against the wire message at compile time; the bridge still applies the owner's runtime checks.
 */
function tool<A extends OwnerAction>(action: A, name: string, description: string, inputSchema: z.ZodObject & z.ZodType<Input<NoInfer<A>>>, scope: Scope, effect: Effect = 'write', external = false) {
  return {
    action,
    name,
    description,
    inputSchema,
    scope,
    annotations: { readOnlyHint: effect === 'read', destructiveHint: effect === 'delete', idempotentHint: effect === 'read', openWorldHint: external },
  };
}

const floor = { floor: floorRef.optional() };
const worker = { workerId: workerRef, ...floor };
const number = z.number().int().positive();
export const OWNER_TOOLS = [
  tool(
    'worker.spawn',
    'office_worker_spawn',
    'Hire an independent worker, shell or cloud worker on a floor. For a subagent that reports to you, use team_hire instead. Cloud hires can incur charges.',
    z
      .strictObject({
        ...floor,
        deskId: id.max(32).default(AUTO_DESK).describe(`Seat id, or ${AUTO_DESK} for the first free seat.`),
        prompt: text.optional(),
        worktree: z.boolean().optional().describe('Use an isolated Git worktree for a local agent.'),
        kind: z.enum(['agent', 'shell', 'cloud']).default('agent'),
        model: model.optional(),
        effort: effort.optional(),
        issue: number.optional().describe('Issue to assign to this worker on the floor’s forge.'),
        repos: z.array(id).optional().describe('Additional open repository floor ids for a multi-repository worker.'),
        images: images.optional(),
        cloud: cloud.optional().describe('Required for kind cloud; choose a Factory computer or environment.'),
      })
      .refine((a) => (a.kind === 'cloud') === (a.cloud !== undefined), 'Supply cloud exactly when kind is cloud.'),
    'floor',
    'write',
    true,
  ),
  tool(
    'worker.prompt',
    'office_worker_prompt',
    'Send a prompt to any worker as the owner. Use team_message for your own subagents and visit_message for peer coordination. This is not raw terminal input.',
    z.strictObject({ ...worker, prompt: text.min(1), issue: number.optional(), images: images.optional(), queue: z.boolean().default(false).describe('Queue behind the current turn using Ctrl+Enter instead of sending immediately.') }),
    'worker',
    'write',
    true,
  ),
  tool(
    'worker.answer',
    'office_worker_answer',
    'Answer a worker’s currently displayed menu as the owner. Supply its exact menu snapshot; changed menus are refused. Unlike question_answer, this is owner-level terminal control.',
    z
      .strictObject({
        ...worker,
        menu,
        choice: number.optional().describe('One displayed option number; not with choices or text.'),
        choices: z.array(number).optional().describe('Complete set of checkbox option numbers; may accompany text.'),
        text: text.optional().describe('Typed answer, optionally accompanying checkbox choices.'),
      })
      .refine((a) => (a.choice !== undefined ? a.choices === undefined && a.text === undefined : a.choices !== undefined || a.text !== undefined), 'Send one choice, checkbox choices, or text; do not combine choice with the others.'),
    'worker',
    'delete',
  ),
  tool('worker.interrupt', 'office_worker_interrupt', 'Interrupt any worker’s current turn without dismissing it. Sends Escape locally or interrupts its Factory session.', z.strictObject({ ...worker }), 'worker', 'delete', true),
  tool(
    'thread.read',
    'office_worker_thread',
    'Read one page of any local or cloud agent’s conversation. Does not attach or type into its terminal. Returns a bounded snapshot and pagination information.',
    z.strictObject({ ...worker, before: z.number().int().nonnegative().optional().describe('Exclusive entry sequence for older history; omit for the newest page.') }),
    'worker',
    'read',
    true,
  ),
] as const;

export function registerOwnerTools(server: OfficeMcpServer, owner: OwnerOffice): void {
  for (const entry of OWNER_TOOLS) {
    server.tool(entry, remoteOnly, async (input, caller, signal) => {
      const args: Record<string, unknown> = { ...input };
      const ref = typeof args.floor === 'string' ? args.floor : undefined;
      delete args.floor;
      let floor: string | undefined;
      if (entry.scope === 'worker') {
        const found = findWorker(owner.floors(), String(args.workerId), ref);
        if (typeof found === 'string') return officeError(found);
        args.workerId = found.worker.id;
        floor = found.floor.id;
      } else {
        const picked = pickFloor(owner.floors(), ref ?? caller.floor.id);
        if (typeof picked === 'string') return officeError(picked);
        floor = picked.floor.id;
      }
      if (entry.action === 'thread.read') args.request = randomUUID();
      if (signal.aborted) return officeError('Cancelled before taking the action.');
      const result = await owner.act(caller.worker, { ...args, t: entry.action }, { floor, signal });
      return ownerResult(entry.name, result);
    });
  }
}
