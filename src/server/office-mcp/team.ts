import { z } from 'zod';
import { officeAccess, officeResult, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';

export const instructions = `Your team consists of real workers at nearby desks, not hidden tasks. A subagent has its own terminal and usually its own git worktree. Its lead is another worker. Permission to hire, team size, allowed models and wake notes are controlled by the owner.`;

export function register(server: OfficeMcpServer, _deps: OfficeMcpDeps): void {
  server.tool(
    {
      name: 'office_whoami',
      description:
        'Read your office identity, desk, lead if you are a subagent, permission to hire and visit, team size, worktree default and wake-note setting. Use this to establish your role before coordinating work. It does not hire, message or wait.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
}
