import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { teamCounts, workerTeams } from '../src/client/dashboard-teams.js';

// Names and relationships from the owner's companion screenshot.
const workers = ['Pixel', 'Nibble', 'Dot', 'Widget', 'Cosmo', 'Sprocket', 'Gizmo', 'Bolt'].map((name, index) => ({
  id: name.toLowerCase(),
  name,
  createdAt: index,
  lead: index ? 'pixel' : undefined,
  status: 'working' as WorkerInfo['status'],
  acked: false,
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

test('team counts include startup and unacknowledged completion, not acknowledged or sleeping workers', () => {
  const input = ['working', 'starting', 'needs_input', 'done', 'done', 'offline', 'exited', 'idle'].map((status, i) => ({ ...workers[i], status: status as WorkerInfo['status'], acked: i === 4 }));
  assert.deepEqual(teamCounts(input), { working: 2, attention: 2 });
  assert.deepEqual(teamCounts([]), { working: 0, attention: 0 });
});
