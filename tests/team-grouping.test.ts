import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { teamCounts, teamOf, teamSummary, workersByTeam, workerTeams, teamLinks } from '../src/shared/team.js';

const workers = ['Pixel', 'Nibble', 'Dot', 'Widget', 'Cosmo', 'Sprocket', 'Gizmo', 'Bolt'].map((name, index) => ({
  id: name.toLowerCase(),
  name,
  createdAt: index,
  lead: index ? 'pixel' : undefined,
  status: 'working' as WorkerInfo['status'],
  acked: false,
  kind: 'agent' as const,
  color: '#fff',
  deskId: `desk-${index}`,
  createdBy: 'test',
  cols: 80,
  rows: 24,
  open: false,
}));

test('teams use hiring relationships and remain stable across statuses and input order', () => {
  const result = workerTeams([...workers].reverse());
  assert.equal(result.length, 1);
  assert.equal(result[0].lead.id, 'pixel');
  assert.deepEqual(
    result[0].children.map((w) => w.id),
    workers.slice(1).map((w) => w.id),
  );
  assert.deepEqual(
    workerTeams(workers.map((w) => ({ ...w, status: 'needs_input' as const }))).map((t) => [t.lead.id, t.children.map((w) => w.id)]),
    result.map((t) => [t.lead.id, t.children.map((w) => w.id)]),
  );
});

test('missing leads, self-links, cycles and unsupported nested links never hide or duplicate workers', () => {
  for (const links of [{ pixel: 'missing' }, { pixel: 'pixel' }, { pixel: 'nibble', nibble: 'pixel' }, { dot: 'nibble' }]) {
    const input = workers.map((w) => ({ ...w, lead: (links as Record<string, string>)[w.id] ?? w.lead }));
    const shown = workerTeams(input).flatMap((t) => [t.lead, ...t.children]);
    assert.deepEqual(shown.map((w) => w.id).sort(), workers.map((w) => w.id).sort());
    assert.deepEqual(workersByTeam(input), shown);
    for (const w of input) assert.deepEqual(teamOf(input, w.id), workerTeams(input).find((t) => t.lead.id === w.id)?.children ?? []);
    assert.deepEqual(
      teamLinks(input).map(({ lead, member }) => [lead.id, member.id]),
      workerTeams(input).flatMap(({ lead, children }) => children.map((member) => [lead.id, member.id])),
    );
  }
  assert.equal(workerTeams(workers.slice(1)).length, 7);
  assert.deepEqual(workerTeams([]), []);
});

test('equal creation times have deterministic ordering; badges and fork ancestry are not hiring', () => {
  const input = workers.map((w) => ({ ...w, lead: undefined, createdAt: 0, team: 'pixel', forkedFrom: 'pixel' }));
  assert.deepEqual(
    workerTeams(input).map((t) => t.lead.id),
    input.map((w) => w.id).sort(),
  );
  assert.ok(workerTeams(input).every((t) => !t.children.length));
});

test('team counts include startup and subagent questions, but not subagent completions', () => {
  const input = ['working', 'starting', 'needs_input', 'done', 'done', 'offline', 'exited', 'idle'].map((status, i) => ({ ...workers[i], status: status as WorkerInfo['status'], acked: i === 4 }));
  assert.deepEqual(teamCounts(input), { working: 2, attention: 1 });
  assert.deepEqual(teamCounts(input.map((w) => ({ ...w, lead: undefined }))), { working: 2, attention: 2 });
  assert.equal(teamSummary(input), '🧭 8 subagents · 2 working · 1 needs you');
  assert.equal(teamSummary(input.filter((w) => w.status === 'done')), '🧭 2 subagents');
  assert.equal(teamSummary(input.filter((w) => w.status === 'starting')), '🧭 1 subagent · 1 working');
  assert.deepEqual(teamCounts([]), { working: 0, attention: 0 });
  assert.equal(teamSummary([]), undefined);
});
