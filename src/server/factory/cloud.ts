import { CLOCK_SKEW_MS, answeredByAssistant, canHost, cloudBadge, cloudStatus, emptyCloud, latestReply, latestTool, officeAutonomy, sessionCwd, type CloudComputer, type CloudTurn } from '../../shared/factory-cloud.js';
import type { FactoryComputersState } from '../../shared/factory-computers.js';
import type { ClientMsg, WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import { isAgentEffort } from '../../shared/protocol.js';
import type { CloudWorkers } from '../cloud-workers.js';
import { fallbackTask } from '../tasks.js';
import { NEW_SESSION_GRACE_MS } from '../../shared/factory-sessions.js';
import { FactoryError, type FactoryApi } from './api.js';
import { HttpError, SliceFeature, badRequest, notFound, str, type FactoryRoute, type FeatureHost } from './feature.js';
import { alreadyGone, whileNew, type NewSessionOptions } from './new-session.js';
import type { FactoryRegistry } from './registry.js';
import type { SessionsFeature } from './sessions.js';

// Cloud workers (docs/factory.md): office workers whose Droid session runs on one of the account's
// Factory computers. Hiring makes the session (POST /sessions) and sends the first prompt as its
// first message; after that the office polls each one's session (quickly while it works, slowly at
// rest) and acts its status and latest tool call out at its desk, like a local worker's. Each floor
// keeps its own (cloud-workers.ts); this is the part that talks to Factory.

/** How often a resting cloud worker's session is read: someone may type to it in Factory's web app. */
const IDLE_EVERY_MS = 60_000;
/** Newest messages read for what it's doing now. */
const TAIL = 8;
/** The most pictures one message carries, as the office's prompts take. */
const MAX_IMAGES = 10;
const PROMPT_MAX = 20_000;
const MODEL_MAX = 256;
/** How long after a turn ends the office looks for its reply, when the reply wasn't listed yet. */
const REPLY_WAIT_MS = 90_000;

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
}

export interface CloudOptions {
  floors(): Iterable<CloudFloor>;
  /** The office's `--agent-args`, for the autonomy its workers run at (see officeAutonomy). */
  agentArgs: readonly string[];
  /** The computers slice, to check a computer is there and can take a session. */
  computers(): FactoryComputersState | undefined;
  /** A toast for everyone on one floor. */
  toast(floorId: string, text: string, level?: 'info' | 'warn' | 'error'): void;
  now?: () => number;
  /** How a write to a just-made session tries again after a 404 (new-session.ts); for tests. */
  retry?: Omit<NewSessionOptions, 'now'>;
  /** A worker's session was deleted as it went home: the Sessions feature drops it (SessionsFeature.forget). */
  sessionDeleted?(sessionId: string): void;
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

  readonly routes: readonly FactoryRoute[] = [
    {
      // Hire a cloud worker: { floor, deskId, computerId, cwd?, prompt?, model?, effort?, images? }.
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
        const found = this.find(params.id);
        if (!found?.info.sessionId) throw notFound('No such cloud worker');
        const sid = found.info.sessionId;
        await this.whileNew(found.info, () => api.post(`/sessions/${encodeURIComponent(sid)}/interrupt`, {}));
        this.recheck(found.info.id);
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
    const c = this.opts.computers()?.items.find((x) => x.id === id);
    return c && { id: c.id, name: c.name, providerType: c.providerType, status: c.status, remoteUser: c.remoteUser };
  }

  /** Makes the session on the computer, seats the worker, then sends it its first prompt. */
  async hire(api: FactoryApi, body: Record<string, unknown>, by: string): Promise<WorkerInfo> {
    const floor = [...this.opts.floors()].find((f) => f.id === str(body.floor, 64));
    if (!floor) throw badRequest('That floor is no longer in the building');
    const images = imageIds(body.images);
    const deskId = str(body.deskId, 32);
    const computer = this.computer(str(body.computerId, 128));
    // A hire that fails leaves its pictures staged: the dialog stays open to try again, and drops them when it closes.
    if (!computer) throw badRequest("That computer isn't on Factory any more");
    if (!canHost(computer)) throw badRequest(`${computer.name} is ${computer.status}: only an active computer can take a session`);
    const where = sessionCwd(str(body.cwd, 5000), computer);
    if (typeof where === 'string') throw badRequest(where);
    const model = str(body.model, MODEL_MAX + 1) || undefined;
    if (model && (model.length > MODEL_MAX || /[\s\p{Cc}]/u.test(model))) throw badRequest('That model id is not valid');
    if (model?.startsWith('custom:')) throw badRequest("Your own (BYOK) models only run on this machine: pick one of Factory's for a cloud worker");
    const effort = isAgentEffort(body.effort) ? body.effort : undefined;
    const prompt = str(body.prompt, PROMPT_MAX);
    const held = floor.cloud.hold(deskId);
    if (held) throw badRequest(held);
    const autonomy = officeAutonomy(this.opts.agentArgs);
    let made: { sessionId?: unknown; sessionSettings?: Session['sessionSettings'] };
    try {
      made = await api.post('/sessions', {
        computerId: computer.id,
        ...where,
        sessionSettings: { interactionMode: 'auto', autonomyLevel: autonomy, ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}) },
      });
    } catch (err) {
      floor.cloud.release(deskId);
      throw err;
    }
    if (typeof made?.sessionId !== 'string' || !made.sessionId) {
      floor.cloud.release(deskId);
      throw new HttpError(502, "Factory made no session (it didn't say which)");
    }
    const info = floor.cloud.add({
      deskId,
      by,
      sessionId: made.sessionId,
      prompt: prompt || (images.length ? 'See the attached images' : undefined),
      model: typeof made.sessionSettings?.model === 'string' ? made.sessionSettings.model : model,
      effort,
      cloud: { computerId: computer.id, computerName: computer.name, provider: computer.providerType, ...where, autonomy },
    });
    if (info.prompt) {
      const task = fallbackTask(info.prompt);
      floor.cloud.update(info.id, (i) => {
        i.task = task;
      });
    }
    this.opts.toast(floor.id, `${by} hired ${info.name} on ${cloudBadge(info.cloud!)}${info.prompt ? ' with a task' : ''}`);
    if (prompt || images.length) {
      void this.send(info.id, prompt, images).then((why) => {
        if (why) this.opts.toast(floor.id, `☁ ${info.name} didn't get its first prompt: ${why instanceof Error ? why.message : why}`, 'warn');
      });
    }
    return floor.cloud.get(info.id) ?? info;
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
    if (!api) return "The office isn't connected to Factory: connect it in ⚙️ Settings → Factory";
    if (info.cloud?.error) return `${info.name} can't take prompts right now: ${info.cloud.error}`;
    const before = info.status;
    const was = floor.cloud.turn(id) ?? {};
    const count = floor.cloud.seen(id)?.count ?? 0;
    floor.cloud.update(id, (i, w) => {
      w.turn = { sentAt: this.now(), countAtSend: count };
      i.activity = clip(message, 80);
      i.lastInputAt = this.now();
      if (!i.task) i.task = fallbackTask(message);
      if (!i.prompt) i.prompt = message;
    });
    floor.cloud.setStatus(id, 'working');
    try {
      const r = await this.whileNew(info, () => api.post<{ status?: unknown }>(`/sessions/${encodeURIComponent(info.sessionId!)}/messages`, { text: message, ...(pictures.length ? { images: pictures } : {}) }));
      if (r?.status === 'running' || r?.status === 'pending')
        floor.cloud.update(id, (_, w) => {
          w.turn = { ...w.turn, seenBusy: true };
        });
    } catch (err) {
      floor.cloud.update(id, (i, w) => {
        w.turn = was;
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
   * and deleted when `deleteSession` (otherwise it stays in the Sessions window). Resolves to what to
   * tell the floor about the session, if anything.
   */
  async sendHome(id: string, deleteSession: boolean): Promise<{ note?: string; error?: string }> {
    const found = this.find(id);
    if (!found) return {};
    const { floor, info } = found;
    floor.cloud.remove(id);
    this.due.delete(id);
    const sid = info.sessionId;
    const busy = info.status === 'working' || info.status === 'starting';
    if (!sid || (!busy && !deleteSession)) return {};
    const api = this.host.api();
    if (!api) return { error: `☁ The office isn't connected to Factory, so ${info.name}'s session ${deleteSession ? 'is still there' : 'keeps going'} on ${info.cloud?.computerName ?? 'Factory'}` };
    const path = `/sessions/${encodeURIComponent(sid)}`;
    const asked = this.now();
    try {
      if (busy) await this.whileNew(info, () => api.post(`${path}/interrupt`, {}));
      if (deleteSession) await this.whileNew(info, () => api.delete(path));
    } catch (err) {
      // A 404 for a session past its first moments: it's gone already, which is what was wanted.
      if (!alreadyGone(err, info.createdAt, asked)) return { error: `☁ ${info.name}'s session: ${(err as Error).message}` };
    }
    if (deleteSession) this.opts.sessionDeleted?.(sid);
    if (deleteSession) return { note: `🗑️ ${info.name}'s Factory session was deleted` };
    return { note: `☁ ${info.name}'s session was stopped; it stays in Factory's sessions` };
  }

  /** Reads every cloud worker's session that's due: each working one at every poll, the rest on the slow clock. */
  async poll(api: FactoryApi): Promise<void> {
    const now = this.now();
    const jobs: Promise<void>[] = [];
    for (const floor of this.opts.floors()) {
      for (const info of floor.cloud.list()) {
        if (!info.sessionId) continue;
        const busy = info.status === 'working' || info.status === 'starting' || this.awaitingReply(floor, info.id, now);
        const wait = busy ? 0 : IDLE_EVERY_MS - this.fastInterval;
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
    const sid = encodeURIComponent(info.sessionId!);
    const computers = this.opts.computers();
    const computer = computers?.items.find((c) => c.id === info.cloud?.computerId);
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
    floor.cloud.update(id, (i) => {
      if (i.cloud?.error) {
        i.cloud = { ...i.cloud, error: undefined };
        if (i.activity?.startsWith('☁ ')) i.activity = i.task?.summary ?? 'Waiting for a prompt';
      }
      if (computer && i.cloud && computer.name !== i.cloud.computerName) i.cloud = { ...i.cloud, computerName: computer.name };
      const model = s?.sessionSettings?.model;
      const effort = s?.sessionSettings?.reasoningEffort;
      if (typeof model === 'string' && model) i.activeModel = model;
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
  /** Hand an issue to it (a card dropped on its desk): assigned on the forge. */
  takeIssue?(issue: number): void;
}

/**
 * Cloud workers in the office: the feature registered with the Factory registry, and what server.ts
 * calls for a ws message about one. Returns undefined when `workerId` isn't a cloud worker's.
 */
export function mountCloud(registry: FactoryRegistry, opts: Omit<CloudOptions, 'computers'>) {
  const feature = registry.register(
    (host) =>
      new CloudFeature(host, {
        ...opts,
        computers: () => registry.feature('computers')?.state(),
        sessionDeleted: (id) => (registry.feature('sessions') as SessionsFeature | undefined)?.forget(id),
      }),
  ) as CloudFeature;

  /** Handles a message about a cloud worker; false when it isn't one. */
  const message = (msg: WorkerMsg, ctx: CloudMessageContext): boolean => {
    const found = feature.find(msg.workerId);
    if (!found) return false;
    const { floor, info } = found;
    switch (msg.t) {
      case 'worker.attach':
        floor.cloud.attach(info.id, ctx.client);
        break;
      case 'worker.detach':
        floor.cloud.detach(info.id, ctx.client);
        break;
      case 'worker.kill':
        opts.toast(floor.id, `${ctx.who} sent ${info.name} home`);
        void feature.sendHome(info.id, msg.deleteSession === true).then(({ note, error }) => {
          if (note) opts.toast(floor.id, note);
          if (error) opts.toast(floor.id, error, 'warn');
        });
        break;
      case 'worker.prompt': {
        const issue = Number.isInteger(msg.issue) && (msg.issue as number) > 0 ? (msg.issue as number) : undefined;
        void feature.send(info.id, str(msg.prompt, PROMPT_MAX), imageIds(msg.images)).then((why) => {
          if (why) return ctx.warn(why instanceof Error ? why.message : why);
          if (issue) {
            opts.toast(floor.id, `${ctx.who} handed issue #${issue} to ${info.name}`);
            ctx.takeIssue?.(issue);
          }
        });
        break;
      }
      case 'worker.resume':
        ctx.warn(`☁ Checking ${info.name}'s session on Factory again`);
        feature.recheck(info.id);
        break;
      case 'term.input':
      case 'term.resize':
      case 'changes.unwatch':
        break;
      default:
        ctx.warn(cloudRefusal(info, msg.t));
    }
    return true;
  };

  return { feature, message, find: (id: string) => feature.find(id) };
}

/** Why something the office does with a local worker isn't done to a cloud one. */
export function cloudRefusal(w: WorkerInfo, t: ClientMsg['t']): string {
  const where = w.cloud ? cloudBadge(w.cloud) : 'a Factory computer';
  if (t === 'worker.shoot' || t === 'worker.revive') return `${w.name} works on ${where}: there's nobody really at this desk to shoot`;
  if (t === 'worker.pr' || t.startsWith('changes.')) return `${w.name} works on ${where}, not in a checkout on this machine: ask it to commit and open the pull request itself`;
  return `${w.name} works on ${where}: that only works for a worker on this machine`;
}
