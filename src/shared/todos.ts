import type { TodoProgress } from './protocol.js';

// A worker's todo list as its hooks report it (TodoWrite), cut down to what its card shows: how many
// items are done, of how many, and the one in progress. Every client words it the same way from here.

const CURRENT_CHARS = 120;
const STEP_CHARS = 200;
const STEP_LIMIT = 50;
const LINE = /^\s*\d+[.)]\s*\[\s*([a-z _-]+?)\s*\]\s*(.*)$/i;

export type TodoItemStatus = 'completed' | 'in_progress' | 'pending';

export interface TodoItem {
  status: TodoItemStatus;
  content: string;
}

function itemStatus(value: unknown): TodoItemStatus {
  const s = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
}

function items(input: unknown): TodoItem[] {
  const todos = input && typeof input === 'object' ? (input as Record<string, unknown>).todos : undefined;
  if (Array.isArray(todos))
    return todos.flatMap((todo) => {
      const t = todo && typeof todo === 'object' ? (todo as Record<string, unknown>) : {};
      const content = typeof t.content === 'string' ? t.content.trim() : '';
      return content ? [{ status: itemStatus(t.status), content }] : [];
    });
  // PreToolUse carries the list as typed: "1. [in_progress] alpha\n2. [pending] beta".
  if (typeof todos === 'string')
    return todos.split('\n').flatMap((line) => {
      const m = LINE.exec(line);
      const content = m?.[2].trim();
      return m && content ? [{ status: itemStatus(m[1]), content }] : [];
    });
  return [];
}

const clipTo = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const clip = (text: string) => clipTo(text, CURRENT_CHARS);

/** Bounded plan steps from a TodoWrite call's `tool_input`, in either shape Droid sends. */
export function todoItems(input: unknown): TodoItem[] {
  return items(input)
    .slice(0, STEP_LIMIT)
    .map((item) => ({ status: item.status, content: clipTo(item.content, STEP_CHARS) }));
}

/** A TodoWrite call's `tool_input`, in either shape Droid sends, as progress; nothing for an empty list. */
export function todoProgress(input: unknown): TodoProgress | undefined {
  const list = items(input);
  if (!list.length) return undefined;
  const current = list.find((i) => i.status === 'in_progress')?.content;
  return { done: list.filter((i) => i.status === 'completed').length, total: list.length, ...(current ? { current: clip(current) } : {}) };
}

/** Progress read back from saved state, or nothing when it isn't well formed. */
export function validTodoProgress(value: unknown): TodoProgress | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { done, total, current } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(done) || (total as number) < 1 || (done as number) < 0 || (done as number) > (total as number)) return undefined;
  return { done: done as number, total: total as number, ...(typeof current === 'string' && current.trim() ? { current: clip(current.trim()) } : {}) };
}

/** Every item is done. */
export const todosFinished = (p: TodoProgress) => p.done >= p.total;

/** "3/5". */
export const todoCount = (p: TodoProgress) => `${p.done}/${p.total}`;

/** "3/5 · Write the tests", or "3/5 done" with nothing in progress: its tooltip and what a screen reader says. */
export function todoLine(p: TodoProgress): string {
  return p.current ? `${todoCount(p)} · ${p.current}` : `${todoCount(p)} done`;
}

/** How far along it is, 0 to 1. */
export const todoFraction = (p: TodoProgress) => (p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0);
