import assert from 'node:assert/strict';
import test from 'node:test';
import type { TeamBadge, WorkerInfo, WorkerStatus } from '../src/shared/protocol.js';
import { TEAM_ACCENTS, TEAM_EMBLEMS, TEAM_MARK, leadBadge, memberBadge, pickTeamLook, settleTeams, teamLinks, teamStanding } from '../src/shared/team.js';
import { GLASS_ROOM } from '../src/shared/layout.js';
import { LINK_LIFT, TeamLines, linkBlocked } from '../src/client/world/team-lines.js';

let made = 0;
const worker = (id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id,
  kind: 'agent',
  deskId: `desk-${++made}`,
  name: id[0].toUpperCase() + id.slice(1),
  color: '#ff8a5b',
  status: 'done',
  acked: true,
  createdBy: 'test',
  createdAt: made,
  cols: 100,
  rows: 30,
  open: false,
  ...extra,
});
const badge = (id: string, i: number, role: TeamBadge['role'] = 'lead'): TeamBadge => ({ id, role, accent: TEAM_ACCENTS[i], emblem: TEAM_EMBLEMS[i], leadName: id[0].toUpperCase() + id.slice(1) });

test('a new team takes an accent and an emblem nobody on the floor wears, and a pair nobody wears once those run out', () => {
  assert.deepEqual(pickTeamLook([]), { accent: TEAM_ACCENTS[0], emblem: TEAM_EMBLEMS[0] });
  assert.deepEqual(pickTeamLook([badge('a', 0), badge('b', 2)]), { accent: TEAM_ACCENTS[1], emblem: TEAM_EMBLEMS[1] });
  // Every accent worn: a free emblem, so no two teams share a pair.
  const worn = TEAM_ACCENTS.map((accent, i) => ({ accent, emblem: TEAM_EMBLEMS[i] }));
  const next = pickTeamLook(worn);
  assert.ok(!worn.some((w) => w.accent === next.accent && w.emblem === next.emblem));
  // All 64 pairs worn: the first, rather than nothing.
  const every = TEAM_ACCENTS.flatMap((accent) => TEAM_EMBLEMS.map((emblem) => ({ accent, emblem })));
  assert.deepEqual(pickTeamLook(every), { accent: TEAM_ACCENTS[0], emblem: TEAM_EMBLEMS[0] });
  for (const e of TEAM_EMBLEMS) assert.ok(TEAM_MARK[e], `${e} has a mark`);
  assert.equal(new Set(TEAM_ACCENTS).size, TEAM_ACCENTS.length);
});

test('a lead keeps the team it formed; a subagent whose lead left starts its own team when it hires', () => {
  const ada = worker('ada', { team: badge('ada', 0) });
  assert.equal(leadBadge(ada, [ada]), ada.team);
  const orphan = worker('orphan', { team: badge('ada', 0, 'member') });
  const mate = worker('mate', { team: badge('ada', 0, 'member') });
  const own = leadBadge(orphan, [orphan, mate]);
  assert.deepEqual(own, { id: 'orphan', role: 'lead', accent: TEAM_ACCENTS[1], emblem: TEAM_EMBLEMS[1], leadName: 'Orphan' });
  assert.deepEqual(memberBadge(own), { ...own, role: 'member' });
});

test('settling saved teams keeps what holds, gives an old office’s teams markings, and never invents history', () => {
  const ada = worker('ada');
  const one = worker('one', { lead: 'ada' });
  const bo = worker('bo', { team: badge('bo', 0) });
  const two = worker('two', { lead: 'bo', team: badge('bo', 0, 'member') });
  const lone = worker('lone');
  const left = worker('left', { team: badge('gone', 3, 'member') });
  const stale = worker('stale', { team: badge('bo', 0, 'member') });
  const forged = worker('forged', { team: badge('someone', 4) });
  const out = settleTeams([ada, one, bo, two, lone, left, stale, forged]);
  assert.deepEqual(out.get('bo'), bo.team, 'a kept team keeps its look');
  assert.deepEqual(out.get('two'), two.team);
  const formed = out.get('ada')!;
  assert.equal(formed.role, 'lead');
  assert.equal(formed.id, 'ada');
  assert.notEqual(`${formed.accent}|${formed.emblem}`, `${bo.team!.accent}|${bo.team!.emblem}`);
  assert.notEqual(`${formed.accent}|${formed.emblem}`, `${left.team!.accent}|${left.team!.emblem}`, "a departed lead's team, still worn, keeps its look to itself");
  assert.deepEqual(out.get('one'), memberBadge(formed));
  assert.equal(out.get('lone'), undefined, 'a worker who never led or joined wears nothing');
  assert.deepEqual(out.get('left'), left.team, 'a subagent whose lead left keeps whose team it was');
  assert.equal(out.get('stale'), undefined, 'markings naming a lead on the floor that is not its lead are dropped');
  assert.equal(out.get('forged'), undefined, "a lead's markings under someone else's id are dropped");
  // Settling again changes nothing.
  const again = settleTeams([ada, one, bo, two, lone, left, stale, forged].map((w) => ({ ...w, team: out.get(w.id) })));
  for (const [id, b] of out) assert.deepEqual(again.get(id), b, id);
});

test('what the markings say close up: lead, follower, or a team whose lead has left', () => {
  const ada = worker('ada', { team: badge('ada', 0) });
  const one = worker('one', { lead: 'ada', team: memberBadge(ada.team!) });
  const orphan = worker('orphan', { team: memberBadge(ada.team!) });
  const all = new Map([ada, one].map((w) => [w.id, w]));
  const get = (id: string) => all.get(id);
  assert.equal(teamStanding(ada, get)?.label, 'Team lead');
  assert.equal(teamStanding(one, get)?.label, "Ada's team · Follower");
  assert.equal(teamStanding(one, get)?.leadHere, true);
  assert.equal(teamStanding(orphan, () => undefined)?.label, "Ada's team · Lead has left");
  assert.equal(teamStanding(worker('solo'), get), undefined);
});

test('links stay up whatever the team is doing, and only a working subagent’s link marches', () => {
  const ada = worker('ada', { team: badge('ada', 0), status: 'done' });
  const statuses: WorkerStatus[] = ['done', 'offline', 'needs_input', 'working', 'exited'];
  const subs = statuses.map((status, i) => worker(`s${i}`, { lead: 'ada', status, team: memberBadge(ada.team!) }));
  const orphan = worker('orphan', { team: memberBadge(ada.team!) });
  const links = teamLinks([ada, ...subs, orphan]);
  assert.equal(links.length, subs.length, 'one link per present subagent, none to a departed lead');
  assert.deepEqual(
    links.map((l) => l.moving),
    statuses.map((s) => s === 'working'),
  );
  for (const l of links) {
    assert.equal(l.accent, ada.team!.accent);
    assert.equal(l.team, 'ada');
  }
  assert.equal(teamLinks([orphan]).length, 0);
});

test('links are drawn over the floor coverings and never through the glass room or between storeys', () => {
  // The desk pods' rugs top out 14 mm up, the lounge rug's border at 10.5 mm.
  assert.ok(LINK_LIFT > 0.014);
  const desk = (x: number, z: number, y = 0) => ({ x, y, z });
  assert.equal(linkBlocked(desk(-10.5, -4), desk(-1.5, -4)), false);
  assert.equal(linkBlocked(desk(-1.5, 4.55), desk(-1.5, 3.45)), false);
  const inside = desk((GLASS_ROOM.minX + GLASS_ROOM.maxX) / 2, (GLASS_ROOM.minZ + GLASS_ROOM.maxZ) / 2);
  assert.equal(linkBlocked(desk(0, 0), inside), true, 'into the glass room');
  assert.equal(linkBlocked(inside, { ...inside, x: inside.x + 1 }), false, 'both inside');
  assert.equal(linkBlocked(desk(GLASS_ROOM.minX - 1, inside.z), desk(GLASS_ROOM.maxX + 1, inside.z)), true, 'across it');
  assert.equal(linkBlocked(desk(GLASS_ROOM.minX - 1, GLASS_ROOM.minZ - 1), desk(GLASS_ROOM.minX - 1, GLASS_ROOM.maxZ + 1)), false, 'beside it');
  assert.equal(linkBlocked(desk(0, 0), desk(1, 0, 3)), true, 'up to the loft');
  // With no links nothing animates.
  const lines = new TeamLines();
  lines.set([]);
  assert.equal(lines.moving, false);
  assert.equal(lines.group.children.length, 0);
});
