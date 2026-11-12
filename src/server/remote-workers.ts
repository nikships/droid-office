import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkerInfo } from '../shared/protocol.js';
import { validateGrokWebhookUrl, type RemoteMcpGrokBot, type RemoteMcpKey, type RemoteMcpWebhookDelivery } from '../shared/remote-mcp.js';
import type { GrokBotCredentials } from './grok-webhook.js';

/** Named keys a bot may hold besides its main key. */
export const MAX_KEYS = 10;
export const GROK_BOTS_FILE = 'remote-grok-bots.json';
const TOUCH_MS = 60_000;

const messageSchema = z.object({ id: z.string(), at: z.number(), text: z.string().max(24_000), floor: z.string().optional() });
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const keySchema = z.object({ id: z.string(), name: z.string().min(1).max(60), token: tokenSchema, createdAt: z.number(), lastUsedAt: z.number().optional() });
const grokBotSchema = z.object({
  webhookUrl: z.string().min(1).max(2000),
  webhookToken: z.string().min(1).max(1000),
});
const savedSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  createdAt: z.number(),
  token: tokenSchema,
  /** When the main key last authenticated, to the minute. */
  lastUsedAt: z.number().optional(),
  /** Extra named keys for the same identity, one per client, each revocable on its own. */
  keys: z.array(keySchema).max(MAX_KEYS).optional(),
  /** Present when this bot's MCP key is marked as a Grok Bot with push webhook delivery. */
  grokBot: grokBotSchema.optional(),
  inbox: z.array(messageSchema).max(500),
});
type SavedRemote = z.infer<typeof savedSchema>;
/** What a bot last said it is doing with office_status; offline until it says, after every office start. */
type Reported = { status: 'idle' | 'working' | 'done'; activity?: string };
export type RemoteMessage = z.infer<typeof messageSchema>;
/** Which of a bot's keys a request used: `main` for the one Settings first gave it, otherwise a named key's id. */
export type RemoteKeyId = 'main' | (string & {});
export type RemoteKey = Omit<RemoteMcpKey, 'connection'>;

export interface GrokBotInput {
  webhookUrl: string;
  /** Required when enabling Grok Bot on a bot with no saved token; optional when updating an existing Grok Bot's URL. */
  webhookToken?: string;
}

function parseWebhookToken(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 1000 || /[\r\n]/.test(trimmed)) throw new Error('Invalid webhook bearer token');
  return trimmed;
}

function parseGrokBot(input: GrokBotInput, existingToken?: string): GrokBotCredentials {
  const checked = validateGrokWebhookUrl(input.webhookUrl);
  if ('error' in checked) throw new Error(checked.error);
  const token = parseWebhookToken(input.webhookToken) ?? existingToken;
  if (!token) throw new Error('Enter the Grok Bot webhook bearer token');
  return { webhookUrl: checked.url, webhookToken: token };
}

/**
 * One authoritative file for external bots, the building agents that run elsewhere. They have no floor or desk
 * (see docs/mission-control.md): a record saved with one loads without it. It keeps each bot's credential
 * (mode 0600, like workers.json's hook tokens) so Settings can show it again.
 */
export class RemoteWorkers {
  private records: SavedRemote[];
  private readonly file: string;
  private readonly grokFile: string;
  private reported = new Map<string, Reported>();
  private deliveries = new Map<string, RemoteMcpWebhookDelivery>();
  /** Bounded in-session history of acknowledged direct messages so overlapping webhook runs still see `acked: true` (team events persist in `team.json`). */
  private ackedHistory = new Map<string, Map<string, RemoteMessage>>();

  constructor(
    dataDir: string,
    /** A bot was added, removed, reported its status, or a key of it was used. */
    private readonly changed: () => void = () => {},
  ) {
    this.file = path.join(dataDir, 'remote-workers.json');
    this.grokFile = path.join(dataDir, GROK_BOTS_FILE);
    try {
      // zod drops the floor and desk an office from before Mission Control saved, so their desks are free.
      this.records = z.array(savedSchema).parse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (new Set(this.records.map((r) => r.id)).size !== this.records.length) throw new Error('Duplicate remote worker identity');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read remote-workers.json; remote identities were not reset', { cause: err });
      this.records = [];
    }
    try {
      const sidecar = z.record(z.string(), grokBotSchema).parse(JSON.parse(readFileSync(this.grokFile, 'utf8')));
      this.records = this.records.map((r) => (!r.grokBot && sidecar[r.id] ? { ...r, grokBot: sidecar[r.id] } : r));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read ${GROK_BOTS_FILE}; Grok Bot webhooks were not reset`, { cause: err });
    }
  }

  list() {
    return this.records.map(({ token: _token, keys, grokBot, inbox, ...r }) => {
      const lastDelivery = this.deliveries.get(r.id);
      const safeGrokBot: RemoteMcpGrokBot | undefined = grokBot ? { webhookUrl: grokBot.webhookUrl, hasToken: Boolean(grokBot.webhookToken), ...(lastDelivery ? { lastDelivery } : {}) } : undefined;
      return {
        ...r,
        keys: (keys ?? []).map(({ token: _t, ...k }): RemoteKey => k),
        ...(safeGrokBot ? { grokBot: safeGrokBot } : {}),
        unread: inbox.length,
      };
    });
  }

  isGrokBot(id: string): boolean {
    return Boolean(this.records.find((r) => r.id === id)?.grokBot);
  }

  hasGrokBots(): boolean {
    return this.records.some((r) => Boolean(r.grokBot));
  }

  /** Server-only credentials for pushing to a Grok Bot's webhook; never exposed in list() or HTTP state. */
  grokWebhook(id: string): GrokBotCredentials | undefined {
    const g = this.records.find((r) => r.id === id)?.grokBot;
    return g ? { webhookUrl: g.webhookUrl, webhookToken: g.webhookToken } : undefined;
  }

  recordDelivery(id: string, delivery: RemoteMcpWebhookDelivery) {
    if (!this.records.some((r) => r.id === id)) return;
    this.deliveries.set(id, delivery);
    this.changed();
  }

  token(id: string, key: RemoteKeyId = 'main'): string | undefined {
    const row = this.records.find((r) => r.id === id);
    return key === 'main' ? row?.token : row?.keys?.find((k) => k.id === key)?.token;
  }

  /** Every bot, in the order they were added. */
  workers(): WorkerInfo[] {
    return this.records.map((r) => this.info(r));
  }

  /** When any of the bot's keys last authenticated. */
  lastUsedAt(id: string): number | undefined {
    const row = this.records.find((r) => r.id === id);
    const times = [row?.lastUsedAt, ...(row?.keys ?? []).map((k) => k.lastUsedAt)].filter((t): t is number => t !== undefined);
    return times.length ? Math.max(...times) : undefined;
  }

  /** What the bot says it is doing (office_status). Kept only while the office runs. */
  report(id: string, status: Reported['status'], activity?: string) {
    if (!this.records.some((r) => r.id === id)) throw new Error('Remote worker was revoked');
    const before = this.reported.get(id);
    this.reported.set(id, { status, activity: activity ?? before?.activity });
    this.changed();
  }

  identity(id: string): WorkerInfo | undefined {
    const row = this.records.find((r) => r.id === id);
    return row ? this.info(row) : undefined;
  }

  private info(r: SavedRemote): WorkerInfo {
    const said = this.reported.get(r.id);
    return {
      id: r.id,
      kind: 'agent',
      remote: true,
      deskId: '',
      name: r.name,
      color: '#ad8dff',
      createdAt: r.createdAt,
      createdBy: 'owner',
      status: said?.status ?? 'offline',
      acked: true,
      cols: 100,
      rows: 30,
      open: false,
      activity: said?.activity ?? (r.grokBot ? 'Grok Bot, woken by webhook' : 'External bot, polls the MCP inbox'),
    };
  }

  /** The identity a key belongs to, so a client that sends only its key needn't know its worker id. */
  resolve(token: string): { id: string; key: RemoteKeyId } | undefined {
    for (const row of this.records) {
      const key = matchKey(row, token);
      if (key) return { id: row.id, key };
    }
    return undefined;
  }

  /** Records that a key was just used. Saved at most once a minute per key, so a busy bot doesn't rewrite the file on every call. */
  touch(id: string, key: RemoteKeyId, now = Date.now()) {
    const row = this.records.find((r) => r.id === id);
    const last = key === 'main' ? row?.lastUsedAt : row?.keys?.find((k) => k.id === key)?.lastUsedAt;
    // A clock set back must not freeze the time until it catches up again.
    if (!row || (last !== undefined && now >= last && now - last < TOUCH_MS)) return;
    try {
      this.change(id, (r) => (key === 'main' ? { ...r, lastUsedAt: now } : { ...r, keys: r.keys?.map((k) => (k.id === key ? { ...k, lastUsedAt: now } : k)) }));
    } catch {
      // The call already authenticated; a "last used" time that can't be saved must not refuse it.
    }
  }

  addKey(id: string, name: string): { key: RemoteKey; token: string } {
    const row = this.records.find((r) => r.id === id);
    if (!row) throw new Error('Remote worker was revoked');
    const label = name.trim();
    if (!label || label.length > 60) throw new Error('Give the key a name of up to 60 characters');
    if ((row.keys?.length ?? 0) >= MAX_KEYS) throw new Error(`A bot has at most ${MAX_KEYS} named keys; revoke one first`);
    if (row.keys?.some((k) => k.name.toLowerCase() === label.toLowerCase())) throw new Error('This bot already has a key with that name');
    const saved = { id: `key-${randomBytes(8).toString('hex')}`, name: label, token: randomBytes(32).toString('hex'), createdAt: Date.now() };
    this.change(id, (r) => ({ ...r, keys: [...(r.keys ?? []), saved] }));
    const { token, ...key } = saved;
    return { key, token };
  }

  /** The named key stops working at once; the bot's main key and its other keys keep working. */
  revokeKey(id: string, key: string) {
    if (!this.records.find((r) => r.id === id)?.keys?.some((k) => k.id === key)) throw new Error('No such key for this bot');
    this.change(id, (r) => ({ ...r, keys: r.keys?.filter((k) => k.id !== key) }));
  }

  add(name: string, grokBot?: GrokBotInput): { worker: WorkerInfo; token: string } {
    const label = name.trim();
    if (!label || label.length > 60) throw new Error('Give the bot a name of up to 60 characters');
    if (this.records.some((r) => r.name.toLowerCase() === label.toLowerCase())) throw new Error('A bot already has that name');
    const parsedGrok = grokBot ? parseGrokBot(grokBot) : undefined;
    const token = randomBytes(32).toString('hex');
    const row: SavedRemote = {
      id: `remote-${randomBytes(12).toString('hex')}`,
      name: label,
      createdAt: Date.now(),
      token,
      ...(parsedGrok ? { grokBot: parsedGrok } : {}),
      inbox: [],
    };
    this.commit([...this.records, row]);
    return { worker: this.info(row), token };
  }

  setGrokBot(id: string, grokBot: GrokBotInput | null) {
    const row = this.records.find((r) => r.id === id);
    if (!row) throw new Error('Remote worker was revoked');
    if (grokBot === null) {
      this.deliveries.delete(id);
      this.change(id, ({ grokBot: _removed, ...rest }) => rest);
      return;
    }
    const next = parseGrokBot(grokBot, row.grokBot?.webhookToken);
    this.change(id, (r) => ({ ...r, grokBot: next }));
  }

  rotate(id: string): string {
    const token = randomBytes(32).toString('hex');
    this.change(id, (r) => ({ ...r, token, lastUsedAt: undefined }));
    return token;
  }

  remove(id: string) {
    this.reported.delete(id);
    this.deliveries.delete(id);
    this.ackedHistory.delete(id);
    this.commit(this.records.filter((r) => r.id !== id));
  }

  enqueueMessage(id: string, text: string, floor?: string): { message?: RemoteMessage; error?: string } {
    const row = this.records.find((r) => r.id === id);
    if (!row) return { error: 'Remote worker was revoked' };
    if (!text.trim()) return { error: 'Empty message' };
    if (text.length > 24_000) return { error: 'Remote message is too long' };
    if (row.inbox.length >= 500) return { error: 'Remote inbox is full; the worker must acknowledge messages first' };
    const message: RemoteMessage = { id: randomBytes(12).toString('hex'), at: Date.now(), text, ...(floor ? { floor } : {}) };
    try {
      this.change(id, (r) => ({ ...r, inbox: [...r.inbox, message] }));
      return { message };
    } catch {
      return { error: 'Could not save the remote message; it was not delivered' };
    }
  }

  enqueue(id: string, text: string, floor?: string): string | undefined {
    return this.enqueueMessage(id, text, floor).error;
  }

  /** Reads never consume messages. Acknowledgments name exact messages, not a high-water mark. */
  inbox(id: string, ack: readonly string[] = [], limit = 50, onlyIds?: ReadonlySet<string>): { messages: (RemoteMessage & { acked?: boolean })[]; remaining: number } {
    let row = this.records.find((r) => r.id === id);
    if (!row) throw new Error('Remote worker was revoked');
    if (ack.length) {
      const ids = new Set(ack);
      const removed = row.inbox.filter((m) => ids.has(m.id));
      if (removed.length) {
        let history = this.ackedHistory.get(id);
        if (!history) {
          history = new Map();
          this.ackedHistory.set(id, history);
        }
        for (const m of removed) {
          history.delete(m.id);
          history.set(m.id, { ...m });
          while (history.size > 500) {
            const oldest = history.keys().next().value;
            if (oldest !== undefined) history.delete(oldest);
          }
        }
        this.change(id, (r) => ({ ...r, inbox: r.inbox.filter((m) => !ids.has(m.id)) }));
        row = this.records.find((r) => r.id === id)!;
      }
    }
    if (onlyIds) {
      const unacked = row.inbox.filter((m) => onlyIds.has(m.id)).map((m) => ({ ...m, acked: false }));
      const unackedSet = new Set(unacked.map((m) => m.id));
      const history = this.ackedHistory.get(id);
      const acked = history ? [...history.values()].filter((m) => onlyIds.has(m.id) && !unackedSet.has(m.id)).map((m) => ({ ...m, acked: true })) : [];
      const matched = [...unacked, ...acked].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      const shown = matched.slice(0, limit);
      const shownUnacked = shown.filter((m) => !m.acked).length;
      return { messages: shown, remaining: Math.max(0, unacked.length - shownUnacked) };
    }
    return { messages: row.inbox.slice(0, limit).map((m) => ({ ...m })), remaining: Math.max(0, row.inbox.length - limit) };
  }

  private change(id: string, update: (row: SavedRemote) => SavedRemote) {
    if (!this.records.some((r) => r.id === id)) throw new Error('Remote worker was revoked');
    this.commit(this.records.map((r) => (r.id === id ? update(r) : r)));
  }

  private commit(records: SavedRemote[]) {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    const grokTmp = `${this.grokFile}.${randomBytes(8).toString('hex')}.tmp`;
    const grokMap = Object.fromEntries(records.flatMap((r) => (r.grokBot ? [[r.id, r.grokBot] as const] : [])));
    try {
      writeFileSync(temporary, `${JSON.stringify(records)}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
      if (Object.keys(grokMap).length) {
        writeFileSync(grokTmp, `${JSON.stringify(grokMap)}\n`, { mode: 0o600 });
        renameSync(grokTmp, this.grokFile);
      } else {
        rmSync(this.grokFile, { force: true });
      }
      this.records = records;
    } finally {
      rmSync(temporary, { force: true });
      rmSync(grokTmp, { force: true });
    }
    this.changed();
  }
}

function hash(token: string) {
  return createHash('sha256').update(token).digest();
}

/** Compares every key of the row, so the time taken doesn't say which one, if any, matched. */
function matchKey(row: SavedRemote, token: string): RemoteKeyId | undefined {
  const given = hash(token);
  let found: RemoteKeyId | undefined = timingSafeEqual(hash(row.token), given) ? 'main' : undefined;
  for (const k of row.keys ?? []) if (timingSafeEqual(hash(k.token), given) && !found) found = k.id;
  return found;
}
