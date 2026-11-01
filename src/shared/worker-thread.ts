/** A picture in the session (a tool's result or an attachment), served by `/api/thread/image` by its id. */
export interface ThreadImage {
  id: string;
  type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Its size in pixels, when its header says, so a client can make room before it loads. */
  width?: number;
  height?: number;
}

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
  /** For a tool result, the seq the next entry took when the result was read: later than seq + 1 when other entries came first. */
  resultSeq?: number;
  /** Pictures in a tool's result or a message; `output` and `text` still say `[Image attachment]` for each. */
  images?: ThreadImage[];
}
