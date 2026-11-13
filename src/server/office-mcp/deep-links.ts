import { cardDeepLink, floorDeepLink, normalizeDeepLinkBase, questionDeepLink, workerDeepLink } from '../../shared/deep-links.js';
import type { OtherFloorWorker } from '../floor-watch.js';
import type { TeamDelivery, TeamMember } from '../team.js';
import type { ReadOut } from '../whiteboard-agent.js';
import type { OfficeMcpDeps } from './index.js';
import type { CompactWorker, OpenQuestion } from './team-events.js';

export function mcpDeepLinkBase(deps: Pick<OfficeMcpDeps, 'deepLinkBase'>): string | undefined {
  return normalizeDeepLinkBase(deps.deepLinkBase?.());
}

export function withMemberDeepLink<T extends TeamMember & { floor?: string }>(member: T, defaultFloorId: string | undefined, base?: string): T & { deepLink: string } {
  const floorId = member.floor || defaultFloorId || undefined;
  return { ...member, deepLink: workerDeepLink(member.id, floorId, base) };
}

export function withCompactWorkerDeepLink(worker: CompactWorker, base?: string): CompactWorker & { deepLink: string; questionDeepLink?: string } {
  const floorId = worker.floor || undefined;
  return {
    ...worker,
    deepLink: workerDeepLink(worker.id, floorId, base),
    ...(worker.status === 'needs_input' || worker.state === 'blocked_on_question' ? { questionDeepLink: questionDeepLink(worker.id, floorId, worker.openQuestionId, base) } : {}),
  };
}

export function withOtherWorkerDeepLink(worker: OtherFloorWorker, defaultFloorId: string | undefined, base?: string): OtherFloorWorker & { deepLink: string } {
  const floorId = worker.floor || defaultFloorId || undefined;
  return { ...worker, deepLink: workerDeepLink(worker.id, floorId, base) };
}

export function withQuestionDeepLink(question: OpenQuestion, base?: string): OpenQuestion & { deepLink: string } {
  const floorId = question.floor || undefined;
  return { ...question, deepLink: questionDeepLink(question.worker, floorId, question.id, base) };
}

/** Attaches `deepLink` to `team_hire`, `team_message`, `team_watch`, `team_review` and `worker_log` bodies. */
export function enrichTeamReplyBody(body: Record<string, unknown>, defaultFloorId: string | undefined, base?: string): Record<string, unknown> {
  const normalizedBase = normalizeDeepLinkBase(base);
  const out: Record<string, unknown> = { ...body };
  const bodyFloor = typeof body.floor === 'string' && body.floor ? body.floor : defaultFloorId;
  const workerObjId = body.worker && typeof body.worker === 'object' ? (body.worker as { id?: unknown }).id : undefined;
  if (typeof workerObjId === 'string' && workerObjId.trim()) {
    const enriched = withMemberDeepLink(body.worker as TeamMember & { floor?: string }, bodyFloor, normalizedBase);
    out.worker = enriched;
    out.deepLink = enriched.deepLink;
  } else if (typeof body.worker === 'string' && body.worker.trim()) {
    out.deepLink = workerDeepLink(body.worker, bodyFloor, normalizedBase);
  } else if (typeof body.id === 'string' && body.id.trim() && ('terminal' in body || 'inspection' in body)) {
    out.deepLink = workerDeepLink(body.id, bodyFloor, normalizedBase);
  }
  if (Array.isArray(body.results)) {
    out.results = (body.results as Array<TeamDelivery & Record<string, unknown>>).map((entry) => {
      const entryFloor = typeof entry.floor === 'string' && entry.floor ? entry.floor : bodyFloor;
      if (entry.worker && typeof entry.worker === 'object' && typeof entry.worker.id === 'string' && entry.worker.id.trim()) {
        const enrichedWorker = withMemberDeepLink(entry.worker as TeamMember & { floor?: string }, entryFloor, normalizedBase);
        return { ...entry, worker: enrichedWorker, deepLink: enrichedWorker.deepLink };
      }
      if (!entry.error && typeof entry.id === 'string' && entry.id.trim()) {
        return { ...entry, deepLink: workerDeepLink(entry.id, entryFloor, normalizedBase) };
      }
      return entry;
    });
  }
  if (Array.isArray(body.watching)) {
    out.watching = (body.watching as Array<unknown>).map((entry) => {
      if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' && (entry as { id: string }).id.trim()) {
        return withMemberDeepLink(entry as TeamMember & { floor?: string }, bodyFloor, normalizedBase);
      }
      return entry;
    });
  }
  return out;
}

export function enrichWhiteboardRead(out: ReadOut, base?: string) {
  const floorId = typeof out.floor?.id === 'string' ? out.floor.id.trim() : '';
  return {
    ...out,
    ...(floorId ? { floorDeepLink: floorDeepLink(floorId, base) } : {}),
    cards: out.cards.map((card) => ({
      ...card,
      ...(typeof card.id === 'string' && card.id.trim() ? { deepLink: cardDeepLink(card.id, floorId || undefined, base) } : {}),
    })),
  };
}

export { cardDeepLink, floorDeepLink, questionDeepLink, workerDeepLink };
