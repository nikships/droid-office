import { menuTakesText, sameMenu, type Menu } from '../shared/asks';
import type { WorkerInfo } from '../shared/protocol';
import type { ActionToken } from './session';

/** Ephemeral, never part of the saved pane layout. */
export interface QuestionDraft {
  workerId: string;
  token: ActionToken;
  sessionId?: string;
  waitingSince?: number;
  menu: Menu;
  choices: number[];
  text: string;
  state: 'idle' | 'sending' | 'sent' | 'uncertain';
  error?: string;
}

/** Floor arrivals may change while a draft is closed, but its question must still match exactly. */
export function sameQuestion(draft: QuestionDraft, token: ActionToken, worker: Pick<WorkerInfo, 'id' | 'sessionId' | 'waitingSince' | 'status'>, menu: Menu | undefined): boolean {
  return (
    draft.token.office === token.office &&
    draft.token.epoch === token.epoch &&
    draft.token.floor === token.floor &&
    draft.workerId === worker.id &&
    draft.sessionId === worker.sessionId &&
    draft.waitingSince === worker.waitingSince &&
    worker.status === 'needs_input' &&
    sameMenu(draft.menu, menu)
  );
}

/** Selection only edits a draft. A radio and custom text are mutually exclusive. */
export function selectQuestionChoice(draft: QuestionDraft, choice: number): QuestionDraft {
  if (!draft.menu.choices.some((c) => c.number === choice)) return draft;
  return {
    ...draft,
    choices: draft.menu.multiSelect ? (draft.choices.includes(choice) ? draft.choices.filter((n) => n !== choice) : [...draft.choices, choice]) : [choice],
    text: draft.menu.multiSelect ? draft.text : '',
    error: undefined,
  };
}

export function writeQuestionText(draft: QuestionDraft, text: string): QuestionDraft {
  return { ...draft, text: text.slice(0, 20000), choices: !draft.menu.multiSelect && text.trim() ? [] : draft.choices, error: undefined };
}

/** Full checkbox state, not simulated keystrokes; absence means there is nothing valid to submit. */
export function questionReply(draft: QuestionDraft): { choice?: number; choices?: number[]; text?: string } | undefined {
  const text = draft.text.trim();
  const choices = [...new Set(draft.choices)].sort((a, b) => a - b);
  if (choices.some((n) => !draft.menu.choices.some((c) => c.number === n)) || (text && !menuTakesText(draft.menu))) return;
  if (!choices.length && !text) return;
  if (draft.menu.multiSelect) return { choices, ...(text ? { text } : {}) };
  if (text) return { text };
  if (choices.length === 1) return { choice: choices[0] };
}
