import { factoryCan } from '../../shared/factory';
import {
  MODE_LABEL,
  NEW_SESSION_GRACE_MS,
  SESSION_AUTONOMY,
  SESSION_EFFORTS,
  SESSION_IMAGE_TYPES,
  SESSION_MODES,
  artifactLabel,
  compactCredits,
  isLive,
  sessionWebUrl,
  sessionWhere,
  type FactorySession,
} from '../../shared/factory-sessions';
import { factoryFetch, refreshFactory, watchFactory } from '../factory';
import { store } from '../state';
import { clip, h, openModal, timeAgo, toast, type Modal } from './dom';
import { mountTranscript, type Transcript } from './factory-transcript';
import { factoryModels, type DroidModelOption } from './models';
import { confirmDialog } from './prompt';

// 🛰️ Sessions: every Droid session of the Factory account the office is connected with, the office's
// own workers' among them. A list to filter and search on the left; on the right the one you pick
// (its settings, credits, subagents, pull requests and transcript, and a box to message it), or the
// form that starts a new one on a Factory computer. The lounge TV opens it (E), as do ☰ and ⌘K.

export interface SessionsWindowActions {
  /** ⚙️ Settings → Factory, to connect. */
  openSettings(): void;
  /** One of the office's workers' terminals. */
  openWorker(workerId: string): void;
}

type StatusFilter = 'all' | 'live' | 'idle';

const EFFORT_WORD: Record<string, string> = { none: 'None', dynamic: 'Dynamic', off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const AUTONOMY_WORD: Record<string, string> = { off: 'Off (asks first)', low: 'Low', medium: 'Medium', high: 'High' };
/** A picture to send with a message: base64 without the data: prefix. */
interface Picture {
  data: string;
  mediaType: string;
  url: string;
  name: string;
}
const PICTURE_MAX = 4;
const PICTURE_BYTES = 4 * 1024 * 1024;

let open: { modal: Modal; select(id: string): void } | undefined;

const statusWord = (s: string) => (s === 'running' ? 'running' : s === 'pending' ? 'pending' : 'idle');
const pillClass = (s: string) => (s === 'running' ? 'working' : s === 'pending' ? 'needs_input' : 'exited');
const titleOf = (s: FactorySession) => s.title.replace(/\s+/g, ' ').trim() || `Session ${s.id.slice(0, 8)}`;

/** Pictures pasted or dropped into a message box, read in the page as base64 for Factory. */
function pictures(textarea: HTMLTextAreaElement, zone: HTMLElement) {
  const items: Picture[] = [];
  const element = h('div.pimgs', { role: 'list', 'aria-label': 'Attached pictures' });
  const render = () =>
    element.replaceChildren(
      ...items.map((p, i) =>
        h(
          'div.pimg',
          { role: 'listitem', title: p.name },
          h('img', { src: p.url, alt: `Image ${i + 1}` }),
          h('span.pimg-n', {}, String(i + 1)),
          h(
            'button.pimg-x',
            {
              type: 'button',
              'aria-label': `Remove image ${i + 1}`,
              onclick: () => {
                items.splice(i, 1);
                render();
              },
            },
            '✕',
          ),
        ),
      ),
    );
  const add = (files: File[]) => {
    for (const f of files) {
      if (!(SESSION_IMAGE_TYPES as readonly string[]).includes(f.type)) {
        toast(`${f.name || 'That file'} isn’t a PNG, JPEG, GIF or WebP picture`, 'warn');
        continue;
      }
      if (f.size > PICTURE_BYTES) {
        toast(`${f.name || 'That picture'} is too big (4 MB at most)`, 'warn');
        continue;
      }
      if (items.length >= PICTURE_MAX) {
        toast(`At most ${PICTURE_MAX} pictures`, 'warn');
        break;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        items.push({ data: url.slice(url.indexOf(',') + 1), mediaType: f.type, url, name: f.name || 'pasted picture' });
        render();
      };
      reader.readAsDataURL(f);
    }
  };
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length || e.clipboardData?.getData('text/plain')) return;
    e.preventDefault();
    add(files);
  });
  zone.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  zone.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    add([...e.dataTransfer.files]);
  });
  return {
    element,
    take: () => items.splice(0).map(({ data, mediaType }) => ({ data, mediaType })),
    clear: () => {
      items.length = 0;
      render();
    },
  };
}

function select(label: string, options: [string, string][], value = ''): HTMLSelectElement {
  const el = h('select.fs-select', { 'aria-label': label }, ...options.map(([v, text]) => h('option', { value: v }, text))) as HTMLSelectElement;
  el.value = value;
  return el;
}

/** A model picker of Factory's Droid models, filled once the catalogue loads; the model it's set to stays offered. */
function modelPicker(): { el: HTMLSelectElement; set(model?: string): void } {
  const el = select('Model', [['', 'Default']]);
  let want = '';
  let models: DroidModelOption[] = [];
  const fill = () => {
    el.replaceChildren(h('option', { value: '' }, 'Default'), ...models.map((m) => h('option', { value: m.id }, m.displayName)));
    if (want && !models.some((m) => m.id === want)) el.append(h('option', { value: want }, want));
    el.value = want;
  };
  el.addEventListener('change', () => {
    want = el.value;
  });
  void factoryModels()
    .then((m) => {
      models = m;
      fill();
    })
    .catch(() => {});
  return {
    el,
    set(model) {
      want = model ?? '';
      fill();
    },
  };
}

const effortSelect = (current?: string) => select('Reasoning effort', [['', 'Default'], ...SESSION_EFFORTS.map((e): [string, string] => [e, EFFORT_WORD[e] ?? e])], current ?? '');

export function openFactorySessions(actions: SessionsWindowActions, selectId?: string) {
  if (open) {
    if (selectId) open.select(selectId);
    return;
  }
  let status: StatusFilter = 'all';
  let where = 'all';
  let query = '';
  let picked: string | undefined = selectId;
  let creating = false;

  const search = h('input.fs-search', { type: 'text', placeholder: 'Search titles', 'aria-label': 'Search sessions by title' }) as HTMLInputElement;
  const statusSeg = h('div.fs-seg', { role: 'group', 'aria-label': 'Status' });
  const whereSel = select('Where', [['all', 'Everywhere']], 'all');
  const newBtn = h('button.btn.primary', { type: 'button', title: 'Start a Droid session on a Factory computer' }, '＋ New session');
  const list = h('ul.fs-list', { role: 'listbox', 'aria-label': 'Sessions' });
  const count = h('span.grow');
  const pane = h('section.fs-pane');
  const header = h('header', {}, h('h2', {}, '🛰️ Droid sessions'), newBtn);
  const el = h(
    'div.modal.fsessions',
    { role: 'dialog', 'aria-label': 'Droid sessions' },
    header,
    h('div.fs-body', {}, h('aside.fs-side', {}, h('div.fs-tools', {}, search, h('div.fs-filters', {}, statusSeg, whereSel)), list, h('footer', {}, count)), pane),
  );

  // ---- The list ----
  const filtered = () => {
    const s = store.factory.sessions;
    const q = query.trim().toLowerCase();
    return s.items.filter((x) => {
      if (status === 'live' && !isLive(x)) return false;
      if (status === 'idle' && isLive(x)) return false;
      if (where === 'office' && !s.office[x.id]) return false;
      if (where === 'elsewhere' && (s.office[x.id] || x.computerId)) return false;
      if (where !== 'all' && where !== 'office' && where !== 'elsewhere' && x.computerId !== where) return false;
      return !q || x.title.toLowerCase().includes(q) || x.id.startsWith(q);
    });
  };

  let listKey = '';
  const renderList = () => {
    const f = store.factory;
    const s = f.sessions;
    statusSeg.replaceChildren(
      ...(
        [
          ['all', 'All'],
          ['live', `Running ${s.items.filter(isLive).length || ''}`.trim()],
          ['idle', 'Idle'],
        ] as [StatusFilter, string][]
      ).map(([v, label]) => h('button.btn', { type: 'button', class: status === v ? 'on' : '', 'aria-pressed': String(status === v), onclick: () => ((status = v), renderList()) }, label)),
    );
    const computers = f.computers.items;
    const wantWhere: [string, string][] = [['all', 'Everywhere'], ['office', 'This office’s workers'], ...computers.map((c): [string, string] => [c.id, `☁ ${c.name}`]), ['elsewhere', 'Elsewhere']];
    if (whereSel.options.length !== wantWhere.length) {
      whereSel.replaceChildren(...wantWhere.map(([v, t]) => h('option', { value: v }, t)));
      whereSel.value = wantWhere.some(([v]) => v === where) ? where : 'all';
    }
    const items = filtered();
    const key = JSON.stringify([items, s.office, picked, creating, Math.floor(Date.now() / 30_000), computers.map((c) => c.name)]);
    if (key === listKey) return;
    listKey = key;
    list.replaceChildren(
      ...items.map((x) => {
        const w = sessionWhere(s, computers, x);
        const prs = x.artifacts.filter((a) => a.url && a.action !== 'view').slice(0, 3);
        const li = h(
          'li',
          { role: 'option', 'aria-selected': String(x.id === picked && !creating), class: x.id === picked && !creating ? 'on' : '', tabindex: 0, title: x.title },
          h(
            'div.fs-row1',
            {},
            h('span.pill', { class: pillClass(x.status) }, statusWord(x.status)),
            h('span.fs-title', {}, clip(titleOf(x), 120)),
            x.credits !== undefined ? h('span.fs-credits', { title: `${x.credits.toLocaleString()} Factory credits` }, `⚡ ${compactCredits(x.credits)}`) : null,
          ),
          h(
            'div.fs-row2',
            {},
            h('span.fs-where', { class: w.kind, style: w.color ? `--who:${w.color}` : undefined }, w.kind === 'cloud' ? `☁ ${w.label}` : w.label),
            // One text node: contiguous strings would be one flex item and the gap wouldn't show.
            [...[x.model, x.effort && EFFORT_WORD[x.effort]].filter(Boolean), `${x.messageCount} msg${x.messageCount === 1 ? '' : 's'}`, timeAgo(x.updatedAt)].join(' · '),
            ...prs.map((a) => h('a.fs-pr', { href: a.url, target: '_blank', rel: 'noopener noreferrer', onclick: (e: Event) => e.stopPropagation() }, artifactLabel(a))),
          ),
        );
        const pick = () => choose(x.id);
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
        return li;
      }),
    );
    if (!items.length) list.append(h('li.fs-empty', {}, s.fetchedAt ? (s.items.length ? 'No session matches' : 'No sessions yet') : 'Reading sessions from Factory… (a first read can take a minute)'));
    const counted = s.credits.since ? '' : ' · credits not counted yet';
    count.textContent = `${items.length} of the last ${s.items.length} sessions${s.fetchedAt ? ` · read ${timeAgo(s.fetchedAt)}` : ''}${s.error ? ` · ⚠ ${s.error}` : ''}${counted}`;
  };

  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });
  whereSel.addEventListener('change', () => {
    where = whereSel.value;
    renderList();
  });

  // ---- The session you picked ----
  let detail: { id: string; transcript: Transcript; paint(): void; dispose(): void } | undefined;

  const closeDetail = () => {
    detail?.dispose();
    detail = undefined;
  };

  const sessionNow = (id: string, fetched?: FactorySession) => store.factory.sessions.items.find((x) => x.id === id) ?? fetched;

  const showDetail = (id: string) => {
    closeDetail();
    let fetched: FactorySession | undefined;
    let children: FactorySession[] | undefined;
    const transcript = mountTranscript({
      sessionId: id,
      live: () => isLive(sessionNow(id, fetched) ?? { status: 'idle' }),
      starting: () => {
        const s = sessionNow(id, fetched);
        return !!s && Date.now() - s.createdAt < NEW_SESSION_GRACE_MS;
      },
    });
    const head = h('div.fs-head');
    const meta = h('dl.fs-meta');
    const extra = h('div.fs-extra');
    const error = h('div.fs-error.hidden', { role: 'alert' });
    const box = h('textarea.fs-input', { rows: 2, placeholder: 'Message this session (Enter sends, Shift+Enter for a new line; paste a picture to attach it)', 'aria-label': 'Message' }) as HTMLTextAreaElement;
    const send = h('button.btn.primary', { type: 'button' }, 'Send');
    const composer = h('div.fs-composer');
    const pics = pictures(box, composer);
    composer.append(pics.element, h('div.fs-compose-row', {}, box, send));
    const say = (text: string) => {
      error.textContent = text;
      error.classList.toggle('hidden', !text);
    };

    const picker = modelPicker();
    const model = picker.el;
    const effort = effortSelect();
    const apply = h('button.btn', { type: 'button', disabled: true }, 'Apply');
    let settingsFor = '';
    const settingsRow = h('div.fs-settings', {}, h('label', {}, 'Model'), model, h('label', {}, 'Effort'), effort, apply);
    const dirty = () => {
      const s = sessionNow(id, fetched);
      apply.toggleAttribute('disabled', (model.value || '') === (s?.model ?? '') && (effort.value || '') === (s?.effort ?? ''));
    };
    model.addEventListener('change', dirty);
    effort.addEventListener('change', dirty);
    apply.addEventListener('click', async () => {
      apply.setAttribute('disabled', '');
      try {
        const r = await factoryFetch<{ session: FactorySession }>('sessions', `/${encodeURIComponent(id)}`, { method: 'PATCH', body: { model: model.value || undefined, reasoningEffort: effort.value || undefined } });
        fetched = r.session;
        settingsFor = '';
        toast('🛰️ Session settings changed');
        refreshFactory('sessions');
        paint();
      } catch (err) {
        say((err as Error).message);
        dirty();
      }
    });

    const doSend = async () => {
      const text = box.value;
      const images = pics.take();
      if (!text.trim() && !images.length) return;
      send.setAttribute('disabled', '');
      say('');
      try {
        const r = await factoryFetch<{ queued?: boolean }>('sessions', `/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { text, ...(images.length ? { images } : {}) } });
        box.value = '';
        pics.clear();
        if (r.queued) toast('It’s still working: your message goes in once its turn ends');
        void transcript.refresh();
      } catch (err) {
        say(`Didn’t send: ${(err as Error).message}`);
      } finally {
        send.removeAttribute('disabled');
      }
    };
    send.addEventListener('click', () => void doSend());
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void doSend();
      }
    });

    const interrupt = async () => {
      try {
        await factoryFetch('sessions', `/${encodeURIComponent(id)}/interrupt`, { method: 'POST' });
        toast('⏹ Interrupted');
        void transcript.refresh();
      } catch (err) {
        say((err as Error).message);
      }
    };
    const remove = () => {
      const s = sessionNow(id, fetched);
      confirmDialog('Delete this session?', `“${clip(s ? titleOf(s) : id, 90)}” goes from Factory: its transcript and settings with it.`, 'Delete it', async () => {
        try {
          await factoryFetch('sessions', `/${encodeURIComponent(id)}`, { method: 'DELETE' });
          picked = undefined;
          closeDetail();
          renderEmpty();
          renderList();
        } catch (err) {
          say((err as Error).message);
        }
      });
    };

    let headKey = '';
    const paint = () => {
      const f = store.factory;
      const s = sessionNow(id, fetched);
      if (!s) return;
      const credits = s.credits ?? fetched?.credits;
      const w = sessionWhere(f.sessions, f.computers.items, s);
      const ours = f.sessions.office[id];
      const k = JSON.stringify([s, credits, w, children?.map((c) => [c.id, c.status, c.title]), Math.floor(Date.now() / 30_000)]);
      if (k === headKey) return;
      headKey = k;
      head.replaceChildren(
        h('div.fs-head-row', {}, h('span.pill', { class: pillClass(s.status) }, statusWord(s.status)), h('h3', {}, titleOf(s))),
        h(
          'div.fs-actions',
          {},
          isLive(s) ? h('button.btn', { type: 'button', onclick: () => void interrupt(), title: 'Stop what it’s doing' }, '⏹ Interrupt') : null,
          ours ? h('button.btn', { type: 'button', onclick: () => actions.openWorker(ours.workerId) }, store.workers.get(ours.workerId)?.cloud ? `☁ ${ours.name}’s window` : `💻 ${ours.name}’s terminal`) : null,
          h('a.btn', { href: sessionWebUrl(id), target: '_blank', rel: 'noopener noreferrer', title: 'Open it in the Factory web app' }, 'Factory ↗'),
          h('button.btn.danger', { type: 'button', onclick: remove }, 'Delete…'),
        ),
      );
      const row = (label: string, value: string | Node | null | undefined) => (value ? [h('dt', {}, label), h('dd', {}, value)] : []);
      meta.replaceChildren(
        ...row('Where', h('span.fs-where', { class: w.kind, style: w.color ? `--who:${w.color}` : undefined }, w.kind === 'cloud' ? `☁ ${w.label}` : w.label)),
        ...row('Credits', credits !== undefined ? `⚡ ${credits.toLocaleString()} (with its subagents)` : 'reading…'),
        ...row('Messages', String(s.messageCount)),
        ...row('Mode', s.interactionMode ? (MODE_LABEL[s.interactionMode as keyof typeof MODE_LABEL] ?? s.interactionMode) : undefined),
        ...row('Autonomy', s.autonomyLevel ? (AUTONOMY_WORD[s.autonomyLevel] ?? s.autonomyLevel) : undefined),
        ...row('Started', s.createdAt ? `${new Date(s.createdAt).toLocaleString()} (${timeAgo(s.createdAt)})` : undefined),
        ...row('Last active', s.updatedAt ? timeAgo(s.updatedAt) : undefined),
        ...row('Session', h('code', {}, id)),
      );
      // The settings follow the session until you change them here.
      const settingsKey = `${s.model ?? ''}|${s.effort ?? ''}`;
      if (settingsKey !== settingsFor) {
        settingsFor = settingsKey;
        picker.set(s.model);
        effort.value = s.effort ?? '';
        dirty();
      }
      const arts = s.artifacts.filter((a) => a.url);
      extra.replaceChildren(
        ...(children?.length
          ? [
              h('h4', {}, `Subagents · ${children.length}`),
              h(
                'ul.fs-children',
                {},
                ...children.map((c) =>
                  h('li', { tabindex: 0, onclick: () => choose(c.id), title: c.title }, h('span.pill', { class: pillClass(c.status) }, statusWord(c.status)), h('span', {}, clip(titleOf(c), 90)), h('small', {}, timeAgo(c.updatedAt))),
                ),
              ),
            ]
          : []),
        ...(arts.length
          ? [
              h('h4', {}, 'Made'),
              h('ul.fs-arts', {}, ...arts.map((a) => h('li', {}, h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, artifactLabel(a)), h('small', {}, [a.kind.replace(/_/g, ' '), a.action].filter(Boolean).join(' · '))))),
            ]
          : []),
      );
    };

    pane.replaceChildren(h('div.fs-detail', {}, head, meta, settingsRow, extra, error, transcript.element, composer));
    paint();
    // Its own read (credits, a fresh status) and its subagents, without holding the window up: either can take a while cold.
    void factoryFetch<{ session: FactorySession }>('sessions', `/${encodeURIComponent(id)}`)
      .then((r) => {
        fetched = r.session;
        if (detail?.id === id) {
          say('');
          paint();
        }
      })
      .catch((err: Error) => {
        if (detail?.id === id && !sessionNow(id)) say(err.message);
      });
    void factoryFetch<{ sessions: FactorySession[] }>('sessions', `/${encodeURIComponent(id)}/children`)
      .then((r) => {
        children = r.sessions;
        if (detail?.id === id) paint();
      })
      .catch(() => {});
    detail = { id, transcript, paint, dispose: () => transcript.dispose() };
  };

  const renderEmpty = () => {
    const f = store.factory;
    if (!f.connection.connected || f.connection.rejected) {
      pane.replaceChildren(
        h(
          'div.fs-blank',
          {},
          h('p', {}, f.connection.rejected ? 'Factory rejected the office’s API key.' : 'The office isn’t connected to Factory.'),
          h('button.btn.primary', { type: 'button', onclick: () => actions.openSettings() }, '⚙️ Settings → Factory'),
        ),
      );
      return;
    }
    const s = f.sessions;
    const c = s.credits;
    pane.replaceChildren(
      h(
        'div.fs-blank',
        {},
        h('p', {}, 'Pick a session to see its transcript, settings and what it cost, or start a new one.'),
        h('div.fs-credits-sum', {}, h('div', {}, h('b', {}, compactCredits(c.today)), h('small', {}, 'credits today')), h('div', {}, h('b', {}, compactCredits(c.week)), h('small', {}, 'last 7 days'))),
        h(
          'p.note',
          {},
          c.since ? `Counted from what the office saw since ${new Date(c.since).toLocaleString()}; before that, each session’s credits are put on the day it was last active (an estimate).` : 'The office hasn’t counted any credits yet.',
        ),
      ),
    );
  };

  // ---- A new session ----
  const showNew = () => {
    closeDetail();
    const computers = store.factory.computers.items;
    const computer = select(
      'Computer',
      computers.map((c) => [c.id, `${c.name}${c.status !== 'active' ? ` (${c.status})` : ''}${c.managed ? '' : ' · your machine'}`]),
      computers.find((c) => c.name === 'orb')?.id ?? computers.find((c) => c.status === 'active')?.id ?? computers[0]?.id ?? '',
    );
    const cwd = h('input', { type: 'text', placeholder: 'Folder on the computer (leave empty for its home)', 'aria-label': 'Folder' }) as HTMLInputElement;
    const fillCwd = () => {
      const c = computers.find((x) => x.id === computer.value);
      cwd.placeholder = c?.remoteUser ? `Folder, like /home/${c.remoteUser}/project (empty: its home)` : 'Folder on the computer (empty: its home)';
    };
    computer.addEventListener('change', fillCwd);
    fillCwd();
    const model = modelPicker().el;
    const effort = effortSelect();
    const mode = select(
      'Interaction mode',
      SESSION_MODES.map((m) => [m, MODE_LABEL[m]]),
      'auto',
    );
    const autonomy = select(
      'Autonomy',
      SESSION_AUTONOMY.map((a) => [a, AUTONOMY_WORD[a]]),
      'medium',
    );
    const prompt = h('textarea', { rows: 6, placeholder: 'What should it do?', 'aria-label': 'First message' }) as HTMLTextAreaElement;
    const go = h('button.btn.primary', { type: 'button' }, 'Start session');
    const cancel = h('button.btn', { type: 'button' }, 'Cancel');
    const error = h('div.fs-error.hidden', { role: 'alert' });
    const form = h('div.fs-new');
    const pics = pictures(prompt, form);
    const field = (label: string, input: HTMLElement) => h('div.fs-field', {}, h('label', {}, label), input);
    form.append(
      h('h3', {}, 'New session on a Factory computer'),
      computers.length ? '' : h('p.note', {}, 'There’s no Factory computer on the account yet. Make one in the Factory web app (or the Computers window), then come back.'),
      h('div.fs-grid', {}, field('Computer', computer), field('Folder', cwd), field('Model', model), field('Effort', effort), field('Mode', mode), field('Autonomy', autonomy)),
      field('First message', prompt),
      pics.element,
      error,
      h('div.fs-new-actions', {}, cancel, go),
    );
    pane.replaceChildren(form);
    cancel.addEventListener('click', () => {
      creating = false;
      renderList();
      if (picked) showDetail(picked);
      else renderEmpty();
    });
    go.addEventListener('click', async () => {
      if (!computer.value) return;
      go.setAttribute('disabled', '');
      error.classList.add('hidden');
      try {
        const images = pics.take();
        const r = await factoryFetch<{ session: FactorySession; error?: string }>('sessions', '', {
          method: 'POST',
          body: {
            computerId: computer.value,
            computerName: computers.find((c) => c.id === computer.value)?.name,
            cwd: cwd.value.trim() || undefined,
            model: model.value || undefined,
            reasoningEffort: effort.value || undefined,
            interactionMode: mode.value,
            autonomyLevel: autonomy.value,
            prompt: prompt.value,
            ...(images.length ? { images } : {}),
          },
        });
        if (r.error) toast(`The session started, but its first message didn’t go: ${r.error}`, 'warn');
        creating = false;
        choose(r.session.id);
      } catch (err) {
        error.textContent = (err as Error).message;
        error.classList.remove('hidden');
        go.removeAttribute('disabled');
      }
    });
    setTimeout(() => prompt.focus(), 30);
  };

  const choose = (id: string) => {
    picked = id;
    creating = false;
    renderList();
    if (detail?.id !== id) showDetail(id);
  };
  newBtn.addEventListener('click', () => {
    if (!factoryCan(store.factory.connection, 'computers')) return toast('Connect the office to Factory first (⚙️ Settings → Factory)', 'warn');
    creating = true;
    renderList();
    showNew();
  });

  const onFactory = () => {
    renderList();
    if (detail) detail.paint();
    else if (!creating) renderEmpty();
  };
  const unsub = store.on('factory', onFactory);
  const stopWatch = watchFactory('sessions');
  // Ages ("2m ago") stay right.
  const tick = setInterval(onFactory, 30_000);
  const modal = openModal(el, {
    doing: '🛰️ looking at Droid sessions',
    onClose: () => {
      unsub();
      stopWatch();
      clearInterval(tick);
      closeDetail();
      open = undefined;
    },
  });
  open = { modal, select: (id) => choose(id) };
  renderList();
  if (picked) showDetail(picked);
  else renderEmpty();
  setTimeout(() => search.focus(), 30);
}
