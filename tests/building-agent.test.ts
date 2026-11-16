import assert from 'node:assert/strict';
import test from 'node:test';
import { missionTeam } from '../src/server/building-agent.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const worker = (extra: Partial<WorkerInfo>): WorkerInfo =>
  ({ id: 'w1', kind: 'agent', deskId: 'd1', name: 'Nova', color: '#fff', status: 'working', acked: true, createdBy: 'me', createdAt: 1, cols: 80, rows: 24, open: false, lead: 'orchestrator', ...extra }) as WorkerInfo;

const floorOf = (...workers: WorkerInfo[]) => [{ id: 'home', def: { name: 'Home' }, workers: { list: () => workers } }];

test('a subagent in Mission Control shows its generated summary, not its last tool call', () => {
  const [member] = missionTeam(floorOf(worker({ activity: 'Bash: npm test', task: { name: 'Fix CI', summary: 'Repairing the flaky login test', generated: true } })), 'orchestrator');
  assert.equal(member.title, 'Fix CI');
  assert.equal(member.activity, 'Repairing the flaky login test');
});

test('a subagent with no generated summary keeps its latest activity, and a question wins over the summary', () => {
  const task = { name: 'Fix CI', summary: 'Repairing the flaky login test', generated: true };
  assert.equal(missionTeam(floorOf(worker({ activity: 'Reading logs' })), 'orchestrator')[0].activity, 'Reading logs');
  assert.equal(missionTeam(floorOf(worker({ status: 'needs_input', activity: 'Which branch?', task })), 'orchestrator')[0].activity, 'Which branch?');
});
