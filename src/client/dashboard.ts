import type { ClientMsg, WorkerInfo } from '../shared/protocol';
import { canAnswer, menuTakesText, readMenu, sameMenu, type Menu } from '../shared/asks';
import { isAsleep, isBusy } from '../shared/status';
import { PROVIDER_LABEL, statusWord } from '../shared/guests';
import { cardsNewestFirst, cardChanged, OWNER } from '../shared/whiteboard';
import { ROOF } from '../shared/rooftop';
import { sessionWebUrl } from '../shared/factory-sessions';
import { BROWSER_KEY, DASHBOARD_FLOOR_KEY, browserCredential, draftKey, forgetBrowserCredential, saveBrowserCredential, type BrowserCredential } from './browser-session';
import { Net } from './net';
import { connectWhiteboard, store } from './state';
import { setBrowserAuth, withToken } from './token';
import { $, closeAllModals, h, openModal, STATUS_LABEL, toast } from './ui/dom';
import { colorDot, emptyState, windowHeader } from './ui/kit';
import { confirmDialog, openPrompt, routeWorktreeMessage, sendHomeDialog } from './ui/prompt';
import { modelBadge } from './ui/models';

const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const remember = (key: string, value: string) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* Drafts stay in this view if storage is blocked. */
  }
};
let credential = (() => {
  try {
    return browserCredential(localStorage);
  } catch {
    return undefined;
  }
})();
let bootstrap = new URLSearchParams(location.search).get('t') ?? '';
// Remove credentials before loading a card or navigating anywhere else.
if (location.search) history.replaceState(null, '', location.pathname);
const auth = () => setBrowserAuth(credential?.token ?? '', credential ? '' : bootstrap);
auth();

let authorized = false;
let fresh = false;
let switching = false;
let selected = '';
let floor = '';
let officeName = 'Droid Office';
let version = '';
let message = 'Connecting to the office…';
let pairing = false;
let persisted = true;
let terminal: typeof import('./ui/terminal') | undefined;
let whiteboard: typeof import('./ui/whiteboard') | undefined;
const busy = new Set<string>();
const status = h('p.dashboard-status', { role: 'status', 'aria-live': 'polite' }, message);
const connection = h('span.pill', {}, 'Connecting');
const title = h('h1', {}, officeName);
const floors = h('select.select', { 'aria-label': 'Active floor' });
const workerList = h('div.list.dashboard-workers', { 'aria-label': 'Workers' });
const detail = h('main.dashboard-detail', { id: 'worker-detail', tabindex: '-1', 'aria-label': 'Worker details' });
const boardLabel = h('span', {}, 'Whiteboard');
const board = h('button.btn', { type: 'button', onclick: () => void openBoard() }, boardLabel);
const agent = h('button.btn.accent', { type: 'button', onclick: () => hire('agent') }, 'Hire Droid');
const shell = h('button.btn', { type: 'button', onclick: () => hire('shell') }, 'Open shell');
const account = h('button.btn.ghost', { type: 'button', onclick: pairingDialog }, 'Browser access');
const reload = h('button.btn.ghost', { type: 'button', onclick: () => location.reload() }, 'Reload');
const retry = h(
  'button.btn',
  {
    type: 'button',
    onclick: () => {
      message = 'Checking office access…';
      paint();
      void net.connect();
    },
  },
  'Reconnect',
);
const authPanel = h('section.dashboard-auth');
const content = h('div.dashboard-content', {}, h('aside.dashboard-sidebar', {}, h('div.eyebrow', {}, 'Active floor'), floors, h('div.row.wrap', {}, agent, shell), h('div.eyebrow', {}, 'Workers'), workerList), detail);
$('dashboard').replaceChildren(
  h('a.dashboard-skip', { href: '#worker-detail' }, 'Skip to worker details'),
  h(
    'header.dashboard-header',
    {},
    h('div.dashboard-brand', {}, h('img', { src: '/favicon.svg', alt: '', width: 28, height: 28 }), h('div', {}, h('div.eyebrow', {}, 'Desktop companion'), title)),
    h('div.row', {}, connection, board, account, reload),
  ),
  h('div.dashboard-banner', {}, status, retry),
  authPanel,
  content,
);

const net = new Net(
  () => ({ ...store.profile, name: 'Owner · browser' }),
  () => null,
  {
    client: 'dashboard',
    device: () => credential?.token ?? '',
    floor: () => (store.floor ?? read(DASHBOARD_FLOOR_KEY)) || null,
    authorize: async (signal) => {
      let response: Response;
      try {
        response = await fetch(withToken('/api/mobile/hello'), { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      } catch (error) {
        if (!signal.aborted) {
          message = 'The office is unreachable. Keep the host awake and the app running; retrying with bounded backoff.';
          paint();
        }
        throw error;
      }
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) throw new Error('Office unavailable');
      const hello = (await response.json()) as { office?: { name: string; version: string } };
      if (signal.aborted) throw new Error('Access check cancelled');
      officeName = hello.office?.name ?? 'Droid Office';
      const next = hello.office?.version ?? '';
      if (version && version !== next) message = 'The office updated. Reload this page if a control is unavailable.';
      version = next;
      authorized = true;
      return true;
    },
    unauthorized: () => {
      authorized = false;
      fresh = false;
      bootstrap = '';
      auth();
      closeAllModals();
      message = credential ? 'This browser’s access was revoked or expired. Forget its saved authorization, then pair again.' : 'Office access is required. Use a current companion link from Settings → Phone on the host.';
      paint();
    },
  },
);
connectWhiteboard((msg) => net.send(msg));
net.onStatus((up) => {
  store.whiteboard.status(up);
  if (!up) {
    fresh = false;
    message = 'Disconnected. Displayed data is stale. Inputs and worker actions are not queued.';
  }
  paint();
});
net.onMessage((msg) => {
  const entering = msg.t === 'welcome' || msg.t === 'floor.enter';
  if (entering) {
    fresh = true;
    switching = false;
    if (floor && floor !== msg.floor) {
      selected = '';
      closeAllModals();
    }
    floor = msg.floor ?? '';
    remember(DASHBOARD_FLOOR_KEY, floor);
    message = msg.arrival?.removed ? 'The previous floor was removed. Showing the office’s current floor.' : 'Connected. Changes appear here as the office commits them.';
  }
  store.apply(msg);
  terminal?.routeTerminalMessage(msg);
  whiteboard?.routeWhiteboardMessage(msg);
  routeWorktreeMessage(msg);
  if (entering) {
    const open = terminal?.openTerminalFor();
    if (open && store.workers.has(open)) net.send({ t: 'worker.attach', workerId: open });
  }
  if (msg.t === 'toast') {
    toast(msg.text, msg.level);
    if (switching && msg.level !== 'info') {
      switching = false;
      message = msg.text;
      paint();
    }
  }
});
for (const topic of ['floors', 'workers', 'whiteboard', 'project'] as const) store.on(topic, paint);
store.on('screens', () => paintQuestion());
floors.addEventListener('change', () => {
  if (!live() || floors.value === store.floor) return;
  closeAllModals();
  switching = true;
  selected = '';
  message = 'Loading the selected floor…';
  net.send({ t: 'floor.go', floor: floors.value });
  paint();
});

function live() {
  return authorized && net.up && fresh && !switching;
}
function usable(id: string, intendedFloor: string) {
  return live() && floor === intendedFloor && store.workers.has(id);
}
async function action(msg: ClientMsg, id = '', intendedFloor = floor): Promise<string | undefined> {
  if (!live() || floor !== intendedFloor || (id && !store.workers.has(id))) return 'The connection, floor or worker changed. Nothing was sent.';
  const key = id || 'hire';
  if (busy.has(key)) return 'An action for this worker is still waiting for confirmation.';
  busy.add(key);
  paint();
  try {
    const result = await net.request(msg);
    if (!result.ok) {
      message = result.error ?? 'The office refused this action.';
      return message;
    }
    message = 'The office confirmed the action.';
    if (msg.t === 'worker.spawn' && result.workerId && floor === intendedFloor) selected = result.workerId;
  } finally {
    busy.delete(key);
    paint();
  }
}

let detailId = '';
let name: HTMLElement;
let meta: HTMLElement;
let activity: HTMLElement;
let buttons: HTMLElement;
let question: HTMLElement;
let shownMenu: Menu | undefined;
let questionKey = '';
let questionDraft = '';
let answered = false;

function paint() {
  title.textContent = officeName;
  connection.textContent = live() ? 'Live' : switching || net.up ? 'Loading' : authorized ? 'Disconnected' : 'Access required';
  connection.className = `pill ${live() ? 'done' : 'needs_input'}`;
  status.textContent = message;
  retry.hidden = live();
  const here = store.currentFloor();
  floors.disabled = !live();
  agent.disabled = shell.disabled = !live() || !here || busy.has('hire');
  board.disabled = !live() || !here;
  content.classList.toggle('dashboard-stale', !live());
  content.hidden = !authorized;
  authPanel.hidden = authorized;
  if (!authorized && !authPanel.childElementCount)
    authPanel.append(
      emptyState(
        '',
        'Your office, without the 3D',
        'Open a companion link from the host’s Settings → Phone. Pair this browser explicitly to keep access across restarts.',
        h('button.btn.accent', { type: 'button', onclick: pairingDialog }, 'Pair this browser'),
      ),
    );
  floors.replaceChildren(...(store.floor === ROOF ? [h('option', { value: ROOF }, 'Rooftop · choose a floor')] : []), ...store.floors.map((f) => h('option', { value: f.id }, `${f.name}${f.repo ? ` · ${f.repo}` : ' · no git'}`)));
  floors.value = store.floor ?? '';
  const workers = [...store.workers.values()].sort((a, b) => a.createdAt - b.createdAt);
  const focusWorker = document.activeElement?.closest('[data-worker]')?.getAttribute('data-worker');
  workerList.replaceChildren(
    ...workers.map((w) =>
      h(
        'button.list-row',
        {
          type: 'button',
          'data-worker': w.id,
          class: w.id === selected ? 'on' : '',
          'aria-current': w.id === selected ? 'true' : undefined,
          onclick: () => {
            selected = w.id;
            paint();
          },
        },
        colorDot(w.color),
        h('span.list-main', {}, h('span.list-title', {}, w.name), h('span.list-meta', {}, w.task?.name ?? w.title ?? kind(w))),
        h('span.pill', { class: w.status }, statusWord(w, STATUS_LABEL)),
      ),
    ),
  );
  if (focusWorker) workerList.querySelector<HTMLButtonElement>(`[data-worker="${CSS.escape(focusWorker)}"]`)?.focus({ preventScroll: true });
  if (!workers.length) workerList.append(h('p.field-hint', {}, live() ? 'No workers on this floor.' : 'Waiting for current workers…'));
  const w = store.workers.get(selected);
  if (!w) {
    detailId = '';
    detail.replaceChildren(
      emptyState(
        '',
        selected ? 'This worker has left' : 'A clear view of the work',
        selected
          ? 'Its session is no longer controlled here. Select another worker.'
          : store.floors.length
            ? 'Select a worker to inspect its task, answer a question or open its live terminal. The Whiteboard is one click away.'
            : 'No floors are available. Add an existing project in the Mac office first.',
      ),
    );
    return;
  }
  if (detailId !== w.id) {
    detailId = w.id;
    shownMenu = undefined;
    questionKey = '';
    questionDraft = read(draftKey(floor, `${w.id}:answer`));
    answered = false;
    name = h('h2');
    meta = h('div.dashboard-meta');
    activity = h('p.dashboard-activity');
    buttons = h('div.row.wrap.dashboard-actions');
    question = h('section.stack.dashboard-question', { 'aria-label': 'Question requiring input' });
    detail.replaceChildren(h('div.eyebrow', {}, 'Worker'), name, activity, buttons, meta, question);
  }
  name.textContent = w.name;
  activity.textContent = w.activity ?? w.task?.summary ?? w.prompt ?? 'Waiting for a task.';
  const lead = w.lead && store.workers.get(w.lead);
  const team = store.teamOf(w.id);
  const info = [
    ['Kind', kind(w)],
    ['Status', statusWord(w, STATUS_LABEL)],
    ['Model', modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort)],
    ['Task', w.task?.name ?? w.title],
    ['Branch', w.worktree?.branch ?? store.currentFloor()?.branch],
    ['Worktree', w.worktree?.path],
    [
      'Availability',
      w.lost
        ? 'Worktree missing. Resume and prompts are unavailable.'
        : w.guest
          ? 'Information only. Use its original terminal.'
          : w.cloud
            ? `Factory · ${w.cloud.computerName}. No local terminal.`
            : isAsleep(w.status)
              ? 'Sleeping. Resume before prompting.'
              : 'Local shared terminal',
    ],
    ['Factory session', w.cloud && w.sessionId ? sessionWebUrl(w.sessionId) : undefined],
    ['Lead', lead ? lead.name : w.lead ? 'Lead is no longer on this floor' : undefined],
    ['Subagents', team.length ? team.map((s) => s.name).join(', ') : undefined],
    ['Other projects', w.repos?.map((r) => `${r.name} · ${r.branch}`).join(', ')],
  ];
  meta.replaceChildren(...info.filter(([, v]) => !!v).map(([label, value]) => h('div.dashboard-meta-row', {}, h('span.eyebrow', {}, label), h('span', { title: value }, value))));
  const local = !w.guest && !w.cloud;
  const enabled = live() && !busy.has(w.id);
  const btn = (label: string, ok: boolean, run: () => void, cls = '') => h('button.btn', { type: 'button', class: cls, disabled: !enabled || !ok, onclick: run }, label);
  buttons.replaceChildren(
    btn('Open terminal', local && !isAsleep(w.status), () => void openTerminal(w.id)),
    ...(w.cloud && w.sessionId ? [h('a.btn', { href: sessionWebUrl(w.sessionId), target: '_blank', rel: 'noopener noreferrer' }, 'Open Factory session')] : []),
    btn(w.kind === 'shell' ? 'Send command' : 'Prompt', !w.guest && !w.lost && !isAsleep(w.status), () => prompt(w)),
    btn(w.kind === 'shell' ? 'Restart shell' : 'Resume', !w.guest && !w.lost && isAsleep(w.status), () => void action({ t: 'worker.resume', workerId: w.id }, w.id)),
    ...(w.pr
      ? [h('a.btn', { href: safeLink(w.pr.url), target: '_blank', rel: 'noopener noreferrer' }, 'Open pull request')]
      : [btn('Create pull request', local && !!w.worktree && !w.lost && !w.prOpening && !isBusy(w.status), () => void action({ t: 'worker.pr', workerId: w.id }, w.id))]),
    btn('Send home…', !w.guest, () => sendHome(w), 'danger'),
  );
  const b = store.floor && store.whiteboard.board(store.floor);
  const changed = b ? cardsNewestFirst(b).filter((c) => cardChanged(b, OWNER, c.id)).length : 0;
  boardLabel.textContent = `Whiteboard${changed ? ` · ${changed} unread` : ''}`;
  paintQuestion();
}

function kind(w: WorkerInfo) {
  return w.guest ? `${PROVIDER_LABEL[w.guest.provider]} · outside office` : w.cloud ? 'Droid · Factory' : w.kind === 'shell' ? 'Shell' : 'Droid';
}
function safeLink(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '#';
  } catch {
    return '#';
  }
}
function lines(id: string) {
  const s = store.screens.get(id);
  return s && Array.from({ length: s.rows }, (_, i) => (s.lines[i] ?? []).map((r) => r[0]).join(''));
}
function paintQuestion(review = false) {
  const w = store.workers.get(detailId);
  if (!w || !question) return;
  const screen = lines(w.id);
  const next = canAnswer(w, screen) ? readMenu(screen!) : undefined;
  if (w.status !== 'needs_input') {
    shownMenu = undefined;
    answered = false;
  }
  if ((!shownMenu && next) || review) {
    shownMenu = next;
    answered = false;
  }
  const current = sameMenu(shownMenu, next);
  const key = JSON.stringify([shownMenu, current, live(), busy.has(w.id), answered, w.status]);
  if (key === questionKey) return;
  questionKey = key;
  question.hidden = !shownMenu && w.status !== 'needs_input';
  const enabled = live() && current && !busy.has(w.id) && !answered;
  if (!shownMenu) {
    question.replaceChildren(
      h(
        'p.note.warn',
        {},
        w.cloud
          ? 'This Factory worker needs input, but there is no local menu to answer. Open its Factory session; nothing was typed here.'
          : w.guest
            ? 'This guest needs input in its own terminal. The office will not type an answer for it.'
            : 'This worker needs input, but its current screen has no safely answerable menu. Open its terminal to respond.',
      ),
    );
    return;
  }
  const menu = shownMenu;
  const text = h('textarea.input', { rows: 3, 'aria-label': 'Typed answer', placeholder: 'Your answer' });
  text.value = questionDraft;
  text.addEventListener('input', () => {
    questionDraft = text.value;
    remember(draftKey(floor, `${w.id}:answer`), questionDraft);
  });
  const reply = async (value: { choice?: number; text?: string }) => {
    const error = await action({ t: 'worker.answer', workerId: w.id, menu, ...value }, w.id);
    if (detailId !== w.id) return;
    if (error) toast(error, 'warn');
    else {
      answered = true;
      questionDraft = '';
      remember(draftKey(floor, `${w.id}:answer`), '');
    }
    questionKey = '';
    paintQuestion();
  };
  question.replaceChildren(
    h(
      'div.stack',
      {},
      h('div.eyebrow', {}, 'Needs your input'),
      h('h3', {}, menu.question ?? 'Choose an answer'),
      ...menu.choices.map((c) =>
        h('button.dashboard-choice', { type: 'button', disabled: !enabled, onclick: () => void reply({ choice: c.number }) }, h('span', {}, `${c.number}. ${c.label}`), c.description ? h('small', {}, c.description) : null),
      ),
      ...(menuTakesText(menu) ? [text, h('button.btn.primary', { type: 'button', disabled: !enabled, onclick: () => void reply({ text: text.value }) }, 'Send typed answer')] : []),
      !current
        ? h('p.note.warn', {}, 'The question changed or was answered elsewhere. Your text is kept; review the current question before sending anything.')
        : answered
          ? h('p.note.info', {}, 'Answer sent. Waiting for the worker’s next state.')
          : null,
      !current && next
        ? h(
            'button.btn',
            {
              type: 'button',
              onclick: () => {
                questionKey = '';
                paintQuestion(true);
              },
            },
            'Review current question',
          )
        : null,
    ),
  );
}

function hire(kind: 'agent' | 'shell') {
  const intended = floor;
  const key = draftKey(intended, `hire:${kind}`);
  openPrompt({
    title: kind === 'shell' ? 'Open a shell' : 'Hire Droid',
    subtitle: store.currentFloor()?.name,
    submitLabel: kind === 'shell' ? 'Open shell' : 'Hire Droid',
    allowEmpty: true,
    initial: read(key),
    onDraft: (v) => remember(key, v),
    modelOption: kind === 'agent',
    imagesOption: kind === 'agent',
    recall: kind === 'agent',
    worktreeOption: !!store.currentFloor()?.repo,
    onSubmit: async (text, opts) => {
      const error = await action({ t: 'worker.spawn', deskId: 'auto', kind, prompt: text, ...opts }, '', intended);
      if (!error) remember(key, '');
      return error;
    },
  });
}
function prompt(w: WorkerInfo) {
  const intended = floor;
  const key = draftKey(intended, w.id);
  openPrompt({
    title: w.kind === 'shell' ? `Command · ${w.name}` : `Prompt · ${w.name}`,
    initial: read(key),
    onDraft: (v) => remember(key, v),
    imagesOption: w.kind !== 'shell',
    recall: w.kind !== 'shell',
    queueOption: w.kind === 'agent',
    onSubmit: async (text, opts) => {
      const error = await action({ t: 'worker.prompt', workerId: w.id, prompt: text, images: opts.images, queue: opts.queue }, w.id, intended);
      if (!error) remember(key, '');
      return error;
    },
  });
}
function sendHome(w: WorkerInfo) {
  const intended = floor;
  const confirm = (cleanup: 'keep' | 'worktree' | 'all' = 'keep') =>
    void action({ t: 'worker.kill', workerId: w.id, cleanup, deleteSession: false }, w.id, intended).then((error) => {
      if (error) toast(error, 'warn');
    });
  if (w.worktree && !w.cloud)
    sendHomeDialog({
      workerId: w.id,
      name: w.name,
      where: store.currentFloor()?.name ?? 'this floor',
      worktree: w.worktree,
      ask: () => {
        if (usable(w.id, intended)) net.send({ t: 'worker.worktree', workerId: w.id });
      },
      onConfirm: confirm,
    });
  else
    confirmDialog(
      `Send ${w.name} home?`,
      w.cloud
        ? 'This removes its desk. Its Factory session stays archived; a computer owned by this worker is deleted, as in the Mac office.'
        : 'This stops its shared terminal for every client and frees its desk. Work in the checkout is kept.',
      'Send home',
      () => confirm(),
    );
}
async function openTerminal(id: string) {
  const intended = floor;
  terminal ??= await import('./ui/terminal');
  terminal.onOpenTeammate((id) => void openTerminal(id));
  if (usable(id, intended)) terminal.openTerminal(net, id);
}
async function openBoard() {
  const intended = floor;
  whiteboard ??= await import('./ui/whiteboard');
  if (live() && intended === floor && store.currentFloor()) whiteboard.openWhiteboard(net, { queueOffline: false });
}

function pairingDialog() {
  const note = h(
    'p.note.info',
    { role: 'status' },
    credential
      ? `${credential.device.name} is paired at ${location.origin}.${persisted ? '' : ' Storage is blocked; authorization lasts only for this page.'}`
      : 'Pairing stores an office device token in this browser at this address. It represents you, not another account.',
  );
  const deviceName = h('input.input', { value: 'Desktop browser', maxlength: 64, 'aria-label': 'Browser name' });
  const pair = h('button.btn.accent', { type: 'button', disabled: !!credential || pairing }, 'Pair this browser');
  const forget = h('button.btn', { type: 'button', disabled: !credential }, 'Forget locally');
  const revoke = h('button.btn.danger', { type: 'button', disabled: !credential }, 'Revoke access…');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'Browser access' },
    windowHeader('Browser access'),
    h(
      'div.body.stack',
      {},
      note,
      credential ? null : deviceName,
      h('p.field-hint', {}, 'Local forget only removes the saved token. Revoking also removes this device from the office and closes its connections. Another IP, hostname or port needs its own pairing.'),
    ),
    h('footer', {}, forget, revoke, pair),
  );
  const modal = openModal(el);
  const forgetHere = () => {
    let removed = false;
    try {
      removed = forgetBrowserCredential(localStorage);
    } catch {
      /* blocked */
    }
    credential = undefined;
    bootstrap = '';
    auth();
    net.close();
    authorized = false;
    closeAllModals();
    message = removed ? 'Browser authorization forgotten locally. The server pairing still exists until revoked from the host.' : 'Access closed, but browser storage could not be cleared. Remove this site’s saved data before reopening.';
    paint();
  };
  forget.addEventListener('click', forgetHere);
  revoke.addEventListener('click', () =>
    confirmDialog('Revoke this browser?', 'This invalidates its saved token on the office and disconnects all tabs using it. You will need a new companion link to pair again.', 'Revoke access', () => {
      revoke.disabled = true;
      void fetch(withToken('/api/mobile/pair'), { method: 'DELETE' })
        .then(async (res) => {
          if (!res.ok) throw new Error('The office did not confirm revocation. The saved authorization has not been removed.');
          forgetHere();
          message = 'Browser access revoked on the office and forgotten locally.';
          paint();
        })
        .catch((error: Error) => {
          note.textContent = error.message;
          revoke.disabled = false;
        });
    }),
  );
  pair.addEventListener('click', () => {
    if (pairing || credential) return;
    pairing = true;
    pair.disabled = true;
    void (async () => {
      try {
        const res = await fetch(withToken('/api/mobile/pair'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: deviceName.value, kind: 'browser' }), signal: AbortSignal.timeout(8000) });
        const body = (await res.json()) as BrowserCredential & { error?: string };
        if (!res.ok) throw new Error(body.error ?? 'The browser could not be paired.');
        credential = body;
        try {
          persisted = saveBrowserCredential(localStorage, body);
        } catch {
          persisted = false;
        }
        bootstrap = '';
        auth();
        net.close();
        modal.close();
        message = persisted ? 'Browser paired. You can bookmark this address.' : 'Paired for this page only: browser storage is blocked. Revoke it before closing to avoid leaving an unused pairing.';
        void net.connect();
        paint();
      } catch (error) {
        note.textContent = (error as Error).message;
      } finally {
        pairing = false;
        pair.disabled = !!credential;
      }
    })();
  });
}
window.addEventListener('storage', (event) => {
  if (event.key !== BROWSER_KEY) return;
  net.close();
  closeAllModals();
  try {
    credential = browserCredential(localStorage);
  } catch {
    credential = undefined;
  }
  bootstrap = '';
  auth();
  authorized = false;
  fresh = false;
  message = 'Browser authorization changed in another tab.';
  if (credential) void net.connect();
  paint();
});
window.addEventListener('online', () => {
  if (authorized) void net.connect();
});
window.addEventListener('offline', () => {
  net.close();
  message = 'Network offline. Worker actions and terminal input are disabled; nothing will be replayed.';
  paint();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && authorized) void net.connect();
});
window.addEventListener('pagehide', () => net.close());
window.addEventListener('pageshow', (e) => {
  if (e.persisted) void net.connect();
});
paint();
void net.connect();
