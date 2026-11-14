import { randomBytes } from 'node:crypto';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { WebSocket } from 'ws';
import { OWNER_REPLIES, type OwnerOffice, type OwnerReply } from '../office-mcp/owner.js';
import type { Floor } from '../floor.js';
import type { Orchestrator } from '../orchestrator.js';
import type { WorkerManager } from '../workers.js';
import type { mountFactory } from '../factory/index.js';
import type { mountSubscriptions } from '../subscriptions/index.js';
import type { Subagents } from '../subagents.js';
import type { WorkerLabelPreferences } from '../worker-label-settings.js';
import type { RemoteOffice } from '../remote-office.js';
import type { WorkerThreadReader } from '../worker-thread.js';
import { readHeadBranch } from '../floor-watch.js';
import { buildWorkerInspection, inspectTerminalRetry } from '../worker-status.js';
import { ORCHESTRATOR_ID, type MissionControlState } from '../../shared/mission-control.js';
import { OFFICE_SHELL_ID } from '../../shared/office-shell.js';
import { isSubscriptionModel } from '../../shared/subscriptions.js';
import { factoryModelTier } from '../../shared/factory-limits.js';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../../shared/protocol.js';
import type { Client } from './client.js';

const OWNER_ACTION_WAIT_MS = 30_000;

interface OwnerContext {
  floors: Map<string, Floor>;
  orchestrator: Orchestrator;
  missionState(): MissionControlState;
  workerFloor(id: string): Floor | undefined;
  workersOf(id: string): WorkerManager | undefined;
  cloud: NonNullable<ReturnType<typeof mountFactory>['cloud']>;
  factory: ReturnType<typeof mountFactory>;
  subscriptions: ReturnType<typeof mountSubscriptions>;
  subagents: Subagents;
  labelPreferences: WorkerLabelPreferences;
  remoteOffice: RemoteOffice;
  workerThreads: WorkerThreadReader;
  acting: AsyncLocalStorage<(text: string) => void>;
  handleMessage(c: Client, msg: ClientMsg): void;
}

/** Building agents use a private owner socket so receipts, replies and async toast context stay isolated. */
export function createOwnerOffice({ floors, orchestrator, missionState, workerFloor, workersOf, cloud, factory, subscriptions, subagents, labelPreferences, remoteOffice, workerThreads, acting, handleMessage }: OwnerContext): OwnerOffice {
  /**
   * The owner's window for building agents. Each action goes through handleMessage on a connection
   * of its own, named for the worker, so it has the owner's checks, effects and toasts exactly.
   */
  return {
    floors: () =>
      [...floors.values()].map((f) => {
        const live = !f.plain ? readHeadBranch(f.dir) : { found: false as const };
        return {
          id: f.id,
          name: f.def.name,
          dir: f.dir,
          plain: f.plain,
          branch: f.plain ? undefined : live.found ? live.branch : f.project.branch,
          baseBranch: f.plain ? undefined : (f.workers.selectedBranch ?? f.workers.baseBranch ?? f.project.branch),
          watchedBy: (leadId, workerId) => f.team.isWatching(leadId, workerId),
          workers: f.everyone(),
        };
      }),
    mission: () => {
      const state = missionState();
      const agent = orchestrator.rosterAgent();
      return [...(agent ? [agent] : []), ...state.bots];
    },
    tail: (id, lines, floorId) => (id === OFFICE_SHELL_ID ? floors.get(floorId ?? '')?.shell.tail(lines) : workersOf(id)?.tail(id, lines)),
    labelsOn: () => labelPreferences.get().on,
    inspect: async (id, floorId) => {
      if (id === OFFICE_SHELL_ID) return undefined;
      if (id === ORCHESTRATOR_ID) {
        const w = orchestrator.workers.get(ORCHESTRATOR_ID);
        if (!w) return undefined;
        const runtime = orchestrator.workers.runtime(ORCHESTRATOR_ID);
        const model = w.activeModel ?? w.model;
        if (w.status === 'working' && model && isSubscriptionModel(model) && subscriptions.availability(model)?.state !== 'exhausted' && inspectTerminalRetry(runtime?.screenRows, w.status, Boolean(runtime?.currentTool))?.retrying) {
          try {
            await subscriptions.recheck();
          } catch {
            // Fall back to cached availability.
          }
        }
        if (model && factoryModelTier({ id: model }) && inspectTerminalRetry(runtime?.screenRows, w.status, Boolean(runtime?.currentTool))) await factory.recheckLimits();
        const now = Date.now();
        return buildWorkerInspection({
          factory: factory.state(),
          worker: w,
          runtime,
          availability: model ? subscriptions.availability(model) : undefined,
          usage: model ? subscriptions.usage(model, now) : undefined,
          labelsOn: labelPreferences.get().on,
          now,
        });
      }
      const floor = floorId ? floors.get(floorId) : workerFloor(id);
      const w = floor?.everyone().find((x) => x.id === id);
      if (!floor || !w) return undefined;
      await floor.team.recheckIfRetrying([w]);
      return floor.team.inspectWorker(w);
    },
    workerMeta: (id) => {
      const f = workerFloor(id);
      if (!f) return undefined;
      const queue = f.workers.queueState(id);
      const blocking = f.workers.blockingTool(id);
      if (!queue?.count && !blocking) return undefined;
      return {
        ...(queue?.count ? { queuedMessages: queue } : {}),
        ...(blocking ? { blockingTool: blocking } : {}),
      };
    },
    threadImages: async (workerId, entries, floorId) => {
      const targetWorkers = workerId === ORCHESTRATOR_ID ? orchestrator.workers : ((floorId ? floors.get(floorId) : undefined)?.workers ?? workerFloor(workerId)?.workers);
      const source = targetWorkers?.threadSession(workerId);
      if (!source || !targetWorkers) return [];
      try {
        return await remoteOffice.images.collectThreadImages(entries, {
          dropPicture: (name) => targetWorkers.dropPicture(workerId, name),
          sessionPicture: (imageId) => workerThreads.image(source, imageId),
        });
      } catch {
        return [];
      }
    },
    act: async (by: WorkerInfo, msg, opts = {}) => {
      // A building agent's hire gets the model list its team_hire gets: here is the one way in for its owner-level actions.
      if (msg.t === 'worker.spawn' && msg.kind !== 'shell' && !opts.owner) {
        const model = typeof msg.model === 'string' && msg.model.trim() ? msg.model.trim() : undefined;
        const cloudSpawn = msg.kind === 'cloud' || Boolean(msg.cloud && typeof msg.cloud === 'object');
        const at = floors.get(opts.floor ?? (typeof msg.floor === 'string' ? msg.floor : ''));
        const refused = at ? await at.team.refuseSpawnModel(by, model, cloudSpawn) : undefined;
        if (refused) return { error: refused, notes: [] };
        const fallback = !model && cloudSpawn && subagents.settings.models?.length ? at?.workers.officeDefault?.model : undefined;
        if (fallback && !fallback.startsWith('custom:')) msg = { ...msg, model: fallback };
      }
      return new Promise<OwnerReply>((resolve) => {
        const notes: string[] = [];
        const expects = OWNER_REPLIES[msg.t];
        const requestId = randomBytes(8).toString('hex');
        let receipt: { error?: string; workerId?: string } | undefined;
        let reply: ServerMsg | undefined;
        let settled = false;
        const onAbort = () => finish(true);
        const complete = () => !!receipt && (!!receipt.error || !expects || !!reply);
        const finish = (timedOut = false) => {
          if (settled) return;
          // A receipt already in is the outcome, even if the wait ends before its toasts are collected.
          const pending = timedOut && !complete();
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          const refused = receipt?.error ?? (reply && 'error' in reply && typeof reply.error === 'string' ? reply.error : undefined);
          // A success toast is confirmation enough; silence is not.
          const unconfirmed = !refused && !pending && !reply && !notes.length && client.owner?.unconfirmed;
          resolve({
            ...(refused ? { error: refused } : {}),
            ...(pending ? { pending } : {}),
            ...(unconfirmed ? { unconfirmed } : {}),
            ...(receipt?.workerId ? { workerId: receipt.workerId } : {}),
            notes,
            ...(reply ? { reply } : {}),
          });
        };
        let ready = false;
        const check = () => {
          if (ready || !complete()) return;
          ready = true;
          // Handlers often toast right after done(), in the same turn: let those land in the notes first.
          setImmediate(() => finish());
        };
        const timer = setTimeout(() => finish(true), OWNER_ACTION_WAIT_MS);
        const workerId = typeof msg.workerId === 'string' ? msg.workerId : undefined;
        const worksOn = workerId ? (workerFloor(workerId) ?? floors.get(cloud.find(workerId)?.floor.id ?? '')) : undefined;
        const home = [...floors.values()].find((f) => f.workers.get(by.id));
        const socket = {
          readyState: WebSocket.OPEN,
          bufferedAmount: 0,
          send: (json: string) => {
            const m = JSON.parse(json) as ServerMsg;
            if (m.t === 'action.result' && m.requestId === requestId) receipt = { ...(m.error ? { error: m.error } : {}), ...(m.workerId ? { workerId: m.workerId } : {}) };
            else if (m.t === 'toast') {
              if (settled) return;
              notes.push(m.text);
              // A synchronous handler refuses by warning without done(); only the first warning counts.
              if (m.level !== 'info') client.owner!.refused ??= m.text;
            } else if (m.t === expects) reply = m;
            check();
          },
          close() {},
          ping() {},
          terminate() {},
        };
        const client: Client = {
          id: `mcp-${requestId}`,
          ws: socket,
          // A worker action runs where that worker sits, as the owner's window has to be on its floor.
          floor: worksOn?.id ?? opts.floor ?? (typeof msg.floor === 'string' && floors.has(msg.floor) ? msg.floor : undefined) ?? home?.id ?? null,
          peer: { name: by.name, color: by.color },
          attached: new Set([...(workerId ? [workerId] : []), OFFICE_SHELL_ID]),
          stale: new Set(),
          lastGongAt: 0,
          isAlive: true,
          dashboard: true,
          requests: new Set(),
          boards: new Map(),
          owner: {},
        };
        if (opts.signal?.aborted) return finish(true);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        // Timers a hire starts keep this context after the action settles; they no longer add to its notes.
        acting.run(
          (text) => {
            if (!settled) notes.push(text);
          },
          () => handleMessage(client, { ...msg, requestId } as unknown as ClientMsg),
        );
      });
    },
  };
}
