import { mergeMessages, messageOf, RESULT_MAX, TEXT_MAX, type FactoryBlock, type FactoryMessage } from '../../shared/factory-sessions.js';

const LIMIT = 1500;
/** How many messages are kept: for an older page (dropping the newest past it), or for anything newer (dropping the oldest). */
export type Limit = (older: boolean) => number;
export const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A delayed REST page must not replace a longer streamed block with an older, shorter copy. */
function complete(a: FactoryMessage, b: FactoryMessage): FactoryMessage {
  const blocks = a.blocks.map((block, i) => {
    const incoming = b.blocks[i];
    if (!incoming) return block;
    if (block.type === incoming.type && 'text' in block && 'text' in incoming && block.text.length > incoming.text.length) return block;
    return incoming;
  });
  return { ...b, seq: b.seq ?? a.seq, blocks: [...blocks, ...b.blocks.slice(blocks.length)] };
}

/**
 * Display-only live messages, never raw daemon snapshots. Canonical messages use Factory's seq.
 * Deltas and standalone tool calls have no seq: they take the next position provisionally, then
 * adopt the canonical seq when create_message or REST supplies it. Missing snapshot seqs retain
 * a known position, or take the next one in snapshot order. All positions remain whole numbers.
 */
export class CloudStreamMessages {
  private messages: FactoryMessage[];
  private pending = new Map<string, Map<number, FactoryBlock>>();
  private finished = new Set<string>();
  private retracted = new Set<string>();
  private droppedOldest = false;

  constructor(
    messages: readonly FactoryMessage[] = [],
    private now = Date.now,
    private limit: Limit = () => LIMIT,
  ) {
    this.messages = [];
    this.merge(messages);
  }

  values(): FactoryMessage[] {
    return this.messages;
  }

  /** Whether the oldest messages were dropped for newer ones since the last ask. */
  takeTrimmed(): boolean {
    const dropped = this.droppedOldest;
    this.droppedOldest = false;
    return dropped;
  }

  /** REST pages and reconnect snapshots enrich what's held, without erasing newer live content. */
  merge(page: readonly FactoryMessage[], older = false): FactoryMessage[] {
    for (const message of page) if (!this.retracted.has(message.id)) this.upsert(message, false, older);
    return this.messages;
  }

  snapshot(raw: readonly unknown[]): FactoryMessage[] {
    return this.merge(raw.map(messageOf).filter((m): m is FactoryMessage => !!m));
  }

  event(value: unknown): FactoryMessage[] {
    const n = record(value);
    switch (n.type) {
      case 'create_message': {
        const raw = record(n.message);
        if (typeof raw.id !== 'string') break;
        const message = messageOf(raw);
        this.finished.add(raw.id);
        this.pending.delete(raw.id);
        if (message) {
          this.retracted.delete(raw.id);
          this.upsert(message, true);
        } else {
          this.retracted.add(raw.id);
          this.messages = this.messages.filter((m) => m.id !== raw.id);
        }
        break;
      }
      case 'assistant_text_delta':
      case 'thinking_text_delta':
        this.delta(n);
        break;
      case 'tool_call': {
        const tool = record(n.toolUse);
        if (typeof tool.id !== 'string') break;
        const message = messageOf({ id: `stream-tool:${tool.id}`, role: 'assistant', createdAt: this.now(), content: [tool] });
        if (!message) break;
        const owner = this.messages.find((m) => m.blocks.some((b) => b.type === 'tool_use' && b.id === tool.id));
        if (owner) this.upsert({ ...owner, blocks: owner.blocks.map((b) => (b.type === 'tool_use' && b.id === tool.id ? message.blocks[0] : b)) }, true);
        else this.upsert(message, false);
        break;
      }
      case 'tool_result': {
        if (typeof n.toolUseId !== 'string' || typeof n.messageId !== 'string') break;
        const message = messageOf({ id: n.messageId, role: 'tool', createdAt: this.now(), content: [n] });
        if (!message) break;
        const prior = this.messages.find((m) => m.id === message.id);
        if (prior) message.blocks = [...prior.blocks.filter((b) => b.type !== 'tool_result' || b.toolUseId !== n.toolUseId), ...message.blocks];
        this.upsert(message, true);
        break;
      }
      case 'assistant_message_retracted':
        this.messages = this.messages.filter((m) => m.id !== n.messageId);
        if (typeof n.messageId === 'string') {
          this.pending.delete(n.messageId);
          this.finished.add(n.messageId);
          this.retracted.add(n.messageId);
        }
        break;
    }
    while (this.finished.size > LIMIT * 2) this.finished.delete(this.finished.values().next().value!);
    while (this.retracted.size > LIMIT * 2) this.retracted.delete(this.retracted.values().next().value!);
    return this.messages;
  }

  private delta(n: Record<string, unknown>) {
    const { messageId, blockIndex, textDelta } = n;
    if (typeof messageId !== 'string' || typeof blockIndex !== 'number' || !Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= 128 || typeof textDelta !== 'string' || this.finished.has(messageId)) return;
    const prior = this.messages.find((m) => m.id === messageId);
    let pending = this.pending.get(messageId);
    if (!pending) this.pending.set(messageId, (pending = new Map(prior?.blocks.map((b, i) => [i, b]))));
    const type = n.type === 'thinking_text_delta' ? 'thinking' : 'text';
    const old = pending.get(blockIndex);
    const text = `${old && 'text' in old ? old.text : ''}${textDelta}`.slice(0, type === 'text' ? TEXT_MAX : RESULT_MAX);
    pending.set(blockIndex, { type, text });
    const blocks = [...pending].sort(([a], [b]) => a - b).map(([, block]) => block);
    this.upsert({ id: messageId, role: 'assistant', createdAt: prior?.createdAt ?? this.now(), seq: prior?.seq, blocks }, false);
  }

  private upsert(message: FactoryMessage, canonical: boolean, older = false) {
    const prior = this.messages.find((m) => m.id === message.id);
    let inherited = prior?.seq;
    // A tool_call has no messageId. Its later canonical assistant message owns the same row.
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      this.messages = this.messages.filter((m) => {
        const placeholder = m.id !== message.id && m.id.startsWith('stream-tool:') && m.blocks.some((b) => b.type === 'tool_use' && b.id === block.id);
        if (placeholder) inherited ??= m.seq;
        return !placeholder;
      });
    }
    const seq = Number.isSafeInteger(message.seq) && message.seq! >= 0 ? message.seq : (inherited ?? this.messages.reduce((max, m) => Math.max(max, m.seq ?? -1), -1) + 1);
    const next = { ...message, seq };
    this.messages = mergeMessages(this.messages, [prior && !canonical ? complete(prior, next) : next]);
    if (!canonical && this.pending.has(message.id)) {
      const merged = this.messages.find((m) => m.id === message.id)!;
      const pending = this.pending.get(message.id)!;
      [...pending.keys()]
        .sort((a, b) => a - b)
        .forEach((index, i) => {
          if (merged.blocks[i]) pending.set(index, merged.blocks[i]);
        });
    }
    const max = this.limit(older);
    if (this.messages.length > max) {
      const dropped = older ? this.messages.slice(max) : this.messages.slice(0, -max);
      this.messages = older ? this.messages.slice(0, max) : this.messages.slice(-max);
      if (!older) this.droppedOldest = true;
      for (const m of dropped) {
        this.pending.delete(m.id);
        this.finished.delete(m.id);
      }
    }
  }
}
