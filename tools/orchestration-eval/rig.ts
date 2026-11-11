import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Answers } from '../../src/server/answers.js';
import type { DroidModelCatalogue } from '../../src/server/droid-models.js';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpDeps, type OfficeMcpFloor } from '../../src/server/office-mcp/index.js';
import type { OwnerFloor, OwnerOffice, OwnerReply } from '../../src/server/office-mcp/owner.js';
import { remoteMcpListener } from '../../src/server/remote-mcp-http.js';
import { RemoteOffice, type RemoteFloor } from '../../src/server/remote-office.js';
import { RemoteWorkers } from '../../src/server/remote-workers.js';
import { officePrompt } from '../../src/server/prompts.js';
import { Team, type TeamReply, type TeamWorkers } from '../../src/server/team.js';
import { Visits } from '../../src/server/visits.js';
import { WhiteboardStore } from '../../src/server/whiteboard.js';
import { readMenu } from '../../src/shared/asks.js';
import { DESKS } from '../../src/shared/layout.js';
import { ORCHESTRATOR_ID, type MissionAgent } from '../../src/shared/mission-control.js';
import { WORKER_VISITS, workerBranchPolicy } from '../../src/shared/prompts.js';
import { SUBAGENT_DEFAULTS, type SubagentSettings, type WorkerInfo } from '../../src/shared/protocol.js';
import type { ModelAvailability, ModelUsage } from '../../src/shared/subscriptions.js';

export type EvalRole = 'orchestrator' | 'external-bot' | 'floor-lead' | 'subagent';

export interface SeedWorker {
  id: string;
  name: string;
  floor: string;
  kind?: WorkerInfo['kind'];
  deskId?: string;
  status?: WorkerInfo['status'];
  lead?: 'caller' | string;
  model?: string;
  effort?: WorkerInfo['effort'];
  task?: { name: string; summary?: string };
  activity?: string;
  worktree?: { path: string; branch: string; base: string; from?: string };
  pr?: { number: number; url: string };
  ask?: WorkerInfo['ask'];
  waitingSince?: number;
  screenLines?: string[];
  tail?: string;
  diff?: { stat: string; diff: string; truncated?: boolean };
  /** Seeded report/question already delivered into Team before the turn starts. */
  report?: { text: string; question?: boolean; options?: string[]; progress?: boolean; pushedSha?: string; prUrl?: string; seen?: boolean };
  /** Also enqueue in external bot's office_inbox when role === 'external-bot'. */
  inboxText?: string;
}

export interface SeedFloor {
  id: string;
  name: string;
  dir: string;
  git?: boolean;
  shellTail?: string;
}

export interface ShellMock {
  match: RegExp;
  output: string | ((cmd: string, state: EvalWorldState) => { output: string; exitCode?: number });
  exitCode?: number;
}

export interface EvalWorldConfig {
  role: EvalRole;
  floors: SeedFloor[];
  callerFloor?: string;
  workers?: SeedWorker[];
  missionExtra?: { id: string; name: string; status?: WorkerInfo['status']; activity?: string }[];
  settings?: Partial<SubagentSettings>;
  catalogue?: DroidModelCatalogue;
  availability?: Record<string, ModelAvailability>;
  usage?: Record<string, ModelUsage>;
  files?: Record<string, string>;
  shellMocks?: ShellMock[];
  initialDirtyFiles?: string[];
}

export interface RecordedCall {
  step: number;
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  resultText: string;
  structured?: Record<string, unknown>;
}

export interface EvalWorldState {
  dirtyFiles: Set<string>;
  stagedFiles: Set<string>;
  commits: string[];
  mergedBranches: string[];
  shellCommands: string[];
  hiredWorkers: { id: string; floor: string; title?: string; brief: string; model?: string; effort?: string; worktree: boolean; from?: string; branch?: string }[];
  messagedWorkers: { id: string; text: string; via: string; step: number }[];
  answeredQuestions: { questionId: string; worker: string; optionId?: string; optionIds?: string[]; text?: string }[];
  dismissedWorkers: string[];
  ackedInboxIds: string[];
}

export interface OpenAiToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ContextBreakdown {
  role: EvalRole;
  toolCount: number;
  systemPromptChars: number;
  mcpInstructionsChars: number;
  toolDescriptionsChars: number;
  toolSchemasChars: number;
  totalChars: number;
  estimatedTokens: number;
}

/** Deterministic token estimate (~3.85 chars/token on mixed English + JSON schema) for offline comparison. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.85);
}

const proxyFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  return new Promise((resolve, reject) => {
    const outgoing = request(req.url, { method: req.method, headers: Object.fromEntries(req.headers), signal: req.signal }, (incoming) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const status = incoming.statusCode ?? 500;
      resolve(new Response([204, 205, 304].includes(status) ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, headers }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
};

function stripSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...schema };
  delete copy.$schema;
  return copy;
}

const DEFAULT_CATALOGUE: DroidModelCatalogue = {
  defaultModel: 'claude-sonnet-5-5',
  models: [
    {
      id: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
      provider: 'anthropic',
      tokenMultiplier: 2.0,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
    },
    {
      id: 'claude-sonnet-5-5',
      displayName: 'Claude Sonnet 5.5',
      provider: 'anthropic',
      tokenMultiplier: 1.0,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    },
    {
      id: 'custom:droidproxy:gpt-6.1-sol',
      displayName: 'DroidProxy: GPT 6.1 Sol',
      provider: 'openai',
      custom: true,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'custom:droidproxy:gpt-6.1-terra',
      displayName: 'DroidProxy: GPT 6.1 Terra',
      provider: 'openai',
      custom: true,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'glm-5.3-flash',
      displayName: 'GLM 5.3 Flash',
      provider: 'factory',
      tokenMultiplier: 0.06,
      noImages: true,
    },
    {
      id: 'custom:droidproxy:grok-4.7',
      displayName: 'DroidProxy: Grok 4.7',
      provider: 'xai',
      custom: true,
    },
  ],
};

export async function createEvalRig(config: EvalWorldConfig) {
  for (const worker of config.workers ?? []) if (!config.floors.some((f) => f.id === worker.floor)) throw new Error(`Unknown seed floor ${worker.floor}`);
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'office-eval-'));
  const now = Date.parse('2026-11-11T12:00:00Z');
  const settings: SubagentSettings = {
    ...SUBAGENT_DEFAULTS,
    wakeLead: true,
    worktree: true,
    visits: true,
    ...config.settings,
  };
  const catalogue = config.catalogue ?? DEFAULT_CATALOGUE;
  const availability: Record<string, ModelAvailability> = config.availability ?? {
    'claude-opus-5-5': { state: 'ok' },
    'claude-sonnet-5-5': { state: 'ok' },
    'custom:droidproxy:gpt-6.1-sol': { state: 'ok' },
    'custom:droidproxy:gpt-6.1-terra': { state: 'ok' },
    'glm-5.3-flash': { state: 'ok' },
    'custom:droidproxy:grok-4.7': { state: 'exhausted', until: now + 7_200_000, window: 'Weekly' },
  };
  const usage: Record<string, ModelUsage> = config.usage ?? {
    'custom:droidproxy:gpt-6.1-sol': {
      provider: 'codex',
      accounts: 2,
      windows: [
        { name: '5-hour', leftPercent: 95, resetsAt: now + 4 * 3_600_000 },
        { name: 'Weekly', leftPercent: 84, resetsAt: now + 5 * 86_400_000 },
      ],
      updatedAt: now - 60_000,
      at: now,
    },
    'custom:droidproxy:gpt-6.1-terra': {
      provider: 'codex',
      accounts: 1,
      windows: [{ name: 'Weekly', leftPercent: 3, resetsAt: now + 2 * 86_400_000 }],
      updatedAt: now - 60_000,
      at: now,
    },
  };

  const state: EvalWorldState = {
    dirtyFiles: new Set(config.initialDirtyFiles ?? []),
    stagedFiles: new Set(),
    commits: [],
    mergedBranches: [],
    shellCommands: [],
    hiredWorkers: [],
    messagedWorkers: [],
    answeredQuestions: [],
    dismissedWorkers: [],
    ackedInboxIds: [],
  };
  let currentStep = 0;
  let hireSeq = 0;

  const store = new RemoteWorkers(rootDir);
  const remoteBot = store.add('GrokBot');
  const orchestratorWorker: WorkerInfo = {
    id: ORCHESTRATOR_ID,
    name: 'Orchestrator',
    kind: 'agent',
    deskId: '',
    color: '#ff6b00',
    status: 'working',
    acked: true,
    createdBy: 'owner',
    createdAt: 1,
    cols: 120,
    rows: 40,
    open: false,
  };

  const callerFloorId = config.callerFloor ?? config.floors[0]?.id ?? 'droid-office';
  const callerId = config.role === 'orchestrator' ? ORCHESTRATOR_ID : config.role === 'external-bot' ? remoteBot.worker.id : config.role === 'floor-lead' ? 'lead-1' : 'sub-caller';

  const floorMaps = new Map<string, Map<string, WorkerInfo>>();
  const floorTails = new Map<string, Map<string, string>>();
  const floorScreens = new Map<string, Map<string, string[]>>();
  const floorDiffs = new Map<string, Map<string, { stat: string; diff: string; truncated?: boolean }>>();
  const remoteFloors: RemoteFloor[] = [];
  const localFloors = new Map<string, OfficeMcpFloor>();
  const cleanupFns: (() => void)[] = [];

  for (const [idx, f] of config.floors.entries()) {
    const dataDir = path.join(rootDir, `floor-${idx}-${f.id}`);
    mkdirSync(dataDir, { recursive: true });
    const people = new Map<string, WorkerInfo>();
    const tails = new Map<string, string>();
    const screens = new Map<string, string[]>();
    const diffs = new Map<string, { stat: string; diff: string; truncated?: boolean }>();
    floorMaps.set(f.id, people);
    floorTails.set(f.id, tails);
    floorScreens.set(f.id, screens);
    floorDiffs.set(f.id, diffs);

    if (f.id === callerFloorId && config.role === 'floor-lead') {
      people.set('lead-1', {
        id: 'lead-1',
        name: 'Nibble',
        kind: 'agent',
        deskId: DESKS[0].id,
        color: '#ff8800',
        status: 'working',
        acked: true,
        createdBy: 'owner',
        createdAt: 1,
        cols: 100,
        rows: 30,
        open: false,
        worktree: { path: '.droid-office/worktrees/nibble', branch: 'feat/webhooks-lead', base: '1111111111111111111111111111111111111111' },
      });
    }
    if (f.id === callerFloorId && config.role === 'subagent') {
      people.set('lead-1', {
        id: 'lead-1',
        name: 'Nibble',
        kind: 'agent',
        deskId: DESKS[0].id,
        color: '#ff8800',
        status: 'working',
        acked: true,
        createdBy: 'owner',
        createdAt: 1,
        cols: 100,
        rows: 30,
        open: false,
      });
      people.set('sub-caller', {
        id: 'sub-caller',
        name: 'Pixel',
        kind: 'agent',
        deskId: DESKS[1].id,
        lead: 'lead-1',
        color: '#00aaff',
        status: 'working',
        acked: true,
        createdBy: 'Nibble',
        createdAt: 2,
        cols: 100,
        rows: 30,
        open: false,
        worktree: { path: '.droid-office/worktrees/pixel', branch: 'office/pixel', base: '1111111111111111111111111111111111111111' },
      });
    }

    const resolvePerson = (id: string): WorkerInfo | undefined => {
      if (id === ORCHESTRATOR_ID) return orchestratorWorker;
      return people.get(id) ?? store.identity(id);
    };

    const names = ['Pixel', 'Byte', 'Nova', 'Gizmo', 'Sprocket', 'Widget'];
    const workers: TeamWorkers & OfficeMcpFloor['workers'] & RemoteFloor['workers'] = {
      list: () => [...people.values()],
      get: (id) => people.get(id),
      authenticate: (id, token) => (token === `tok-${id}` ? people.get(id) : undefined),
      buildingAgent: (id) => id === ORCHESTRATOR_ID || !!store.identity(id),
      releaseLead: (id) => {
        for (const w of people.values()) if (w.lead === id) delete w.lead;
      },
      officeDefault: { model: 'claude-sonnet-5-5', effort: 'high' },
      deskOccupied: (deskId) => [...people.values()].some((w) => w.deskId === deskId),
      hire: (deskId, by, prompt, worktree, choice, lead, from, branch) => {
        const num = ++hireSeq;
        const id = `hired-${num}`;
        const pickedName = names[(people.size + num) % names.length] ?? `Sub${num}`;
        const subBranch = branch ?? `office/${pickedName.toLowerCase()}-${num}`;
        const w: WorkerInfo = {
          id,
          name: `${pickedName}-${num}`,
          kind: 'agent',
          deskId,
          lead,
          color: '#44bbff',
          status: 'working',
          acked: true,
          createdBy: by,
          createdAt: 100 + num,
          cols: 100,
          rows: 30,
          open: false,
          model: choice.model ?? 'claude-sonnet-5-5',
          effort: choice.effort ?? 'high',
          ...(worktree
            ? {
                worktree: {
                  path: `.droid-office/worktrees/${id}`,
                  branch: subBranch,
                  base: '1111111111111111111111111111111111111111',
                  ...(from ? { from } : {}),
                },
              }
            : {}),
        };
        people.set(id, w);
        state.hiredWorkers.push({
          id,
          floor: f.id,
          brief: prompt,
          model: w.model,
          effort: w.effort,
          worktree,
          from,
          branch: w.worktree?.branch,
        });
        return w;
      },
      prompt: (id, text) => {
        if (store.identity(id)) return store.enqueue(id, text, f.id);
        state.messagedWorkers.push({ id, text, via: 'prompt', step: currentStep });
        return undefined;
      },
      resume: (id, text) => {
        if (text && store.identity(id)) return store.enqueue(id, text, f.id);
        if (text) state.messagedWorkers.push({ id, text, via: 'resume', step: currentStep });
        const w = people.get(id);
        if (w) w.status = 'working';
        return undefined;
      },
      kill: async (id) => {
        state.dismissedWorkers.push(id);
        people.delete(id);
        team.onWorkerGone(id);
        return { note: 'Kept its worktree' };
      },
      dismiss: async (id, pruneWorktree) => {
        state.dismissedWorkers.push(id);
        people.delete(id);
        team.onWorkerGone(id);
        return { note: pruneWorktree ? 'Removed its clean worktree' : 'Kept its worktree' };
      },
      tail: (id, lines) => {
        const raw = tails.get(id) ?? '';
        return raw.split('\n').slice(-lines).join('\n');
      },
      setTask: (id, task) => {
        const w = people.get(id);
        if (w) w.task = task;
        const rec = state.hiredWorkers.find((h) => h.id === id);
        if (rec) rec.title = task.name;
      },
      screenLines: (id) => screens.get(id),
      screenMenu: (id) => (screens.has(id) ? readMenu(screens.get(id)!) : undefined),
      write: (id, data) => {
        state.messagedWorkers.push({ id, text: data, via: 'terminal-write', step: currentStep });
        return true;
      },
    };

    const team = new Team(
      { ...workers, get: resolvePerson },
      {
        dataDir,
        dir: f.dir,
        git: f.git !== false,
        settings: () => settings,
        models: async () => catalogue,
        availability: (m) => availability[m],
        usage: (m) => usage[m],
        toast() {},
        now: () => now,
      },
    );

    const realHandle = team.handle.bind(team);
    team.handle = async (caller: WorkerInfo, body: Record<string, unknown>): Promise<TeamReply> => {
      if (body.action === 'diff') {
        const targetRef = typeof body.worker === 'string' ? body.worker.trim().toLowerCase() : '';
        const found = [...people.values()].find((w) => w.lead === caller.id && (w.id.toLowerCase() === targetRef || w.name.toLowerCase() === targetRef));
        if (!found) return { status: 404, body: { error: `No subagent called ${String(body.worker)} in your team.` } };
        if (typeof body.base === 'string' && (body.base.startsWith('-') || /\s/.test(body.base))) {
          return { status: 400, body: { error: 'Use a branch, tag or commit without spaces or a leading dash.' } };
        }
        const mocked = diffs.get(found.id) ?? { stat: ' 0 files changed', diff: '' };
        return {
          status: 200,
          body: {
            worker: found.id,
            base: found.worktree?.base ?? '1111111111111111111111111111111111111111',
            ...(body.commits !== undefined ? { commits: body.commits } : {}),
            stat: mocked.stat,
            diff: mocked.diff,
            truncated: !!mocked.truncated,
          },
        };
      }
      if (body.action === 'merge') {
        const targetRef = typeof body.worker === 'string' ? body.worker.trim().toLowerCase() : '';
        const found = [...people.values()].find((w) => w.lead === caller.id && (w.id.toLowerCase() === targetRef || w.name.toLowerCase() === targetRef));
        if (!found) return { status: 404, body: { error: `No subagent called ${String(body.worker)} in your team.` } };
        if (f.git === false) return { status: 400, body: { error: 'Integration requires a Git floor.' } };
        if (body.mode !== undefined && body.mode !== 'merge' && body.mode !== 'cherry-pick') return { status: 400, body: { error: 'mode takes merge or cherry-pick.' } };
        if (body.commits !== undefined && body.mode !== 'cherry-pick') return { status: 400, body: { error: 'commits requires mode: cherry-pick.' } };
        if ((caller.id === ORCHESTRATOR_ID || caller.remote) && (!body.target || typeof body.target !== 'string' || !body.target.trim())) {
          return { status: 400, body: { error: 'Building agents have no branch: name the target local branch to integrate into.' } };
        }
        const target = typeof body.target === 'string' && body.target.trim() ? body.target.trim() : 'main';
        const branch = found.worktree?.branch ?? 'HEAD';
        const simCmd = `git merge ${branch}`;
        const conflictMock = (config.shellMocks ?? []).find((m) => m.match.test(simCmd) && (m.exitCode ?? 0) !== 0);
        if (conflictMock) {
          return {
            status: 409,
            body: {
              worker: found.id,
              status: 'blocked',
              summary: `Merge conflict integrating ${branch} into ${target}.`,
              conflicts: [{ path: 'src/shared/protocol.ts' }],
              remaining: [`Resolve conflicts in ${f.dir} or have ${found.name} rebase onto ${target}.`],
            },
          };
        }
        state.mergedBranches.push(branch);
        return {
          status: 200,
          body: {
            worker: found.id,
            status: 'ok',
            summary: `Landed ${branch} on ${target}.`,
            artifacts: { mergeCommit: 'a111111111111111111111111111111111111111' },
          },
        };
      }
      return realHandle(caller, body);
    };

    const visit = new Visits({ ...workers, get: resolvePerson, tell: workers.prompt, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {}, now: () => now });
    const whiteboard = new WhiteboardStore(dataDir);
    cleanupFns.push(() => {
      team.stop();
      visit.stop();
      whiteboard.stop();
    });

    const mcpFloor: OfficeMcpFloor = { id: f.id, name: f.name, dir: f.dir, workers, team, visits: visit, whiteboard };
    localFloors.set(f.id, mcpFloor);
    remoteFloors.push({ id: f.id, dir: f.dir, def: { name: f.name }, workers, team, visits: visit, whiteboard });
  }

  for (const [idx, sw] of (config.workers ?? []).entries()) {
    const people = floorMaps.get(sw.floor);
    if (!people) throw new Error(`Unknown seed floor ${sw.floor}`);
    const leadId = sw.lead === 'caller' ? callerId : sw.lead;
    const w: WorkerInfo = {
      id: sw.id,
      name: sw.name,
      kind: sw.kind ?? 'agent',
      deskId: sw.deskId ?? DESKS[(idx + 2) % DESKS.length].id,
      color: '#55cc88',
      status: sw.status ?? 'working',
      acked: true,
      createdBy: leadId ?? 'owner',
      createdAt: 10 + idx,
      cols: 100,
      rows: 30,
      open: false,
      ...(leadId ? { lead: leadId } : {}),
      ...(sw.model ? { model: sw.model, activeModel: sw.model } : {}),
      ...(sw.effort ? { effort: sw.effort, activeEffort: sw.effort } : {}),
      ...(sw.task ? { task: { ...sw.task, summary: sw.task.summary ?? '' } } : {}),
      ...(sw.activity ? { activity: sw.activity } : {}),
      ...(sw.worktree ? { worktree: sw.worktree } : {}),
      ...(sw.pr ? { pr: sw.pr } : {}),
      ...(sw.ask ? { ask: sw.ask } : {}),
      ...(sw.waitingSince !== undefined ? { waitingSince: sw.waitingSince } : {}),
    };
    people.set(w.id, w);
    if (sw.tail !== undefined) floorTails.get(sw.floor)!.set(w.id, sw.tail);
    if (sw.screenLines) floorScreens.get(sw.floor)!.set(w.id, sw.screenLines);
    if (sw.diff) floorDiffs.get(sw.floor)!.set(w.id, sw.diff);
    const floor = localFloors.get(sw.floor)!;
    (floor.team as Team).onWorker(w);
    if (sw.report) {
      await floor.team.handle(w, {
        action: 'report',
        text: sw.report.text,
        ...(sw.report.question ? { question: true } : {}),
        ...(sw.report.options ? { options: sw.report.options } : {}),
        ...(sw.report.progress ? { progress: true } : {}),
        ...(sw.report.pushedSha ? { pushedSha: sw.report.pushedSha } : {}),
        ...(sw.report.prUrl ? { prUrl: sw.report.prUrl } : {}),
      });
      if (sw.report.seen && leadId) {
        (floor.team as Team).markSeen(leadId, [1, 2, 3, 4, 5, 6, 7, 8]);
      }
    }
    if (sw.inboxText && config.role === 'external-bot') {
      store.enqueue(callerId, sw.inboxText, sw.floor);
    }
  }

  const remoteOffice = new RemoteOffice(store, () => remoteFloors);
  const realInbox = remoteOffice.inbox.bind(remoteOffice);
  remoteOffice.inbox = (id, ack = [], limit = 50, includeMessages = true) => {
    if (ack.length) state.ackedInboxIds.push(...ack);
    return realInbox(id, ack, limit, includeMessages);
  };

  const ownerFloors = (): OwnerFloor[] =>
    config.floors.map((f) => ({
      id: f.id,
      name: f.name,
      workers: [...(floorMaps.get(f.id)?.values() ?? [])],
    }));

  const missionAgents = (): MissionAgent[] => {
    const teamSummary = (lead: string) => config.floors.flatMap((f) => [...(floorMaps.get(f.id)?.values() ?? [])].filter((w) => w.lead === lead).map((w) => ({ id: w.id, name: w.name, floor: f.id, floorName: f.name, status: w.status })));
    const list: MissionAgent[] = [{ worker: orchestratorWorker, team: teamSummary(ORCHESTRATOR_ID) }];
    if (config.role === 'external-bot') {
      list.push({ worker: remoteBot.worker, team: teamSummary(remoteBot.worker.id) });
    }
    for (const extra of config.missionExtra ?? []) {
      list.push({
        worker: {
          id: extra.id,
          name: extra.name,
          kind: 'agent',
          deskId: '',
          remote: true,
          color: '#999',
          status: extra.status ?? 'idle',
          activity: extra.activity,
          acked: true,
          createdBy: 'owner',
          createdAt: 5,
          cols: 100,
          rows: 30,
          open: false,
        },
        team: [],
      });
    }
    return list;
  };

  const owner: OwnerOffice = {
    floors: ownerFloors,
    mission: missionAgents,
    tail: (workerId, lines, floorId) => {
      if (workerId === 'office-shell') {
        const sf = config.floors.find((f) => f.id === floorId);
        return sf?.shellTail ?? '$ git status\nnothing to commit, working tree clean';
      }
      for (const f of config.floors) {
        if (floorId && f.id !== floorId) continue;
        const t = floorTails.get(f.id)?.get(workerId);
        if (t !== undefined) return t.split('\n').slice(-lines).join('\n');
        if (floorMaps.get(f.id)?.has(workerId)) return '';
      }
      if (workerId === ORCHESTRATOR_ID) return 'Orchestrator active';
      return undefined;
    },
    act: async (_by, msg, opts): Promise<OwnerReply> => {
      if (msg.t === 'worker.prompt') {
        state.messagedWorkers.push({ id: String(msg.workerId), text: String(msg.prompt ?? ''), via: 'office_worker_prompt', step: currentStep });
        return { notes: [`Sent prompt to ${String(msg.workerId)}`] };
      }
      if (msg.t === 'worker.spawn') {
        const num = ++hireSeq;
        const id = `spawned-${num}`;
        const fId = opts?.floor ?? callerFloorId;
        state.hiredWorkers.push({
          id,
          floor: fId,
          brief: String(msg.prompt ?? ''),
          model: typeof msg.model === 'string' ? msg.model : undefined,
          effort: typeof msg.effort === 'string' ? msg.effort : undefined,
          worktree: msg.worktree !== false,
        });
        return { workerId: id, notes: [`Spawned ${id} on ${fId}`] };
      }
      if (msg.t === 'worker.kill') {
        state.dismissedWorkers.push(String(msg.workerId));
        return { notes: [`Sent ${String(msg.workerId)} home`] };
      }
      if (msg.t === 'worker.worktree') {
        return {
          notes: [],
          reply: { t: 'worker.worktree', workerId: String(msg.workerId), state: { exists: true, dirty: 0, ahead: 1, unpushed: 0 } },
        };
      }
      if (msg.t === 'thread.read') {
        return {
          notes: [],
          reply: { t: 'thread.snapshot', workerId: String(msg.workerId), entries: [], hasMore: false } as unknown as OwnerReply['reply'],
        };
      }
      return { notes: [] };
    },
  };

  const answers = new Answers();
  const findFloorForWorker = (workerId: string): OfficeMcpFloor | undefined => {
    for (const [fId, map] of floorMaps.entries()) {
      if (map.has(workerId)) return localFloors.get(fId);
    }
    return undefined;
  };

  let httpServer: ReturnType<typeof createServer>;
  const hostname = 'eval.office.ts.net';
  if (config.role === 'external-bot') {
    httpServer = remoteMcpListener({
      answers,
      owner,
      remote: remoteOffice,
      remoteTransport: { hostname: () => hostname, owner: () => undefined },
      settings: () => settings,
      floor: findFloorForWorker,
    });
  } else {
    const deps: OfficeMcpDeps = {
      answers,
      owner,
      remote: remoteOffice,
      orchestrator: {
        cwd: '/tmp/droid-office/orchestrator',
        authenticate: (id, token) => (id === ORCHESTRATOR_ID && token === 'tok-orchestrator' ? orchestratorWorker : undefined),
      },
      settings: () => settings,
      floor: findFloorForWorker,
    };
    const mcp = createOfficeMcp(deps);
    httpServer = createServer((req, res) => {
      if (req.url === OFFICE_MCP_PATH) void mcp.handle(req, res);
      else res.writeHead(404).end();
    });
  }

  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const url = new URL(OFFICE_MCP_PATH, origin);

  const client = new Client({ name: 'orchestration-eval', version: '1.0.0' });
  const headers: Record<string, string> =
    config.role === 'external-bot'
      ? { host: `${hostname}:8443`, Authorization: `Bearer ${remoteBot.token}`, [OFFICE_MCP_WORKER_HEADER]: remoteBot.worker.id }
      : { Authorization: `Bearer tok-${callerId}`, [OFFICE_MCP_WORKER_HEADER]: callerId };
  await client.connect(new StreamableHTTPClientTransport(url, { ...(config.role === 'external-bot' ? { fetch: proxyFetch } : {}), requestInit: { headers } }));

  const listed = (await client.listTools()).tools;
  const mcpInstructions = client.getInstructions() ?? '';

  const baseSystemPrompt =
    config.role === 'orchestrator'
      ? officePrompt(undefined, 'orchestrator.system', { name: 'Orchestrator', folder: '/tmp/droid-office/orchestrator' })
      : config.role === 'floor-lead'
        ? officePrompt(undefined, 'worker.system', {
            name: 'Nibble',
            visits: WORKER_VISITS,
            branchPolicy: workerBranchPolicy('main', '/work/droid-office/.droid-office/floor-branch.json'),
          })
        : config.role === 'subagent'
          ? [
              officePrompt(undefined, 'worker.system', {
                name: 'Pixel',
                visits: '',
                branchPolicy: workerBranchPolicy('main', '/work/droid-office/.droid-office/floor-branch.json'),
              }),
              officePrompt(undefined, 'subagent.brief', {
                name: 'Pixel',
                lead: 'Nibble',
                where: 'You work in your own git worktree on branch office/pixel.',
                text: 'Implement the assigned task and report back.',
                fence: '```',
                pullName: 'pull request',
                PullName: 'Pull request',
                pr: 'PR',
              }),
            ].join('\n\n')
          : 'You are an autonomous software engineering agent connected to the Droid Office MCP server.';

  const fullSystemPrompt = [baseSystemPrompt, mcpInstructions].filter(Boolean).join('\n\n');

  const mcpToolDefs: OpenAiToolDef[] = listed.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: stripSchemaMeta(t.inputSchema as Record<string, unknown>),
    },
  }));

  const hostToolDefs: OpenAiToolDef[] =
    config.role === 'external-bot'
      ? []
      : [
          {
            type: 'function',
            function: {
              name: 'shell',
              description: 'Simulated shell, not a real checkout: supports git status, git add <explicit files>, and staged git commit, joined with &&. Other commands are unsupported. Use worker_diff/worker_log for worker inspection.',
              parameters: {
                type: 'object',
                properties: { command: { type: 'string', description: 'Shell command to run.' } },
                required: ['command'],
                additionalProperties: false,
              },
            },
          },
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: `Read a scenario fixture by absolute path. Available files: ${Object.keys(config.files ?? {}).join(', ') || '(none)'}. Other paths return ENOENT; this is not a complete checkout.`,
              parameters: {
                type: 'object',
                properties: { path: { type: 'string', description: 'Absolute file path.' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
          },
        ];

  const allTools = [...mcpToolDefs, ...hostToolDefs];
  const calls: RecordedCall[] = [];
  const mcpToolNames = new Set(listed.map((t) => t.name));

  function contextBreakdown(): ContextBreakdown {
    const toolDescriptions = listed.map((t) => t.description ?? '').join('\n');
    const toolSchemas = JSON.stringify(listed);
    const total = `${baseSystemPrompt}\n${mcpInstructions}\n${toolSchemas}`;
    return {
      role: config.role,
      toolCount: listed.length,
      systemPromptChars: baseSystemPrompt.length,
      mcpInstructionsChars: mcpInstructions.length,
      toolDescriptionsChars: toolDescriptions.length,
      toolSchemasChars: toolSchemas.length,
      totalChars: total.length,
      estimatedTokens: estimateTokens(total),
    };
  }

  function runShell(command: string): { output: string; isError: boolean } {
    state.shellCommands.push(command);
    for (const mock of config.shellMocks ?? []) {
      if (mock.match.test(command)) {
        if (typeof mock.output === 'function') {
          const res = mock.output(command, state);
          return { output: res.output, isError: (res.exitCode ?? 0) !== 0 };
        }
        return { output: mock.output, isError: (mock.exitCode ?? 0) !== 0 };
      }
    }
    // Deliberately bounded simulation, not a POSIX shell. Unknown commands must never look successful.
    const outputs: string[] = [];
    for (const part of command.split(/\s+&&\s+/)) {
      if (/^cd\s+\/[^;&|]+$/.test(part)) continue;
      const git = /^git(?:\s+-C\s+\S+)?\s+(.*)$/.exec(part);
      const args = git?.[1] ?? '';
      if (/^status(?:\s|$)/.test(args)) {
        outputs.push(state.dirtyFiles.size ? [...state.dirtyFiles].map((f) => `${state.stagedFiles.has(f) ? 'M ' : ' M'} ${f}`).join('\n') : 'nothing to commit, working tree clean');
      } else if (/^add\s+/.test(args)) {
        const files = args
          .slice(4)
          .trim()
          .split(/\s+/)
          .filter((f) => f !== '--');
        if (files.some((f) => !state.dirtyFiles.has(f))) return { output: 'Simulation requires explicit dirty file paths for git add', isError: true };
        for (const file of files) state.stagedFiles.add(file);
      } else if (/^commit(?:\s|$)/.test(args)) {
        if (!state.stagedFiles.size) return { output: 'nothing staged to commit', isError: true };
        for (const file of state.stagedFiles) state.dirtyFiles.delete(file);
        state.stagedFiles.clear();
        state.commits.push(command);
        outputs.push('[feat/webhooks-lead 9e8d7c6] Committed staged prerequisites');
      } else {
        return { output: `Unsupported simulated shell command: ${part}`, isError: true };
      }
    }
    return { output: outputs.join('\n'), isError: false };
  }

  async function executeTool(step: number, name: string, rawArgs: Record<string, unknown>): Promise<string> {
    currentStep = step;
    if (name === 'shell') {
      if (!hostToolDefs.some((t) => t.function.name === name) || typeof rawArgs.command !== 'string') {
        const output = 'Shell tool unavailable or invalid command arguments';
        calls.push({ step, name, args: rawArgs, isError: true, resultText: output });
        return output;
      }
      const cmd = typeof rawArgs.command === 'string' ? rawArgs.command : '';
      const res = runShell(cmd);
      calls.push({ step, name, args: rawArgs, isError: res.isError, resultText: res.output });
      return res.output;
    }
    if (name === 'read_file') {
      if (!hostToolDefs.some((t) => t.function.name === name)) {
        const output = 'Read tool unavailable';
        calls.push({ step, name, args: rawArgs, isError: true, resultText: output });
        return output;
      }
      const p = typeof rawArgs.path === 'string' ? rawArgs.path : '';
      const content = config.files?.[p];
      const isError = content === undefined;
      const text = content ?? `ENOENT: no such file ${p}`;
      calls.push({ step, name, args: rawArgs, isError, resultText: text });
      return text;
    }
    if (!mcpToolNames.has(name)) {
      const msg = `Unknown tool: ${name}`;
      calls.push({ step, name, args: rawArgs, isError: true, resultText: msg });
      return msg;
    }
    const res = await client.callTool({ name, arguments: rawArgs });
    const text = (res.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    const structured = res.structuredContent as Record<string, unknown> | undefined;
    const isError = res.isError === true;
    if (!isError && name === 'question_answer' && structured?.answered) {
      state.answeredQuestions.push({
        questionId: String(rawArgs.questionId ?? ''),
        worker: String(structured.worker ?? ''),
        optionId: typeof rawArgs.optionId === 'string' ? rawArgs.optionId : undefined,
        optionIds: Array.isArray(rawArgs.optionIds) ? rawArgs.optionIds.map(String) : undefined,
        text: typeof rawArgs.text === 'string' ? rawArgs.text : undefined,
      });
    }
    calls.push({ step, name, args: rawArgs, isError, resultText: text, structured });
    return text;
  }

  async function close() {
    await client.close().catch(() => undefined);
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    for (const fn of cleanupFns) fn();
    rmSync(rootDir, { recursive: true, force: true });
  }

  return {
    callerId,
    fullSystemPrompt,
    baseSystemPrompt,
    mcpInstructions,
    listedTools: listed,
    allTools,
    state,
    calls,
    contextBreakdown,
    executeTool,
    close,
  };
}
