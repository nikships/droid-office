// The chips above an agent prompt box, and the history beside it. Both read this browser's copy
// (prompt-recall.ts). The box itself stays the caller's textarea.

import { loadSettings } from '../state';
import { claimEscape, clip, h } from './dom';
import { PROMPT_LABEL_MAX, PROMPT_PRESET_MAX, PROMPT_TEXT_MAX, defaultPresets, loadPromptHistory, normalizePresets, recallPrompt, rememberPrompt, savePromptHistory, type PromptPreset } from '../prompt-recall';

let historySeq = 0;

/** Chips, the History button and its list, wrapped around `ta`. `sent` records a prompt that actually went out. */
export function promptExtras(ta: HTMLTextAreaElement): { element: HTMLElement; sent(text: string): void; dispose(): void } {
  const presets = loadSettings().presets;
  let history = loadPromptHistory();
  /** -1 while the textarea is yours; otherwise an index into `history`. */
  let cursor = -1;
  let draft = ta.value;
  let typing = false;

  const chips = h('div.chips.prompt-presets', { role: 'group', 'aria-label': 'Preset prompts' }, ...presets.map((p) => h('button.chip', { type: 'button', title: p.text, onclick: () => fill(p.text) }, p.label)));
  chips.classList.toggle('hidden', presets.length === 0);

  const listId = `prompt-history-${++historySeq}`;
  const list = h('div.list.boxed.prompt-history-list', { id: listId, role: 'listbox', 'aria-label': 'Recent prompts' });
  const historyPanel = h('div.prompt-history.hidden', {}, list);
  const historyBtn = h(
    'button.btn.sm.prompt-history-btn',
    { type: 'button', title: 'Recent prompts. Up and Down in the box recall them too.', 'aria-label': 'Prompt history', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId },
    'History',
  );

  const setText = (text: string) => {
    typing = true;
    ta.value = text;
    ta.focus();
    ta.setSelectionRange(text.length, text.length);
    typing = false;
  };

  const fill = (text: string) => {
    cursor = -1;
    draft = text;
    setText(text);
    closeList();
  };

  const paintList = () => {
    if (!history.length) {
      list.replaceChildren(h('p.field-hint.prompt-history-empty', {}, 'Nothing sent yet. The last 50 prompts stay in this browser.'));
      return;
    }
    list.replaceChildren(
      ...history.map((text, i) => {
        const lines = text.split('\n');
        const row = h(
          'button.list-row',
          {
            type: 'button',
            role: 'option',
            title: text,
            'aria-selected': String(i === cursor),
            onclick: () => pick(i),
          },
          h('span.list-main', {}, h('span.list-title', {}, clip(lines[0], 180)), lines.length > 1 ? h('span.list-meta', {}, clip(lines.slice(1).join(' '), 180)) : null),
        );
        return row;
      }),
    );
  };

  const closeList = () => {
    historyPanel.classList.add('hidden');
    historyBtn.setAttribute('aria-expanded', 'false');
  };

  const openList = () => {
    // A cloud window or the queue stays open, so the list is whatever was saved since, not the copy from when the box opened.
    history = loadPromptHistory();
    paintList();
    historyPanel.classList.remove('hidden');
    historyBtn.setAttribute('aria-expanded', 'true');
  };

  const pick = (index: number) => {
    if (cursor < 0) draft = ta.value;
    cursor = index;
    setText(history[index] ?? '');
    closeList();
  };

  historyBtn.addEventListener('click', () => {
    if (historyPanel.classList.contains('hidden')) openList();
    else closeList();
  });

  ta.addEventListener('input', () => {
    if (typing) return;
    cursor = -1;
    draft = ta.value;
  });

  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionStart);
    // Right after a recall the cursor sits at the end, and another arrow keeps walking. Move
    // the cursor into the text and the arrows edit again until you're back on the first or last line.
    const browsing = cursor >= 0 && ta.selectionStart === ta.value.length;
    const onFirst = !before.includes('\n');
    const onLast = !after.includes('\n');
    if (!browsing) {
      if (e.key === 'ArrowUp' && !onFirst) return;
      if (e.key === 'ArrowDown' && (cursor < 0 || !onLast)) return;
    }
    // Starting a walk from what you're typing: pick up prompts another box saved. Mid-walk stays put, so the cursor doesn't jump.
    if (cursor < 0) {
      history = loadPromptHistory();
      draft = ta.value;
    }
    if (!history.length) return;
    e.preventDefault();
    const next = recallPrompt(history, cursor, e.key === 'ArrowUp' ? 'up' : 'down', draft);
    cursor = next.index;
    setText(next.text);
    closeList();
  });

  const compose = h('div.prompt-compose', {}, chips, h('div.prompt-field', {}, ta, historyBtn), historyPanel);

  // The dialog's own Esc handler asks before closing, so Esc dismisses the list and leaves the box and its draft open.
  const releaseEscape = claimEscape(compose, () => {
    if (historyPanel.classList.contains('hidden')) return false;
    closeList();
    ta.focus();
    return true;
  });
  const onDoc = (e: Event) => {
    if (!compose.isConnected) return dispose();
    if (historyPanel.classList.contains('hidden')) return;
    if (e.target instanceof Node && compose.contains(e.target)) return;
    closeList();
  };
  document.addEventListener('pointerdown', onDoc, true);

  const dispose = () => {
    releaseEscape();
    document.removeEventListener('pointerdown', onDoc, true);
  };

  return {
    element: compose,
    sent(text: string) {
      history = rememberPrompt(history, text);
      savePromptHistory(history);
      cursor = -1;
      draft = '';
    },
    dispose,
  };
}

/** Settings → You → Prompt chips. Edits stay in the rows until they're a name plus some text. */
export function presetEditor(initial: PromptPreset[], onChange: (presets: PromptPreset[]) => void): HTMLElement {
  const rows: { el: HTMLElement; label: HTMLInputElement; text: HTMLTextAreaElement }[] = [];
  const list = h('div.preset-list');
  const add = h('button.btn.sm', { type: 'button' }, 'Add a chip') as HTMLButtonElement;
  const reset = h('button.btn.sm.ghost', { type: 'button' }, 'Reset');
  const hint = h('p.field-hint', {}, `Up to ${PROMPT_PRESET_MAX}. A chip needs a name and some text, then one tap fills the prompt box.`);

  const paint = () => add.toggleAttribute('disabled', rows.length >= PROMPT_PRESET_MAX);
  const emit = () => {
    paint();
    onChange(normalizePresets(rows.map((r) => ({ label: r.label.value, text: r.text.value }))));
  };

  const addRow = (preset: PromptPreset) => {
    if (rows.length >= PROMPT_PRESET_MAX) return;
    const label = h('input.input', { type: 'text', value: preset.label, maxlength: String(PROMPT_LABEL_MAX), placeholder: 'Name', 'aria-label': 'Chip name' }) as HTMLInputElement;
    const text = h('textarea.input', { rows: 2, maxlength: String(PROMPT_TEXT_MAX), placeholder: 'What the chip types', 'aria-label': preset.label ? `Prompt for ${preset.label}` : 'Chip prompt' }) as HTMLTextAreaElement;
    text.value = preset.text;
    const remove = h('button.btn.sm.ghost', { type: 'button' }, 'Remove');
    const el = h('div.preset-row', {}, label, text, remove);
    const row = { el, label, text };
    remove.addEventListener('click', () => {
      const i = rows.indexOf(row);
      if (i >= 0) rows.splice(i, 1);
      el.remove();
      emit();
    });
    label.addEventListener('input', emit);
    text.addEventListener('input', emit);
    rows.push(row);
    list.append(el);
  };

  const refill = (presets: PromptPreset[]) => {
    rows.splice(0, rows.length);
    list.replaceChildren();
    for (const p of presets) addRow(p);
    emit();
  };

  add.addEventListener('click', () => {
    addRow({ label: '', text: '' });
    paint();
    rows[rows.length - 1]?.label.focus();
  });
  reset.addEventListener('click', () => refill(defaultPresets()));
  for (const p of initial) addRow(p);
  paint();

  return h('div.stack.tight.preset-editor', {}, list, h('div.row.wrap', {}, add, reset), hint);
}
