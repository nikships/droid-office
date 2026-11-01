import type { FactoryBlock, FactoryMessage } from './factory-sessions.js';
import type { ThreadEntry } from './worker-thread.js';

// A cloud worker's Thread: its Factory session's messages (GET /sessions/{id}/messages, as messageOf
// cuts them down) projected into the same ThreadEntry list a local worker's session file gives, so
// thread-presentation.ts builds its rows and every client draws it the way it draws a local thread.

/**
 * Positions per message. Factory numbers messages with `seq`, a few apart, and a message is a list of
 * blocks: block i gets `seq * SEQ_STRIDE + 2i` (and a TodoWrite's plan the slot after it), which stays
 * the same on every read and page. Positions are whole numbers: the Android app reads them as Longs.
 */
export const SEQ_STRIDE = 256;

const REMINDER = /<(system-(?:reminder|notification))\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const clean = (text: string) => text.replace(REMINDER, '').trim();

/** A TodoWrite's list in the "1. [completed] Step" form threadPlan reads, from either input shape Droid sends. */
export function todoText(input: Record<string, unknown>): string | undefined {
  const todos = input.todos;
  if (typeof todos === 'string') return todos.trim() || undefined;
  if (!Array.isArray(todos)) return undefined;
  const lines = todos.flatMap((todo, i) => {
    const t = todo && typeof todo === 'object' ? (todo as Record<string, unknown>) : {};
    const content = typeof t.content === 'string' ? t.content.trim() : '';
    if (!content) return [];
    const status = t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in progress' : 'pending';
    return [`${i + 1}. [${status}] ${content}`];
  });
  return lines.length ? lines.join('\n') : undefined;
}

type ToolResult = Extract<FactoryBlock, { type: 'tool_result' }>;
const resultText = (r: ToolResult) => r.text.trim() || (r.images ? `${r.images} picture${r.images === 1 ? '' : 's'}` : '');

/**
 * The thread entries for a session's messages, oldest first. A tool result fills in the call it
 * answers (its output, whether it failed, and where it came: `resultSeq`); one whose call isn't among
 * these messages is left out, as a local thread leaves it out.
 */
export function cloudEntries(messages: readonly FactoryMessage[]): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  const tools = new Map<string, ThreadEntry>();
  const numbered = messages.every((m) => m.seq !== undefined);
  messages.forEach((m, index) => {
    const base = (numbered ? (m.seq as number) : index) * SEQ_STRIDE;
    const role = m.role === 'user' ? 'user' : 'assistant';
    m.blocks.slice(0, SEQ_STRIDE / 2).forEach((b, i) => {
      const seq = base + 2 * i;
      const id = `${m.id}:${i}`;
      if (m.role === 'tool') {
        if (b.type !== 'tool_result') return;
        const call = tools.get(b.toolUseId);
        if (!call) return;
        call.output = resultText(b);
        call.error = b.isError;
        // Just after everything before it rather than its own slot: a result is late when it lands past
        // the last entry (thread-presentation's lateResults), and a stride's gap would always say so.
        call.resultSeq = (out.at(-1)?.seq ?? seq) + 1;
        return;
      }
      switch (b.type) {
        case 'text': {
          const text = clean(b.text);
          if (!text) return;
          if (m.isError && role === 'assistant') out.push({ id, seq, role: 'system', kind: 'notice', text, error: true });
          else out.push({ id, seq, role, kind: 'text', text });
          return;
        }
        case 'thinking': {
          const text = b.text.trim();
          if (text) out.push({ id, seq, role, kind: 'thinking', text });
          return;
        }
        case 'tool_use': {
          if (!b.id) return;
          const entry: ThreadEntry = { id: `tool:${b.id}`, seq, role: 'assistant', kind: 'tool', name: b.name, input: JSON.stringify(b.input, null, 2) };
          out.push(entry);
          tools.set(b.id, entry);
          if (b.name === 'TodoWrite') {
            const text = todoText(b.input);
            if (text) out.push({ id: `${id}:todo`, seq: seq + 1, role: 'system', kind: 'todo', text });
          }
          return;
        }
        case 'image':
          out.push({ id, seq, role, kind: 'notice', text: '[Image attachment]' });
          return;
        case 'document':
          out.push({ id, seq, role, kind: 'notice', text: `Attached ${b.name}` });
          return;
        default:
          return;
      }
    });
  });
  return out;
}
