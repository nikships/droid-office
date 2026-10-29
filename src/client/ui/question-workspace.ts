import { menuTakesText, type Menu } from '../../shared/asks';
import { questionPresentation } from '../../shared/ask-question';
import type { ThreadEntry } from '../../shared/worker-thread';
import { h, openModal } from './dom';
import { windowHeader } from './kit';

export interface QuestionDraft {
  text: string;
  choices?: number[];
}
export interface QuestionState {
  menu: Menu;
  entries: readonly ThreadEntry[];
  enabled: boolean;
  sending: boolean;
  answered: boolean;
  current: boolean;
  connected: boolean;
  supported?: boolean;
}
export type QuestionReply = { choice?: number; choices?: number[]; text?: string };

/** One scrollable answer surface, with pinned navigation and submit controls. */
export function openQuestionWorkspace(opts: { name: string; state: QuestionState; draft: QuestionDraft; onDraft(): void; reply(value: QuestionReply, menu: Menu): Promise<void>; review(): void; raw(): void; onClose(): void }) {
  let state = opts.state;
  let key = '';
  let selected = new Set<number>();
  let submitting = false;
  const previousFocus = document.activeElement;
  const body = h('div.body.qw-body');
  const feedback = h('p.qw-feedback', { role: 'status', 'aria-live': 'polite' });
  const count = h('span.qw-count');
  const submit = h('button.btn.accent', { type: 'submit' }, 'Submit answer');
  const review = h('button.btn', { type: 'button', onclick: opts.review, hidden: true }, 'Show current question');
  const raw = h(
    'button.btn.ghost',
    {
      type: 'button',
      onclick: () => {
        modal.close();
        opts.raw();
      },
    },
    'Raw TTY',
  );
  const back = h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Back to thread');
  const form = h(
    'form.modal.question-workspace',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Answer questions' },
    windowHeader('Answer questions', `${opts.name} is waiting for your answer`),
    body,
    h('div.qw-feedback-row', {}, feedback, review),
    h('footer', {}, h('div.grow.qw-footer-meta', {}, count, raw), back, submit),
  );
  const modal = openModal(form, {
    size: 'lg',
    onClose: () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      opts.onClose();
    },
  });
  const updateSelection = () => {
    for (const input of body.querySelectorAll<HTMLInputElement>('input[name="answer-choice"]')) {
      input.checked = selected.has(Number(input.value));
      input.closest('label')?.classList.toggle('on', input.checked);
    }
    count.textContent = state.menu.multiSelect ? `${selected.size} selected` : selected.size ? '1 answer selected' : 'Choose an answer';
    const hasText = !!opts.draft.text.trim();
    submit.disabled = submitting || !state.enabled || state.supported === false || (!selected.size && !hasText);
  };
  const update = (next: QuestionState) => {
    state = next;
    const display = questionPresentation(state.menu, state.entries);
    const nextKey = JSON.stringify([state.menu.question, state.menu.choices.map((c) => [c.number, c.label, c.description]), state.menu.multiSelect, display]);
    if (key !== nextKey) {
      const first = !key;
      key = nextKey;
      selected = new Set(opts.draft.choices ?? state.menu.choices.filter((c) => c.selected).map((c) => c.number));
      const instructions = state.menu.multiSelect ? 'Select all that apply' : 'Select one answer';
      const text = h('textarea.input.qw-text', { rows: 3, maxlength: 20000, 'aria-label': 'Your own answer', placeholder: state.menu.multiSelect ? 'Add your own answer (optional)…' : 'Or write your own answer…' });
      text.value = opts.draft.text;
      text.addEventListener('input', () => {
        opts.draft.text = text.value;
        if (!state.menu.multiSelect && text.value.trim()) selected.clear();
        opts.draft.choices = [...selected];
        opts.onDraft();
        updateSelection();
      });
      body.replaceChildren(
        h(
          'div.qw-content',
          {},
          h('div.qw-question-meta', {}, h('span.eyebrow', {}, display.position ? `Question ${display.position} of ${display.total}` : 'Current question'), h('span.pill', {}, state.menu.multiSelect ? 'Multiple answers' : 'One answer')),
          h('h3.qw-question', { id: 'qw-question' }, display.question),
          h('p.qw-instructions', { id: 'qw-instructions' }, `${instructions}. Nothing is sent until you submit.`),
          h(
            'div.qw-choices',
            { role: state.menu.multiSelect ? 'group' : 'radiogroup', 'aria-labelledby': 'qw-question', 'aria-describedby': 'qw-instructions' },
            ...display.choices.map((choice) => {
              const input = h('input', { type: state.menu.multiSelect ? 'checkbox' : 'radio', name: 'answer-choice', value: choice.number });
              input.addEventListener('change', () => {
                if (!state.menu.multiSelect) {
                  selected.clear();
                  text.value = '';
                  opts.draft.text = '';
                }
                if (input.checked) selected.add(choice.number);
                else selected.delete(choice.number);
                opts.draft.choices = [...selected];
                opts.onDraft();
                updateSelection();
              });
              return h('label.qw-choice', {}, input, h('span.qw-choice-copy', {}, h('span', {}, choice.label), choice.description ? h('small', {}, choice.description) : null));
            }),
          ),
          menuTakesText(state.menu) ? h('div.field.qw-own-answer', {}, h('label', {}, state.menu.multiSelect ? 'Add an answer' : 'Your own answer'), text) : null,
          !display.complete ? h('p.qw-source-note', {}, 'Showing the terminal’s readable text. If anything is missing, open Raw TTY.') : null,
        ),
      );
      if (first) requestAnimationFrame(() => (body.querySelector<HTMLInputElement>('input:enabled') ?? back).focus({ preventScroll: true }));
    }
    for (const input of body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) input.disabled = !state.enabled || state.supported === false;
    feedback.textContent = state.sending
      ? 'Sending your answer…'
      : state.answered
        ? 'Answer sent. Waiting for the next question or the worker’s reply.'
        : !state.connected
          ? 'Disconnected. Your draft is kept. Nothing will be sent automatically.'
          : state.supported === false
            ? 'This office version cannot safely submit checkbox answers. Update the host, or use Raw TTY.'
            : !state.current
              ? 'This question changed or was answered elsewhere. Review the current question before sending.'
              : 'Your draft stays here if you go back to the thread.';
    review.hidden = state.current || state.sending || state.answered || !state.connected;
    submit.textContent = state.sending ? 'Sending…' : 'Submit answer';
    updateSelection();
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const text = opts.draft.text.trim();
    submitting = true;
    updateSelection();
    void opts.reply(state.menu.multiSelect ? { choices: [...selected], ...(text ? { text } : {}) } : text ? { text } : { choice: [...selected][0] }, state.menu).finally(() => {
      submitting = false;
      updateSelection();
    });
  });
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...form.querySelectorAll<HTMLElement>('button:enabled, input:enabled, textarea:enabled')].filter((control) => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  update(state);
  return { update, close: () => modal.close() };
}
