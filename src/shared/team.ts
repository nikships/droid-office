import type { TeamBadge, TeamEmblem, WorkerInfo } from './protocol.js';

/** A lead's subagents (see WorkerInfo.lead), oldest first. */
export function teamOf(workers: Iterable<WorkerInfo>, leadId: string): WorkerInfo[] {
  return [...workers].filter((w) => w.lead === leadId).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Every worker by when it was hired, each lead's subagents right under it, so a team reads as one
 * block. A subagent whose lead has gone stands on its own.
 */
export function workersByTeam(workers: Iterable<WorkerInfo>): WorkerInfo[] {
  const all = [...workers].sort((a, b) => a.createdAt - b.createdAt);
  const ids = new Set(all.map((w) => w.id));
  return all.filter((w) => !w.lead || !ids.has(w.lead)).flatMap((w) => [w, ...all.filter((s) => s.lead === w.id)]);
}

/** "🧭 3 subagents · 2 working · 1 needs input" for a lead's team; nothing for an empty one. */
export function teamSummary(team: readonly WorkerInfo[]): string | undefined {
  if (!team.length) return undefined;
  const busy = team.filter((s) => s.status === 'working').length;
  const waiting = team.filter((s) => s.status === 'needs_input').length;
  return [`🧭 ${team.length} subagent${team.length === 1 ? '' : 's'}`, busy && `${busy} working`, waiting && `${waiting} need${waiting === 1 ? 's' : ''} input`].filter(Boolean).join(' · ');
}

/**
 * The accent and emblem pairs teams wear, in the order new teams take them. A team's pair is unique
 * among the teams still on the floor; the emblems differ too, so color is never the only tell.
 */
export const TEAM_ACCENTS: readonly string[] = ['#2f7dff', '#ff3d7f', '#14c9a0', '#ffb81c', '#9b5cff', '#ff6a2b', '#18c0e8', '#9ccc2a'];
export const TEAM_EMBLEMS: readonly TeamEmblem[] = ['chevron', 'star', 'diamond', 'bolt', 'ring', 'cross', 'hex', 'triangle'];

/** Each emblem as a character, for the hint and the Workers panel. */
export const TEAM_MARK: Record<TeamEmblem, string> = { chevron: '⌃', star: '★', diamond: '◆', bolt: 'ϟ', ring: '◎', cross: '✚', hex: '⬢', triangle: '▲' };

type Look = Pick<TeamBadge, 'accent' | 'emblem'>;

/** Each team on the floor once, by id, as the first worker wearing it shows it. */
export function teamsWorn(workers: Iterable<WorkerInfo>): Map<string, TeamBadge> {
  const teams = new Map<string, TeamBadge>();
  for (const w of workers) if (w.team && !teams.has(w.team.id)) teams.set(w.team.id, w.team);
  return teams;
}

/**
 * The look a new team takes: an accent and an emblem no team on the floor wears, else a pair no team
 * wears. With every one of the 64 pairs taken, the first.
 */
export function pickTeamLook(worn: Iterable<Look>): Look {
  const list = [...worn];
  const accents = new Set(list.map((b) => b.accent));
  const emblems = new Set(list.map((b) => b.emblem));
  const pairs = new Set(list.map((b) => `${b.accent}|${b.emblem}`));
  for (let i = 0; i < TEAM_ACCENTS.length; i++) if (!accents.has(TEAM_ACCENTS[i]) && !emblems.has(TEAM_EMBLEMS[i % TEAM_EMBLEMS.length])) return { accent: TEAM_ACCENTS[i], emblem: TEAM_EMBLEMS[i % TEAM_EMBLEMS.length] };
  const freeAccents = TEAM_ACCENTS.filter((a) => !accents.has(a));
  const freeEmblems = TEAM_EMBLEMS.filter((e) => !emblems.has(e));
  for (const accent of freeAccents.length ? freeAccents : TEAM_ACCENTS) {
    for (const emblem of freeEmblems.length ? freeEmblems : TEAM_EMBLEMS) if (!pairs.has(`${accent}|${emblem}`)) return { accent, emblem };
  }
  for (const accent of TEAM_ACCENTS) for (const emblem of TEAM_EMBLEMS) if (!pairs.has(`${accent}|${emblem}`)) return { accent, emblem };
  return { accent: TEAM_ACCENTS[0], emblem: TEAM_EMBLEMS[0] };
}

/**
 * The badge `lead` wears once it hires: the team it already leads, else a new one under its own id.
 * A subagent whose lead left, hiring for itself, drops its old team's markings for its own team's.
 */
export function leadBadge(lead: WorkerInfo, workers: Iterable<WorkerInfo>): TeamBadge {
  if (lead.team?.role === 'lead' && lead.team.id === lead.id) return lead.team;
  const others = teamsWorn([...workers].filter((w) => w.id !== lead.id));
  return { id: lead.id, role: 'lead', ...pickTeamLook(others.values()), leadName: lead.name };
}

/** What a subagent of the team `lead` leads wears. */
export function memberBadge(lead: TeamBadge): TeamBadge {
  return { ...lead, role: 'member' };
}

/**
 * The badge every worker should wear, given who leads whom now (`lead`, already checked) and what
 * each wore before: kept where it still holds, a new team for a lead with subagents but none, its
 * lead's for each subagent. A lead's badge under another worker's id, or a subagent's badge naming a
 * lead that is on the floor but no longer its lead, is dropped rather than shown wrong. Nothing here
 * makes a worker anyone's subagent.
 */
export function settleTeams(workers: readonly WorkerInfo[]): Map<string, TeamBadge | undefined> {
  const all = [...workers].sort((a, b) => a.createdAt - b.createdAt);
  const byId = new Map(all.map((w) => [w.id, w]));
  const linked = (w: WorkerInfo) => !!w.lead && byId.has(w.lead);
  const out = new Map<string, TeamBadge | undefined>();
  for (const w of all) {
    const b = w.team;
    const wrong = !b || (b.role === 'lead' ? b.id !== w.id : linked(w) ? w.lead !== b.id : byId.has(b.id));
    out.set(w.id, wrong ? undefined : b);
  }
  const leads = new Set(all.filter(linked).map((w) => w.lead!));
  for (const id of leads) {
    if (out.get(id)?.role === 'lead') continue;
    const lead = byId.get(id)!;
    const worn = teamsWorn(all.filter((w) => w.id !== id).map((w) => ({ ...w, team: out.get(w.id) })));
    out.set(id, { id, role: 'lead', ...pickTeamLook(worn.values()), leadName: lead.name });
  }
  for (const w of all) if (linked(w)) out.set(w.id, memberBadge(out.get(w.lead!)!));
  return out;
}

/** What a worker's markings say about it, close up: "Team lead", "Ada's team · Follower" or "Ada's team · Lead has left". */
export function teamStanding(w: WorkerInfo, get: (id: string) => WorkerInfo | undefined): { badge: TeamBadge; leadHere: boolean; label: string } | undefined {
  const badge = w.team;
  if (!badge) return undefined;
  if (badge.role === 'lead') return { badge, leadHere: true, label: 'Team lead' };
  const leadHere = w.lead === badge.id && !!get(badge.id);
  return { badge, leadHere, label: `${badge.leadName}'s team · ${leadHere ? 'Follower' : 'Lead has left'}` };
}

/**
 * The links on the floor: one from each lead to each of its subagents on the floor, whatever either
 * is doing. `moving` is that subagent working, so one busy subagent doesn't animate anyone else's.
 */
export function teamLinks(workers: Iterable<WorkerInfo>): { lead: WorkerInfo; member: WorkerInfo; team: string; accent: string; moving: boolean }[] {
  const all = [...workers];
  const byId = new Map(all.map((w) => [w.id, w]));
  const links: { lead: WorkerInfo; member: WorkerInfo; team: string; accent: string; moving: boolean }[] = [];
  for (const member of all) {
    const lead = member.lead ? byId.get(member.lead) : undefined;
    if (!lead) continue;
    links.push({ lead, member, team: lead.team?.id ?? lead.id, accent: lead.team?.accent ?? lead.color, moving: member.status === 'working' });
  }
  return links;
}
