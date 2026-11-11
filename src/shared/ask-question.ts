import type { Menu } from './asks.js';
import type { AskedQuestion, WorkerAsk } from './protocol.js';
import type { ThreadEntry } from './worker-thread.js';

export type { AskedQuestion };

/** AskUser's own questionnaire format: `1. [question] …`, `[topic] …`, `[option] …`, `(multi)` at the end of a question. */
export function parseQuestionnaire(text: string): AskedQuestion[] {
  const questions: AskedQuestion[] = [];
  let current: AskedQuestion | undefined;
  let continuing: 'question' | 'option' | undefined;
  for (const line of text.split('\n')) {
    const question = /^\s*(?:\d+[.)]\s*)?\[question]\s*(.+)$/.exec(line);
    const option = /^\s*\[option]\s*(.+)$/.exec(line);
    const topic = /^\s*\[topic]\s*(.*)$/.exec(line);
    if (question) {
      current = { question: question[1].replace(/\s*\(multi\)\s*$/i, '').trim(), options: [], multiSelect: /\(multi\)\s*$/i.test(question[1]) };
      questions.push(current);
      continuing = 'question';
    } else if (option && current) {
      current.options.push(option[1].trim());
      continuing = 'option';
    } else if (topic) {
      if (current && topic[1].trim()) current.topic = topic[1].trim();
      continuing = undefined;
    } else if (current && continuing === 'option') current.options[current.options.length - 1] += `\n${line}`;
    else if (current && continuing === 'question') {
      if (/\(multi\)\s*$/i.test(line)) current.multiSelect = true;
      const continued = line.replace(/\s*\(multi\)\s*$/i, '').trim();
      current.question += `\n${continued}`;
    }
  }
  return questions.map((question) => ({ ...question, question: question.question.trim(), options: question.options.map((option) => option.trim()) }));
}

/** An AskUser call's input, in either of the shapes Droid has used: a questionnaire, or a list of questions. */
export function inputQuestions(args: Record<string, unknown>): AskedQuestion[] {
  if (typeof args.questionnaire === 'string') return parseQuestionnaire(args.questionnaire);
  if (!Array.isArray(args.questions)) return [];
  return args.questions.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const q = value as Record<string, unknown>;
    if (typeof q.question !== 'string' || !Array.isArray(q.options)) return [];
    const options = q.options.flatMap((option: unknown) => {
      const label = typeof option === 'string' ? option : option && typeof option === 'object' ? (option as Record<string, unknown>).label : undefined;
      return typeof label === 'string' && label.trim() ? [label.trim()] : [];
    });
    return [{ question: q.question.trim(), options, multiSelect: q.multiSelect === true || q.multi_select === true }];
  });
}

/** Full question text comes from the pending tool call, never the terminal's viewport. */
export function askedQuestions(entries: readonly ThreadEntry[]): AskedQuestion[] {
  const call = [...entries].reverse().find((entry) => entry.kind === 'tool' && ['askuser', 'askuserquestion', 'request_user_input'].includes(entry.name?.split(/[.:/]/).at(-1)?.toLowerCase() ?? ''));
  if (!call || call.output !== undefined) return [];
  try {
    return inputQuestions(JSON.parse(call.input ?? '{}'));
  } catch {
    return [];
  }
}

/** What a permission prompt asks, in one line: "Approve high-risk command: rm -rf build". */
export function permissionLine(ask: Extract<WorkerAsk, { kind: 'permission' }>): string {
  const risk = ask.risk && /^(low|medium|high)$/.test(ask.risk) ? `${ask.risk}-risk ` : '';
  const what = ask.tool === 'Execute' ? 'command' : ask.tool;
  const detail = ask.command ?? ask.file ?? ask.summary;
  return `Approve ${risk}${what}${detail ? `: ${detail}` : ''}`;
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.…]+$/, '');

export interface QuestionDisplay {
  question: string;
  choices: Menu['choices'];
  /** Which question of a questionnaire this is, when the menu matched one. */
  position?: number;
  total?: number;
  /** The text is the ask's own, not pieced together from the screen. */
  complete: boolean;
}

/**
 * The card for the menu on screen. The hook's pending ask (WorkerInfo.ask) has the exact text; the
 * Thread's pending tool call is the fallback for an office that doesn't send one. Every numbered
 * option is matched in order: ambiguous or mismatching questions cannot relabel an answer.
 */
export function questionPresentation(menu: Menu, entries: readonly ThreadEntry[], ask?: WorkerAsk): QuestionDisplay {
  if (menu.review) return { question: 'Review your answers', choices: menu.choices, complete: true };
  if (ask?.kind === 'permission') return { question: permissionLine(ask), choices: menu.choices, complete: true };
  const all = ask?.kind === 'question' && ask.questions.length ? ask.questions : askedQuestions(entries);
  const matches = all.filter(
    (q) =>
      q.options.length === menu.choices.length &&
      q.multiSelect === !!menu.multiSelect &&
      menu.choices.every((choice, index) => {
        const label = normalize(choice.label);
        return label.length > 0 && normalize(q.options[index]).startsWith(label);
      }),
  );
  const byQuestion = matches.filter((question) => menu.question && normalize(question.question).endsWith(normalize(menu.question)));
  const full = matches.length === 1 ? matches[0] : byQuestion.length === 1 ? byQuestion[0] : undefined;
  return {
    question: full?.question || menu.question || 'Choose an answer',
    choices: menu.choices.map((choice, index) => ({ ...choice, ...(full ? { label: full.options[index], description: undefined } : {}) })),
    ...(full ? { position: all.indexOf(full) + 1, total: all.length } : {}),
    complete: !!full,
  };
}
