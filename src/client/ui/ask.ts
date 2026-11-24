import { PROMPT_MAX } from '../../shared/prompts';
import type { AgentEffort, WorkerStatus } from '../../shared/protocol';
import { slashRefusal } from '../../shared/slash-commands';
import { store } from '../state';
import { attachComposerAssist } from './composer-assist';
import { claimEscape, h, openModal, STATUS_LABEL } from './dom';
import { promptImages } from './images';
import { colorDot } from './kit';
import { agentPicker, type AgentFields } from './models';
import { pictureHint, repoPicker, sendHint, worktreeRow } from './prompt';
import { promptExtras } from './prompt-box';

// Send a prompt about an issue or PR to a worker: a new one at a free desk, or one already sitting
// at a desk (it lands in their input box, queued if they're busy).

export interface AskWorker {
  id: string;
  name: string;
  color: string;
  status: WorkerStatus;
  cloud?: boolean;
}

export interface AskOptions {
  title: string;
  /** Told to the worker before your text, so it knows what you mean. Shown, not editable. */
  context?: string;
  /** A ready-made prompt to start from. */
  initial?: string;
  placeholder?: string;
  /** The desk a new worker would take, when one is free. */
  newDesk?: string;
  workers: AskWorker[];
  /** Offer the "own git worktree" option for a new worker. */
  worktreeOption: boolean;
  /** Offer the model and effort pickers for a new worker. */
  modelOption?: boolean;
  /** Other floors' projects a new worker in its own worktree can work in too (see WorkerInfo.repos). */
  repoOptions?: { id: string; name: string }[];
  /** The floor this prompt is for, so slash commands and `@` workspace files resolve for a new worker. */
  floor?: string;
  /** `to` is a worker id, or null for a new worker. */
  onSubmit(prompt: string, to: string | null, worktree: boolean, model?: string, effort?: AgentEffort, repos?: string[], images?: string[]): void;
}

// Shared with the hire prompt, so the choice sticks either way.
const WT_KEY = 'droid-office.worktree';

export function openAsk(opts: AskOptions) {
  let to: string | null = opts.newDesk ? null : (opts.workers[0]?.id ?? null);
  const ta = h('textarea.input', { id: 'ask-prompt', rows: opts.initial ? 9 : 5, placeholder: opts.placeholder ?? 'What should the worker do?', 'aria-label': 'Prompt' }) as HTMLTextAreaElement;
  ta.value = opts.initial ?? '';
  const refusedNote = h('p.note.bad.hidden', { role: 'alert' });
  const targetIsCloud = () => Boolean(to && opts.workers.find((w) => w.id === to)?.cloud);
  const assist = attachComposerAssist({
    input: ta,
    scope: () => {
      const cloud = targetIsCloud();
      return {
        floor: opts.floor,
        workerId: to ?? undefined,
        slash: !cloud,
        inlineOnly: Boolean(opts.context?.trim()),
        mentions: !cloud && Boolean(to || opts.floor),
        pastes: true,
      };
    },
    factoryConnected: () => store.factory.connection.connected && !store.factory.connection.rejected,
    preloadSlash: true,
    onChange: () => refusedNote.classList.add('hidden'),
  });
  ta.addEventListener('keydown', (e) => void assist.handleKeydown(e));
  const syncInput = () => {
    refusedNote.classList.add('hidden');
    assist.onInput();
  };
  ta.addEventListener('input', syncInput);
  const images = promptImages(ta);
  const extras = promptExtras(ta, { onRecall: syncInput });
  let remembered = false;
  try {
    remembered = localStorage.getItem(WT_KEY) === '1';
  } catch {
    // storage blocked
  }
  const { row: wtRow, box: wtBox } = worktreeRow('ask-wt', remembered);
  const repos = repoPicker(opts.worktreeOption ? opts.repoOptions : undefined, wtBox);
  const models: AgentFields | null = opts.modelOption ? agentPicker('ask-models') : null;
  const modelRow = models ? h('div.group-row.block', {}, models.element) : null;
  const newOpts = h('div.group.prompt-opts', { role: 'group', 'aria-label': 'New worker options' }, modelRow, wtRow, repos.element);
  const submit = h('button.btn.primary', { type: 'submit' });

  const choices = h('div.seg.ask-to', { role: 'group', 'aria-label': 'Send to' });
  const pick = (id: string | null) => {
    to = id;
    for (const b of choices.children) b.classList.toggle('on', (b as HTMLElement).dataset.to === (id ?? ''));
    wtRow.classList.toggle('hidden', !!id || !opts.worktreeOption);
    repos.element?.classList.toggle('hidden', !!id);
    modelRow?.classList.toggle('hidden', !!id);
    newOpts.classList.toggle('hidden', !!id || (!models && !opts.worktreeOption));
    submit.textContent = id ? 'Send' : 'Hire & start';
    submit.classList.toggle('accent', !id);
    submit.classList.toggle('primary', !!id);
    refusedNote.classList.add('hidden');
    assist.syncScope();
  };
  if (opts.newDesk) choices.append(h('button.btn', { type: 'button', 'data-to': '', onclick: () => pick(null) }, `New worker · ${opts.newDesk}`));
  for (const w of opts.workers) {
    const dot = colorDot(w.color);
    choices.append(h('button.btn', { type: 'button', 'data-to': w.id, title: `Type it into ${w.name}'s prompt`, onclick: () => pick(w.id) }, dot, w.name, h('small', {}, STATUS_LABEL[w.status] ?? w.status)));
  }

  const cancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const form = h(
    'form.modal.ask',
    { role: 'dialog', 'aria-label': opts.title },
    h('header', {}, h('h2', {}, opts.title)),
    h(
      'div.body.stack',
      {},
      h('div.field', {}, h('label', {}, 'Send to'), choices),
      opts.context ? h('details.ask-context', {}, h('summary', {}, 'The worker is told first…'), h('pre', {}, opts.context)) : null,
      h('div.field', {}, h('label', { for: 'ask-prompt' }, 'Prompt'), h('div.prompt-composer', {}, h('div.prompt-input', {}, assist.pasteChips, extras.element, pictureHint(), images.element), assist.mentionMenu, assist.slashMenu)),
      newOpts,
      refusedNote,
    ),
    h('footer', {}, sendHint(false), cancel, submit),
  ) as HTMLFormElement;
  form.noValidate = true;
  pick(to);

  const releaseEsc = claimEscape(form, () => assist.dismissMenu());
  const offFactory = store.on('factory', () => assist.paintSlash());
  const modal = openModal(form, {
    onClose: () => {
      images.discard();
      releaseEsc();
      offFactory();
      assist.dispose();
      extras.dispose();
    },
  });
  images.dropZone(modal.backdrop, modal.el);
  cancel.addEventListener('click', () => modal.close());
  let waiting = false;
  const send = () => {
    if (waiting) return;
    const text = assist.expand().trim();
    if (!text && !images.ids().length && !images.busy()) {
      ta.focus();
      return;
    }
    if (text.length > PROMPT_MAX) {
      refusedNote.textContent = `This message is ${text.length.toLocaleString('en-US')} characters, over the ${PROMPT_MAX.toLocaleString('en-US')}-character limit. Remove some pasted text.`;
      refusedNote.classList.remove('hidden');
      return;
    }
    const target = to ? opts.workers.find((w) => w.id === to) : undefined;
    const fullPrompt = opts.context ? `${opts.context}\n\n${text}` : text;
    if (!target?.cloud) {
      const slashError = slashRefusal(fullPrompt, target?.name ?? (to ? 'this worker' : 'the new worker'), false, assist.slashList());
      if (slashError) {
        refusedNote.textContent = slashError;
        refusedNote.classList.remove('hidden');
        return;
      }
    }
    // A picture still going up is sent with the prompt once it's there.
    if (images.busy()) {
      waiting = true;
      void images.settled().then(() => {
        waiting = false;
        send();
      });
      return;
    }
    const refused = !to && models?.cannotRun();
    if (refused) {
      refusedNote.textContent = `${refused}. Pick another model.`;
      refusedNote.classList.remove('hidden');
      return;
    }
    const picked = images.take();
    if (text) extras.sent(text);
    modal.close();
    if (!to && opts.worktreeOption) {
      try {
        localStorage.setItem(WT_KEY, wtBox.checked ? '1' : '0');
      } catch {
        // storage blocked
      }
    }
    opts.onSubmit(fullPrompt, to, !to && opts.worktreeOption && wtBox.checked, !to ? models?.model() : undefined, !to ? models?.effort() : undefined, !to && opts.worktreeOption && wtBox.checked ? repos.value() : undefined, picked);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 30);
}
