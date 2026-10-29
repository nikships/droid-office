import type { Menu } from './asks.js';
import type { ThreadEntry } from './worker-thread.js';

export interface AskedQuestion {
  question: string;
  options: string[];
  multiSelect: boolean;
}

/** Full question text comes from the pending tool call, never the terminal's viewport. */
export function askedQuestions(entries: readonly ThreadEntry[]): AskedQuestion[] {
  const call = [...entries].reverse().find((entry) => entry.kind === 'tool' && ['askuser', 'askuserquestion', 'request_user_input'].includes(entry.name?.split(/[.:/]/).at(-1)?.toLowerCase() ?? ''));
  if (!call || call.output !== undefined) return [];
  try {
    const args = JSON.parse(call.input ?? '{}');
    if (typeof args.questionnaire === 'string') {
      const questions: AskedQuestion[] = [];
      let current: AskedQuestion | undefined;
      let continuing: 'question' | 'option' | undefined;
      for (const line of args.questionnaire.split('\n') as string[]) {
        const question = /^\s*(?:\d+[.)]\s*)?\[question]\s*(.+)$/.exec(line);
        const option = /^\s*\[option]\s*(.+)$/.exec(line);
        if (question) {
          current = { question: question[1].replace(/\s*\(multi\)\s*$/i, '').trim(), options: [], multiSelect: /\(multi\)\s*$/i.test(question[1]) };
          questions.push(current);
          continuing = 'question';
        } else if (option && current) {
          current.options.push(option[1].trim());
          continuing = 'option';
        } else if (/^\s*\[topic]/.test(line)) continuing = undefined;
        else if (current && continuing === 'option') current.options[current.options.length - 1] += `\n${line}`;
        else if (current && continuing === 'question') {
          if (/\(multi\)\s*$/i.test(line)) current.multiSelect = true;
          const continued = line.replace(/\s*\(multi\)\s*$/i, '').trim();
          current.question += `\n${continued}`;
        }
      }
      return questions.map((question) => ({ ...question, question: question.question.trim(), options: question.options.map((option) => option.trim()) }));
    }
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
  } catch {
    return [];
  }
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.…]+$/, '');

/** Match every numbered option in order. Ambiguous or mismatching calls cannot relabel an answer. */
export function questionPresentation(menu: Menu, entries: readonly ThreadEntry[]) {
  const all = askedQuestions(entries);
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
