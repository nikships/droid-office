// What you type into an agent prompt box, kept in this browser: the last prompts sent, and the
// one-tap chips above the box. Neither is office state. A shell command, a commit message and a
// pull-request description are not prompts and don't come through here.

export interface PromptPreset {
  label: string;
  text: string;
}

/** Chips a new office starts with. The owner edits these under Settings → Workers. */
export const DEFAULT_PROMPT_PRESETS: readonly PromptPreset[] = [
  { label: 'Review', text: 'Review the changes and point out bugs, risks, and missing tests.' },
  { label: 'Tests', text: 'Run the tests and fix whatever fails.' },
  { label: 'Lint', text: 'Run the linter and fix what it reports.' },
  { label: 'Explain', text: 'Explain what this does and why, in plain language.' },
  { label: 'Commit', text: 'Commit the changes with a clear message. Don’t push.' },
];

export const PROMPT_HISTORY_MAX = 50;
export const PROMPT_PRESET_MAX = 12;
export const PROMPT_LABEL_MAX = 24;
export const PROMPT_TEXT_MAX = 2000;

const HISTORY_KEY = 'droid-office.prompt-history';

export function defaultPresets(): PromptPreset[] {
  return DEFAULT_PROMPT_PRESETS.map((p) => ({ ...p }));
}

/** As the office keeps a prompt: Windows line ends and outer whitespace don't count. */
export function normPrompt(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/**
 * The owner's chips. A missing or junk value is the defaults, so an old settings file keeps them.
 * An array is theirs, even an empty one (they cleared the row). Incomplete entries are dropped.
 */
export function normalizePresets(raw: unknown): PromptPreset[] {
  if (!Array.isArray(raw)) return defaultPresets();
  const out: PromptPreset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label = String((item as { label?: unknown }).label ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, PROMPT_LABEL_MAX);
    const text = normPrompt(String((item as { text?: unknown }).text ?? '')).slice(0, PROMPT_TEXT_MAX);
    if (!label || !text) continue;
    if (out.some((p) => p.label.toLowerCase() === label.toLowerCase())) continue;
    out.push({ label, text });
    if (out.length >= PROMPT_PRESET_MAX) break;
  }
  return out;
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
