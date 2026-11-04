import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkerInfo } from '../shared/protocol.js';
import type { RemoteMcpKey } from '../shared/remote-mcp.js';

/** Named keys a bot may hold besides its main key. */
export const MAX_KEYS = 10;
const TOUCH_MS = 60_000;

const messageSchema = z.object({ id: z.string(), at: z.number(), text: z.string().max(24_000), floor: z.string().optional() });
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const keySchema = z.object({ id: z.string(), name: z.string().min(1).max(60), token: tokenSchema, createdAt: z.number(), lastUsedAt: z.number().optional() });
const savedSchema = z.object({
  id: z.string(),
  floor: z.string(),
  deskId: z.string(),
  name: z.string().min(1).max(60),
  createdAt: z.number(),
  token: tokenSchema,
  /** When the main key last authenticated, to the minute. */
  lastUsedAt: z.number().optional(),
  /** Extra named keys for the same identity, one per client, each revocable on its own. */
  keys: z.array(keySchema).max(MAX_KEYS).optional(),
  inbox: z.array(messageSchema).max(500),
});
type SavedRemote = z.infer<typeof savedSchema>;
export type RemoteMessage = z.infer<typeof messageSchema>;
/** Which of a bot's keys a request used: `main` for the one Settings first gave it, otherwise a named key's id. */
export type RemoteKeyId = 'main' | (string & {});
export type RemoteKey = Omit<RemoteMcpKey, 'connection'>;

/**
 * One authoritative file for remote identities and their seats, including across floor moves. It keeps each
 * bot's credential (mode 0600, like workers.json's hook tokens) so Settings can show it again.
 */
export class RemoteWorkers {
  private records: SavedRemote[];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'remote-workers.json');
    try {
      this.records = z.array(savedSchema).parse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (new Set(this.records.map((r) => r.id)).size !== this.records.length) throw new Error('Duplicate remote worker identity');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read remote-workers.json; remote identities were not reset', { cause: err });
      this.records = [];
    }
  }

  list() {
    return this.records.map(({ token: _token, keys, inbox, ...r }) => ({ ...r, keys: (keys ?? []).map(({ token: _t, ...k }): RemoteKey => k), unread: inbox.length }));
  }

  token(id: string, key: RemoteKeyId = 'main'): string | undefined {
    const row = this.records.find((r) => r.id === id);
    return key === 'main' ? row?.token : row?.keys?.find((k) => k.id === key)?.token;
  }

  workers(floor: string): WorkerInfo[] {
    return this.records.filter((r) => r.floor === floor).map((r) => this.info(r));
  }

  identity(id: string): WorkerInfo | undefined {
    const row = this.records.find((r) => r.id === id);
    return row ? this.info(row) : undefined;
  }

  private info(r: SavedRemote): WorkerInfo {
    return {
      id: r.id,
      kind: 'agent',
      remote: true,
      deskId: r.deskId,
      name: r.name,
      color: '#ad8dff',
      createdAt: r.createdAt,
      createdBy: 'owner',
      status: 'offline',
      acked: true,
      cols: 100,
      rows: 30,
      open: false,
      activity: 'Remote worker, polls the MCP inbox',
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

  add(name: string, floor: string, deskId: string): { worker: WorkerInfo; token: string } {
    const token = randomBytes(32).toString('hex');
    const row: SavedRemote = { id: `remote-${randomBytes(12).toString('hex')}`, floor, deskId, name, createdAt: Date.now(), token, inbox: [] };
    this.commit([...this.records, row]);
    return { worker: this.info(row), token };
  }

  rotate(id: string): string {
    const token = randomBytes(32).toString('hex');
    this.change(id, (r) => ({ ...r, token, lastUsedAt: undefined }));
    return token;
  }

  remove(id: string) {
    this.commit(this.records.filter((r) => r.id !== id));
  }

  move(id: string, floor: string, deskId: string) {
    this.change(id, (r) => ({ ...r, floor, deskId }));
  }

  enqueue(id: string, text: string, floor?: string): string | undefined {
    const row = this.records.find((r) => r.id === id);
    if (!row) return 'Remote worker was revoked';
    if (!text.trim()) return 'Empty message';
    if (text.length > 24_000) return 'Remote message is too long';
    if (row.inbox.length >= 500) return 'Remote inbox is full; the worker must acknowledge messages first';
    try {
      this.change(id, (r) => ({ ...r, inbox: [...r.inbox, { id: randomBytes(12).toString('hex'), at: Date.now(), text, floor }] }));
      return undefined;
    } catch {
      return 'Could not save the remote message; it was not delivered';
    }
  }

  /** Reads never consume messages. Acknowledgments name exact messages, not a high-water mark. */
  inbox(id: string, ack: readonly string[] = [], limit = 50): { messages: RemoteMessage[]; remaining: number } {
    let row = this.records.find((r) => r.id === id);
    if (!row) throw new Error('Remote worker was revoked');
    if (ack.length) {
      const ids = new Set(ack);
      this.change(id, (r) => ({ ...r, inbox: r.inbox.filter((m) => !ids.has(m.id)) }));
      row = this.records.find((r) => r.id === id)!;
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
    try {
      writeFileSync(temporary, `${JSON.stringify(records)}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
      this.records = records;
    } finally {
      rmSync(temporary, { force: true });
    }
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
