import { randomBytes } from 'node:crypto';
import {
  CLOCK_SKEW_MS,
  CLOUD_INSTANCE_MAX_MS,
  answeredByAssistant,
  canHost,
  cloudBadge,
  cloudStatus,
  emptyCloud,
  latestReply,
  latestTool,
  officeAutonomy,
  sessionCwd,
  type CloudComputer,
  type CloudTurn,
  type CloudWorker,
} from '../../shared/factory-cloud.js';
import { anyComputer, computerOf, type FactoryComputer, type FactoryComputersState } from '../../shared/factory-computers.js';
import { ENV_PHASE_WORD, canStartFrom, environmentPhase, instanceName, repoFolder, type FactoryEnvironmentsState } from '../../shared/factory-environments.js';
import type { ClientMsg, WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import { isAgentEffort } from '../../shared/protocol.js';
import { PROMPTS, fillPrompt, type PromptId, type PromptVars } from '../../shared/prompts.js';
import type { CloudWorkers } from '../cloud-workers.js';
import { fallbackTask } from '../tasks.js';
import { cloudScreen } from '../../shared/cloud-screen.js';
import { NEW_SESSION_GRACE_MS, mergeMessages, messageOf, type FactoryMessage } from '../../shared/factory-sessions.js';
import { FactoryError, type FactoryApi } from './api.js';
import { HttpError, SliceFeature, badRequest, notFound, str, type FactoryRoute, type FeatureHost } from './feature.js';
import { alreadyGone, whileNew, type NewSessionOptions } from './new-session.js';
import type { ComputersFeature } from './computers.js';
import type { FactoryRegistry } from './registry.js';
import type { SessionsFeature } from './sessions.js';
import { CloudThreadReader } from './cloud-thread.js';
import { CloudStream, type CloudStreamOptions } from './cloud-stream.js';
import { record } from './cloud-stream-messages.js';
import type { ThreadPage } from '../worker-thread.js';

// Cloud workers (docs/factory.md): office workers whose Droid session runs on one of the account's
// Factory computers. Hiring makes the session (POST /sessions) and sends the first prompt as its
// first message; after that the office polls each one's session (quickly while it works, slowly at
// rest) and acts its status and latest tool call out at its desk, like a local worker's. Each floor
// keeps its own (cloud-workers.ts); this is the part that talks to Factory.

/** How often a resting cloud worker's session is read: someone may type to it in Factory's web app. */
const IDLE_EVERY_MS = 60_000;
/** Newest messages read for what it's doing now, and enough of them to fill its laptop's screen. */
const TAIL = 20;
/** The most pictures one message carries, as the office's prompts take. */
const MAX_IMAGES = 10;
const PROMPT_MAX = 20_000;
const MODEL_MAX = 256;
/** How long after a turn ends the office looks for its reply, when the reply wasn't listed yet. */
const REPLY_WAIT_MS = 90_000;
/** How often a computer started from an Environment is read while it comes up (they usually take seconds). */
const INSTANCE_EVERY_MS = 2000;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** One floor's cloud workers, as the feature reaches them. */
export interface CloudFloor {
  id: string;
  name: string;
  cloud: CloudWorkers;
  /** Takes pictures that were pasted into a prompt off the floor's staging area. */
  unstage(ids: readonly string[]): void;
  /** The floor's repository (`owner/name`), to start a session from an Environment in its clone. */
  repo?: string;
}

export interface CloudOptions {
  /** Server-only credential for passive remote daemon streaming. REST remains the write path. */
  key?: () => string | undefined;
  streamClient?: CloudStreamOptions['client'];
  /** A display name already held in the server's model catalogue; never starts a lookup. */
  modelName?(id: string): string | undefined;
  floors(): Iterable<CloudFloor>;
  /** The office's `--agent-args`, for the autonomy its workers run at (see officeAutonomy). */
  agentArgs: readonly string[];
  /** The computers slice, to check a computer is there and can take a session. */
  computers(): FactoryComputersState | undefined;
  /** The Environments slice, for a hire on one. */
  environments?(): FactoryEnvironmentsState | undefined;
  /** A computer the office started for a worker, or deleted as it went home: the computers slice hears now. */
  computerMade?(c: FactoryComputer): void;
  computerDeleted?(id: string): void;
  /** A toast for everyone on one floor. */
  toast(floorId: string, text: string, level?: 'info' | 'warn' | 'error'): void;
  now?: () => number;
  /** How a write to a just-made session tries again after a 404 (new-session.ts); for tests. */
  retry?: Omit<NewSessionOptions, 'now'>;
  /** A worker's session was deleted as it went home: the Sessions feature drops it (SessionsFeature.forget). */
  sessionDeleted?(sessionId: string): void;
  /** How often and how long a hire waits for a computer started from an Environment; for tests. */
  instanceWait?: { everyMs: number; maxMs: number };
  /** One of the office's prompts as rewritten in Settings (server/prompts.ts); the default without it. */
  prompt?(id: PromptId, vars: PromptVars): string;
}

type Session = { status?: unknown; messageCount?: unknown; updatedAt?: unknown; title?: unknown; sessionSettings?: { model?: unknown; reasoningEffort?: unknown } };
type Picture = { type: 'base64'; data: string; mediaType: string };

const MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** The cloud slice, and the poller and routes of every floor's cloud workers. */
export class CloudFeature extends SliceFeature<'cloud'> {
  readonly interval = IDLE_EVERY_MS;
  readonly fastInterval = 4000;
  /** Workers to read on the next poll whatever their clock says (just prompted, interrupted, asked to check again). */
  private due = new Set<string>();
  private now: () => number;
  /** Each cloud worker's Thread, read from its session's messages (cloud-thread.ts). */
  readonly threads: CloudThreadReader;
  readonly stream?: CloudStream;
  private streamRevisions = new Map<string, number>();
  private acceptedAt = new Map<string, number>();
  private screens = new Set<string>();
  private screenTimer?: ReturnType<typeof setTimeout>;

  readonly routes: readonly FactoryRoute[] = [
    {
      // Hire a cloud worker: { floor, deskId, computerId | environmentId, cwd?, prompt?, model?, effort?, images? }.
      method: 'POST',
      path: '/hire',
      handle: async ({ api, json, by }) => {
        const body = await json<Record<string, unknown>>();
        const worker = await this.hire(api, body, by);
        return { worker };
      },
    },
    {
      // A message to a cloud worker's session: { text, images? }.
      method: 'POST',
      path: '/:id/message',
      handle: async ({ params, json }) => {
        const body = await json<{ text?: unknown; images?: unknown }>();
        const why = await this.send(params.id, str(body.text, PROMPT_MAX), imageIds(body.images));
        if (why) throw typeof why === 'string' ? badRequest(why) : why;
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/:id/interrupt',
      handle: async ({ api, params }) => {
        await this.interrupt(api, params.id);
        return { ok: true };
      },
    },
  ];

  constructor(
    host: FeatureHost,
    private opts: CloudOptions,
  ) {
    super('cloud', host, emptyCloud);
    this.now = opts.now ?? Date.now;
    this.threads = new CloudThreadReader(() => host.api(), { now: this.now, streaming: (id) => this.stream?.healthy(id) ?? false });
    if (opts.key) {
      this.stream = new CloudStream({
        api: () => host.api(),
        key: opts.key,
        now: this.now,
        client: opts.streamClient,
        sources: () => [...this.opts.floors()].flatMap((floor) => floor.cloud.list().flatMap((w) => (w.sessionId && w.cloud && !w.cloud.error ? [{ sessionId: w.sessionId, computerId: w.cloud.computerId }] : []))),
        reset: () => {
          this.threads.clear();
          this.screens.clear();
          this.streamRevisions.clear();
          this.acceptedAt.clear();
        },
        snapshot: (id, snapshot, superseded) => {
          const session = record(snapshot.session);
          this.threads.streamSnapshot(id, Array.isArray(session.messages) ? session.messages : [], snapshot.hasOlderMessages === true);
          this.streamMetadata(id, superseded.settings ? {} : record(snapshot.settings), superseded.title ? undefined : session.title);
          if (!superseded.state) this.streamState(id, snapshot.workingState);
          this.streamPaint(id);
        },
        notification: (id, n) => this.streamEvent(id, n),
      });
      this.stream.start();
    }
  }

  /** Immediate credential invalidation, including rejection while the registry stops polling. */
  connectionChanged(): void {
    void this.stream?.sync();
  }

  override reset(): void {
    this.stream?.reset();
    this.threads.clear();
    super.reset();
  }

  stop(): void {
    this.stream?.stop();
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.screenTimer = undefined;
  }

  private session(id: string): { floor: CloudFloor; info: WorkerInfo } | undefined {
    for (const floor of this.opts.floors()) {
      const info = floor.cloud.list().find((w) => w.sessionId === id);
      if (info) return { floor, info };
    }
    return undefined;
  }

  private streamState(id: string, state: unknown): void {
    const found = this.session(id);
    if (!found) return;
    const { floor, info } = found;
    if (state === 'idle') {
      if (floor.cloud.turn(info.id)?.seenBusy && info.status === 'working' && !this.waitingForAcceptance(id, floor.cloud.turn(info.id))) {
        floor.cloud.update(info.id, (_, w) => {
          w.turn = {};
        });
        floor.cloud.setStatus(info.id, 'done');
      }
    } else if (typeof state === 'string') {
      floor.cloud.update(info.id, (i, w) => {
        w.turn = { ...w.turn, seenBusy: true };
        if (i.cloud?.error) i.cloud = { ...i.cloud, error: undefined };
      });
      floor.cloud.setStatus(info.id, state === 'waiting_for_tool_confirmation' ? 'needs_input' : 'working');
    }
  }

  private streamEvent(id: string, n: Record<string, unknown>): void {
    this.streamRevisions.set(id, (this.streamRevisions.get(id) ?? 0) + 1);
    this.threads.streamEvent(id, n);
    this.streamPaint(id);
    const found = this.session(id);
    if (!found) return;
    const { floor, info } = found;
    if (n.type === 'create_message') {
      const message = record(n.message);
      if (message.role === 'user' && message.visibility !== 'llm_only') this.acceptedAt.set(id, this.now());
    }
    if (n.type === 'settings_updated') this.streamMetadata(id, record(n.settings));
    if (n.type === 'session_title_updated') this.streamMetadata(id, {}, n.title);
    if (n.type === 'droid_working_state_changed') this.streamState(id, n.newState);
    if (n.type === 'tool_call') {
      const tool = latestTool([{ role: 'assistant', content: [n.toolUse] }]);
      if (tool)
        floor.cloud.update(info.id, (i) => {
          i.activity = tool.activity;
          i.action = tool.action;
        });
    }
    if (n.type === 'agent_turn_completed') {
      if (this.waitingForAcceptance(id, floor.cloud.turn(info.id))) return;
      const messages = this.threads.messages(id);
      const reply = [...messages].reverse().find((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'text'));
      const text = reply?.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
      floor.cloud.update(info.id, (i, w) => {
        w.turn = {};
        if (text) {
          i.activity = clip(text, 80);
          if (i.task) i.task = { ...i.task, summary: clip(text, 140) };
        }
        if (n.reason !== 'completed' && n.reason !== 'cancelled') i.activity = `Factory session ended: ${String(n.reason).slice(0, 80)}`;
      });
      // A turn that ended badly is still over: done, with why in its activity, so the next message can go.
      floor.cloud.setStatus(info.id, 'done');
    }
  }

  private waitingForAcceptance(id: string, turn: CloudTurn | undefined): boolean {
    const accepted = this.acceptedAt.get(id);
    return accepted !== undefined && turn?.sentAt !== undefined && turn.sentAt > accepted;
  }

  private streamMetadata(id: string, settings: Record<string, unknown>, title?: unknown): void {
    const found = this.session(id);
    if (!found) return;
    this.reportModel(found.floor, found.info, settings.modelId);
    found.floor.cloud.update(found.info.id, (i) => {
      if (isAgentEffort(settings.reasoningEffort)) i.activeEffort = settings.reasoningEffort;
      if (typeof title === 'string' && title.trim()) i.title = clip(title, 120);
    });
  }

  private reportModel(floor: CloudFloor, info: WorkerInfo, value: unknown): void {
    if (typeof value !== 'string' || !value.trim()) return;
    const model = value.trim().slice(0, MODEL_MAX);
    let warn = false;
    const updated = floor.cloud.update(info.id, (i) => {
      i.activeModel = model;
      if (i.model && i.model !== model && i.cloud && !i.cloud.modelMismatchWarned) {
        i.cloud = { ...i.cloud, modelMismatchWarned: true };
        warn = true;
      }
    });
    if (warn && updated) {
      const name = (id: string) => clip(this.opts.modelName?.(id) || id, 120);
      this.opts.toast(floor.id, `☁ Factory runs ${updated.name} on ${name(model)}, not ${name(updated.model!)}`, 'warn');
    }
  }

  /** Token notifications update held state only; laptop frames are coalesced at four per second. */
  private streamPaint(id: string): void {
    this.screens.add(id);
    if (this.screenTimer) return;
    this.screenTimer = setTimeout(() => {
      this.screenTimer = undefined;
      for (const sessionId of this.screens) {
        const found = this.session(sessionId);
        const frame = cloudScreen(this.threads.messages(sessionId).slice(-TAIL));
        if (found && frame) found.floor.cloud.setScreen(found.info.id, frame);
      }
      this.screens.clear();
    }, 250);
    this.screenTimer.unref?.();
  }

  /** The office's Factory API now, if it's connected. */
  api(): FactoryApi | undefined {
    return this.host.api();
  }

  /** Stops the turn a cloud worker's session is in. */
  async interrupt(api: FactoryApi, id: string): Promise<void> {
    const found = this.find(id);
    if (!found?.info.sessionId) throw notFound('No such cloud worker');
    const sid = found.info.sessionId;
    await this.whileNew(found.info, () => api.post(`/sessions/${encodeURIComponent(sid)}/interrupt`, {}));
    this.recheck(found.info.id);
  }

  /** A page of a cloud worker's Thread, as `thread.read` answers it; undefined when it isn't one. */
  thread(id: string, before?: number): Promise<ThreadPage> | undefined {
    const found = this.find(id);
    if (!found) return undefined;
    const { info } = found;
    void this.stream?.sync();
    if (!info.sessionId) return Promise.resolve({ entries: [], hasMore: false, error: `${info.name} has no Factory session` });
    return this.threads.read({ sessionId: info.sessionId, createdAt: info.createdAt, busy: info.status === 'working' || info.status === 'starting' }, before);
  }

  /** The floor a cloud worker sits on, and the worker. */
  find(id: string): { floor: CloudFloor; info: WorkerInfo } | undefined {
    for (const floor of this.opts.floors()) {
      const info = floor.cloud.get(id);
      if (info) return { floor, info };
    }
    return undefined;
  }

  busy(): boolean {
    const now = this.now();
    for (const f of this.opts.floors()) for (const w of f.cloud.list()) if (w.status === 'working' || w.status === 'starting' || this.awaitingReply(f, w.id, now)) return true;
    return false;
  }

  /** Its turn ended before its reply could be read, and the office still looks for it. */
  private awaitingReply(floor: CloudFloor, id: string, now: number): boolean {
    const by = floor.cloud.turn(id)?.replyBy;
    return by !== undefined && now < by;
  }

  /** `call` on a worker's session, tried again for a while when it 404s because the session was only just made. */
  private whileNew<T>(info: WorkerInfo, call: () => Promise<T>): Promise<T> {
    return whileNew(info.createdAt, call, { now: this.now, ...this.opts.retry });
  }

  /** Reads a worker's session on the next poll, which comes right away. */
  recheck(id: string) {
    this.due.add(id);
    this.host.pollSoon();
  }

  private computer(id: string): CloudComputer | undefined {
    const s = this.opts.computers();
    const c = s && anyComputer(s, id);
    return c && { id: c.id, name: c.name, providerType: c.providerType, status: c.status, remoteUser: c.remoteUser };
  }

  /**
   * A computer of its own for a worker hired on an Environment: unlisted, like the ones Factory's
   * web app starts for a session, and waited for until it's active. Deleted again if it never is.
   */
  private async startInstance(api: FactoryApi, environmentId: string, envName: string): Promise<FactoryComputer> {
    const made = computerOf(await api.post('/computers', { name: instanceName(envName, randomBytes(4).toString('hex')), source: { kind: 'environment', environmentId, isListed: false } }));
    if (!made) throw new HttpError(502, `Factory made no computer from ${envName} (it didn't say which)`);
    const { everyMs, maxMs } = this.opts.instanceWait ?? { everyMs: INSTANCE_EVERY_MS, maxMs: CLOUD_INSTANCE_MAX_MS };
    const until = this.now() + maxMs;
    let c: FactoryComputer = made;
    this.opts.computerMade?.(c);
    try {
      while (c.status !== 'active') {
        if (c.status === 'error') throw new HttpError(502, `${c.name} didn't start from ${envName} on Factory`);
        if (this.now() >= until) throw new HttpError(504, `${c.name} didn't start from ${envName} within ${Math.round(maxMs / 60_000)} minutes`);
        await new Promise((r) => setTimeout(r, everyMs));
        c = computerOf(await api.get(`/computers/${encodeURIComponent(made.id)}`, { includeProvisioningSteps: true })) ?? c;
        this.opts.computerMade?.(c);
      }
    } catch (err) {
      await this.deleteInstance(api, made.id);
      throw err;
    }
    return c;
  }

  /** Deletes a computer the office started for a worker; whether it's gone (a 404 counts). */
  private async deleteInstance(api: FactoryApi, id: string): Promise<boolean> {
    try {
      await api.delete(`/computers/${encodeURIComponent(id)}`);
    } catch (err) {
      if (!(err instanceof FactoryError && err.status === 404)) return false;
    }
    this.opts.computerDeleted?.(id);
    return true;
  }

  /** Makes the session on the computer, seats the worker, then sends it its first prompt. */
  async hire(api: FactoryApi, body: Record<string, unknown>, by: string): Promise<WorkerInfo> {
    const floor = [...this.opts.floors()].find((f) => f.id === str(body.floor, 64));
    if (!floor) throw badRequest('That floor is no longer in the building');
    const images = imageIds(body.images);
    const deskId = str(body.deskId, 32);
    const environmentId = str(body.environmentId, 128);
    const env = environmentId ? this.opts.environments?.()?.items.find((e) => e.id === environmentId) : undefined;
    let computer = environmentId ? undefined : this.computer(str(body.computerId, 128));
    // A hire that fails leaves its pictures staged: the dialog stays open to try again, and drops them when it closes.
    if (environmentId) {
      if (!env) throw badRequest("That Environment isn't on Factory any more");
      if (!canStartFrom(env)) throw badRequest(`${env.name} is ${ENV_PHASE_WORD[environmentPhase(env)].toLowerCase()}: a computer starts from an Environment once it has built`);
    } else {
      if (!computer) throw badRequest("That computer isn't on Factory any more");
      if (!canHost(computer)) throw badRequest(`${computer.name} is ${computer.status}: only an active computer can take a session`);
    }
    const typedCwd = str(body.cwd, 5000);
    // On an Environment the folder is checked again against the computer once it's started; this
    // catches a folder that's wrong on any computer before one is started for nothing.
    const typedWhere = sessionCwd(typedCwd, computer ?? { name: env!.name, providerType: 'e2b', remoteUser: 'factory-user' });
    if (typeof typedWhere === 'string') throw badRequest(typedWhere);
    const model = str(body.model, MODEL_MAX + 1) || undefined;
    if (model && (model.length > MODEL_MAX || /[\s\p{Cc}]/u.test(model))) throw badRequest('That model id is not valid');
    if (model?.startsWith('custom:')) throw badRequest("Your own (BYOK) models only run on this machine: pick one of Factory's for a cloud worker");
    const effort = isAgentEffort(body.effort) ? body.effort : undefined;
    const prompt = str(body.prompt, PROMPT_MAX);
    const held = floor.cloud.hold(deskId);
    if (held) throw badRequest(held);
    const autonomy = officeAutonomy(this.opts.agentArgs);
    let where: { cwd?: string } = typedWhere;
    let instance: FactoryComputer | undefined;
    let catchUp = false;
    let made: { sessionId?: unknown; sessionSettings?: Session['sessionSettings'] };
    try {
      if (env) {
        instance = await this.startInstance(api, env.id, env.name);
        computer = { id: instance.id, name: instance.name, providerType: instance.providerType, status: instance.status, remoteUser: instance.remoteUser };
        const typed = sessionCwd(typedCwd, computer);
        if (typeof typed === 'string') throw badRequest(typed);
        // Left empty: the floor's repository's clone, where the Environment put it.
        const dir = typed.cwd ? undefined : repoFolder(instance.repos, floor.repo);
        where = dir ? { cwd: dir } : typed;
        catchUp = !!dir;
      }
      made = await api.post('/sessions', {
        computerId: computer!.id,
        ...where,
        sessionSettings: { interactionMode: 'auto', autonomyLevel: autonomy, ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}) },
      });
      if (typeof made?.sessionId !== 'string' || !made.sessionId) throw new HttpError(502, "Factory made no session (it didn't say which)");
    } catch (err) {
      floor.cloud.release(deskId);
      if (instance) await this.deleteInstance(api, instance.id);
      throw err;
    }
    const host = computer!;
    const place: CloudWorker = {
      computerId: host.id,
      computerName: host.name,
      provider: host.providerType,
      ...where,
      autonomy,
      ...(env ? { environmentId: env.id, environmentName: env.name, instance: true } : {}),
      ...(catchUp ? { catchUp: true } : {}),
    };
    const info = floor.cloud.add({
      deskId,
      by,
      sessionId: made.sessionId as string,
      prompt: prompt || (images.length ? 'See the attached images' : undefined),
      model: model ?? (typeof made.sessionSettings?.model === 'string' ? made.sessionSettings.model : undefined),
      effort,
      cloud: place,
    });
    if (info.prompt) {
      const task = fallbackTask(info.prompt);
      floor.cloud.update(info.id, (i) => {
        i.task = task;
      });
    }
    this.opts.toast(floor.id, `${by} hired ${info.name} on ${cloudBadge(place)}${info.prompt ? ' with a task' : ''}`);
    this.reportModel(floor, info, made.sessionSettings?.model);
    if (prompt || images.length) {
      void this.send(info.id, prompt, images).then((why) => {
        if (why) this.opts.toast(floor.id, `☁ ${info.name} didn't get its first prompt: ${why instanceof Error ? why.message : why}`, 'warn');
      });
    }
    return floor.cloud.get(info.id) ?? info;
  }

  /** What goes before the first message to a worker whose clone is from its Environment's build (cloud.environment). */
  private catchUpNote(c: CloudWorker): string {
    const vars = { environment: c.environmentName ?? 'it was started from', folder: c.cwd ?? '.' };
    return (this.opts.prompt ? this.opts.prompt('cloud.environment', vars) : fillPrompt(PROMPTS['cloud.environment'].text, vars)).trim();
  }

  /** Sends a message to a cloud worker's session; why not, or undefined once Factory has it. */
  async send(id: string, text: string, images: readonly string[]): Promise<string | Error | undefined> {
    const found = this.find(id);
    if (!found) return 'That worker has gone home';
    const { floor, info } = found;
    const pictures: Picture[] = [];
    for (const imageId of images.slice(0, MAX_IMAGES)) {
      const p = floor.cloud.drops.stagedPicture(imageId);
      if (p) pictures.push({ type: 'base64', data: p.body.toString('base64'), mediaType: MEDIA[p.ext] ?? 'image/png' });
    }
    floor.unstage(images);
    const message = text.trim() || (pictures.length ? 'See the attached images' : '');
    if (!message) return 'Type something to send';
    const api = this.host.api();
    if (!api) return "The office isn't connected to Factory: connect it in ⚙️ Settings → Connections";
    if (info.cloud?.error) return `${info.name} can't take prompts right now: ${info.cloud.error}`;
    const before = info.status;
    const catchUp = info.cloud?.catchUp === true;
    const lead = catchUp ? this.catchUpNote(info.cloud!) : '';
    const was = floor.cloud.turn(id) ?? {};
    const count = floor.cloud.seen(id)?.count ?? 0;
    floor.cloud.update(id, (i, w) => {
      // Cleared before the message goes, so a second one sent meanwhile doesn't carry the note too.
      if (i.cloud) delete i.cloud.catchUp;
      w.turn = { sentAt: this.now(), countAtSend: count };
      i.activity = clip(message, 80);
      i.lastInputAt = this.now();
      if (!i.task) i.task = fallbackTask(message);
      if (!i.prompt) i.prompt = message;
    });
    floor.cloud.setStatus(id, 'working');
    try {
      // The answer's own "running" doesn't count as seeing the turn run: a read right after it can still
      // say idle from before the message, which would end the turn before it began.
      await this.whileNew(info, () => api.post<{ status?: unknown }>(`/sessions/${encodeURIComponent(info.sessionId!)}/messages`, { text: lead ? `${lead}\n\n${message}` : message, ...(pictures.length ? { images: pictures } : {}) }));
    } catch (err) {
      floor.cloud.update(id, (i, w) => {
        w.turn = was;
        if (catchUp && i.cloud) i.cloud.catchUp = true;
        i.activity = clip(`Couldn't send: ${(err as Error).message}`, 80);
      });
      floor.cloud.setStatus(id, before === 'starting' ? 'idle' : before);
      return err as Error;
    }
    this.recheck(id);
    return undefined;
  }

  /**
   * Sends a cloud worker home: it leaves its desk now, its session is interrupted when it's working,
   * and deleted when `deleteSession` (otherwise it stays on the Factory account). A computer the
   * office started for it from an Environment is deleted too (its sessions are archived with it).
   * Resolves to what to tell the floor about the session, if anything.
   */
  async sendHome(id: string, deleteSession: boolean): Promise<{ note?: string; error?: string }> {
    const found = this.find(id);
    if (!found) return {};
    const { floor, info } = found;
    floor.cloud.remove(id);
    void this.stream?.sync();
    this.due.delete(id);
    const sid = info.sessionId;
    if (sid) {
      this.threads.forget(sid);
      this.streamRevisions.delete(sid);
      this.acceptedAt.delete(sid);
      this.screens.delete(sid);
    }
    const instance = info.cloud?.instance === true;
    const busy = info.status === 'working' || info.status === 'starting';
    if (!sid || (!instance && !busy && !deleteSession)) return {};
    const api = this.host.api();
    if (!api) {
      if (instance) return { error: `☁ The office isn't connected to Factory, so ${info.name}'s computer ${info.cloud?.computerName} is still there: delete it in Factory` };
      return { error: `☁ The office isn't connected to Factory, so ${info.name}'s session ${deleteSession ? 'is still there' : 'keeps going'} on ${info.cloud?.computerName ?? 'Factory'}` };
    }
    const path = `/sessions/${encodeURIComponent(sid)}`;
    const asked = this.now();
    const interrupt = () => this.whileNew(info, () => api.post(`${path}/interrupt`, {}));
    let sessionError: string | undefined;
    try {
      // Deleting its computer stops the session anyway.
      if (busy && !instance) await interrupt();
      if (deleteSession) await this.whileNew(info, () => api.delete(path));
    } catch (err) {
      // A 404 for a session past its first moments: it's gone already, which is what was wanted.
      if (!alreadyGone(err, info.createdAt, asked)) sessionError = (err as Error).message;
    }
    if (deleteSession && !sessionError) this.opts.sessionDeleted?.(sid);
    if (instance) {
      // Its computer goes whatever happened to the session: it was started for this worker alone.
      const name = info.cloud?.computerName ?? 'computer';
      if (!(await this.deleteInstance(api, info.cloud!.computerId))) {
        // The computer stays, so a session at work there would carry on: stop it.
        if (busy) await interrupt().catch(() => undefined);
        return { error: `☁ Couldn't delete ${info.name}'s computer ${name}: delete it in the Computers window${sessionError ? `. Its session: ${sessionError}` : ''}` };
      }
      if (sessionError) return { error: `☁ ${info.name}'s computer ${name} was deleted, but its session wasn't: ${sessionError}` };
      return { note: deleteSession ? `🗑️ ${info.name}'s computer ${name} and its session were deleted` : `🗑️ ${info.name}'s computer ${name} was deleted; its session stays archived in Factory` };
    }
    if (sessionError) return { error: `☁ ${info.name}'s session: ${sessionError}` };
    if (deleteSession) return { note: `🗑️ ${info.name}'s Factory session was deleted` };
    return { note: `☁ ${info.name}'s session was stopped; it stays in Factory's sessions` };
  }

  /**
   * The stream keeps its status: it's healthy, and it has seen the turn the office sent run. A turn
   * that ran and ended before the stream subscribed leaves only an idle snapshot, so REST finishes it.
   */
  private live(sessionId: string, turn: CloudTurn | undefined): boolean {
    return (this.stream?.healthy(sessionId) ?? false) && !(turn?.sentAt !== undefined && !turn.seenBusy);
  }

  /** Reads every cloud worker's session that's due: each working one at every poll, the rest on the slow clock. */
  async poll(api: FactoryApi): Promise<void> {
    void this.stream?.sync();
    const now = this.now();
    const jobs: Promise<void>[] = [];
    for (const floor of this.opts.floors()) {
      for (const info of floor.cloud.list()) {
        if (!info.sessionId) continue;
        const busy = info.status === 'working' || info.status === 'starting' || this.awaitingReply(floor, info.id, now);
        const wait = busy && !this.live(info.sessionId, floor.cloud.turn(info.id)) ? 0 : IDLE_EVERY_MS - this.fastInterval;
        if (!this.due.delete(info.id) && now - floor.cloud.polledAt(info.id) < wait) continue;
        jobs.push(this.pollOne(api, floor, info, now));
      }
    }
    if (!jobs.length) {
      if (!this.slice.fetchedAt) this.set({ fetchedAt: now, error: undefined });
      return;
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as Error] : []));
    const rejected = failed.find((e) => e instanceof FactoryError && e.status === 401);
    if (rejected) throw rejected;
    // Some answered: the ones that didn't keep their last status and try again next time.
    if (failed.length === results.length) throw failed[0];
    this.set({ fetchedAt: now, error: failed.length ? failed[0].message : undefined });
  }

  private async pollOne(api: FactoryApi, floor: CloudFloor, info: WorkerInfo, now: number): Promise<void> {
    const id = info.id;
    const revision = this.streamRevisions.get(info.sessionId!);
    const sid = encodeURIComponent(info.sessionId!);
    const computers = this.opts.computers();
    const computer = computers && anyComputer(computers, info.cloud?.computerId);
    // The computers list has been read and it isn't on it: the computer was deleted.
    if (computers?.fetchedAt && !computers.error && !computer) return this.broken(floor, id, `its computer ${info.cloud?.computerName ?? ''} is no longer on Factory`.replace('  ', ' '), now);
    if (computer?.status === 'error') return this.broken(floor, id, `its computer ${computer.name} has a problem on Factory`, now);
    let s: Session;
    try {
      s = await api.get<Session>(`/sessions/${sid}`);
    } catch (err) {
      // Factory 404s a session for a little while right after it was made: only one the office has
      // read before (or has waited out) counts as gone.
      if (err instanceof FactoryError && err.status === 404 && (floor.cloud.seen(id) || now - info.createdAt > NEW_SESSION_GRACE_MS)) return this.broken(floor, id, 'its session is gone from Factory', now);
      throw err;
    }
    const turn: CloudTurn = floor.cloud.turn(id) ?? {};
    if (this.live(info.sessionId!, turn) || this.streamRevisions.get(info.sessionId!) !== revision) {
      // A slow REST response cannot rewind live state, including one received during this request.
      floor.cloud.polled(id, { count: Number(s?.messageCount) || 0, updatedAt: Number(s?.updatedAt) || 0 }, turn, now);
      return;
    }
    let mapped = cloudStatus({ status: String(s?.status ?? ''), messageCount: Number(s?.messageCount) || 0 }, turn, now);
    const count = Number(s?.messageCount) || 0;
    const updatedAt = Number(s?.updatedAt) || 0;
    const seen = floor.cloud.seen(id);
    const moved = !seen || seen.count !== count || seen.updatedAt !== updatedAt;
    let messages: unknown[] | undefined;
    // The tail is read when the session moved, when a fresh `done` needs its reply, while a turn
    // the office sent is open and idle (its answer may have landed between two reads of a fast turn),
    // and while a turn that ended looks for its reply.
    const watching = mapped.status === 'working' && turn.sentAt !== undefined && s?.status === 'idle';
    const awaiting = mapped.status === undefined && turn.replyBy !== undefined && now < turn.replyBy;
    if (count > 0 && (moved || watching || awaiting || (mapped.status === 'done' && info.status !== 'done'))) {
      try {
        const r = await api.get<{ messages?: unknown[] }>(`/sessions/${sid}/messages`, { limit: TAIL });
        messages = Array.isArray(r?.messages) ? r.messages : undefined;
      } catch {
        // The status is enough to go on: what it's doing shows at the next read.
      }
    }
    if (this.live(info.sessionId!, floor.cloud.turn(id)) || this.streamRevisions.get(info.sessionId!) !== revision) {
      if (messages) this.threads.absorb(info.sessionId!, messages);
      floor.cloud.polled(id, { count, updatedAt }, floor.cloud.turn(id) ?? {}, now);
      return;
    }
    // Factory lists a message many seconds after it was made, so the newest one listed can still be
    // the last turn's reply: only one made after the message went answers this turn.
    const after = turn.sentAt !== undefined ? turn.sentAt - CLOCK_SKEW_MS : turn.replyAfter;
    const replied = !!messages && answeredByAssistant(messages, after);
    if (watching && replied) mapped = { status: 'done', turn: {} };
    const next: WorkerStatus | undefined = mapped.status ?? (info.status === 'exited' || info.status === 'offline' ? 'idle' : undefined);
    // A turn that ended before its reply was listed reads the tail at every poll for a while, to put
    // the reply at the desk.
    if (next === 'done' && !replied) mapped = { ...mapped, turn: { replyBy: now + REPLY_WAIT_MS, ...(after !== undefined ? { replyAfter: after } : {}) } };
    else if (awaiting && replied) mapped = { ...mapped, turn: {} };
    this.reportModel(floor, info, s?.sessionSettings?.model);
    floor.cloud.update(id, (i) => {
      if (i.cloud?.error) {
        i.cloud = { ...i.cloud, error: undefined };
        if (i.activity?.startsWith('☁ ')) i.activity = i.task?.summary ?? 'Waiting for a prompt';
      }
      if (computer && i.cloud && computer.name !== i.cloud.computerName) i.cloud = { ...i.cloud, computerName: computer.name };
      const effort = s?.sessionSettings?.reasoningEffort;
      if (isAgentEffort(effort)) i.activeEffort = effort;
      if (typeof s?.title === 'string' && s.title.trim()) i.title = clip(s.title, 120);
      if (!messages) return;
      if (next === 'working' || (next === undefined && i.status === 'working')) {
        const tool = latestTool(messages);
        if (tool) {
          i.activity = tool.activity;
          i.action = tool.action;
        }
      } else if ((next === 'done' || awaiting) && replied) {
        const reply = latestReply(messages);
        if (reply) {
          i.activity = clip(reply, 80);
          if (i.task) i.task = { ...i.task, summary: clip(reply, 140) };
        }
      }
    });
    if (messages) {
      this.threads.absorb(info.sessionId!, messages);
      const parsed = messages.map(messageOf).filter((m): m is FactoryMessage => !!m);
      const frame = cloudScreen(mergeMessages([], parsed));
      if (frame) floor.cloud.setScreen(id, frame);
    }
    floor.cloud.polled(id, { count, updatedAt }, mapped.turn, now);
    if (next) floor.cloud.setStatus(id, next);
  }

  /** It can't work: its session or computer is gone. It stays at its desk, saying why, until it's sent home. */
  private broken(floor: CloudFloor, id: string, why: string, now: number) {
    floor.cloud.update(id, (i) => {
      if (i.cloud) i.cloud = { ...i.cloud, error: why };
      i.activity = `☁ ${why[0].toUpperCase()}${why.slice(1)}`;
    });
    floor.cloud.polled(id, undefined, {}, now);
    floor.cloud.setStatus(id, 'exited');
  }
}

/** Picture ids from a request: the staged ones (see DropStore.stage), at most a prompt's worth. */
function imageIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x)).slice(0, MAX_IMAGES) : [];
}

/** The ws messages that act on a worker, as a cloud worker answers them. */
type WorkerMsg = Extract<ClientMsg, { workerId: string }>;

export interface CloudMessageContext {
  /** Who sent it (the page's player name). */
  who: string;
  /** The sender's connection. */
  client: string;
  /** Just to the sender. */
  warn(text: string): void;
  done?(error?: string, workerId?: string): void;
  /** Hand an issue to it (a card dropped on its desk): assigned on the forge. */
  takeIssue?(issue: number): void;
}

/**
 * Cloud workers in the office: the feature registered with the Factory registry, and what server.ts
 * calls for a ws message about one. Returns undefined when `workerId` isn't a cloud worker's.
 */
export function mountCloud(registry: FactoryRegistry, opts: Omit<CloudOptions, 'computers' | 'environments' | 'computerMade' | 'computerDeleted'>) {
  const feature = registry.register(
    (host) =>
      new CloudFeature(host, {
        ...opts,
        computers: () => registry.feature('computers')?.state(),
        environments: () => registry.feature('environments')?.state(),
        computerMade: (c) => (registry.feature('computers') as ComputersFeature | undefined)?.track(c),
        computerDeleted: (id) => (registry.feature('computers') as ComputersFeature | undefined)?.forget(id),
        sessionDeleted: (id) => (registry.feature('sessions') as SessionsFeature | undefined)?.forget(id),
      }),
  ) as CloudFeature;

  /** Handles a message about a cloud worker; false when it isn't one. */
  const message = (msg: WorkerMsg, ctx: CloudMessageContext): boolean => {
    const found = feature.find(msg.workerId);
    if (!found) return false;
    const { floor, info } = found;
    const failed = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
    switch (msg.t) {
      case 'worker.attach':
        floor.cloud.attach(info.id, ctx.client);
        ctx.done?.(undefined, info.id);
        break;
      case 'worker.detach':
        floor.cloud.detach(info.id, ctx.client);
        ctx.done?.(undefined, info.id);
        break;
      case 'worker.kill':
        opts.toast(floor.id, `${ctx.who} sent ${info.name} home`);
        void feature.sendHome(info.id, msg.deleteSession === true).then(
          ({ note, error }) => {
            if (note) opts.toast(floor.id, note);
            if (error) opts.toast(floor.id, error, 'warn');
            ctx.done?.(error, info.id);
          },
          (error: unknown) => ctx.done?.(failed(error, 'The office could not confirm sending the worker home.'), info.id),
        );
        break;
      case 'worker.prompt': {
        const issue = Number.isInteger(msg.issue) && (msg.issue as number) > 0 ? (msg.issue as number) : undefined;
        void feature.send(info.id, str(msg.prompt, PROMPT_MAX), imageIds(msg.images)).then(
          (why) => {
            if (why) {
              const error = why instanceof Error ? why.message : why;
              ctx.warn(error);
              return ctx.done?.(error, info.id);
            }
            ctx.done?.(undefined, info.id);
            if (issue) {
              opts.toast(floor.id, `${ctx.who} handed issue #${issue} to ${info.name}`);
              ctx.takeIssue?.(issue);
            }
          },
          (error: unknown) => ctx.done?.(failed(error, 'The office could not confirm the prompt.'), info.id),
        );
        break;
      }
      case 'worker.interrupt': {
        const api = feature.api();
        if (!api) {
          const error = "The office isn't connected to Factory: connect it in ⚙️ Settings → Connections";
          ctx.warn(error);
          ctx.done?.(error, info.id);
          break;
        }
        void feature.interrupt(api, info.id).then(
          () => ctx.done?.(undefined, info.id),
          (error: unknown) => {
            const why = `☁ Couldn't interrupt ${info.name}: ${failed(error, 'Factory did not answer')}`;
            ctx.warn(why);
            ctx.done?.(why, info.id);
          },
        );
        break;
      }
      case 'worker.resume':
        ctx.warn(`☁ Checking ${info.name}'s session on Factory again`);
        feature.recheck(info.id);
        ctx.done?.(undefined, info.id);
        break;
      case 'term.input':
      case 'term.resize':
      case 'changes.unwatch':
        ctx.done?.(`${info.name} has no local terminal.`, info.id);
        break;
      default: {
        const error = cloudRefusal(info, msg.t);
        ctx.warn(error);
        ctx.done?.(error, info.id);
      }
    }
    return true;
  };

  /**
   * Hires a cloud worker for a `worker.spawn` with `cloud`, as the hire route does; the worker, or why
   * not. Over the WebSocket, so a companion on another device can hire one too (the route's writes
   * only take the office's own page or a paired phone).
   */
  const hire = async (body: Record<string, unknown>, by: string): Promise<WorkerInfo | string> => {
    const api = feature.api();
    if (!api) return "The office isn't connected to Factory: connect it in ⚙️ Settings → Connections";
    try {
      return await feature.hire(api, body, by);
    } catch (error) {
      return error instanceof Error ? error.message : 'Factory did not answer';
    }
  };

  return { feature, message, hire, find: (id: string) => feature.find(id), thread: (id: string, before?: number) => feature.thread(id, before) };
}

/** Why something the office does with a local worker isn't done to a cloud one. */
export function cloudRefusal(w: WorkerInfo, t: ClientMsg['t']): string {
  const where = w.cloud ? cloudBadge(w.cloud) : 'a Factory computer';
  if (t === 'worker.shoot') return `${w.name} works on ${where}: there's nobody really at this desk to shoot`;
  if (t === 'worker.pr' || t.startsWith('changes.')) return `${w.name} works on ${where}, not in a checkout on this machine: ask it to commit and open the pull request itself`;
  return `${w.name} works on ${where}: that only works for a worker on this machine`;
}
