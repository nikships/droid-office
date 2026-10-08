import { canHost, cloudBadge, cloudSessionUrl, computerHome, type CloudComputer } from '../../shared/factory-cloud';
import { NEW_SESSION_GRACE_MS, creditsNote } from '../../shared/factory-sessions';
import { statusWord } from '../../shared/guests';
import type { AgentEffort, WorkerInfo } from '../../shared/protocol';
import { factoryFetch, watchFactory } from '../factory';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, STATUS_LABEL, toast, type Modal } from './dom';
import { mountTranscript } from './factory-transcript';
import { promptImages } from './images';
import { modelBadge } from './models';

// Cloud workers in the browser (src/server/factory/cloud.ts): the hire dialog's "Runs on" choice, the
// window E opens at one's desk (its session on Factory and a prompt box), and sending one home.

/** A hire's Factory computer and the folder its session starts in there. */
export interface CloudChoice {
  computerId: string;
  computerName: string;
  cwd: string;
}

export interface RunsOn {
  element: HTMLElement;
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

/** The hire dialog's "Runs on": this machine (the default), or an active Factory computer with a folder there. Null when there's no computer to offer. */
export function runsOnPicker(): RunsOn | null {
  const computers = cloudComputers();
  if (!computers.length) return null;
  const select = h(
    'select',
    { id: 'runs-on', 'aria-label': 'Runs on' },
    h('option', { value: '' }, '💻 This machine'),
    ...computers.map((c) => h('option', { value: c.id }, `${cloudBadge({ computerName: c.name })} · ${c.providerType}`)),
  ) as HTMLSelectElement;
  const folder = h('input', { id: 'runs-on-cwd', type: 'text', spellcheck: false, autocomplete: 'off', 'aria-label': 'Folder on that computer', style: 'flex:1 1 220px;min-width:160px' }) as HTMLInputElement;
  const note = h('p.setting-note', { style: 'margin:6px 0 0' });
  const cloudRow = h('div.model-choice.hidden', {}, h('label', { for: 'runs-on-cwd' }, 'Folder'), folder);
  const listeners: ((cloud: boolean) => void)[] = [];
  const picked = () => computers.find((c) => c.id === select.value);
  const paint = () => {
    const c = picked();
    cloudRow.classList.toggle('hidden', !c);
    note.classList.toggle('hidden', !c);
    if (c) {
      const home = computerHome(c);
      folder.value = savedCwds()[c.id] ?? '';
      folder.placeholder = home ? `Empty for its home folder (${home}), or ~/repo` : `Empty for its home folder, or a full path on ${c.name}`;
      note.textContent = `Its Droid session runs on ${c.name}, in auto mode, through Factory: no worktree or terminal here. Clone the repository there first if it isn't.`;
    }
    for (const fn of listeners) fn(!!c);
  };
  select.addEventListener('change', paint);
  paint();
  return {
    element: h('div', {}, h('div.model-choice', {}, h('label', { for: 'runs-on' }, 'Runs on'), select), cloudRow, note),
    choice: () => {
      const c = picked();
      return c && { computerId: c.id, computerName: c.name, cwd: folder.value.trim() };
    },
    onChange: (fn) => {
      listeners.push(fn);
      fn(!!picked());
    },
  };
}

/** Makes a cloud worker's session at `deskId` and seats it; why it didn't, for the dialog to show. */
export async function hireCloud(deskId: string, text: string, o: { model?: string; effort?: AgentEffort; images: string[]; cloud: CloudChoice }): Promise<string | undefined> {
  saveCwd(o.cloud.computerId, o.cloud.cwd);
  try {
    await factoryFetch('cloud', '/hire', {
      method: 'POST',
      body: { floor: store.floor, deskId, computerId: o.cloud.computerId, cwd: o.cloud.cwd, prompt: text, model: o.model, effort: o.effort, images: o.images },
    });
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** The line under a cloud worker's name: where it runs, its model, its folder there. */
export function cloudLine(w: WorkerInfo): string {
  if (!w.cloud) return '';
  const badge = modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort);
  return [cloudBadge(w.cloud), badge, w.cloud.cwd ?? '~'].filter(Boolean).join(' · ');
}

/** Sending a cloud worker home: it leaves its desk, and its Factory session is kept unless the box is ticked. */
export function sendCloudHome(net: Net, w: WorkerInfo) {
  const box = h('input', { type: 'checkbox', id: 'cloud-delete' }) as HTMLInputElement;
  const yes = h('button.btn.danger', { type: 'button' }, 'Send home');
  const no = h('button.btn', { type: 'button' }, 'Never mind');
  const where = w.cloud ? w.cloud.computerName : 'Factory';
  const busy = w.status === 'working' || w.status === 'starting';
  const el = h(
    'div.modal',
    { role: 'alertdialog', 'aria-label': `Send ${w.name} home?` },
    h('header', {}, h('h2', {}, `Send ${w.name} home?`)),
    h(
      'div.body',
      {},
      h('p', { style: 'margin:0;font-weight:700' }, `${w.name} leaves the desk${busy ? `, and its session on ${where} is stopped` : ''}. The session stays in Factory unless you delete it.`),
      h('label', { for: 'cloud-delete', style: 'display:flex;gap:8px;align-items:center;margin:12px 0 0;font-weight:700;cursor:pointer' }, box, '🗑️ Also delete its Factory session'),
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

/** The cloud worker whose window is open, if any. */
export function openCloudFor(): string | null {
  return current?.workerId ?? null;
}

/**
 * A cloud worker's window: where it runs, its session's transcript (factory-transcript.ts, read live
 * while it works), its session in Factory's web app, and a prompt box (Enter sends, Shift+Enter is a
 * new line, pictures pasted or dropped) with Interrupt while it works. The office reads its session
 * quickly while this is open.
 */
export function openCloudWindow(net: Net, workerId: string) {
  if (current?.workerId === workerId) return;
  current?.modal.close();
  const info = store.workers.get(workerId);
  if (!info?.cloud) return;

  const dot = h('span.dot', { style: `background:${info.color}` });
  const title = h('h2', {});
  const pill = h('span.pill', {});
  const link = info.sessionId ? h('a.btn', { href: cloudSessionUrl(info.sessionId), target: '_blank', rel: 'noopener noreferrer', title: 'Its session in the Factory web app' }, 'Open in Factory ↗') : null;
  const closeBtn = h('button.btn.close', { title: 'Close (Esc)', 'aria-label': 'Close' }, '✕');
  const meta = h('div.cloud-meta');
  const error = h('p.cloud-error.setting-note.bad.hidden', { role: 'alert' });
  const worker = () => store.workers.get(workerId);
  const busyNow = () => {
    const s = worker()?.status;
    return s === 'working' || s === 'starting';
  };
  const transcript = info.sessionId
    ? mountTranscript({
        sessionId: info.sessionId,
        live: busyNow,
        starting: () => {
          const w = worker();
          return !!w && (w.status === 'starting' || Date.now() - w.createdAt < NEW_SESSION_GRACE_MS);
        },
        empty: () => (worker()?.status === 'starting' ? 'Starting… sending its first prompt' : 'Waiting for a prompt'),
      })
    : null;
  const ta = h('textarea', { rows: 3, placeholder: `Message ${info.name}…`, 'aria-label': `Message ${info.name}` }) as HTMLTextAreaElement;
  const images = promptImages(ta);
  const interrupt = h('button.btn', { type: 'button', title: 'Stop what it is doing now' }, '⏹ Interrupt');
  const send = h('button.btn.primary', { type: 'submit' }, 'Send');
  const form = h('form.cloud-prompt', {}, ta, images.element, h('div.cloud-actions', {}, h('span.grow', {}, 'Enter to send · Shift+Enter for a new line · paste or drop pictures'), interrupt, send)) as HTMLFormElement;
  const el = h(
    'div.modal.term.cloud-win',
    { role: 'dialog', 'aria-label': `${info.name} on ${info.cloud.computerName}` },
    h('header', {}, dot, title, pill, link, closeBtn),
    meta,
    error,
    transcript?.element ?? h('div.ft', {}, h('div.ft-status', {}, 'It has no Factory session')),
    form,
  );

  const refresh = () => {
    const w = store.workers.get(workerId);
    if (!w?.cloud) return modal.close();
    title.textContent = [`☁ ${w.name}`, w.title].filter(Boolean).join(' · ');
    pill.className = `pill ${w.status}`;
    pill.textContent = statusWord(w, STATUS_LABEL);
    meta.textContent = [cloudLine(w), `autonomy ${w.cloud.autonomy}`, creditsNote(store.factory.sessions, w.sessionId)].filter(Boolean).join(' · ');
    const busy = busyNow();
    error.textContent = w.cloud.error ? `☁ ${w.name} can't work: ${w.cloud.error}. Send it home and hire another.` : '';
    error.classList.toggle('hidden', !w.cloud.error);
    interrupt.toggleAttribute('disabled', !busy);
    send.toggleAttribute('disabled', !!w.cloud.error);
  };

  const submit = () => {
    const text = ta.value.trim();
    if (images.busy()) return void images.settled().then(submit);
    if (!text && !images.ids().length) return ta.focus();
    const ids = images.take();
    net.send({ t: 'worker.prompt', workerId, prompt: text, images: ids.length ? ids : undefined });
    ta.value = '';
    void transcript?.refresh();
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  interrupt.addEventListener('click', () => {
    interrupt.toggleAttribute('disabled', true);
    factoryFetch('cloud', `/${encodeURIComponent(workerId)}/interrupt`, { method: 'POST' })
      .then(() => transcript?.refresh())
      .catch((err: Error) => {
        toast(`☁ Couldn't interrupt ${info.name}: ${err.message}`, 'warn');
        refresh();
      });
  });
  closeBtn.addEventListener('click', () => modal.close());

  const unsub = store.on('workers', refresh);
  const unsubCredits = store.on('factory', refresh);
  const unwatch = watchFactory('cloud');
  net.send({ t: 'worker.attach', workerId });
  const modal = openModal(el, {
    backdropCloses: true,
    doing: `☁ in ${info.name}'s window`,
    onClose: () => {
      unsub();
      unsubCredits();
      unwatch();
      transcript?.dispose();
      images.discard();
      net.send({ t: 'worker.detach', workerId });
      if (current?.modal === modal) current = null;
    },
  });
  images.dropZone(modal.backdrop, el);
  current = { workerId, modal };
  refresh();
  setTimeout(() => ta.focus(), 30);
}
