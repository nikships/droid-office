import type { AgentEffort, AgentProvider, ServerMsg, WorktreeCleanup, WorktreeState } from '../../shared/protocol';
import { h, openModal } from './dom';
import { store } from '../state';
import { providerPicker, type ProviderPicker } from './provider';

export interface PromptOptions {
  title: string;
  subtitle?: string;
  /** A warning over the prompt, e.g. that the machine is under pressure. */
  warning?: string;
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  /** Allow hiring a worker without an initial prompt (the direct hire flow). */
  allowEmpty?: boolean;
  /** Offer the "own git worktree" option (only when hiring a new worker). */
  worktreeOption?: boolean;
  /** Offer the configured agent provider choice (only when hiring a new worker). */
  providerOption?: boolean;
  /** The desk being hired at, so the model/effort choice remembered here is this desk's, not the whole office's. */
  deskId?: string;
  onSubmit(text: string, opts: { worktree: boolean; provider?: AgentProvider; model?: string; effort?: AgentEffort }): void;
}

const WT_KEY = 'droid-office.worktree';
/** Whether the last hire asked for its own git worktree (the Ask window shares the choice). */
export function worktreePref(): boolean {
  try {
    return localStorage.getItem(WT_KEY) === '1';
  } catch {
    return false;
  }
}
/** Remembers the worktree choice without hiring (the VR hire view's toggle). */
export function setWorktreePref(worktree: boolean) {
  try {
    localStorage.setItem(WT_KEY, worktree ? '1' : '0');
  } catch {
    // storage blocked
  }
}

export function openPrompt(opts: PromptOptions) {
  const ta = h('textarea', { rows: 7, placeholder: opts.placeholder ?? 'What should the worker work on?', 'aria-label': 'Prompt' }) as HTMLTextAreaElement;
  ta.value = opts.initial ?? '';
  const wtBox = h('input', { type: 'checkbox', id: 'wt-toggle' }) as HTMLInputElement;
  wtBox.checked = worktreePref();
  const wtRow = opts.worktreeOption
    ? h(
        'label',
        { for: 'wt-toggle', style: 'display:flex;gap:8px;align-items:center;margin:10px 0 0;font-weight:700;cursor:pointer', title: 'Isolate this worker on its own branch so parallel workers never collide' },
        wtBox,
        '🌿 Work in its own git worktree & branch',
      )
    : null;
  const provider: ProviderPicker | null = opts.providerOption ? providerPicker(store.project, 'prompt-provider', 'Worker provider', opts.deskId ? `desk:${opts.deskId}` : 'prompt-provider') : null;
  const submit = h('button.btn.primary', { type: 'submit' }, opts.submitLabel ?? 'Send');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const form = h(
    'form.modal',
    { role: 'dialog', 'aria-label': opts.title },
    h('header', {}, h('h2', {}, opts.title)),
    h(
      'div.body',
      {},
      opts.warning ? h('p.setting-note.bad', { style: 'margin:0 0 10px', role: 'alert' }, opts.warning) : null,
      opts.subtitle ? h('p', { style: 'margin:0 0 10px;font-weight:700;color:var(--muted)' }, opts.subtitle) : null,
      ta,
      provider?.element ?? null,
      wtRow,
    ),
    h('footer', {}, h('span.grow', {}, 'Enter to send · Shift+Enter for a new line'), cancel, submit),
  ) as HTMLFormElement;
  form.noValidate = true;

  const modal = openModal(form);
  cancel.addEventListener('click', () => modal.close());
  const send = () => {
    const text = ta.value.trim();
    if (!text && !opts.allowEmpty) {
      ta.focus();
      return;
    }
    if (provider && !provider.valid()) return;
    modal.close();
    if (opts.worktreeOption) setWorktreePref(wtBox.checked);
    opts.onSubmit(text, { worktree: !!opts.worktreeOption && wtBox.checked, provider: provider?.value(), model: provider?.model(), effort: provider?.effort() });
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  ta.addEventListener('keydown', (e) => {
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

export function confirmDialog(title: string, body: string, confirmLabel: string, onConfirm: () => void) {
  const yes = h('button.btn.danger', { type: 'button' }, confirmLabel);
  const no = h('button.btn', { type: 'button' }, 'Never mind');
  const el = h('div.modal', { role: 'alertdialog', 'aria-label': title }, h('header', {}, h('h2', {}, title)), h('div.body', {}, h('p', { style: 'margin:0;font-weight:700' }, body)), h('footer', {}, no, yes));
  const modal = openModal(el);
  no.addEventListener('click', () => modal.close());
  yes.addEventListener('click', () => {
    modal.close();
    onConfirm();
  });
  setTimeout(() => yes.focus(), 30);
}

export interface SendHomeOptions {
  workerId: string;
  name: string;
  /** The desk's label. */
  where: string;
  worktree: { path: string; branch: string };
  /** Asks the office what the worktree holds; the answer comes back through routeWorktreeMessage. */
  ask(): void;
  onConfirm(cleanup: WorktreeCleanup): void;
}

/** Whoever is waiting to hear what a worker's worktree holds, by worker id. */
const worktreeChecks = new Map<string, (state: WorktreeState) => void>();

export function routeWorktreeMessage(msg: ServerMsg) {
  if (msg.t !== 'worker.worktree') return;
  worktreeChecks.get(msg.workerId)?.(msg.state);
  worktreeChecks.delete(msg.workerId);
}

function inspectWorktree(workerId: string, ask: () => void): Promise<WorktreeState> {
  return new Promise((resolve) => {
    worktreeChecks.set(workerId, resolve);
    ask();
    setTimeout(() => {
      if (worktreeChecks.get(workerId) !== resolve) return;
      worktreeChecks.delete(workerId);
      resolve({ exists: true, dirty: 0, ahead: 0, unpushed: 0, error: 'the office did not answer' });
    }, 8000);
  });
}

const CLEANUP_LABEL: Record<WorktreeCleanup, string> = {
  all: 'Send home & delete both',
  worktree: 'Send home & delete worktree',
  keep: 'Send home',
};

/**
 * Sending home a worker that has its own worktree: pick what becomes of the worktree and its branch.
 * Opens on "keep" while the office checks the worktree, then suggests deleting when nothing would be lost.
 */
export function sendHomeDialog(opts: SendHomeOptions) {
  const { branch, path } = opts.worktree;
  const choices: [WorktreeCleanup, string, string][] = [
    ['all', 'Delete the worktree and its branch', `Removes ${path} and ${branch}.`],
    ['worktree', 'Delete the worktree, keep the branch', `${branch} stays for a pull request or a later checkout.`],
    ['keep', 'Keep both', 'Leaves everything as it is; droid-office prune tidies up later.'],
  ];
  const radios = new Map<WorktreeCleanup, HTMLInputElement>();
  let touched = false;
  const yes = h('button.btn.danger', { type: 'submit' }, CLEANUP_LABEL.keep);
  const chosen = (): WorktreeCleanup => [...radios].find(([, r]) => r.checked)?.[0] ?? 'keep';
  const pick = (c: WorktreeCleanup) => {
    radios.get(c)!.checked = true;
    yes.textContent = CLEANUP_LABEL[c];
  };
  const list = h(
    'div.choices',
    {},
    ...choices.map(([value, title, sub]) => {
      const r = h('input', {
        type: 'radio',
        name: 'cleanup',
        value,
        onchange: () => {
          touched = true;
          yes.textContent = CLEANUP_LABEL[chosen()];
        },
      }) as HTMLInputElement;
      radios.set(value, r);
      return h('label.choice', {}, r, h('span', {}, title, h('small', {}, sub)));
    }),
  );
  const status = h('p.wt-status', {}, `Checking what ${branch} holds…`);
  const no = h('button.btn', { type: 'button' }, 'Never mind');
  const form = h(
    'form.modal',
    { role: 'dialog', 'aria-label': `Send ${opts.name} home?` },
    h('header', {}, h('h2', {}, `Send ${opts.name} home?`)),
    h('div.body', {}, h('p', { style: 'margin:0 0 12px;font-weight:700' }, `This stops the session at ${opts.where} for everyone and frees the desk. ${opts.name} worked in its own worktree on 🌿 ${branch}:`), list, status),
    h('footer', {}, no, yes),
  ) as HTMLFormElement;
  pick('keep');
  const modal = openModal(form);
  no.addEventListener('click', () => modal.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const cleanup = chosen();
    modal.close();
    opts.onConfirm(cleanup);
  });
  void inspectWorktree(opts.workerId, opts.ask).then((s) => {
    if (!form.isConnected) return;
    const lines: string[] = [];
    let risky = false;
    if (s.error) {
      lines.push(`Couldn't check the worktree: ${s.error}.`);
      risky = true;
    } else {
      if (!s.exists) lines.push('The worktree folder is already gone.');
      if (s.dirty) {
        lines.push(`⚠️ ${plural(s.dirty, 'uncommitted change')} in the worktree — deleting it loses them.`);
        risky = true;
      }
      if (s.unpushed) {
        lines.push(`⚠️ ${plural(s.unpushed, 'commit')} on ${branch} that no remote has — deleting the branch loses them.`);
        risky = true;
      } else if (s.ahead) lines.push(`${plural(s.ahead, 'commit')} on ${branch}, all pushed or merged.`);
      if (!lines.length) lines.push('Nothing on the branch yet and a clean worktree: safe to delete.');
    }
    status.replaceChildren(...lines.flatMap((l, i) => (i ? [h('br'), l] : [l])));
    status.classList.toggle('warn', risky);
    if (!touched) pick(risky ? 'keep' : 'all');
  });
  setTimeout(() => yes.focus(), 30);
}

export interface ShootDialogOptions {
  workerId: string;
  name: string;
  where: string;
  worktree?: { path: string; branch: string };
  ask?: () => void;
  onConfirm(cleanup?: WorktreeCleanup): void;
  onRevive(): void;
}

/** The local casualty preview is button-resolved: Escape and the close button always mean Revive. */
export function shootDialog(opts: ShootDialogOptions): { dismiss(): void } {
  const radios = new Map<WorktreeCleanup, HTMLInputElement>();
  let touched = false;
  let resolved = false;
  const yes = h('button.btn.danger', { type: 'submit' }, 'Confirm kill');
  const status = h('p.wt-status', {}, opts.worktree ? `Checking what ${opts.worktree.branch} holds…` : 'The session will keep running unless you confirm cleanup.');
  const choices = opts.worktree
    ? h(
        'div.choices',
        {},
        ...(
          [
            ['all', 'Delete the worktree and its branch', `Removes ${opts.worktree.path} and ${opts.worktree.branch}.`],
            ['worktree', 'Delete the worktree, keep the branch', `${opts.worktree.branch} stays for a pull request or a later checkout.`],
            ['keep', 'Keep both', 'Leaves everything as it is; droid-office prune tidies up later.'],
          ] as const
        ).map(([value, title, sub]) => {
          const radio = h('input', {
            type: 'radio',
            name: 'cleanup',
            value,
            onchange: () => {
              touched = true;
              yes.textContent = CLEANUP_LABEL[[...radios].find(([, r]) => r.checked)?.[0] ?? 'keep'];
            },
          }) as HTMLInputElement;
          radios.set(value, radio);
          return h('label.choice', {}, radio, h('span', {}, title, h('small', {}, sub)));
        }),
      )
    : null;
  const body = h('div.body', {}, h('p', { style: 'margin:0 0 12px;font-weight:700' }, `${opts.name} has fallen at ${opts.where}. This is only a local preview; its session keeps running until you confirm cleanup.`), choices, status);
  const revive = h('button.btn', { type: 'button' }, 'Revive');
  const form = h('form.modal', { role: 'dialog', 'aria-label': `Clean up ${opts.name}?` }, h('header', {}, h('h2', {}, `Clean up ${opts.name}?`)), body, h('footer', {}, revive, yes)) as HTMLFormElement;
  const chosen = (): WorktreeCleanup => [...radios].find(([, r]) => r.checked)?.[0] ?? 'keep';
  const modal = openModal(form, {
    backdropCloses: false,
    onClose: () => {
      if (!resolved) {
        resolved = true;
        opts.onRevive();
      }
    },
  });
  const resolve = (cleanup?: WorktreeCleanup) => {
    if (resolved) return;
    resolved = true;
    modal.close();
    opts.onConfirm(cleanup);
  };
  revive.addEventListener('click', () => {
    if (resolved) return;
    resolved = true;
    modal.close();
    opts.onRevive();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    resolve(opts.worktree ? chosen() : undefined);
  });
  if (opts.worktree) {
    radios.get('keep')!.checked = true;
    void inspectWorktree(opts.workerId, opts.ask ?? (() => {})).then((state) => {
      if (!form.isConnected) return;
      const lines: string[] = [];
      let risky = false;
      if (state.error) {
        lines.push(`Couldn't check the worktree: ${state.error}.`);
        risky = true;
      } else {
        if (!state.exists) lines.push('The worktree folder is already gone.');
        if (state.dirty) {
          lines.push(`${plural(state.dirty, 'uncommitted change')} would be lost if deleted.`);
          risky = true;
        }
        if (state.unpushed) {
          lines.push(`${plural(state.unpushed, 'commit')} on ${opts.worktree!.branch} has no remote and would be lost if deleted.`);
          risky = true;
        } else if (state.ahead) lines.push(`${plural(state.ahead, 'commit')} on ${opts.worktree!.branch}, all pushed or merged.`);
        if (!lines.length) lines.push('Nothing on the branch yet and a clean worktree: safe to delete.');
      }
      status.replaceChildren(...lines.flatMap((line, i) => (i ? [h('br'), line] : [line])));
      status.classList.toggle('warn', risky);
      if (!touched) {
        const safe = risky ? 'keep' : 'all';
        radios.get(safe)!.checked = true;
        yes.textContent = CLEANUP_LABEL[safe];
      }
    });
  }
  setTimeout(() => revive.focus(), 30);
  return {
    dismiss() {
      resolved = true;
      modal.close();
    },
  };
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
