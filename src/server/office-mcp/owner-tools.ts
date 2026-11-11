import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ORCHESTRATOR_ID } from '../../shared/mission-control.js';
import type { ClientMsg } from '../../shared/protocol.js';
import { AUTO_DESK } from '../../shared/protocol.js';
import type { OfficeMcpServer } from './index.js';
import { officeError } from './index.js';
import { buildingOnly, findMissionAgent, findWorker, missionControlRefusal, outsideOffice, pickFloor, ownerResult, type OwnerAction, type OwnerOffice } from './owner.js';
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
    'Spawn a standalone owner-managed worker, shell, or cloud worker ONLY when explicitly requested (may incur cloud charges). To delegate as a lead, ALWAYS use team_hire.',
    z
      .strictObject({
        floor: floorRef,
        deskId: id.max(32).default(AUTO_DESK).describe(`Seat id, or ${AUTO_DESK}.`),
        prompt: text.optional(),
        worktree: z.boolean().optional().describe('Isolated Git worktree.'),
        kind: z.enum(['agent', 'shell', 'cloud']).default('agent'),
        model: model.optional(),
        effort: effort.optional(),
        issue: number.optional().describe('Forge issue number.'),
        repos: z.array(id).optional().describe('Extra floor ids for multi-repo.'),
        images: images.optional(),
        cloud: cloud.optional().describe('Required for cloud.'),
      })
      .refine((a) => (a.kind === 'cloud') === (a.cloud !== undefined), 'Supply cloud exactly when kind is cloud.'),
    'floor',
    'write',
    true,
  ),
  tool(
    'worker.prompt',
    'office_worker_prompt',
    'Prompt an independent floor worker (check office_look first; for subagents use team_message; never prompt a worker at a permission prompt).',
    z.strictObject({ ...worker, prompt: text.min(1), issue: number.optional(), images: images.optional(), queue: z.boolean().default(false).describe('Queue behind running turn.') }),
    'worker',
    'write',
    true,
  ),
  tool(
    'worker.answer',
    'office_worker_answer',
    'Answer an independent floor worker’s AskUser menu using its exact screen snapshot (for subagents use question_answer; never for permission prompts).',
    z
      .strictObject({
        ...worker,
        menu,
        choice: number.optional().describe('Single option number.'),
        choices: z.array(number).optional().describe('Checkbox option numbers.'),
        text: text.optional().describe('Typed answer.'),
      })
      .refine((a) => (a.choice !== undefined ? a.choices === undefined && a.text === undefined : a.choices !== undefined || a.text !== undefined), 'Send one choice, checkbox choices, or text; do not combine choice with the others.'),
    'worker',
    'delete',
  ),
  tool('worker.interrupt', 'office_worker_interrupt', 'Interrupt a floor worker’s running turn without dismissing it.', z.strictObject({ ...worker }), 'worker', 'delete', true),
  tool(
    'thread.read',
    'office_worker_thread',
    'Read one page of a local or cloud worker’s conversation (or Orchestrator’s), read-only.',
    z.strictObject({ ...worker, before: z.number().int().nonnegative().optional().describe('Entry sequence for older history.') }),
    'worker',
    'read',
    true,
  ),
] as const;

export function registerOwnerTools(server: OfficeMcpServer, owner: OwnerOffice): void {
  for (const entry of OWNER_TOOLS) {
    server.tool(entry, buildingOnly, async (input, caller, signal) => {
      const args: Record<string, unknown> = { ...input };
      const ref = typeof args.floor === 'string' ? args.floor : undefined;
      delete args.floor;
      let floor: string | undefined;
      if (entry.scope === 'worker') {
        const found = findWorker(owner.floors(), String(args.workerId), ref);
        if (typeof found === 'string') {
          const building = findMissionAgent(owner, String(args.workerId));
          if (!building) return officeError(found);
          // Building agents are read, never controlled, and only the Orchestrator's conversation is in this office.
          if (entry.action !== 'thread.read') return officeError(missionControlRefusal(building, entry.name));
          if (building.worker.id !== ORCHESTRATOR_ID) return officeError(outsideOffice(building, 'conversation'));
          args.workerId = building.worker.id;
        } else {
          args.workerId = found.worker.id;
          floor = found.floor.id;
        }
      } else {
        const at = ref ?? caller.floor?.id;
        if (!at) return officeError('Name the floor: office_floors lists them.');
        const picked = pickFloor(owner.floors(), at);
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
