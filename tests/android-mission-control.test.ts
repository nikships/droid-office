import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ORCHESTRATOR_COLOR, ORCHESTRATOR_ID, ORCHESTRATOR_NAME, type MissionAgent, type MissionControlState } from '../src/shared/mission-control.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { botLine, ORCHESTRATOR_EXAMPLES, ORCHESTRATOR_MODEL_CHANGE, ORCHESTRATOR_PITCH, orchestratorLine } from '../src/client/mission.js';

const kotlin = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/core/MissionControl.kt', import.meta.url), 'utf8');

/** The string a top-level or member `const val NAME = "..."` holds in MissionControl.kt. */
function constant(name: string): string {
  const match = new RegExp(`const val ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(kotlin);
  assert.ok(match, `MissionControl.kt has no const val ${name}`);
  return match[1];
}

const state = (patch: Partial<MissionControlState['orchestrator']>): MissionControlState => ({ orchestrator: { settings: { on: true }, ...patch }, bots: [] });

const worker = (patch: Partial<WorkerInfo>): WorkerInfo =>
  ({ id: 'bot', kind: 'agent', name: 'Bot', color: '#888888', deskId: '', status: 'offline', acked: true, createdBy: '', createdAt: 0, cols: 80, rows: 24, open: false, ...patch }) as WorkerInfo;

test("the phone's Orchestrator identity is the office's", () => {
  assert.equal(constant('ORCHESTRATOR_COLOR'), ORCHESTRATOR_COLOR);
  assert.equal(constant('ORCHESTRATOR_ID'), ORCHESTRATOR_ID);
  assert.equal(constant('ORCHESTRATOR_NAME'), ORCHESTRATOR_NAME);
});

test("the phone says what the Orchestrator is for in the web companion's words", () => {
  assert.equal(constant('PITCH'), ORCHESTRATOR_PITCH);
  const examples = [...(/val examples = listOf\(([^)]*)\)/.exec(kotlin)?.[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  assert.deepEqual(examples, [...ORCHESTRATOR_EXAMPLES]);
});

test("the phone says when a new Orchestrator model takes over in the office's words", () => {
  assert.equal(constant('MODEL_CHANGE'), ORCHESTRATOR_MODEL_CHANGE);
});

test("the phone's Orchestrator and bot lines are the web companion's", () => {
  assert.equal(constant('READY'), orchestratorLine(state({})));
  assert.ok(kotlin.includes(`"${orchestratorLine({ orchestrator: { settings: { on: false } }, bots: [] })}"`), 'the off line differs from orchestratorLine');
  const bot: MissionAgent = { worker: worker({}), team: [] };
  assert.ok(kotlin.includes(`"${botLine(bot)}"`), 'the offline bot line differs from botLine');
});
