// Prompt recall uses this browser's history; the textarea belongs to the caller.

import { h } from './dom';
import { loadPromptHistory, recallPrompt, rememberPrompt, savePromptHistory } from '../prompt-recall';

/** Wrap `ta` with prompt recall. `sent` records a prompt that actually went out. */
export function promptExtras(ta: HTMLTextAreaElement): { element: HTMLElement; sent(text: string): void; dispose(): void } {
  let history = loadPromptHistory();
  /** -1 while the textarea is yours; otherwise an index into `history`. */
  let cursor = -1;
  let draft = ta.value;
  let typing = false;

  const setText = (text: string) => {
    typing = true;
    ta.value = text;
    ta.focus();
    ta.setSelectionRange(text.length, text.length);
    typing = false;
  };

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
  });

  const compose = h('div.prompt-compose', {}, h('div.prompt-field', {}, ta));

  return {
    element: compose,
    sent(text: string) {
      history = rememberPrompt(history, text);
      savePromptHistory(history);
      cursor = -1;
      draft = '';
    },
    dispose() {},
  };
}
