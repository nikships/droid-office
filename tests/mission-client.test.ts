import test from 'node:test';
import assert from 'node:assert/strict';
import { ORCHESTRATOR_ID, type MissionAgent, type MissionControlState } from '../src/shared/mission-control.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { botLine, isMissionId, missionLead, missionWaiting, missionWorker, ORCHESTRATOR_EXAMPLES, orchestratorLine, orchestratorMessage, orchestratorStarted, orchestratorWorker } from '../src/client/mission.js';

const worker = (over: Partial<WorkerInfo>): WorkerInfo =>
  ({ id: ORCHESTRATOR_ID, kind: 'agent', name: 'Orchestrator', color: '#ee6018', deskId: '', status: 'idle', acked: true, createdBy: '', createdAt: 0, cols: 120, rows: 40, open: true, ...over }) as WorkerInfo;
const bot: MissionAgent = {
  worker: worker({ id: 'bot-claw', name: 'OpenClaw', remote: true, status: 'working', activity: 'Reading the inbox' }),
  team: [{ id: 'w-1', name: 'Byte', floor: 'f-web', floorName: 'web-app', status: 'working' }],
  lastUsedAt: 1,
};
const state = (over: Partial<MissionControlState['orchestrator']> = {}, bots: MissionAgent[] = []): MissionControlState => ({ orchestrator: { settings: { on: true }, ...over }, bots });

test('before its first prompt the Orchestrator is an idle stand-in with no session, on its chosen model', () => {
  const s = state({ settings: { on: true, model: 'custom:opus', effort: 'high' } });
  const w = orchestratorWorker(s);
  assert.equal(w?.id, ORCHESTRATOR_ID);
  assert.equal(w?.status, 'idle');
  assert.equal(w?.sessionId, undefined);
  assert.equal(w?.model, 'custom:opus');
  assert.equal(w?.effort, 'high');
  assert.equal(orchestratorStarted(s), false);
  assert.equal(orchestratorLine(s), 'Ready for a task anywhere in the building');
  assert.equal(orchestratorWorker(state({ settings: { on: false } })), undefined, 'off, it is nowhere');
  assert.equal(orchestratorWorker(undefined), undefined, 'an office without Mission Control has none');
});

test('once it has a session, its worker is the session’s and says what it is doing', () => {
  const agent = { worker: worker({ sessionId: 's-1', status: 'working', task: { name: 'Get CI green' } as WorkerInfo['task'] }), team: [] };
  const s = state({ agent });
  assert.equal(orchestratorWorker(s), agent.worker);
  assert.equal(orchestratorStarted(s), true);
  assert.equal(orchestratorLine(s), 'Get CI green');
  assert.equal(orchestratorLine(state({ agent, blocked: 'Droid is signed out' })), 'Droid is signed out', 'why it can’t start comes first');
  assert.match(orchestratorLine(state({ settings: { on: false }, agent })), /^Off\./);
});

test('building agents are found by id, the Orchestrator while off included', () => {
  const s = state({}, [bot]);
  assert.equal(missionWorker(s, ORCHESTRATOR_ID)?.id, ORCHESTRATOR_ID);
  assert.equal(missionWorker(s, 'bot-claw'), bot.worker);
  assert.equal(missionWorker(s, 'w-1'), undefined, 'a subagent is a floor’s worker');
  assert.equal(isMissionId(state({ settings: { on: false } }), ORCHESTRATOR_ID), true);
  assert.equal(isMissionId(s, 'bot-claw'), true);
  assert.equal(isMissionId(s, 'w-1'), false);
  assert.equal(isMissionId(undefined, ORCHESTRATOR_ID), false);
  assert.equal(missionLead(s, 'bot-claw'), bot);
  assert.equal(missionLead(s, undefined), undefined);
  assert.equal(missionLead(state({ settings: { on: false }, agent: { worker: worker({}), team: [] } }), ORCHESTRATOR_ID), undefined, 'its team reports to nobody while it is off');
});

test('only the Orchestrator waits on the owner: a question or an unread finished turn', () => {
  assert.equal(missionWaiting(state({ agent: { worker: worker({ status: 'needs_input' }), team: [] } })), 1);
  assert.equal(missionWaiting(state({ agent: { worker: worker({ status: 'done', acked: false }), team: [] } })), 1);
  assert.equal(missionWaiting(state({ agent: { worker: worker({ status: 'done', acked: true }), team: [] } })), 0);
  assert.equal(missionWaiting(state({ settings: { on: false }, agent: { worker: worker({ status: 'needs_input' }), team: [] } })), 0);
  assert.equal(missionWaiting(state({}, [{ ...bot, worker: { ...bot.worker, status: 'needs_input' } }])), 0, 'external bots never do');
});

test('a prompt and Stop are the Orchestrator’s own messages; everything else stays a worker message', () => {
  assert.deepEqual(orchestratorMessage({ t: 'worker.prompt', workerId: ORCHESTRATOR_ID, prompt: 'Go' }), { t: 'orchestrator.prompt', prompt: 'Go' });
  assert.deepEqual(orchestratorMessage({ t: 'worker.prompt', workerId: ORCHESTRATOR_ID, prompt: 'Later', queue: true, images: ['a.png'] }), { t: 'orchestrator.prompt', prompt: 'Later', images: ['a.png'], queue: true });
  assert.deepEqual(orchestratorMessage({ t: 'worker.interrupt', workerId: ORCHESTRATOR_ID }), { t: 'orchestrator.interrupt' });
  const read = { t: 'thread.read', workerId: ORCHESTRATOR_ID, request: 'r' } as const;
  assert.equal(orchestratorMessage(read as never), read);
});

test('a bot says what it last reported, or that it hasn’t since the office started', () => {
  assert.equal(botLine(bot), 'Reading the inbox');
  assert.equal(botLine({ ...bot, worker: { ...bot.worker, status: 'offline' } }), 'Hasn’t reported since the office started');
  assert.equal(ORCHESTRATOR_EXAMPLES.length, 3);
});
