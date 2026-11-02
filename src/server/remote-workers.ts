import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkerInfo } from '../shared/protocol.js';

const messageSchema = z.object({ id: z.string(), at: z.number(), text: z.string().max(24_000), floor: z.string().optional() });
const savedSchema = z.object({
  id: z.string(),
  floor: z.string(),
  deskId: z.string(),
  name: z.string().min(1).max(60),
  createdAt: z.number(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  inbox: z.array(messageSchema).max(500),
});
type SavedRemote = z.infer<typeof savedSchema>;
export type RemoteMessage = z.infer<typeof messageSchema>;

/** One authoritative file for remote identities and their seats, including across floor moves. */
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
    return this.records.map(({ tokenHash: _token, inbox, ...r }) => ({ ...r, unread: inbox.length }));
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

  authenticate(id: string, token: string): boolean {
    const row = this.records.find((r) => r.id === id);
    return !!row && timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), hash(token));
  }

  add(name: string, floor: string, deskId: string): { worker: WorkerInfo; token: string } {
    const token = randomBytes(32).toString('hex');
    const row: SavedRemote = { id: `remote-${randomBytes(12).toString('hex')}`, floor, deskId, name, createdAt: Date.now(), tokenHash: hash(token).toString('hex'), inbox: [] };
    this.commit([...this.records, row]);
    return { worker: this.info(row), token };
  }

  rotate(id: string): string {
    const token = randomBytes(32).toString('hex');
    this.change(id, (r) => ({ ...r, tokenHash: hash(token).toString('hex') }));
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
