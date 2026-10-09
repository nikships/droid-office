import type { AgentEffort, LostBranch, ServerMsg, WorktreeCleanup, WorktreeState } from '../../shared/protocol';
import { h, openModal } from './dom';
import { promptImages, type PromptImages } from './images';
import { choices as optionCards, groupRow, toggle, windowHeader } from './kit';
import { agentPicker, type AgentFields } from './models';
import type { CloudChoice, RunsOn } from './factory-cloud';

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
  /** Offer the model and effort pickers (only when hiring a new worker). */
  modelOption?: boolean;
  /** Take pictures pasted or dropped into the prompt: for a prompt that goes to an agent. */
  imagesOption?: boolean;
  /** The desk being hired at, so the model/effort choice remembered here is this desk's, not the whole office's. */
  deskId?: string;
  /** Other floors' projects a new worker in its own worktree can work in too (see WorkerInfo.repos). */
  repoOptions?: { id: string; name: string }[];
  onSubmit(text: string, opts: { worktree: boolean; model?: string; effort?: AgentEffort; repos: string[]; images: string[] }): void;
  /** The "Runs on" choice of a hire: this machine, or one of the account's Factory computers (factory-cloud.ts). */
  runsOn?: RunsOn | null;
  /** Hires on a Factory computer instead of onSubmit; resolves to why it didn't, which the box stays open to show. */
  onCloud?(text: string, opts: { model?: string; effort?: AgentEffort; images: string[]; cloud: CloudChoice }): Promise<string | undefined>;
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

export function setWorktreePref(worktree: boolean) {
  try {
    localStorage.setItem(WT_KEY, worktree ? '1' : '0');
  } catch {
    // storage blocked
  }
}

/**
 * Hiring across repositories: other floors' projects the new worker takes on too, each in a worktree
 * of its own on the same branch. That needs a worktree of its own here, so picking one ticks `wtBox`
 * and unticking that clears them.
 */
export function repoPicker(options: { id: string; name: string }[] | undefined, wtBox: HTMLInputElement): { element: HTMLElement | null; value(): string[] } {
  const picks = (options ?? []).map((r) => {
    const box = h('input', { type: 'checkbox', value: r.id, onchange: () => box.checked && (wtBox.checked = true) }) as HTMLInputElement;
    return { id: r.id, box, el: h('label.chip.repo-pick', { title: `A worktree of ${r.name} too, on the same branch, with a pull request of its own` }, box, h('span', {}, r.name)) };
  });
  if (!picks.length) return { element: null, value: () => [] };
  wtBox.addEventListener('change', () => {
    if (!wtBox.checked) for (const p of picks) p.box.checked = false;
  });
  const element = groupRow('Also work in', 'A worktree of each on the same branch, with a pull request of its own', h('div.chips', {}, ...picks.map((p) => p.el)));
  element.classList.add('repo-picks');
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Other projects to work in');
  return { element, value: () => picks.filter((p) => p.box.checked).map((p) => p.id) };
}

/** The "own git worktree" row of a hire's options, and its switch. */
export function worktreeRow(id: string, checked: boolean): { row: HTMLElement; box: HTMLInputElement } {
  const sw = toggle({ label: 'Work in its own git worktree & branch', id, checked, bare: true });
  const row = groupRow('Own git worktree & branch', 'Its own branch, so parallel workers never collide', sw);
  row.classList.add('wt-row');
  row.title = 'Isolate this worker on its own branch so parallel workers never collide';
  return { row, box: sw.input };
}

/** A prompt box's footer hint: the keys that send it, and pictures when it takes them. */
export function sendHint(pictures: boolean): HTMLElement {
  return h('span.grow.send-hint', {}, h('span.key', {}, 'Enter'), 'send', h('span.key', {}, '⇧ Enter'), 'new line', pictures ? h('span.send-hint-more', {}, '· paste or drop pictures') : null);
}

/** The line under a prompt box that takes pictures, where the footer has no room to say so. */
export function pictureHint(): HTMLElement {
  return h('p.field-hint', {}, 'Paste or drop pictures to attach them.');
}

export function openPrompt(opts: PromptOptions) {
  const ta = h('textarea.input', { rows: opts.modelOption ? 5 : 4, placeholder: opts.placeholder ?? 'What should the worker work on?', 'aria-label': 'Prompt' }) as HTMLTextAreaElement;
  ta.value = opts.initial ?? '';
  const images: PromptImages | null = opts.imagesOption ? promptImages(ta) : null;
  const wt = worktreeRow('wt-toggle', worktreePref());
  const wtBox = wt.box;
  const wtRow = opts.worktreeOption ? wt.row : null;
  const repos = repoPicker(opts.worktreeOption ? opts.repoOptions : undefined, wtBox);
  const models: AgentFields | null = opts.modelOption ? agentPicker('hire-models', opts.deskId ? `desk:${opts.deskId}` : 'hire') : null;
  // Hiring is the one "make it happen" action, in the accent; a prompt to a worker already there is a plain send.
  const submit = h(opts.modelOption ? 'button.btn.accent' : 'button.btn.primary', { type: 'submit' }, opts.submitLabel ?? 'Send');
  const cancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const failed = h('p.note.bad.hidden', { role: 'alert' });
  // A worker on a Factory computer works in a folder there: no worktree here, no other floors.
  opts.runsOn?.onChange((cloud) => {
    wtRow?.classList.toggle('hidden', cloud);
    repos.element?.classList.toggle('hidden', cloud);
  });
  const rows = [models ? h('div.group-row.block', {}, models.element) : null, ...(opts.runsOn?.rows ?? []), wtRow, repos.element].filter((r): r is HTMLElement => !!r);
  const form = h(
    'form.modal.prompt-box',
    { role: 'dialog', 'aria-label': opts.title },
    windowHeader(opts.title, opts.subtitle),
    h(
      'div.body.stack',
      {},
      opts.warning ? h('p.note.bad', { role: 'alert' }, opts.warning) : null,
      h('div.prompt-input', {}, ta, images ? pictureHint() : null, images?.element ?? null),
      rows.length ? h('div.group.prompt-opts', { role: 'group', 'aria-label': 'Options' }, ...rows) : null,
      failed,
    ),
    h('footer', {}, sendHint(false), cancel, submit),
  ) as HTMLFormElement;
  form.noValidate = true;

  const modal = openModal(form, { onClose: () => images?.discard() });
  images?.dropZone(modal.backdrop, modal.el);
  cancel.addEventListener('click', () => modal.close());
  let waiting = false;
  const send = () => {
    if (waiting) return;
    const text = ta.value.trim();
    if (!text && !images?.ids().length && !images?.busy() && !opts.allowEmpty) {
      ta.focus();
      return;
    }
    // A picture still going up is sent with the prompt once it's there.
    if (images?.busy()) {
      waiting = true;
      void images.settled().then(() => {
        waiting = false;
        send();
      });
      return;
    }
    const cloud = opts.onCloud && opts.runsOn?.choice();
    if (cloud && opts.onCloud) {
      // Making the session takes a while, and when Factory says no the box stays open saying why.
      waiting = true;
      const label = submit.textContent;
      submit.toggleAttribute('disabled', true);
      submit.textContent = `☁ Starting on ${cloud.computerName}…`;
      failed.classList.add('hidden');
      void opts.onCloud(text, { model: models?.model(), effort: models?.effort(), images: images?.ids() ?? [], cloud }).then((why) => {
        waiting = false;
        submit.toggleAttribute('disabled', false);
        submit.textContent = label;
        if (why) {
          failed.textContent = `☁ ${why}`;
          failed.classList.remove('hidden');
          return;
        }
        images?.take();
        modal.close();
      });
      return;
    }
    const picked = images?.take() ?? [];
    modal.close();
    if (opts.worktreeOption) setWorktreePref(wtBox.checked);
    const worktree = !!opts.worktreeOption && wtBox.checked;
    opts.onSubmit(text, { worktree, model: models?.model(), effort: models?.effort(), repos: worktree ? repos.value() : [], images: picked });
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
  const no = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const el = h('div.modal.sm.confirm', { role: 'alertdialog', 'aria-label': title }, h('header', {}, h('h2', {}, title)), h('div.body', {}, h('p.confirm-text', {}, body)), h('footer', {}, no, yes));
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
  /** A worker across repositories: the folders of its workspace, its own floor's first (see WorkerInfo.repos). */
  repos?: string[];
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
  const across = opts.repos && opts.repos.length > 1 ? opts.repos : undefined;
  const options: { value: WorktreeCleanup; icon: string; title: string; description: string }[] = across
    ? [
        { value: 'all', icon: '🗑️', title: 'Delete the worktrees and their branch', description: `Removes its worktrees of ${across.join(', ')}, and ${branch} in each.` },
        { value: 'worktree', icon: '🌿', title: 'Delete the worktrees, keep the branch', description: `${branch} stays in each for a pull request or a later checkout.` },
        { value: 'keep', icon: '📦', title: 'Keep them all', description: 'Leaves everything as it is; droid-office prune in each project tidies up later.' },
      ]
    : [
        { value: 'all', icon: '🗑️', title: 'Delete the worktree and its branch', description: `Removes ${path} and ${branch}.` },
        { value: 'worktree', icon: '🌿', title: 'Delete the worktree, keep the branch', description: `${branch} stays for a pull request or a later checkout.` },
        { value: 'keep', icon: '📦', title: 'Keep both', description: 'Leaves everything as it is; droid-office prune tidies up later.' },
      ];
  let touched = false;
  const yes = h('button.btn.danger', { type: 'submit' }, CLEANUP_LABEL.keep);
  const list = optionCards(
    'cleanup',
    options,
    'keep',
    (v) => {
      touched = true;
      yes.textContent = CLEANUP_LABEL[v as WorktreeCleanup];
    },
    { rows: true },
  );
  const chosen = (): WorktreeCleanup => (list.value() as WorktreeCleanup) || 'keep';
  const pick = (c: WorktreeCleanup) => {
    list.select(c);
    yes.textContent = CLEANUP_LABEL[c];
  };
  const status = h('p.note.info', {}, `Checking what ${branch} holds…`);
  const no = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const form = h(
    'form.modal.send-home',
    { role: 'dialog', 'aria-label': `Send ${opts.name} home?` },
    h('header', {}, h('h2', {}, `Send ${opts.name} home?`)),
    h(
      'div.body.stack',
      {},
      h(
        'p.send-home-text',
        {},
        `This stops the session at ${opts.where} for everyone and frees the desk. ${opts.name} worked ${across ? `in worktrees of ${across.join(', ')}, each` : 'in its own worktree'} on `,
        h('code.wt-branch', { title: branch }, branch),
        across ? '. What becomes of them?' : '. What becomes of it?',
      ),
      list,
      status,
    ),
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
    // Across repositories, a line for each worktree, named.
    const each = s.repos?.length ? s.repos.map((r) => describeState(r.state, branch, `${r.name}: `)) : [describeState(s, branch)];
    const lines = each.flatMap((d) => d.lines);
    const risky = each.some((d) => d.risky);
    if (s.repos?.length && s.error && !lines.length) lines.push(`Couldn't check the worktrees: ${s.error}.`);
    status.replaceChildren(...lines.flatMap((l, i) => (i ? [h('br'), l] : [l])));
    const warn = risky || (!!s.error && !s.repos?.length);
    status.classList.toggle('warn', warn);
    status.classList.toggle('good', !warn);
    status.classList.remove('info');
    if (!touched) pick(risky ? 'keep' : 'all');
  });
  setTimeout(() => yes.focus(), 30);
}

export interface LostWorktreeOptions {
  name: string;
  worktree: { path: string; branch: string };
  lost: { branch: LostBranch };
  /** A worker across repositories: its workspace folder, deleted with every worktree in it. */
  workspace?: string;
  /** The other workers on the floor whose worktrees were deleted too. */
  others: string[];
  /** Its process is still running, in the deleted folder: its terminal is there to look at. */
  openTerminal?: () => void;
  /** Puts the folder back, for `all` the others' too. */
  rebuild(all: boolean): void;
  sendHome(): void;
}

/**
 * A worker whose worktree was deleted outside droid-office (see WorkerInfo.lost): says what happened
 * and what's left, and puts it back (every lost worker's at once, when there are more), or sends it home.
 */
export function lostWorktreeDialog(opts: LostWorktreeOptions) {
  const { name, others } = opts;
  const { branch } = opts.worktree;
  const folder = opts.workspace ?? opts.worktree.path;
  const title = `🌿 ${name}'s worktree was deleted`;
  const what = {
    here: `Its branch ${branch} is still here. Rebuilding checks it out again in the same place, and ${name} carries on its conversation; only uncommitted changes went with the folder.`,
    origin: `Its branch ${branch} was deleted too, but it had been pushed: rebuilding checks origin's copy out again in the same place, and ${name} carries on its conversation.`,
    gone: `Its branch ${branch} was deleted too and was never pushed, so the work on it is gone. Rebuilding makes the branch again from where it started, and ${name} carries on its conversation.`,
  }[opts.lost.branch];
  const one = h('button.btn.primary', { type: 'button' }, 'Rebuild worktree');
  const all = others.length ? h('button.btn', { type: 'button' }, `Rebuild all ${others.length + 1}`) : null;
  const home = h('button.btn.danger', { type: 'button' }, 'Send home…');
  const look = opts.openTerminal ? h('button.btn', { type: 'button' }, 'Open terminal') : null;
  const el = h(
    'div.modal.lost-worktree',
    { role: 'alertdialog', 'aria-label': title },
    h('header', {}, h('h2', {}, title)),
    h(
      'div.body.stack',
      {},
      h('p.lost-text', {}, h('code.wt-path', { title: folder }, folder), ` was deleted outside droid-office, so ${name} ${opts.openTerminal ? 'is running in a folder that no longer exists' : "can't start there"}.`),
      h(opts.lost.branch === 'gone' ? 'p.note.warn' : 'p.note.info', {}, what),
      others.length ? h('p.note.warn', {}, `${plural(others.length, 'other worker')} on this floor lost ${others.length === 1 ? 'its worktree' : 'their worktrees'} too: ${others.join(', ')}.`) : null,
    ),
    h('footer', {}, home, h('span.grow'), look, all, one),
  );
  const modal = openModal(el);
  const then = (fn: () => void) => () => {
    modal.close();
    fn();
  };
  one.addEventListener(
    'click',
    then(() => opts.rebuild(false)),
  );
  all?.addEventListener(
    'click',
    then(() => opts.rebuild(true)),
  );
  home.addEventListener('click', then(opts.sendHome));
  if (look) look.addEventListener('click', then(opts.openTerminal!));
  setTimeout(() => one.focus(), 30);
}

/** What deleting one worktree (and its branch) would lose, in a line or two for the send-home dialog. */
function describeState(s: WorktreeState, branch: string, prefix = ''): { lines: string[]; risky: boolean } {
  if (s.error) return { lines: [`${prefix}Couldn't check the worktree: ${s.error}.`], risky: true };
  const lines: string[] = [];
  let risky = false;
  if (!s.exists) lines.push(`${prefix}The worktree folder is already gone.`);
  if (s.dirty) {
    lines.push(`⚠️ ${prefix}${plural(s.dirty, 'uncommitted change')} in the worktree — deleting it loses them.`);
    risky = true;
  }
  if (s.unpushed) {
    lines.push(`⚠️ ${prefix}${plural(s.unpushed, 'commit')} on ${branch} that no remote has — deleting the branch loses them.`);
    risky = true;
  } else if (s.ahead) lines.push(`${prefix}${plural(s.ahead, 'commit')} on ${branch}, all pushed or merged.`);
  if (!lines.length) lines.push(`${prefix}Nothing on the branch yet and a clean worktree: safe to delete.`);
  return { lines, risky };
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
