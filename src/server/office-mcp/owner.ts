import { z } from 'zod';
import { DESK_BY_ID } from '../../shared/layout.js';
import { ORCHESTRATOR_ID, type MissionAgent } from '../../shared/mission-control.js';
import { OFFICE_SHELL_ID } from '../../shared/office-shell.js';
import type { ClientMsg, ServerMsg, WorkerInfo, WorktreeState } from '../../shared/protocol.js';
import { analyzeCheckoutSafety, workerLocation } from '../floor-watch.js';
import { buildWorkerInspection, describeTaskLabel, formatTaskTag, formatWorkerInspection, type WorkerInspection, type WorkerTaskLabel } from '../worker-status.js';
import { formatBlockingSummary, formatQueueBrief, type BlockingToolState, type WorkerQueueState } from '../worker-queue.js';
import { officeError, officeResult, type OfficeMcpAccess, type OfficeMcpCaller, type OfficeMcpDeps, type OfficeMcpServer } from './index.js';
import { floorRef, resolveWorkerTarget, WORKER_TARGET_ERROR, workerTarget } from './owner-schemas.js';
import { registerOwnerTools } from './owner-tools.js';

/** Owner actions used by the remote worker tools, including dismissal's worktree inspection. */
export const OWNER_ACTIONS = ['worker.spawn', 'worker.prompt', 'worker.answer', 'worker.interrupt', 'thread.read', 'worker.kill', 'worker.worktree'] as const satisfies readonly ClientMsg['t'][];
export type OwnerAction = (typeof OWNER_ACTIONS)[number];

/** The message that answers an action, for the actions that have one: the caller gets it back. */
export const OWNER_REPLIES: Partial<Record<OwnerAction, ServerMsg['t']>> = {
  'worker.worktree': 'worker.worktree',
  'thread.read': 'thread.snapshot',
};

/** What an owner action came to, as the owner's own window would have seen it. */
export interface OwnerReply {
  error?: string;
  /** Started, but neither finished nor refused within the wait: read the office before repeating it. */
  pending?: boolean;
  /** Neither refused nor confirmed: the handler may have ignored it (an unknown id), or its outcome comes later as a toast. */
  unconfirmed?: boolean;
  workerId?: string;
  /** Toasts it raised. */
  notes: string[];
  /** The message that answers it (see OWNER_REPLIES). */
  reply?: ServerMsg;
}

/** The floors in the order the elevator numbers them. */
export interface OwnerFloor {
  id: string;
  name: string;
  dir?: string;
  branch?: string;
  baseBranch?: string;
  plain?: boolean;
  watchedBy?(leadId: string, workerId: string): boolean;
  workers: WorkerInfo[];
}

/** The owner's window, for building agents. The server sends each action through its own message handler. */
export interface OwnerOffice {
  floors(): OwnerFloor[];
  /** Mission Control's building agents: no floor, no desk, and never controllable through the Office MCP. */
  mission(): MissionAgent[];
  /** The end of a worker's terminal, or of a floor's boss shell (OFFICE_SHELL_ID with its floor). */
  tail(workerId: string, lines: number, floor?: string): string | undefined;
  /** Structured worker telemetry (plan, current/last tool, model cooldown, PR/CI, label provenance). */
  inspect?(workerId: string, floor?: string): Promise<WorkerInspection | undefined> | WorkerInspection | undefined;
  /** Whether background worker labels are currently enabled in Settings. */
  labelsOn?(): boolean;
  /** Live pending-message queue and active blocking command on a local floor worker, when present. */
  workerMeta?(workerId: string): { queuedMessages?: WorkerQueueState; blockingTool?: BlockingToolState } | undefined;
  /** `owner`: the owner's own choice (a Settings pick), so the model list for building agents doesn't apply. */
  act(by: WorkerInfo, msg: { t: OwnerAction } & Record<string, unknown>, opts?: { floor?: string; signal?: AbortSignal; owner?: boolean }): Promise<OwnerReply>;
}

/** A building agent named exactly by id or name; a name shared with a floor worker needs the id. */
export function findMissionAgent(owner: OwnerOffice, ref: string): MissionAgent | undefined {
  const want = ref.trim().toLowerCase();
  const all = owner.mission();
  return all.find((a) => a.worker.id.toLowerCase() === want) ?? all.find((a) => a.worker.name.toLowerCase() === want);
}

/** What a controlling owner tool says about a building agent, which may only be read. */
export function missionControlRefusal(agent: MissionAgent, tool: string): string {
  return `${agent.worker.name} (${agent.worker.id}) is a building agent in Mission Control, not a floor worker: ${tool} is not available for building agents. Nothing was sent.`;
}

/** Why an external bot has nothing here to read: its session runs on its own machine. */
export function outsideOffice(agent: MissionAgent, what: 'terminal' | 'conversation'): string {
  return `${agent.worker.name} runs outside this office, so it has no ${what} to read. Use team_status or office_inbox.`;
}

export interface RosterWorker {
  id: string;
  name: string;
  kind: WorkerInfo['kind'];
  floor: string;
  floorName: string;
  /** 1-based, as the elevator numbers floors. */
  floorNumber: number;
  desk: string;
  status: WorkerInfo['status'];
  title?: string;
  task?: string;
  taskLabel?: WorkerTaskLabel;
  activity?: string;
  model?: string;
  effort?: string;
  lead?: { id: string; name: string };
  /** One of the caller's own subagents. */
  yours: boolean;
  /** An independent (or other lead's) floor worker the caller follows via team_watch. */
  watching?: true;
  you: boolean;
  remote?: true;
  cloud?: true;
  cwd?: string;
  branch?: string;
  sharedCheckout?: true;
  warnings?: string[];
  worktree?: { branch: string };
  pr?: { number: number; url: string };
  queuedMessages?: WorkerQueueState;
  blockingTool?: BlockingToolState;
}

export const ownerInstructions = `You have owner-level access across floors via office_* tools. Act only within the owner's request. Use team_hire and team_* for delegated work; use office_worker_spawn only when explicitly asked for a standalone, shell, or cloud worker. Inspect workers with office_roster, office_look and office_worker_thread before steering with office_worker_prompt (default queue: false steers now; queue: true queues behind the turn; urgent: true interrupts blocking commands; worker_queue lists/clears/promotes queued items); interrupt or answer AskUser menus with office_worker_interrupt and office_worker_answer (leave terminal permission prompts untouched and tell the owner). Keep worktrees, branches and cloud sessions unless asked to delete them, and check state before retrying pending/unconfirmed actions.`;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Building agents have the owner's access whenever the office provides its owner bridge. */
export function hasOwnerAccess(caller: Pick<OfficeMcpCaller, 'building'>, owner: OwnerOffice | undefined): boolean {
  return caller.building && !!owner;
}

export const buildingOnly: OfficeMcpAccess = (c) => (c.building ? undefined : 'Only building agents have owner access through the Office MCP');
const REPLY_MAX = 60_000;
const TERMINAL_MAX = 48_000;

/** A floor by id, elevator number or name. */
export function pickFloor(floors: OwnerFloor[], ref: string): { floor: OwnerFloor; number: number } | string {
  const want = ref.trim().toLowerCase();
  const n = /^\d+$/.test(want) ? Number(want) : undefined;
  const id = floors.findIndex((f) => f.id.toLowerCase() === want);
  const numbered = n !== undefined && n >= 1 && n <= floors.length ? n - 1 : -1;
  const names = floors.flatMap((f, at) => (f.name.toLowerCase() === want ? [at] : []));
  if (id < 0 && numbered < 0 && names.length > 1) return `Several floors are called ${ref}. Use a floor id or elevator number: ${names.map((at) => `${at + 1} (${floors[at].id})`).join(', ')}.`;
  if (id < 0 && numbered >= 0 && names.some((at) => at !== numbered)) return `${ref} is both an elevator number and a different floor's name. Use the floor id.`;
  let at = names[0] ?? -1;
  if (numbered >= 0) at = numbered;
  if (id >= 0) at = id;
  if (at < 0) return `No floor ${ref}. Floors: ${floors.map((f, x) => `${x + 1} ${f.name} (${f.id})`).join(', ') || 'none open'}`;
  return { floor: floors[at], number: at + 1 };
}

export function roster(
  floors: OwnerFloor[],
  caller: string,
  only?: string,
  labelsOn = true,
  metaFor?: (workerId: string) => { queuedMessages?: WorkerQueueState; blockingTool?: BlockingToolState } | undefined,
  precomputedSafety?: ReturnType<typeof analyzeCheckoutSafety>,
): RosterWorker[] {
  const names = new Map(floors.flatMap((f) => f.workers.map((w) => [w.id, w.name] as const)));
  const { perWorker } = precomputedSafety ?? analyzeCheckoutSafety(floors.filter((f) => !only || f.id === only));
  return floors.flatMap((f, i) =>
    f.id !== only && only !== undefined
      ? []
      : [...f.workers]
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((w): RosterWorker => {
            const model = w.activeModel ?? w.model;
            const effort = w.activeEffort ?? w.effort;
            const taskLabel = describeTaskLabel(w, labelsOn);
            const meta = metaFor?.(w.id);
            const loc = workerLocation(w, f);
            const warnings = perWorker.get(w.id);
            const watching = f.watchedBy?.(caller, w.id) && w.lead !== caller ? (true as const) : undefined;
            return {
              id: w.id,
              name: w.name,
              kind: w.kind,
              floor: f.id,
              floorName: f.name,
              floorNumber: i + 1,
              desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId,
              status: w.status,
              ...(w.title ? { title: w.title } : {}),
              ...(w.task ? { task: w.task.summary ? `${w.task.name}: ${w.task.summary}` : w.task.name } : {}),
              ...(taskLabel ? { taskLabel } : {}),
              ...(w.activity ? { activity: w.activity } : {}),
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
              ...(w.lead ? { lead: { id: w.lead, name: names.get(w.lead) ?? w.lead } } : {}),
              yours: w.lead === caller,
              ...(watching ? { watching } : {}),
              you: w.id === caller,
              ...(w.remote ? { remote: true as const } : {}),
              ...(w.cloud ? { cloud: true as const } : {}),
              ...(loc.cwd ? { cwd: loc.cwd } : {}),
              ...(loc.branch ? { branch: loc.branch } : {}),
              ...(loc.sharedCheckout ? { sharedCheckout: true as const } : {}),
              ...(warnings?.length ? { warnings } : {}),
              ...(w.worktree ? { worktree: { branch: w.worktree.branch } } : {}),
              ...(w.pr ? { pr: w.pr } : {}),
              ...(meta?.queuedMessages?.count ? { queuedMessages: meta.queuedMessages } : {}),
              ...(meta?.blockingTool ? { blockingTool: meta.blockingTool } : {}),
            };
          }),
  );
}

/** One worker anywhere in the building, by id or name; a name on several floors needs `floor`. */
export function findWorker(floors: OwnerFloor[], ref: string, floor?: string): { worker: WorkerInfo; floor: OwnerFloor; number: number } | string {
  let scope = floors.map((f, i) => ({ floor: f, number: i + 1 }));
  if (floor) {
    const picked = pickFloor(floors, floor);
    if (typeof picked === 'string') return picked;
    scope = [picked];
  }
  const want = ref.trim().toLowerCase();
  const byId = scope.flatMap((s) => s.floor.workers.filter((w) => w.id.toLowerCase() === want).map((worker) => ({ ...s, worker })));
  const found = byId.length ? byId : scope.flatMap((s) => s.floor.workers.filter((w) => w.name.toLowerCase() === want || w.name.replace(/ 🐚$/, '').toLowerCase() === want).map((worker) => ({ ...s, worker })));
  if (found.length === 1) return found[0];
  if (found.length > 1) return `${ref} is on several floors (${found.map((m) => `${m.number} ${m.floor.name}: ${m.worker.id}`).join(', ')}). Use the worker id or floor.`;
  return `No worker called ${ref}${floor ? ' on that floor' : ' in the building'}. office_roster lists everyone.`;
}

function rosterLine(w: RosterWorker): string {
  const tags = [
    w.you ? 'you' : '',
    w.yours ? 'your subagent' : '',
    w.watching ? 'watching' : '',
    w.lead && !w.yours ? `subagent of ${w.lead.name}` : '',
    w.remote ? 'external' : '',
    w.cloud ? 'cloud' : '',
    w.kind === 'shell' ? 'shell' : '',
  ].filter(Boolean);
  const queueBrief = w.queuedMessages ? formatQueueBrief(w.queuedMessages) : undefined;
  const shownBranch = w.branch ?? w.worktree?.branch;
  return [
    `  ${w.name} (${w.id})${tags.length ? ` [${tags.join(', ')}]` : ''}, ${w.desk}, ${w.status}${w.model ? `, ${w.model}${w.effort ? ` ${w.effort}` : ''}` : ''}`,
    ...(w.task || w.title ? [`    Task: ${w.task ?? w.title}${formatTaskTag(w.taskLabel)}`] : []),
    ...(w.activity ? [`    Doing: ${w.activity}`] : []),
    ...(w.blockingTool ? [`    Blocking command: ${formatBlockingSummary(w.blockingTool)}`] : []),
    ...(queueBrief ? [`    ${queueBrief}`] : []),
    ...(w.cwd ? [`    Directory: ${w.cwd}${w.sharedCheckout ? ' (shared checkout, no worktree)' : ''}`] : []),
    ...(shownBranch ? [`    Branch: ${shownBranch}${w.pr ? `, PR ${w.pr.url}` : ''}`] : w.pr ? [`    PR: ${w.pr.url}`] : []),
    ...(w.warnings?.length ? [`    Warning: ${w.warnings.join('; ')}`] : []),
  ].join('\n');
}

function missionLine(agent: MissionAgent, caller: string, labelsOn = true): string {
  const w = agent.worker;
  const tags = [w.id === caller ? 'you' : '', w.id === ORCHESTRATOR_ID ? 'orchestrator' : 'external'].filter(Boolean);
  const taskLabel = describeTaskLabel(w, labelsOn);
  return [
    `  ${w.name} (${w.id}) [${tags.join(', ')}], Mission Control, ${w.status}${w.model ? `, ${w.model}${w.effort ? ` ${w.effort}` : ''}` : ''}`,
    ...(w.task ? [`    Task: ${w.task.name}${formatTaskTag(taskLabel)}`] : []),
    ...(w.activity ? [`    Doing: ${w.activity}`] : []),
    ...(agent.team.length ? [`    Team: ${agent.team.map((m) => `${m.name} on ${m.floorName} (${m.status})`).join(', ')}`] : []),
  ].join('\n');
}

function worktreeWords(s: WorktreeState): string {
  if (s.error) return `The office could not read its worktree (${s.error}).`;
  if (!s.exists) return 'Its worktree folder was already gone.';
  const parts = [s.dirty ? `${s.dirty} uncommitted file${s.dirty === 1 ? '' : 's'}` : '', s.unpushed ? `${s.unpushed} commit${s.unpushed === 1 ? '' : 's'} on no remote` : ''].filter(Boolean);
  return parts.length ? `Its worktree had ${parts.join(' and ')}.` : 'Its worktree held no unsaved or unpushed work.';
}

function outcomeText(r: OwnerReply): string {
  if (r.pending) return 'started; no outcome yet. Read the office before repeating it.';
  if (r.unconfirmed) return 'sent. The office neither refused nor confirmed it; check the notes or the office before repeating it.';
  return 'done.';
}

function terminalText(text: string): { text: string; truncated?: true } {
  return text.length > TERMINAL_MAX ? { text: text.slice(-TERMINAL_MAX), truncated: true } : { text };
}

function replyText(r: OwnerReply): { text: string; truncated: boolean } {
  const json = r.reply ? JSON.stringify(r.reply, null, 1) : '';
  const truncated = json.length > REPLY_MAX;
  const shown = truncated ? `${json.slice(0, REPLY_MAX)}\n[Truncated: ${json.length - REPLY_MAX} more characters]` : json;
  return { text: [...r.notes, ...(r.workerId ? [`Worker: ${r.workerId}`] : []), ...(r.reply ? [`Reply (${r.reply.t}):\n${shown}`] : [])].join('\n'), truncated };
}

function outcomeStatus(result: OwnerReply): 'pending' | 'unconfirmed' | 'done' {
  if (result.pending) return 'pending';
  if (result.unconfirmed) return 'unconfirmed';
  return 'done';
}

export function ownerResult(name: string, result: OwnerReply) {
  if (result.error) return officeError(`${name} refused: ${result.error}${result.notes.length ? `\n${result.notes.join('\n')}` : ''}`);
  const details = replyText(result);
  const status = outcomeStatus(result);
  return officeResult(`${name}: ${outcomeText(result)}${details.text ? `\n${details.text}` : ''}`, {
    status,
    ...(result.pending ? { pending: true } : {}),
    ...(result.unconfirmed ? { unconfirmed: true } : {}),
    notes: result.notes,
    ...(result.workerId ? { workerId: result.workerId } : {}),
    ...(result.reply ? (details.truncated ? { replyType: result.reply.t, replyTruncated: true } : { reply: result.reply }) : {}),
  });
}

function renderLookWithTerminal(title: string, shown: { text: string; truncated?: true }, emptyLabel: string, state?: WorkerInspection): string {
  const truncBanner = shown.truncated ? '[Truncated: latest 48,000 characters]\n' : '';
  if (!state) return `${title}:\n\n${truncBanner}${shown.text || emptyLabel}`;
  const stateBlock = formatWorkerInspection(state);
  const prefix = `${title}:\n\n${stateBlock}\n\nTerminal:\n${truncBanner}`;
  const budget = Math.max(0, TERMINAL_MAX - prefix.length);
  const body = shown.text.length > budget ? shown.text.slice(-budget) : shown.text;
  const out = `${prefix}${body || emptyLabel}`;
  return out.length > TERMINAL_MAX ? out.slice(-TERMINAL_MAX) : out;
}

export function register(server: OfficeMcpServer, deps: OfficeMcpDeps): void {
  const owner = deps.owner;
  if (!owner) return;
  const metaFor = (workerId: string) => {
    const direct = owner.workerMeta?.(workerId);
    if (direct) return direct;
    const f = deps.floor(workerId);
    if (!f) return undefined;
    const queue = f.workers.queueState?.(workerId);
    const blocking = f.workers.blockingTool?.(workerId);
    if (!queue?.count && !blocking) return undefined;
    return { ...(queue?.count ? { queuedMessages: queue } : {}), ...(blocking ? { blockingTool: blocking } : {}) };
  };
  server.tool(
    {
      name: 'office_roster',
      description: 'List workers across the building (or one floor) with id, desk, status, task, queued messages, blocking commands, directory, branch/PR, checkout warnings, model, and lead, plus Mission Control agents (read-only).',
      inputSchema: z.strictObject({ floor: floorRef.optional() }),
      annotations: readOnly,
    },
    buildingOnly,
    ({ floor }, caller) => {
      const floors = owner.floors();
      const labelsOn = owner.labelsOn?.() ?? true;
      let only: string | undefined;
      if (floor) {
        const picked = pickFloor(floors, floor);
        if (typeof picked === 'string') return officeError(picked);
        only = picked.floor.id;
      }
      const selectedFloors = floors.filter((f) => !only || f.id === only);
      const safety = analyzeCheckoutSafety(selectedFloors);
      const { warnings } = safety;
      const workers = roster(floors, caller.worker.id, only, labelsOn, metaFor, safety);
      const shown = floors
        .map((f, i) => ({
          id: f.id,
          name: f.name,
          number: i + 1,
          ...(f.dir ? { dir: f.dir } : {}),
          ...(f.branch ? { branch: f.branch } : {}),
          ...(f.baseBranch ? { baseBranch: f.baseBranch } : {}),
        }))
        .filter((f) => !only || f.id === only);
      const mission = only ? [] : owner.mission();
      const floorText =
        shown
          .map((f) => {
            const here = workers.filter((w) => w.floor === f.id);
            return [`Floor ${f.number}: ${f.name} (${f.id}), ${here.length} worker${here.length === 1 ? '' : 's'}`, ...here.map(rosterLine)].join('\n');
          })
          .join('\n\n') || 'No floors are open.';
      const warningText = warnings.length ? [`Checkout warnings\n${warnings.map((x) => `  Warning (${x.floorName}): ${x.message}`).join('\n')}`] : [];
      return officeResult([floorText, ...warningText, ...(mission.length ? [`Mission Control\n${mission.map((a) => missionLine(a, caller.worker.id, labelsOn)).join('\n')}`] : [])].join('\n\n'), {
        floors: shown,
        workers,
        ...(warnings.length ? { warnings } : {}),
        mission,
        workerLabelsEnabled: labelsOn,
      });
    },
  );
  const hasWorker = (a: { worker?: string; workerId?: string; name?: string }) => resolveWorkerTarget(a) !== undefined;
  server.tool(
    {
      name: 'office_look',
      description: `Read structured worker state (plan, tool, model cooldown, PR/CI) and a bounded terminal snapshot (<=48,000 characters) of a local worker, "${OFFICE_SHELL_ID}" shell, or Orchestrator, read-only. Accepts worker (or name/workerId); pass lines: 0 for structured state without raw terminal noise, or use office_worker_thread for cloud/history.`,
      inputSchema: z
        .strictObject({
          ...workerTarget,
          floor: floorRef.optional(),
          lines: z.number().int().min(0).max(400).default(80).describe('Latest lines (default 80, max 400; 0 for structured worker state only).'),
        })
        .refine(hasWorker, WORKER_TARGET_ERROR),
      annotations: readOnly,
    },
    buildingOnly,
    async (args, caller) => {
      const name = resolveWorkerTarget(args)!;
      const { floor, lines } = args;
      if (name.toLowerCase() === OFFICE_SHELL_ID) {
        if (lines === 0) return officeError(`${OFFICE_SHELL_ID} has no structured agent state; pass lines >= 1.`);
        const floors = owner.floors();
        let shellFloor: OwnerFloor | undefined;
        if (floor) {
          const picked = pickFloor(floors, floor);
          if (typeof picked === 'string') return officeError(picked);
          shellFloor = picked.floor;
        } else shellFloor = floors.find((f) => f.workers.some((w) => w.id === caller.worker.id));
        if (!shellFloor) return officeError('Name the floor whose shell to read.');
        const text = owner.tail(OFFICE_SHELL_ID, lines, shellFloor.id);
        if (text === undefined) return officeError(`${shellFloor.name}'s shell is not running.`);
        const shown = terminalText(text);
        return officeResult(`${shellFloor.name}'s shell:\n\n${shown.truncated ? '[Truncated: latest 48,000 characters]\n' : ''}${shown.text || '(empty)'}`, { worker: OFFICE_SHELL_ID, floor: shellFloor.id, ...shown });
      }
      const found = findWorker(owner.floors(), name, floor);
      if (typeof found === 'string') {
        const building = findMissionAgent(owner, name);
        if (!building) return officeError(found);
        if (building.worker.id !== ORCHESTRATOR_ID) return officeError(outsideOffice(building, 'terminal'));
        const state = await owner.inspect?.(building.worker.id);
        if (lines === 0) {
          const snap = state ?? buildWorkerInspection({ worker: building.worker, labelsOn: owner.labelsOn?.() ?? true });
          return officeResult(`${building.worker.name} in Mission Control:\n\n${formatWorkerInspection(snap, { includeSteps: true })}`, {
            worker: building.worker.id,
            floor: null,
            missionControl: true,
            lines: 0,
            state: snap,
          });
        }
        const text = owner.tail(building.worker.id, lines);
        if (text === undefined) return officeError(`${building.worker.name} has no terminal yet (${building.worker.status}).`);
        const shown = terminalText(text);
        return officeResult(renderLookWithTerminal(`${building.worker.name} in Mission Control`, shown, '(its terminal is empty)', state), {
          worker: building.worker.id,
          floor: null,
          missionControl: true,
          ...(state ? { state } : {}),
          ...shown,
        });
      }
      const state = await owner.inspect?.(found.worker.id, found.floor.id);
      if (lines === 0) {
        const snap = state ?? buildWorkerInspection({ worker: found.worker, labelsOn: owner.labelsOn?.() ?? true });
        return officeResult(`${found.worker.name} on floor ${found.number} (${found.floor.name}):\n\n${formatWorkerInspection(snap, { includeSteps: true })}`, {
          worker: found.worker.id,
          floor: found.floor.id,
          lines: 0,
          state: snap,
        });
      }
      const text = owner.tail(found.worker.id, lines);
      if (text === undefined) return officeError(`${found.worker.name} has no terminal to read (${found.worker.cloud ? 'a cloud worker: use office_worker_thread' : found.worker.status}).`);
      const shown = terminalText(text);
      return officeResult(renderLookWithTerminal(`${found.worker.name} on floor ${found.number} (${found.floor.name})`, shown, '(its terminal is empty)', state), {
        worker: found.worker.id,
        floor: found.floor.id,
        ...(state ? { state } : {}),
        ...shown,
      });
    },
  );
  server.tool(
    {
      name: 'office_send_home',
      description: 'Send a floor worker home (prefer team_dismiss for subagents; accepts worker, name, or workerId). cleanup defaults to keep; pass worktree/all or deleteSession: true only when the owner asked.',
      inputSchema: z
        .strictObject({
          ...workerTarget,
          floor: floorRef.optional(),
          cleanup: z.enum(['keep', 'worktree', 'all']).default('keep').describe('Default keep; worktree/all only when asked.'),
          deleteSession: z.boolean().default(false).describe('Cloud only: delete Factory session when asked.'),
        })
        .refine(hasWorker, WORKER_TARGET_ERROR),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    buildingOnly,
    async (args, caller, signal) => {
      const name = resolveWorkerTarget(args)!;
      const { floor, cleanup, deleteSession } = args;
      const found = findWorker(owner.floors(), name, floor);
      if (typeof found === 'string') {
        const building = findMissionAgent(owner, name);
        return officeError(building ? missionControlRefusal(building, 'office_send_home') : found);
      }
      const { worker } = found;
      const before = worker.worktree ? await owner.act(caller.worker, { t: 'worker.worktree', workerId: worker.id }, { signal }) : undefined;
      const state = before?.reply?.t === 'worker.worktree' ? before.reply.state : undefined;
      if (signal.aborted) return officeError('Cancelled before sending anyone home.');
      const result = await owner.act(caller.worker, { t: 'worker.kill', workerId: worker.id, cleanup, deleteSession }, { signal });
      if (result.error) return officeError(`${worker.name} was not sent home: ${result.error}`);
      const status = outcomeStatus(result);
      const target = `${worker.name} on floor ${found.number} (${found.floor.name}), cleanup ${cleanup}`;
      return officeResult(
        [
          status === 'done' ? `Sent ${worker.name} home from floor ${found.number} (${found.floor.name}), cleanup ${cleanup}.` : `Dismissal requested for ${target}: ${outcomeText(result)}`,
          ...(state ? [worktreeWords(state)] : []),
          ...(worker.cloud ? [`Factory session deletion ${deleteSession ? 'requested' : 'not requested (keep)'}.`] : []),
          ...result.notes,
        ].join('\n'),
        {
          status,
          worker: worker.id,
          name: worker.name,
          floor: found.floor.id,
          floorNumber: found.number,
          cleanup,
          deleteSession,
          ...(state ? { worktree: state } : {}),
          notes: result.notes,
          ...(result.pending ? { pending: true } : {}),
          ...(result.unconfirmed ? { unconfirmed: true } : {}),
        },
      );
    },
  );
  registerOwnerTools(server, owner);
}
