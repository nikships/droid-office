// How the Thread view reads: text, spacing, and how much of a worker's tools and thinking shows.
// Saved in this browser (JSON under one key) and applied live to every Thread that is open.

import { savedPrefs, type PrefOptions } from './saved-prefs';

export const THREAD_TEXT_SIZES = ['sm', 'md', 'lg', 'xl'] as const;
export const THREAD_FONTS = ['sans', 'serif', 'mono'] as const;
export const THREAD_SPACINGS = ['compact', 'default', 'relaxed'] as const;
export const THREAD_WIDTHS = ['narrow', 'default', 'wide', 'full'] as const;
export const THREAD_WORK = ['steps', 'fold'] as const;
export const THREAD_TOOLS = ['folded', 'open'] as const;
export const THREAD_THINKING = ['hidden', 'folded', 'open'] as const;

export interface ThreadViewPrefs {
  textSize: (typeof THREAD_TEXT_SIZES)[number];
  font: (typeof THREAD_FONTS)[number];
  spacing: (typeof THREAD_SPACINGS)[number];
  width: (typeof THREAD_WIDTHS)[number];
  /** Whether the tool calls and thoughts between assistant messages show each step or fold into one line. */
  work: (typeof THREAD_WORK)[number];
  tools: (typeof THREAD_TOOLS)[number];
  thinking: (typeof THREAD_THINKING)[number];
}

export const THREAD_VIEW_DEFAULTS: Readonly<ThreadViewPrefs> = Object.freeze({ textSize: 'md', font: 'sans', spacing: 'default', width: 'default', work: 'steps', tools: 'folded', thinking: 'folded' });

const OPTIONS: PrefOptions<ThreadViewPrefs> = {
  textSize: THREAD_TEXT_SIZES,
  font: THREAD_FONTS,
  spacing: THREAD_SPACINGS,
  width: THREAD_WIDTHS,
  work: THREAD_WORK,
  tools: THREAD_TOOLS,
  thinking: THREAD_THINKING,
};

const prefs = savedPrefs('droid-office.thread-view', THREAD_VIEW_DEFAULTS, OPTIONS);

export const normalizeThreadViewPrefs = prefs.normalize;
export const isDefaultThreadViewPrefs = prefs.isDefault;
export const threadViewPrefs = prefs.get;
export const setThreadViewPrefs = prefs.set;
export const resetThreadViewPrefs = prefs.reset;
export const onThreadViewPrefs = prefs.on;

const SCALE: Record<ThreadViewPrefs['textSize'], string> = { sm: '0.93', md: '1', lg: '1.14', xl: '1.29' };
const FONT: Record<ThreadViewPrefs['font'], string> = { sans: 'var(--font-sans)', serif: "ui-serif, Georgia, 'Times New Roman', serif", mono: 'var(--font-mono)' };
const GAP: Record<ThreadViewPrefs['spacing'], string> = { compact: 'var(--space-3)', default: 'var(--space-5)', relaxed: 'var(--space-7)' };
const LEADING: Record<ThreadViewPrefs['spacing'], string> = { compact: '1.55', default: '1.725', relaxed: '1.9' };
// Full width is a viewport-wide cap rather than `none`, which `min()` in the pinned message's width can't take.
const MEASURE: Record<ThreadViewPrefs['width'], string> = { narrow: '640px', default: '768px', wide: '960px', full: '100vw' };

/** The CSS variables a `.worker-thread` root takes for these choices. */
export function threadViewVars(prefs: ThreadViewPrefs): Record<string, string> {
  return {
    '--wt-text-scale': SCALE[prefs.textSize],
    '--wt-prose-font': FONT[prefs.font],
    '--wt-entry-gap': GAP[prefs.spacing],
    '--wt-prose-leading': LEADING[prefs.spacing],
    '--wt-measure': MEASURE[prefs.width],
  };
}

/** What the choices that change how a row is built come to; a row painted under another key is painted again. */
export const threadViewRowKey = (prefs: ThreadViewPrefs): string => `${prefs.work}:${prefs.tools}:${prefs.thinking}`;
