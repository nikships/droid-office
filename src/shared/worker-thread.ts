/** A safe, display-only projection of a local Droid conversation. */
export interface ThreadEntry {
  id: string;
  /** Unique increasing display position; tool results update their original call's position. */
  seq: number;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'tool' | 'thinking' | 'notice' | 'todo';
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  error?: boolean;
}
