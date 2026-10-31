// The last agent prompts sent, kept in this browser rather than office state. A shell command,
// a commit message and a pull-request description are not prompts and don't come through here.

export const PROMPT_HISTORY_MAX = 50;

const HISTORY_KEY = 'droid-office.prompt-history';

/** As the office keeps a prompt: Windows line ends and outer whitespace don't count. */
export function normPrompt(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/** Newest first. A blank is ignored. Sending one that's already saved moves it to the front. */
export function rememberPrompt(history: readonly string[], text: string): string[] {
  const value = normPrompt(text);
  if (!value) return history.slice();
  return [value, ...history.filter((p) => p !== value)].slice(0, PROMPT_HISTORY_MAX);
}

export interface Recall {
  /** -1 is the text being typed. 0 is the newest saved prompt. */
  index: number;
  text: string;
}

/**
 * Up walks toward older prompts, Down back toward `draft`. At either end the position stays,
 * so holding the key doesn't wrap around and wipe what you were writing.
 */
export function recallPrompt(history: readonly string[], index: number, dir: 'up' | 'down', draft: string): Recall {
  if (!history.length || (dir === 'down' && index <= 0)) return { index: -1, text: draft };
  const at = dir === 'up' ? Math.min(index + 1, history.length - 1) : index - 1;
  return { index: at, text: history[at] ?? draft };
}

export function loadPromptHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? 'null');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map(normPrompt)
      .slice(0, PROMPT_HISTORY_MAX);
  } catch {
    return [];
  }
}

export function savePromptHistory(history: readonly string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, PROMPT_HISTORY_MAX)));
  } catch {
    // storage blocked
  }
}
