import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Answers } from '../src/server/answers.js';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import { Team, type TeamModel, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { buildWorkerInspection, factoryModelUsage, formatProviderQuotas, inspectTerminalRetry, summarizeFactoryQuotas, type ProviderQuotaSummary } from '../src/server/worker-status.js';
import { emptyFactoryState } from '../src/shared/factory.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';

const NOW = Date.parse('2026-11-14T05:45:39.724Z');
const STANDARD = 'gpt-6.1-sol';
const CORE = 'glm-5.3-flash';
const CUSTOM = 'custom:droidproxy:gpt-6.1-sol';

// DOFF-930's real-account /limits capture, with no account or key fields.
function capturedFactory() {
  const factory = emptyFactoryState();
  factory.connection = { connected: true, capabilities: [] };
  factory.limits = {
    usesTokenRateLimitsBilling: true,
    hasActiveSubscription: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 61, windowEnd: '2026-11-14T06:06:30.724Z', secondsRemaining: 1251 },
        weekly: { usedPercent: 86, windowEnd: '2026-11-14T19:35:51.947Z', secondsRemaining: 49812 },
        monthly: { usedPercent: 56, windowEnd: '2026-12-01T05:59:57.602Z', secondsRemaining: 1469657 },
      },
      core: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        weekly: { usedPercent: 20, windowEnd: '2026-11-17T03:30:49.318Z', secondsRemaining: 251109 },
        monthly: { usedPercent: 15, windowEnd: '2026-12-10T03:30:49.318Z', secondsRemaining: 2238309 },
      },
    },
    overagePreference: 'droidCore',
    canManageOverage: true,
    extraUsageBalanceCents: 0,
    extraUsageAllowed: true,
    fetchedAt: NOW,
    error: null,
  };
  return factory;
}

function worker(id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, name: id, kind: 'agent', deskId: 'desk-1', color: '#ee6018', status: 'working', acked: true, createdBy: 'test', createdAt: NOW, cols: 100, rows: 30, open: false, ...extra };
}

test('Factory summaries include both tiers without model picks, three windows and overage metadata', () => {
  const factory = capturedFactory();
  const quotas = summarizeFactoryQuotas(factory, [], NOW);
  assert.deepEqual(
    quotas.map((q) => q.name),
    ['Factory Standard', 'Factory Droid Core'],
  );
  assert.deepEqual(
    quotas[0].windows.map((w) => w.leftPercent),
    [39, 14, 44],
  );
  assert.deepEqual(
    quotas[1].windows.map((w) => w.leftPercent),
    [100, 80, 85],
  );
  assert.equal(quotas[1].windows[0].resetsAt, null);
  assert.equal(quotas[0].overagePreference, 'droidCore');
  assert.equal(quotas[0].extraUsageBalanceCents, 0);
  const text = formatProviderQuotas(quotas);
  assert.match(text, /5-hour 39% left.*Weekly 14% left.*Monthly 44% left/);
  assert.match(text, /Droid Core/);
  assert.match(text, /\$0\.00/);
  assert.equal(factoryModelUsage(factory, { id: CUSTOM, custom: true }, NOW), undefined);
});

test('worker quota and 402/retry inspection reports Factory resets and leaves custom models untouched', () => {
  const factory = capturedFactory();
  factory.limits.limits.standard!.fiveHour.usedPercent = 100;
  const inspection = buildWorkerInspection({ worker: worker('hosted', { model: STANDARD }), factory, now: NOW });
  assert.equal(inspection.modelStatus?.state, 'cooldown');
  assert.equal(inspection.modelStatus?.resetsAt, '2026-11-14T06:06:30.724Z');
  assert.ok(inspection.modelStatus?.resetsIn);
  assert.ok(inspection.modelStatus?.overageHint);
  assert.equal(inspection.modelStatus?.windows?.length, 3);
  const retry = ['Retrying the model request (attempt 2/5)...'];
  const core = buildWorkerInspection({ worker: worker('core', { model: CORE }), factory, runtime: { screenRows: retry }, now: NOW });
  assert.equal(core.modelStatus?.state, 'retrying');
  assert.equal(core.modelStatus?.providerName, 'Factory Droid Core');
  assert.match(core.modelStatus!.summary, /Monthly 85% left/);
  assert.equal(buildWorkerInspection({ worker: worker('custom', { model: CUSTOM }), factory, now: NOW }).modelStatus, undefined);
  assert.equal(inspectTerminalRetry(['402 Usage exhausted for this subscription'], 'idle')?.retrying, false);
  factory.limits.error = 'Limits could not be read';
  assert.notEqual(buildWorkerInspection({ worker: worker('hosted', { model: STANDARD }), factory, now: NOW }).modelStatus?.state, 'cooldown');
});

test('MCP Factory quotas, model discovery, hire gates and retry rechecks share the actual tool entry points', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-factory-limits-mcp-'));
  const factory = capturedFactory();
  factory.limits.limits.standard!.fiveHour.usedPercent = 100;
  const lead = worker('lead');
  const sub = worker('sub', { deskId: 'desk-2', lead: lead.id, model: STANDARD });
  const people = new Map([
    [lead.id, lead],
    [sub.id, sub],
  ]);
  let rechecks = 0;
  let hires = 0;
  const workers: TeamWorkers & OfficeMcpFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (token === 'test-token' ? people.get(id) : undefined),
    deskOccupied: (id) => [...people.values()].some((w) => w.deskId === id),
    officeDefault: { model: STANDARD },
    hire: () => {
      hires++;
      return worker('hired');
    },
    prompt: () => undefined,
    resume: () => undefined,
    kill: async () => ({}),
    tail: () => 'Retrying the model request (attempt 2/5)...',
    runtime: () => ({ screenRows: ['Retrying the model request (attempt 2/5)...'] }),
    setTask: () => {},
  };
  const settings = { ...SUBAGENT_DEFAULTS, wakeLead: false };
  const team = new Team(workers, {
    dataDir: dir,
    dir,
    git: false,
    settings: () => settings,
    toast: () => {},
    now: () => NOW,
    factory: () => factory,
    recheckFactoryLimits: async () => {
      rechecks++;
    },
    models: async () => ({
      defaultModel: STANDARD,
      models: [
        { id: STANDARD, displayName: 'GPT 6.1 Sol' },
        { id: CORE, displayName: 'GLM 5.3 Flash' },
        { id: CUSTOM, displayName: 'DroidProxy GPT 6.1 Sol', custom: true },
      ],
    }),
  });
  const visits = new Visits(workers, { settings: () => settings, toast: () => {}, emit: () => {} });
  const whiteboard = new WhiteboardStore(dir);
  const floor: OfficeMcpFloor = { id: 'test', name: 'test', dir, workers, team, visits, whiteboard };
  const mcp = createOfficeMcp({ hookUrl: 'http://127.0.0.1:0', answers: new Answers(), settings: () => settings, floor: () => floor });
  const server = createServer((req, res) => {
    void mcp.handle(req, res);
  });
  const client = new Client({ name: 'Factory limits test', version: '1' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    team.stop();
    visits.stop();
    whiteboard.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}${OFFICE_MCP_PATH}`), { requestInit: { headers: { authorization: 'Bearer test-token', [OFFICE_MCP_WORKER_HEADER]: lead.id } } }),
  );
  const quotas = await client.callTool({ name: 'team_models', arguments: { only: 'quotas' } });
  const quotaBody = quotas.structuredContent as { quotas: ProviderQuotaSummary[]; models: TeamModel[] };
  assert.equal(quotaBody.models.length, 0);
  assert.equal(quotaBody.quotas[0].state, 'cooldown');
  assert.equal(quotaBody.quotas[1].state, 'ok');
  assert.equal(rechecks, 1);
  const all = await client.callTool({ name: 'models_list', arguments: {} });
  const model = (all.structuredContent as { models: TeamModel[] }).models.find((m) => m.id === STANDARD)!;
  assert.ok(model.cannotRun);
  assert.ok(model.cooldown?.resetsIn);
  assert.equal(model.factoryUsage?.windows.length, 3);
  assert.match((all.content as { text: string }[]).map((c) => c.text).join('\n'), /Factory Standard:.*Monthly 44% left/);
  const blocked = await client.callTool({ name: 'team_hire', arguments: { title: 'Quota test', brief: 'No network work', model: STANDARD, worktree: false } });
  assert.equal(blocked.isError, true);
  assert.equal(hires, 0);
  assert.match((blocked.content as { text: string }[]).map((c) => c.text).join('\n'), /glm-5\.3-flash|custom:droidproxy/);
  const status = await client.callTool({ name: 'team_status', arguments: {} });
  assert.match(JSON.stringify(status.structuredContent), /"modelStatus":\{"state":"cooldown"/);
  const log = await client.callTool({ name: 'worker_log', arguments: { worker: 'sub', tail: 0 } });
  assert.match(JSON.stringify(log.structuredContent), /2026-11-14T06:06:30.724Z/);
  factory.connection.connected = false;
  assert.equal(await team.refuseSpawnModel(lead, STANDARD), undefined);
  factory.connection.connected = true;
  factory.limits.hasActiveSubscription = false;
  assert.match((await team.refuseSpawnModel(lead, STANDARD))!, /subscription/i);
  assert.equal(await team.refuseSpawnModel(lead, CUSTOM), undefined);
});
