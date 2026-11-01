import { canHost, cloudBadge, cloudHire, cloudSessionUrl, computerHome, type CloudComputer } from '../../shared/factory-cloud';
import { canStartFrom, repoName, type FactoryEnvironment } from '../../shared/factory-environments';
import { creditsNote } from '../../shared/factory-sessions';
import { statusWord } from '../../shared/guests';
import type { AgentEffort, ClientMsg, WorkerInfo } from '../../shared/protocol';
import { watchFactory } from '../factory';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, STATUS_LABEL, type Modal } from './dom';
import { colorDot, groupRow, toggle } from './kit';
import { modelBadge } from './models';
import { mountWorkerThread } from './worker-thread';

// Cloud workers in the browser (src/server/factory/cloud.ts): the hire dialog's "Runs on" choice and
// the hire it makes, the window E opens at one's desk (its Thread), and sending one home.

/** A hire's Factory computer, or the Environment to start one from for it, and the folder its session starts in there. */
export interface CloudChoice {
  /** '' for a hire on an Environment: the office starts its computer. */
  computerId: string;
  /** The computer's name, or the Environment's. */
  computerName: string;
  environmentId?: string;
  cwd: string;
}

export interface RunsOn {
  /** Rows for the hire dialog's options group: where it runs, then the folder there (shown for a computer). */
  rows: HTMLElement[];
  /** The computer picked, or undefined for this machine. */
  choice(): CloudChoice | undefined;
  /** Hears the choice change between this machine (false) and a computer (true). */
  onChange(fn: (cloud: boolean) => void): void;
}

const CWD_KEY = 'droid-office.cloud-cwd';

/** The folder last typed for each computer. */
function savedCwds(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(CWD_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function saveCwd(computerId: string, cwd: string) {
  try {
    localStorage.setItem(CWD_KEY, JSON.stringify({ ...savedCwds(), [computerId]: cwd }));
  } catch {
    // storage blocked
  }
}

/** The account's computers a session can start on now, while the office is connected to Factory. */
export function cloudComputers(): CloudComputer[] {
  const f = store.factory;
  if (!f.connection.connected || f.connection.rejected) return [];
  return f.computers.items.filter(canHost).map((c) => ({ id: c.id, name: c.name, providerType: c.providerType, status: c.status, remoteUser: c.remoteUser }));
}

/** The account's Environments a computer can start from now, the default first. */
export function cloudEnvironments(): FactoryEnvironment[] {
  const f = store.factory;
  if (!f.connection.connected || f.connection.rejected) return [];
  return f.environments.items.filter(canStartFrom).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

/**
 * The hire dialog's "Runs on": this machine (the default), a fresh computer from one of the
 * account's Environments, or an active Factory computer, with a folder there. Null when there's
 * nothing but this machine to offer.
 */
export function runsOnPicker(): RunsOn | null {
  const computers = cloudComputers();
  const envs = cloudEnvironments();
  if (!computers.length && !envs.length) return null;
  const repo = store.floors
    .find((f) => f.id === store.floor)
    ?.repo?.split('/')
    .pop();
  const select = h(
    'select.select',
    { id: 'runs-on', 'aria-label': 'Runs on' },
    h('option', { value: '' }, '💻 This machine'),
    envs.length ? h('optgroup', { label: 'A fresh computer from an Environment' }, ...envs.map((e) => h('option', { value: `env:${e.id}` }, `⧉ ${e.name}${e.isDefault ? ' (default)' : ''}`))) : null,
    computers.length ? h('optgroup', { label: 'One of your computers' }, ...computers.map((c) => h('option', { value: c.id }, `${cloudBadge({ computerName: c.name })} · ${c.providerType}`))) : null,
  ) as HTMLSelectElement;
  const folder = h('input.input', { id: 'runs-on-cwd', type: 'text', spellcheck: false, autocomplete: 'off', 'aria-label': 'Folder on that computer' }) as HTMLInputElement;
  const note = h('small');
  const runsRow = groupRow('Runs on', 'This machine, a fresh computer from a Factory Environment, or one of your computers', select);
  runsRow.classList.add('runs-on-row');
  const cloudRow = groupRow('Folder', note, folder);
  cloudRow.classList.add('runs-on-folder', 'hidden');
  const listeners: ((cloud: boolean) => void)[] = [];
  const pickedEnv = () => (select.value.startsWith('env:') ? envs.find((e) => `env:${e.id}` === select.value) : undefined);
  const picked = () => computers.find((c) => c.id === select.value);
  const paint = () => {
    const c = picked();
    const e = pickedEnv();
    cloudRow.classList.toggle('hidden', !c && !e);
    if (e) {
      // The same pick the server makes for an empty folder (repoFolder): this floor's repository, else the only one.
      const clone = e.repositories.find((r) => !!repo && repoName(r.url) === repoName(repo)) ?? (e.repositories.length === 1 ? e.repositories[0] : undefined);
      folder.value = savedCwds()[`env:${e.id}`] ?? '';
      folder.placeholder = clone
        ? `Empty for its clone of ${clone.url
            .replace(/\.git$/, '')
            .split('/')
            .pop()}, or ~/…`
        : 'Empty for its home folder (/home/factory-user), or ~/…';
      note.textContent = `A computer of its own starts from ${e.name} with everything installed (about 10 seconds), and is deleted when it goes home. Its Droid session runs in auto mode through Factory: no worktree or terminal here.`;
    } else if (c) {
      const home = computerHome(c);
      folder.value = savedCwds()[c.id] ?? '';
      folder.placeholder = home ? `Empty for its home folder (${home}), or ~/repo` : `Empty for its home folder, or a full path on ${c.name}`;
      note.textContent = `Its Droid session runs on ${c.name}, in auto mode, through Factory: no worktree or terminal here. Clone the repository there first if it isn't.`;
    }
    for (const fn of listeners) fn(!!c || !!e);
  };
  select.addEventListener('change', paint);
  paint();
  return {
    rows: [runsRow, cloudRow],
    choice: () => {
      const e = pickedEnv();
      if (e) return { computerId: '', computerName: e.name, environmentId: e.id, cwd: folder.value.trim() };
      const c = picked();
      return c && { computerId: c.id, computerName: c.name, cwd: folder.value.trim() };
    },
    onChange: (fn) => {
      listeners.push(fn);
      fn(!!picked() || !!pickedEnv());
    },
  };
}

/** The `worker.spawn` that hires a cloud worker at `deskId` (or 'auto'), remembering the folder typed for that computer. */
export function cloudSpawn(deskId: string, text: string, o: { model?: string; effort?: AgentEffort; images: string[]; cloud: CloudChoice }): Extract<ClientMsg, { t: 'worker.spawn' }> {
  saveCwd(o.cloud.environmentId ? `env:${o.cloud.environmentId}` : o.cloud.computerId, o.cloud.cwd);
  return { t: 'worker.spawn', deskId, prompt: text || undefined, model: o.model, effort: o.effort, images: o.images.length ? o.images : undefined, cloud: cloudHire(o.cloud) };
}

/** Hires a cloud worker at `deskId` and waits until it's seated (making its session takes a while); why it wasn't, for the dialog to show. */
export async function hireCloud(net: Net, deskId: string, text: string, o: { model?: string; effort?: AgentEffort; images: string[]; cloud: CloudChoice }): Promise<string | undefined> {
  const result = await net.request(cloudSpawn(deskId, text, o));
  return result.ok ? undefined : (result.error ?? 'The office refused the hire.');
}

/** The line under a cloud worker's name: where it runs, its model, its folder there. */
export function cloudLine(w: WorkerInfo): string {
  if (!w.cloud) return '';
  const badge = modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort);
  return [cloudBadge(w.cloud), badge, w.cloud.cwd ?? '~'].filter(Boolean).join(' · ');
}

/** Sending a cloud worker home: it leaves its desk, and its Factory session is kept unless the box is ticked. */
export function sendCloudHome(net: Net, w: WorkerInfo) {
  const del = toggle({ label: 'Also delete its Factory session', description: 'Its transcript and settings go with it', id: 'cloud-delete' });
  const box = del.input;
  const yes = h('button.btn.danger', { type: 'button' }, 'Send home');
  const no = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const where = w.cloud ? w.cloud.computerName : 'Factory';
  const busy = w.status === 'working' || w.status === 'starting';
  const el = h(
    'div.modal.sm.confirm',
    { role: 'alertdialog', 'aria-label': `Send ${w.name} home?` },
    h('header', {}, h('h2', {}, `Send ${w.name} home?`)),
    h(
      'div.body.stack',
      {},
      h(
        'p.confirm-text',
        {},
        w.cloud?.instance
          ? `${w.name} leaves the desk, and the computer the office started for it from ${w.cloud.environmentName ?? 'its Environment'} (${where}) is deleted. Its session stays archived in Factory unless you delete it.`
          : `${w.name} leaves the desk${busy ? `, and its session on ${where} is stopped` : ''}. The session stays in Factory unless you delete it.`,
      ),
      del,
    ),
    h('footer', {}, no, yes),
  );
  const modal = openModal(el);
  no.addEventListener('click', () => modal.close());
  yes.addEventListener('click', () => {
    modal.close();
    net.send({ t: 'worker.kill', workerId: w.id, deleteSession: box.checked || undefined });
  });
  setTimeout(() => yes.focus(), 30);
}

let current: { workerId: string; modal: Modal } | null = null;
/** What was typed in each cloud worker's window, kept while the page is open. */
const drafts = new Map<string, string>();

/** The cloud worker whose window is open, if any. */
export function openCloudFor(): string | null {
  return current?.workerId ?? null;
}

/**
 * A cloud worker's window: where it runs, its session in Factory's web app, and its Thread
 * (worker-thread.ts, the same view the web companion shows), read from its Factory session while
 * the window is open. The office reads its session quickly while this is open.
 */
export function openCloudWindow(net: Net, workerId: string) {
  if (current?.workerId === workerId) return;
  current?.modal.close();
  const info = store.workers.get(workerId);
  if (!info?.cloud) return;

  const dot = colorDot(info.color);
  const title = h('h2', {});
  const pill = h('span.pill', {});
  const link = info.sessionId ? h('a.btn.sm', { href: cloudSessionUrl(info.sessionId), target: '_blank', rel: 'noopener noreferrer', title: 'Its session in the Factory web app' }, 'Open in Factory ↗') : null;
  const closeBtn = h('button.btn.close', { title: 'Close (Esc)', 'aria-label': 'Close' }, '✕');
  const meta = h('div.cloud-meta');
  const error = h('p.cloud-error.note.bad.hidden', { role: 'alert' });
  const thread = mountWorkerThread(net, {
    worker: info,
    // A cloud worker never waits on a menu here: nothing to show in the question slot.
    question: h('div', { hidden: true }),
    queueKey: `droid-office.cloud-queue:${store.floor ?? ''}:${workerId}`,
    draft: drafts.get(workerId) ?? '',
    onDraft: (text) => (text ? drafts.set(workerId, text) : drafts.delete(workerId)),
    send: async (msg) => {
      const result = await net.request(msg);
      return result.ok ? undefined : (result.error ?? 'The office refused that.');
    },
    cloudErrorShown: true,
  });
  const el = h('div.modal.term.cloud-win', { role: 'dialog', 'aria-label': `${info.name} on ${info.cloud.computerName}` }, h('header', {}, dot, title, pill, link ? h('div.actions', {}, link) : null, closeBtn), meta, error, thread.element);

  const refresh = () => {
    const w = store.workers.get(workerId);
    if (!w?.cloud) return modal.close();
    title.textContent = [`☁ ${w.name}`, w.title].filter(Boolean).join(' · ');
    title.title = title.textContent;
    pill.className = `pill ${w.status}`;
    pill.textContent = statusWord(w, STATUS_LABEL);
    meta.textContent = [cloudLine(w), `autonomy ${w.cloud.autonomy}`, creditsNote(store.factory.sessions, w.sessionId)].filter(Boolean).join(' · ');
    meta.title = meta.textContent;
    error.textContent = w.cloud.error ? `☁ ${w.name} can't work: ${w.cloud.error}. Check again, or send it home and hire another.` : '';
    error.classList.toggle('hidden', !w.cloud.error);
    thread.update(w, net.up);
  };
  closeBtn.addEventListener('click', () => modal.close());

  const unsub = store.on('workers', refresh);
  const unsubCredits = store.on('factory', refresh);
  const unstatus = net.onStatus(refresh);
  const unwatch = watchFactory('cloud');
  const modal = openModal(el, {
    backdropCloses: true,
    doing: `☁ in ${info.name}'s window`,
    onClose: () => {
      unsub();
      unsubCredits();
      unstatus();
      unwatch();
      thread.dispose();
      if (current?.modal === modal) current = null;
    },
  });
  thread.dropZone(modal.backdrop, el);
  current = { workerId, modal };
  refresh();
  thread.activate(true);
  setTimeout(() => thread.element.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')?.focus(), 30);
}
