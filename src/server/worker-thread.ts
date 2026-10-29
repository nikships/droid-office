import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { ThreadEntry } from '../shared/worker-thread.js';
import { LABEL_TEXT_CHARS } from '../shared/worker-labels.js';
import { DROID_SESSIONS_DIR } from './droid-session.js';

const PAGE_SIZE = 100;
const FIELD_CHARS = 12_000;
const RESPONSE_BYTES = 900_000;
const LINE_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const TRUNCATED = '\n[… truncated]';
const SESSION_ID = /^[a-zA-Z0-9-]{1,160}$/;

export interface ThreadSession {
  sessionId: string;
  cwd: string;
  /** Ignore text preceding an Office /clear, even if Droid keeps the same session file. */
  since?: number;
}

export interface ThreadPage {
  sessionId?: string;
  entries: ThreadEntry[];
  hasMore: boolean;
  error?: string;
}

interface Projection {
  text: string;
  since: number;
  entries: ThreadEntry[];
  tools: Map<string, ThreadEntry>;
  bytes: number;
  seq: number;
  dropped: boolean;
  before: number;
}

interface CachedSession {
  file?: string;
  stamp?: string;
  inode?: string;
  size: number;
  position: number;
  pending: Buffer;
  oversized: boolean;
  head: Buffer;
  tail: Buffer;
  projection: Projection;
  refresh?: Promise<void>;
  pages: Map<number, Promise<ThreadPage>>;
}

const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Only printable content is projected; transport metadata is never serialized. */
function clean(value: unknown, limit = FIELD_CHARS): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/<system-reminder\b[^>]*>[\s\S]*?(?:<\/system-reminder\s*>|$)/gi, '')
    .replace(/data:[^\s"'<>]*;base64,[a-zA-Z0-9+/=\s]+/gi, '[attachment omitted]')
    .replace(/[a-zA-Z0-9+/]{256,}={0,2}/g, '[binary data omitted]')
    .trim();
  return text.length > limit ? text.slice(0, limit) + TRUNCATED : text;
}

function pretty(value: unknown): string {
  return clean(
    JSON.stringify(
      value,
      (key, item: unknown) => {
        if (/^(signature|signatureProvider|encrypted.*|system.?prompt|systemInfo.*|hook.*|userMessageSource|data)$/i.test(key)) return undefined;
        if (typeof item === 'string') return clean(item);
        return item;
      },
      2,
    ),
  );
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) return '';
  return clean(
    content
      .slice(0, 1024)
      .map((part) => {
        const p = object(part);
        return p.type === 'text' ? clean(p.text) : p.type === 'image' ? '[Image attachment]' : '';
      })
      .filter(Boolean)
      .join('\n'),
  );
}

const projection = (before = Infinity, since = 0): Projection => ({ text: '', since, entries: [], tools: new Map(), bytes: 0, seq: 0, dropped: false, before });
const entryBytes = (entry: ThreadEntry) => Buffer.byteLength(JSON.stringify(entry));

/** A bounded recent window, with disk scans only for explicit older-page requests. */
export class WorkerThreadReader {
  private sessions = new Map<string, CachedSession>();

  constructor(
    private root = DROID_SESSIONS_DIR,
    private limits = { sessions: 8, entries: 1000, bytes: 2 * 1024 * 1024 },
    private textOnly = false,
  ) {}

  /** Independent text window: a long stretch of tools cannot evict the conversation. */
  async readText(source: ThreadSession): Promise<string | undefined> {
    const page = await this.read(source);
    if (page.error) return;
    return this.sessions.get(JSON.stringify([source.cwd, source.sessionId, source.since ?? 0]))?.projection.text;
  }

  async read(source: ThreadSession, before?: number): Promise<ThreadPage> {
    const { sessionId, cwd } = source;
    if (!SESSION_ID.test(sessionId) || !path.isAbsolute(cwd)) return this.unavailable();
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) return this.unavailable('Invalid conversation page.');
    const key = JSON.stringify([cwd, sessionId, source.since ?? 0]);
    let cached = this.sessions.get(key);
    if (!cached) {
      while (this.sessions.size >= this.limits.sessions) {
        const idle = [...this.sessions].find(([, item]) => !item.refresh && !item.pages.size);
        if (!idle) return this.unavailable('Conversation reader is busy. Try again shortly.');
        this.sessions.delete(idle[0]);
      }
      cached = this.empty(source.since);
      this.sessions.set(key, cached);
    }
    // Map order is the bounded LRU, including a worker changing session or cwd.
    this.sessions.delete(key);
    this.sessions.set(key, cached);
    const state = cached;
    try {
      if (!state.refresh) state.refresh = this.refresh(state, source).finally(() => (state.refresh = undefined));
      await state.refresh;
      if (!state.file) return this.unavailable('The local conversation file is not available yet.');
      const oldest = state.projection.entries[0]?.seq ?? Infinity;
      if (before === undefined || !state.projection.dropped || before > oldest) return { sessionId, ...this.page(state.projection, before) };
      let page = state.pages.get(before);
      if (!page) {
        if (state.pages.size >= 4) return this.unavailable('Conversation reader is busy. Try again shortly.');
        page = this.older(state.file, sessionId, before).finally(() => state.pages.delete(before));
        state.pages.set(before, page);
      }
      return await page;
    } catch {
      // A disappearing/replaced file must never keep serving another session's stale cache.
      Object.assign(state, this.empty(source.since));
      return this.unavailable('The local conversation could not be read. Try again shortly.');
    }
  }

  private unavailable(error = 'Conversation is unavailable for this worker.'): ThreadPage {
    return { entries: [], hasMore: false, error };
  }

  private empty(since = 0): CachedSession {
    return { size: 0, position: 0, pending: Buffer.alloc(0), oversized: false, head: Buffer.alloc(0), tail: Buffer.alloc(0), projection: projection(Infinity, since), pages: new Map() };
  }

  private async find({ sessionId, cwd }: ThreadSession): Promise<string | undefined> {
    const name = `${sessionId}.jsonl`;
    const canonical = await realpath(cwd).catch(() => cwd);
    for (const directory of new Set([cwd, canonical])) {
      const guess = path.join(this.root, directory.replace(/[^a-zA-Z0-9-]/g, '-'), name);
      if (
        await stat(guess).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        return guess;
    }
    // Match Droid's discovery fallback, but validate the recorded cwd before using a fallback.
    for (const directory of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!directory.isDirectory()) continue;
      const file = path.join(this.root, directory.name, name);
      const handle = await open(file, 'r').catch(() => undefined);
      if (!handle) continue;
      try {
        const head = await this.bytes(handle, 0, CHUNK_BYTES);
        const newline = head.indexOf(10);
        if (newline < 0) continue;
        const start = object(JSON.parse(head.subarray(0, newline).toString('utf8')));
        if (start.type === 'session_start' && typeof start.cwd === 'string' && (start.cwd === cwd || (await realpath(start.cwd).catch(() => start.cwd)) === canonical)) return file;
      } catch {
        // An incomplete header can be retried on the next read.
      } finally {
        await handle.close();
      }
    }
    return undefined;
  }

  private async refresh(state: CachedSession, source: ThreadSession): Promise<void> {
    state.file ??= await this.find(source);
    if (!state.file) return;
    const handle = await open(state.file, 'r');
    try {
      const info = await handle.stat();
      const inode = `${info.dev}:${info.ino}`;
      const stamp = `${inode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (stamp === state.stamp) return;
      let reset = state.inode !== inode || info.size <= state.size;
      if (!reset && state.position) {
        const head = await this.bytes(handle, 0, state.head.length);
        const tail = await this.bytes(handle, state.position - state.tail.length, state.tail.length);
        reset = !head.equals(state.head) || !tail.equals(state.tail);
      }
      if (reset) {
        state.position = 0;
        state.pending = Buffer.alloc(0);
        state.oversized = false;
        state.projection = projection(Infinity, state.projection.since);
      }
      await this.consume(handle, state, info.size);
      state.head = await this.bytes(handle, 0, Math.min(256, state.position));
      state.tail = await this.bytes(handle, Math.max(0, state.position - 256), Math.min(256, state.position));
      state.inode = inode;
      state.size = info.size;
      state.stamp = stamp;
    } finally {
      await handle.close();
    }
  }

  private async bytes(handle: FileHandle, position: number, size: number): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, position);
    return buffer.subarray(0, bytesRead);
  }

  private async consume(handle: FileHandle, state: CachedSession, end: number): Promise<void> {
    while (state.position < end) {
      const chunk = await this.bytes(handle, state.position, Math.min(CHUNK_BYTES, end - state.position));
      if (!chunk.length) break;
      state.position += chunk.length;
      let start = 0;
      for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, at);
        if (!state.oversized && state.pending.length + part.length <= LINE_BYTES) {
          this.record(state.projection, Buffer.concat([state.pending, part]).toString('utf8'));
        } else {
          this.add(state.projection, { id: `oversized:${state.projection.seq}`, role: 'system', kind: 'notice', text: 'A conversation record was too large to display.' });
        }
        state.pending = Buffer.alloc(0);
        state.oversized = false;
        start = at + 1;
      }
      if (start < chunk.length && !state.oversized) {
        if (state.pending.length + chunk.length - start > LINE_BYTES) {
          state.pending = Buffer.alloc(0);
          state.oversized = true;
        } else {
          state.pending = Buffer.concat([state.pending, chunk.subarray(start)]);
        }
      }
    }
    // The final unterminated record stays pending, and is never parsed until its newline arrives.
  }

  private trim(state: Projection): void {
    while (state.entries.length > this.limits.entries || state.bytes > this.limits.bytes) {
      const removed = state.entries.shift();
      if (!removed) break;
      state.bytes -= entryBytes(removed);
      if (removed.kind === 'tool') state.tools.delete(removed.id);
      state.dropped = true;
    }
  }

  private add(state: Projection, value: Omit<ThreadEntry, 'seq'>): void {
    const entry = { ...value, seq: state.seq++ };
    if (entry.seq >= state.before) return;
    state.entries.push(entry);
    state.bytes += entryBytes(entry);
    if (entry.kind === 'tool') state.tools.set(entry.id, entry);
    this.trim(state);
  }

  private record(state: Projection, line: string): void {
    let row: Record<string, unknown>;
    try {
      row = object(JSON.parse(line));
    } catch {
      return;
    }
    if (this.textOnly && row.type !== 'message') return;
    const id = clean(row.id, 160) || `record:${state.seq}`;
    if (row.type === 'agent_turn_outcome') {
      const reason = clean(row.reason, 80);
      this.add(state, { id: `turn:${clean(row.turnId, 160) || id}:${reason}`, role: 'system', kind: 'notice', text: reason === 'cancelled' ? 'Turn cancelled' : reason ? `Turn ended · ${reason}` : 'Turn ended' });
      return;
    }
    if (row.type === 'todo_state') {
      const todos = object(row.todos).todos;
      if (Array.isArray(todos)) {
        const text = clean(
          todos
            .slice(0, 100)
            .map((todo, index) => {
              const item = object(todo);
              const status = item.status === 'completed' ? 'completed' : item.status === 'in_progress' ? 'in progress' : 'pending';
              return `${index + 1}. [${status}] ${clean(item.content)}`;
            })
            .join('\n'),
        );
        if (text) this.add(state, { id: `${id}:todo`, role: 'system', kind: 'todo', text });
      }
      return;
    }
    if (row.type !== 'message') return;
    const message = object(row.message);
    if (message.role !== 'user' && message.role !== 'assistant') return;
    if ([message, row].some((item) => Object.keys(item).some((key) => key.startsWith('hook')))) return;
    if ([message.visibility, row.visibility].some((visibility) => visibility !== undefined && visibility !== 'both' && visibility !== 'user_only')) return;
    if (message.userMessageSource && message.userMessageSource !== 'cli_tui') return;
    const role = message.role;
    const timestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    if (!state.since || (Number.isFinite(timestamp) && timestamp >= state.since)) {
      const parts =
        typeof message.content === 'string'
          ? [message.content]
          : Array.isArray(message.content)
            ? message.content
                .slice(0, 1024)
                .filter((part) => object(part).type === 'text')
                .map((part) => object(part).text)
            : [];
      for (const part of parts) {
        const text = clean(part, Infinity).slice(-LABEL_TEXT_CHARS);
        if (text) state.text = `${state.text}\n\n${role}: ${text}`.slice(-LABEL_TEXT_CHARS);
      }
    }
    if (this.textOnly) return;
    if (typeof message.content === 'string') {
      const text = clean(message.content);
      if (text) this.add(state, { id: `${id}:text`, role, kind: 'text', text });
      return;
    }
    if (!Array.isArray(message.content)) return;
    for (const [index, value] of message.content.slice(0, 1024).entries()) {
      const part = object(value);
      const partId = `${id}:${index}`;
      if (part.type === 'tool_result') {
        const toolId = clean(part.tool_use_id, 160);
        const tool = state.tools.get(`tool:${toolId}`);
        if (!tool) continue;
        state.bytes -= entryBytes(tool);
        tool.output = contentText(part.content);
        tool.error = part.is_error === true;
        tool.resultSeq = state.seq;
        state.bytes += entryBytes(tool);
        this.trim(state);
      } else if (part.type === 'tool_use') {
        const toolId = clean(part.id, 160);
        if (!toolId) continue;
        this.add(state, { id: `tool:${toolId}`, role: 'assistant', kind: 'tool', name: clean(part.name, 160), input: pretty(part.input) });
      } else if (part.type === 'image') {
        this.add(state, { id: partId, role, kind: 'notice', text: '[Image attachment]' });
      } else if (part.type === 'text' || part.type === 'thinking') {
        const text = clean(part.type === 'text' ? part.text : part.thinking);
        if (text) this.add(state, { id: partId, role, kind: part.type === 'thinking' ? 'thinking' : 'text', text });
      }
    }
  }

  private page(state: Projection, before = Infinity): Omit<ThreadPage, 'sessionId'> {
    const candidates = state.entries.filter((entry) => entry.seq < before);
    const entries = candidates.slice(-PAGE_SIZE).map((entry) => ({ ...entry }));
    let bytes = Buffer.byteLength(JSON.stringify(entries));
    while (bytes > RESPONSE_BYTES && entries.length > 1) {
      const removed = entries.shift();
      if (removed) bytes -= entryBytes(removed) + 1;
    }
    return { entries, hasMore: candidates.length > entries.length || (state.dropped && before > 0) };
  }

  private async older(file: string, sessionId: string, before: number): Promise<ThreadPage> {
    const state = this.empty();
    state.projection = projection(before);
    const handle = await open(file, 'r');
    try {
      await this.consume(handle, state, (await handle.stat()).size);
      return { sessionId, ...this.page(state.projection, before) };
    } finally {
      await handle.close();
    }
  }
}
