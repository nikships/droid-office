import { factoryCan } from '../../shared/factory';
import {
  BULK_MAX,
  computerPhase,
  currentStep,
  DEFAULT_REMOTE_USER,
  diskPct,
  memPct,
  NAME_MAX,
  NAME_PREFIX,
  SECRET_NAME,
  type ComputerPhase,
  type FactoryComputer,
  type FactoryMetricSample,
  type FactoryRepoChoice,
} from '../../shared/factory-computers';
import { factoryFetch, refreshFactory, watchFactory } from '../factory';
import { store } from '../state';
import { fmtGb, loadColor } from '../world/machine';
import { PHASE_WORD } from '../world/factory-computers';
import { h, openModal, timeAgo, toast } from './dom';
import { emptyState, field, toggle } from './kit';

// The Computers window (E at the compute wall, ☰ → Computers): every Droid Computer with its status,
// one computer's provisioning steps, metrics and actions, the new-computer form, and the
// organization's computer secrets. Every action is a route of the computers feature
// (src/server/factory/computers.ts); the list itself is store.factory.computers.

type View = { kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'new' };

const RANGES: [hours: number, label: string][] = [
  [6, '6 hours'],
  [24, '24 hours'],
  [96, '4 days'],
];

/** loadColor's colors as the classes that paint a chart's "now" in them. */
const LOAD_TONE: Record<string, string> = { '#ef4444': 'bad', '#f2b84b': 'warn', '#3ccf91': 'ok' };

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

const pill = (phase: ComputerPhase) => h('span.pill.cmp-phase', { class: phase }, PHASE_WORD[phase]);
const providerTag = (c: FactoryComputer) => h('span.cmp-tag', { class: c.managed ? 'managed' : 'byom', title: c.managed ? 'Factory runs it' : 'Your own machine, connected to Factory' }, c.managed ? c.providerType || 'managed' : 'BYOM');

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function shortTime(at: number, hours: number): string {
  const d = new Date(at);
  return hours > 24 ? d.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** A button that runs `run` with its label swapped for "…" meanwhile, its result or error in `out`. */
function actionButton(label: string, title: string, run: () => Promise<string | undefined>, out: HTMLElement, cls = ''): HTMLButtonElement {
  const btn = h('button.btn', { type: 'button', title, class: cls }, label) as HTMLButtonElement;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = `${label}…`;
    out.className = 'cmp-out';
    out.textContent = '';
    try {
      const said = await run();
      if (said) {
        out.className = 'cmp-out note good';
        out.textContent = said;
      }
    } catch (err) {
      out.className = 'cmp-out note bad';
      out.textContent = (err as Error).message;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  return btn;
}

/** The floor's repository on GitHub, as Factory names one, if it's on GitHub. */
function floorRepo(): string | undefined {
  const f = store.floors.find((x) => x.id === store.floor);
  return f?.repo && store.project?.forge !== 'gitlab' && /^[\w.-]+\/[\w.-]+$/.test(f.repo) ? f.repo : undefined;
}

/** Opens the Computers window, on one computer when `id` is given. `settings` opens ⚙️ Settings → Factory. */
export function openComputers(opts: { settings: () => void; id?: string }) {
  let view: View = opts.id ? { kind: 'detail', id: opts.id } : { kind: 'list' };
  const sub = h('p.sub', {}, 'Factory’s cloud computers and the machines you connected yourself');
  const add = h('button.btn.primary.sm', { type: 'button', title: 'Make a new Droid Computer' }, '+ New computer');
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const rows = h('ul.list.cmp-list', { role: 'listbox', 'aria-label': 'Computers' });
  const pane = h('section.cmp-pane');
  const split = h('div.split.cmp-split', {}, h('aside.cmp-side', {}, rows), pane);
  const body = h('div.body.flush.cmp-body');
  const foot = h('span.grow');
  const footActions = h('div.row.cmp-foot-actions');
  const el = h(
    'div.modal.xl.computers',
    { role: 'dialog', 'aria-label': 'Droid Computers' },
    h('header', {}, h('div.titles', {}, h('h2', {}, 'Droid Computers'), sub), h('div.actions', {}, add), close),
    body,
    h('footer', {}, foot, footActions),
  );
  let section: Section | undefined;

  const go = (next: View) => {
    view = next;
    section?.dispose?.();
    section = undefined;
    paint();
  };
  add.addEventListener('click', () => go({ kind: 'new' }));

  const paintRows = () => {
    const s = store.factory.computers;
    const now = Date.now();
    const secretsRow = h(
      'li.list-row.cmp-secrets-row',
      { role: 'option', tabindex: 0, 'aria-selected': String(view.kind === 'list'), class: view.kind === 'list' ? 'on' : '', title: 'What Droid Computers are, and the organization’s computer secrets' },
      h('span.list-icon', {}, '🔑'),
      h('span.list-main', {}, h('span.list-title', {}, 'Overview and secrets'), h('span.list-meta', {}, s.secretsError ? 'secrets unavailable' : `${s.secrets.length} secret${s.secrets.length === 1 ? '' : 's'} set`)),
    );
    onPick(secretsRow, () => go({ kind: 'list' }));
    let items: HTMLElement[];
    if (!s.fetchedAt && !s.items.length) {
      items = s.error ? [h('li.note.bad', {}, s.error)] : [0, 1, 2].map(() => h('li.skeleton.cmp-skeleton', { 'aria-hidden': 'true' }));
    } else if (!s.items.length) {
      items = [h('li.empty-state.cmp-side-empty', {}, h('b', {}, 'No Droid Computers yet'), h('p', {}, 'Make one with + New computer.'))];
    } else {
      items = s.items.map((c) => {
        const phase = computerPhase(c, s, now);
        const m = s.metrics[c.id]?.latest;
        const step = phase === 'provisioning' || phase === 'error' ? currentStep(c) : undefined;
        const meta = [
          c.managed ? c.providerType || 'managed' : 'BYOM',
          c.remoteUser ?? '',
          c.createdAt ? `made ${timeAgo(c.createdAt)}` : '',
          c.repos?.length ? (c.repos.length === 1 ? c.repos[0] : `${c.repos.length} repos`) : '',
          step ? `${step.name}${step.error ? `: ${step.error}` : ''}` : '',
          phase === 'asleep' && m ? `last seen ${timeAgo(m.at)}` : '',
          c.managed && m ? `CPU ${Math.round(m.cpuPct)}% · MEM ${memPct(m)}% · DISK ${diskPct(m)}%` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const on = view.kind === 'detail' && view.id === c.id;
        const li = h(
          'li.list-row',
          { role: 'option', tabindex: 0, 'aria-selected': String(on), class: on ? 'on' : '', title: `Open ${c.name}` },
          h('span.list-icon', { title: c.managed ? 'Factory runs it' : 'Your own machine, connected to Factory' }, c.managed ? '☁️' : '💻'),
          h('span.list-main', {}, h('span.list-title', {}, c.name, s.here === c.id ? h('span.cmp-tag.here', { title: 'This is the machine the office runs on' }, 'This machine') : null), h('span.list-meta', { title: meta }, meta)),
          h('span.list-end', {}, pill(phase)),
        );
        onPick(li, () => go({ kind: 'detail', id: c.id }));
        return li;
      });
    }
    rows.replaceChildren(secretsRow, h('li.cmp-list-label', { role: 'presentation' }, 'Computers'), ...items);
  };

  const paint = () => {
    const conn = store.factory.connection;
    const s = store.factory.computers;
    const can = factoryCan(conn, 'computers');
    add.classList.toggle('hidden', !can);
    foot.textContent = s.fetchedAt ? `Updated ${timeAgo(s.fetchedAt)}${s.error ? ` · ⚠️ ${s.error}` : ''}${conn.rejected ? ' · ⚠️ Factory rejected the office’s key' : ''}` : '';
    if (!conn.connected || (!can && !conn.rejected)) {
      section?.dispose?.();
      section = undefined;
      footActions.replaceChildren();
      const why = !conn.connected ? 'Connect the office to Factory to see your Droid Computers here, make new ones and run them from the office.' : 'This Factory key can’t reach Droid Computers.';
      body.replaceChildren(emptyState('🖥️', !conn.connected ? 'Not connected to Factory' : 'No access to Droid Computers', why, h('button.btn.primary', { type: 'button', onclick: () => opts.settings() }, 'Settings → Factory')));
      return;
    }
    if (body.firstElementChild !== split) body.replaceChildren(split);
    paintRows();
    if (!section) {
      section = view.kind === 'detail' ? detail(view.id, go) : view.kind === 'new' ? newForm(go) : list();
      pane.replaceChildren(...section.nodes);
      pane.scrollTop = 0;
      footActions.replaceChildren(...(section.footer ?? []));
    }
    section.render();
  };

  const stopWatching = watchFactory('computers');
  const off = store.on('factory', paint);
  // The ages, and asleep-ness, move on by themselves.
  const tick = setInterval(paint, 30_000);
  const modal = openModal(el, {
    doing: '🖥️ at the compute wall',
    onClose: () => {
      off();
      clearInterval(tick);
      stopWatching();
      section?.dispose?.();
    },
  });
  close.addEventListener('click', () => modal.close());
  refreshFactory('computers');
  paint();
}

/** What a pane shows; `footer` is its buttons on the right of the window's footer. */
type Section = { nodes: Node[]; render(): void; dispose?(): void; footer?: Node[] };

/** Click, Enter or Space on a list row. */
function onPick(row: HTMLElement, pick: () => void) {
  row.addEventListener('click', pick);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick();
    }
  });
}

// ---- The overview ------------------------------------------------------------------------------

function list(): Section {
  const intro = h(
    'div.section',
    {},
    h('div.eyebrow', {}, 'Droid Computers'),
    h('p.cmp-lede', {}, 'Factory’s cloud computers (managed) and the machines you connected yourself (BYOM). Pick one on the left for its metrics, provisioning and actions.'),
  );
  const secrets = secretsCard();
  return { nodes: [h('div.stack.loose.cmp-pane-inner', {}, intro, secrets.node)], render: secrets.render };
}

/** The organization's computer secrets: their names, a remove for each, and a form to set one. Values are never shown, and never come back. */
function secretsCard() {
  const names = h('ul.list.boxed.cmp-secrets');
  const key = h('input.input', { type: 'text', placeholder: 'NAME', 'aria-label': 'Secret name', spellcheck: 'false', autocomplete: 'off', maxlength: 128 }) as HTMLInputElement;
  const value = h('input.input', { type: 'password', placeholder: 'Value', 'aria-label': 'Secret value', autocomplete: 'new-password', maxlength: 10000 }) as HTMLInputElement;
  const out = h('p.cmp-out');
  const save = actionButton(
    'Set',
    'Set this secret on every computer of the organization',
    async () => {
      const k = key.value.trim().toUpperCase();
      if (!SECRET_NAME.test(k)) throw new Error('A secret’s name is capital letters, digits and _, not starting with a digit');
      if (!value.value) throw new Error('Give it a value');
      await factoryFetch('computers', '/secrets', { method: 'PATCH', body: { upsert: [{ key: k, value: value.value }], delete: [] } });
      key.value = '';
      value.value = '';
      return `${k} is set. Computers get it when they’re refreshed or made.`;
    },
    out,
  );
  key.addEventListener('input', () => {
    const at = key.selectionStart;
    key.value = key.value.toUpperCase();
    key.setSelectionRange(at, at);
  });
  const node = h(
    'section.section',
    {},
    h('div.eyebrow', {}, 'Computer secrets'),
    h('p.cmp-lede', {}, 'Environment variables every computer in the organization gets. Values are write-only: Factory never shows them again, and neither does the office.'),
    names,
    h('div.cmp-inline-form', {}, key, value, save),
    out,
  );
  const render = () => {
    const s = store.factory.computers;
    if (s.secretsError) {
      names.replaceChildren(h('li.list-row.cmp-muted', {}, h('span.list-main', {}, h('span.list-meta', {}, s.secretsError))));
      return;
    }
    if (!s.secrets.length) {
      names.replaceChildren(h('li.list-row.cmp-muted', {}, h('span.list-main', {}, h('span.list-meta', {}, 'No secrets yet.'))));
      return;
    }
    names.replaceChildren(
      ...s.secrets.map((name) =>
        h(
          'li.list-row',
          {},
          h('span.list-icon', {}, '🔑'),
          h('span.list-main', {}, h('code.list-title.cmp-secret-name', { title: name }, name)),
          h(
            'span.list-end',
            {},
            h('span.cmp-secret-val', { 'aria-hidden': 'true' }, '••••••••'),
            actionButton(
              'Remove',
              `Remove ${name} from the organization`,
              async () => {
                if (!confirm(`Remove the computer secret ${name}? Computers keep it until they’re refreshed.`)) return undefined;
                await factoryFetch('computers', '/secrets', { method: 'PATCH', body: { upsert: [], delete: [name] } });
                return `${name} removed.`;
              },
              out,
              'danger sm',
            ),
          ),
        ),
      ),
    );
  };
  return { node, render };
}

// ---- One computer ------------------------------------------------------------------------------

function detail(id: string, go: (v: View) => void): Section {
  const titleEl = h('h3.cmp-title');
  const badges = h('div.row.cmp-badges');
  const idEl = h('span.cmp-id', { title: 'Its id in Factory' });
  const facts = h('dl.cmp-facts');
  const out = h('p.cmp-out', { role: 'status' });
  const call = (path: string, init: Parameters<typeof factoryFetch>[2] = { method: 'POST' }) => factoryFetch('computers', `/${encodeURIComponent(id)}${path}`, init);
  const nameOf = () => store.factory.computers.items.find((c) => c.id === id)?.name ?? id;

  const wake = actionButton(
    'Wake',
    'Resume it if it’s asleep (it does nothing to one that’s running)',
    async () => {
      const r = await call('/restart', { method: 'POST', body: { mode: 'resume' } });
      return (r as { wasRestarted?: boolean }).wasRestarted ? 'Waking it up. It shows as active once it sends its first sample.' : 'It was already running.';
    },
    out,
    'sm',
  );
  const reboot = actionButton(
    'Reboot',
    'Restart it from scratch',
    async () => {
      if (!confirm(`Reboot ${nameOf()}? Anything running on it stops.`)) return undefined;
      await call('/restart', { method: 'POST', body: { mode: 'reboot' } });
      return 'Rebooting.';
    },
    out,
    'sm',
  );
  const keepAwake = actionButton(
    'Keep awake',
    'Count this as use, so Factory doesn’t put it to sleep for a while',
    async () => {
      const r = (await call('/activity')) as { lastActiveAt?: number };
      return `Marked as in use ${r.lastActiveAt ? timeAgo(r.lastActiveAt) : 'just now'}.`;
    },
    out,
    'sm',
  );
  const refresh = actionButton(
    'Refresh credentials',
    'Set up its git credentials and the organization’s computer secrets again',
    async () => {
      const r = (await call('/refresh')) as { configured?: number; secretsConfigured?: number };
      return `Refreshed: ${r.configured ?? 0} credential${r.configured === 1 ? '' : 's'} and ${r.secretsConfigured ?? 0} secret${r.secretsConfigured === 1 ? '' : 's'} configured.`;
    },
    out,
    'sm',
  );
  const deps = actionButton(
    'Retry install deps',
    'Run the install-dependencies step again',
    async () => {
      await call('/install-deps');
      return 'Installing dependencies again. Its steps below show how it goes.';
    },
    out,
    'sm',
  );
  const actions = h('div.row.wrap.cmp-actions', {}, wake, reboot, keepAwake, refresh, deps);
  const head = h('div.cmp-head', {}, h('div.row.between.cmp-head-row', {}, h('div.cmp-head-title', {}, titleEl, badges), idEl), actions);

  // Rename and remote user.
  const nameIn = h('input.input', { type: 'text', 'aria-label': 'Name', maxlength: NAME_MAX, spellcheck: 'false' }) as HTMLInputElement;
  const userIn = h('input.input', { type: 'text', 'aria-label': 'Remote user', maxlength: NAME_MAX, spellcheck: 'false', placeholder: 'Remote user' }) as HTMLInputElement;
  const editOut = h('p.cmp-out');
  const saveEdit = actionButton(
    'Save',
    'Rename it, or change the user sessions run as',
    async () => {
      const c = store.factory.computers.items.find((x) => x.id === id);
      const body: Record<string, string> = {};
      if (nameIn.value.trim() && nameIn.value.trim() !== c?.name) body.name = nameIn.value.trim();
      if (userIn.value.trim() && userIn.value.trim() !== c?.remoteUser) body.remoteUser = userIn.value.trim();
      if (!Object.keys(body).length) return 'Nothing changed.';
      await call('', { method: 'PATCH', body });
      return 'Saved.';
    },
    editOut,
  );
  const edit = h('section.section', {}, h('div.eyebrow', {}, 'Name and remote user'), h('div.cmp-fields.cmp-edit', {}, field('Name', nameIn), field('Remote user', userIn), saveEdit), editOut);
  let editSeeded = '';

  // Deleting takes its name typed out.
  const confirmIn = h('input.input', { type: 'text', 'aria-label': 'Type the computer’s name to delete it', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const delOut = h('p.cmp-out');
  const del = actionButton(
    'Delete',
    'Delete this computer for good',
    async () => {
      await call('', { method: 'DELETE', body: { confirm: confirmIn.value.trim() } });
      toast(`Deleted ${confirmIn.value.trim()}`);
      go({ kind: 'list' });
      return undefined;
    },
    delOut,
    'danger',
  );
  const dangerNote = h('p.cmp-lede');
  const danger = h('section.section.cmp-danger', {}, h('div.eyebrow', {}, 'Delete'), dangerNote, h('div.cmp-inline-form.two', {}, confirmIn, del), delOut);
  confirmIn.addEventListener('input', () => (del.disabled = confirmIn.value.trim() !== nameOf()));

  const steps = h('ol.list.boxed.cmp-steps');
  const stepsCard = h('section.section', {}, h('div.eyebrow', {}, 'Provisioning'), steps);

  // Metrics over a range Factory keeps (about four days).
  let hours = 24;
  let samples: FactoryMetricSample[] | null = null;
  let samplesError = '';
  let loadedFor = '';
  const rangeTabs = h('div.seg', { role: 'group', 'aria-label': 'Range' });
  const charts = h('div.cmp-charts');
  const metricsCard = h('section.section', {}, h('div.row.between.cmp-section-head', {}, h('div.eyebrow', {}, 'Metrics'), rangeTabs), charts);
  const loadMetrics = async () => {
    const key = `${hours}`;
    loadedFor = key;
    samples = null;
    samplesError = '';
    paintCharts();
    try {
      const r = await factoryFetch<{ samples: FactoryMetricSample[] }>('computers', `/${encodeURIComponent(id)}/metrics`, { query: { hours } });
      if (loadedFor !== key) return;
      samples = r.samples;
    } catch (err) {
      if (loadedFor !== key) return;
      samplesError = (err as Error).message;
      samples = [];
    }
    paintCharts();
  };
  const paintCharts = () => {
    rangeTabs.replaceChildren(
      ...RANGES.map(([n, label]) =>
        h(
          'button.btn.sm',
          {
            type: 'button',
            class: n === hours ? 'on' : '',
            'aria-pressed': String(n === hours),
            onclick: () => {
              hours = n;
              void loadMetrics();
            },
          },
          label,
        ),
      ),
    );
    if (samplesError) return charts.replaceChildren(h('p.note.bad', {}, samplesError));
    if (!samples) return charts.replaceChildren(...[0, 1, 2].map(() => h('div.skeleton.cmp-chart-skeleton', { 'aria-label': 'Reading its samples…' })));
    if (!samples.length) return charts.replaceChildren(h('p.cmp-muted', {}, `No samples in the last ${RANGES.find(([n]) => n === hours)?.[1] ?? `${hours} hours`}: it was asleep the whole time.`));
    const last = samples[samples.length - 1];
    charts.replaceChildren(
      chart('CPU', samples, (s) => s.cpuPct, `${Math.round(last.cpuPct)}% of ${last.cpuCount} CPU`, hours),
      chart('Memory', samples, memPct, `${fmtGb(last.memUsed)} of ${fmtGb(last.memTotal)}`, hours),
      chart('Disk', samples, diskPct, `${fmtGb(last.diskUsed)} of ${fmtGb(last.diskTotal)}`, hours),
    );
  };

  let fetched = false;
  const render = () => {
    const s = store.factory.computers;
    const c = s.items.find((x) => x.id === id);
    if (!c) {
      titleEl.textContent = s.fetchedAt ? 'That computer isn’t there any more.' : 'Reading it…';
      badges.replaceChildren();
      idEl.textContent = '';
      for (const n of [facts, actions, edit, danger, stepsCard, metricsCard]) n.classList.add('hidden');
      return;
    }
    for (const n of [facts, actions, edit, danger, stepsCard, metricsCard]) n.classList.remove('hidden');
    const phase = computerPhase(c, s, Date.now());
    const latest = s.metrics[c.id]?.latest;
    titleEl.textContent = c.name;
    titleEl.title = c.name;
    badges.replaceChildren(pill(phase), providerTag(c), s.here === c.id ? h('span.cmp-tag.here', {}, 'This machine') : '');
    idEl.textContent = c.id;
    const fact = (k: string, v: string | Node) => [h('div.cmp-fact', {}, h('dt', {}, k), h('dd', {}, v))];
    facts.replaceChildren(
      ...fact('Status', phase === 'asleep' ? `Asleep${latest ? ` · last seen ${timeAgo(latest.at)}` : ''}` : phase === 'waking' ? 'Waking up' : String(c.status)),
      ...fact('Provider', c.managed ? `${c.providerType} (managed by Factory)` : 'BYOM (your own machine)'),
      ...fact('Created', c.createdAt ? `${new Date(c.createdAt).toLocaleString()} (${timeAgo(c.createdAt)})` : '—'),
      ...fact('Remote user', c.remoteUser ?? '—'),
      ...fact('Repositories', c.repos?.length ? h('span', {}, ...c.repos.map((r) => h('code', {}, r))) : '—'),
      ...(latest ? fact('Size', `${latest.cpuCount} CPU · ${fmtGb(latest.memTotal)} memory · ${fmtGb(latest.diskTotal)} disk`) : []),
    );
    wake.classList.toggle('hidden', !c.managed);
    reboot.classList.toggle('hidden', !c.managed);
    keepAwake.classList.toggle('hidden', !c.managed);
    deps.classList.toggle('hidden', !c.provisioningSteps?.some((st) => /dep/i.test(st.id) || /dep/i.test(st.name)) && phase !== 'error');
    const seed = `${c.name}|${c.remoteUser ?? ''}`;
    if (seed !== editSeeded && document.activeElement !== nameIn && document.activeElement !== userIn) {
      editSeeded = seed;
      nameIn.value = c.name;
      userIn.value = c.remoteUser ?? '';
    }
    dangerNote.textContent = `Deleting ${c.name} ends whatever runs on it and can’t be undone. Type its name to delete it.`;
    confirmIn.placeholder = c.name;
    del.disabled = confirmIn.value.trim() !== c.name;
    const list = c.provisioningSteps ?? [];
    steps.replaceChildren(
      ...(list.length
        ? list.map((st) => {
            const state = st.error || st.status === 'failed' || st.status === 'error' ? 'bad' : st.status === 'completed' ? 'ok' : st.startedAt ? 'run' : 'wait';
            const took = st.startedAt ? duration((st.completedAt ?? Date.now()) - st.startedAt) : '';
            return h(
              'li.list-row.cmp-step',
              { class: state },
              h('span.list-icon.mark', {}, state === 'ok' ? '✓' : state === 'bad' ? '✗' : state === 'run' ? '…' : '○'),
              h('span.list-main', {}, h('span.list-title', {}, st.name), st.error ? h('span.list-meta.why', {}, st.error) : null),
              h('span.list-end.took', {}, took),
            );
          })
        : [h('li.list-row.cmp-muted', {}, h('span.list-main', {}, h('span.list-meta', {}, c.managed ? 'Factory hasn’t listed its steps.' : 'A BYOM computer is set up on your own machine.')))]),
    );
    metricsCard.classList.toggle('hidden', !c.managed);
    // Factory answers 400 for the metrics of a computer that isn't up yet.
    if (c.managed && c.status !== 'active') {
      loadedFor = '';
      rangeTabs.replaceChildren();
      charts.replaceChildren(h('p.cmp-muted', {}, c.status === 'error' ? 'No metrics: it didn’t finish provisioning.' : 'Its metrics start once it’s provisioned.'));
    } else if (c.managed && !loadedFor) void loadMetrics();
    if (!fetched) {
      fetched = true;
      // The latest steps and repositories, past the list's.
      void factoryFetch('computers', `/${encodeURIComponent(id)}`).catch(() => undefined);
    }
  };
  return { nodes: [h('div.stack.loose.cmp-pane-inner', {}, h('div.stack.tight', {}, head, out), facts, stepsCard, metricsCard, edit, danger)], render };
}

/** One metric over the range as a filled line, broken where it was asleep, with its now and peak over it. */
function chart(name: string, samples: FactoryMetricSample[], value: (s: FactoryMetricSample) => number, now: string, hours: number): HTMLElement {
  const W = 600;
  const H = 120;
  const end = Date.now();
  const start = end - hours * 3600_000;
  const x = (at: number) => ((at - start) / (end - start)) * W;
  const y = (v: number) => H - (Math.max(0, Math.min(100, v)) / 100) * H;
  const runs: FactoryMetricSample[][] = [];
  for (const s of samples) {
    const run = runs[runs.length - 1];
    if (run && s.at - run[run.length - 1].at <= 16 * 60_000) run.push(s);
    else runs.push([s]);
  }
  const paths: SVGElement[] = [svg('line', { x1: 0, y1: y(90), x2: W, y2: y(90), class: 'grid' })];
  for (const run of runs) {
    const line = run.map((s, i) => `${i ? 'L' : 'M'}${x(s.at).toFixed(1)},${y(value(s)).toFixed(1)}`).join('');
    if (run.length > 1) paths.push(svg('path', { d: `${line}L${x(run[run.length - 1].at).toFixed(1)},${H}L${x(run[0].at).toFixed(1)},${H}Z`, class: 'fill' }));
    paths.push(svg('path', { d: run.length > 1 ? line : `M${x(run[0].at) - 1},${y(value(run[0]))}h2`, class: 'line' }));
  }
  const peak = Math.round(Math.max(...samples.map(value)));
  const last = Math.round(value(samples[samples.length - 1]));
  return h(
    'div.cmp-chart',
    {},
    h('div.cmp-chart-head', {}, h('span.cmp-chart-name', {}, name), h('span.cmp-chart-now', { class: LOAD_TONE[loadColor(last)] ?? 'ok' }, now), h('span.cmp-chart-peak', {}, `peak ${peak}%`)),
    svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${name} over the last ${hours} hours` }, ...paths) as unknown as HTMLElement,
    h('div.cmp-chart-axis', {}, h('span', {}, shortTime(start, hours)), h('span', {}, 'now')),
  );
}

// ---- A new computer ----------------------------------------------------------------------------

function newForm(go: (v: View) => void): Section {
  let bulk = false;
  const one = h('button.btn', { type: 'button' }, 'One');
  const several = h('button.btn', { type: 'button' }, 'Several');
  const floorName =
    (store.floors.find((f) => f.id === store.floor)?.name ?? 'office')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'office';
  const nameIn = h('input.input', { type: 'text', 'aria-label': 'Name', maxlength: NAME_MAX, spellcheck: 'false', value: `${floorName}-computer`.slice(0, NAME_MAX) }) as HTMLInputElement;
  const prefixIn = h('input.input', { type: 'text', 'aria-label': 'Name prefix', maxlength: 58, spellcheck: 'false', value: floorName.replace(/^[^a-z]+/, '') || 'droid' }) as HTMLInputElement;
  const qtyIn = h('input.input', { type: 'number', 'aria-label': 'How many', min: 1, max: BULK_MAX, value: 2 }) as HTMLInputElement;
  const userIn = h('input.input', { type: 'text', 'aria-label': 'Remote user', maxlength: NAME_MAX, spellcheck: 'false', placeholder: DEFAULT_REMOTE_USER }) as HTMLInputElement;
  const provider = h('select.select', { 'aria-label': 'Provider' }) as HTMLSelectElement;
  const autoDepsToggle = toggle({ label: 'Install dependencies when it’s made', description: 'Factory runs each repository’s install step after cloning it.', checked: true });
  const autoDeps = autoDepsToggle.input;
  const single = h('div.cmp-fields', {}, field('Name', nameIn), field('Remote user', userIn));
  const multi = h(
    'div.cmp-fields',
    {},
    field('How many', qtyIn),
    field('Name prefix', prefixIn),
    h('p.field-hint.cmp-span', {}, `Up to ${BULK_MAX} at once. Factory names them after the prefix. It’s lower-case letters, digits and hyphens, starting with a letter.`),
  );

  // The repository picker: what Factory's GitHub app sees, this floor's repository picked to start with.
  const picked = new Set<string>();
  const here = floorRepo();
  if (here) picked.add(`https://github.com/${here}`);
  let repos: FactoryRepoChoice[] | null = null;
  let reposError = '';
  const filter = h('input.input', { type: 'search', placeholder: 'Find a repository…', 'aria-label': 'Find a repository', spellcheck: 'false' }) as HTMLInputElement;
  const repoList = h('ul.list.boxed.cmp-repos');
  const chosen = h('p.field-hint');
  const muted = (text: string, cls = '') => h('li.list-row.cmp-muted', { class: cls }, h('span.list-main', {}, h('span.list-meta', {}, text)));
  const paintRepos = () => {
    chosen.textContent = picked.size ? `Clones ${[...picked].map((u) => u.replace(/^https:\/\/github\.com\//, '')).join(', ')}` : 'No repositories: it starts empty.';
    if (reposError) return repoList.replaceChildren(muted(reposError, 'bad'));
    if (!repos) return repoList.replaceChildren(...[0, 1, 2].map(() => h('li.skeleton.cmp-skeleton', { 'aria-label': 'Reading the repositories Factory sees…' })));
    const q = filter.value.trim().toLowerCase();
    const all = [...repos];
    for (const u of picked) if (!all.some((r) => r.url === u)) all.unshift({ fullName: u.replace(/^https:\/\/github\.com\//, ''), url: u });
    const shown = all.filter((r) => !q || r.fullName.toLowerCase().includes(q)).sort((a, b) => Number(picked.has(b.url)) - Number(picked.has(a.url)));
    repoList.replaceChildren(
      ...shown.slice(0, 60).map((r) => {
        const box = h('input', { type: 'checkbox', checked: picked.has(r.url) }) as HTMLInputElement;
        box.addEventListener('change', () => {
          if (box.checked) picked.add(r.url);
          else picked.delete(r.url);
          paintRepos();
        });
        return h(
          'li',
          {},
          h(
            'label.list-row.cmp-repo',
            {},
            h('span.list-icon', {}, box),
            h('span.list-main', {}, h('span.list-title', { title: r.fullName }, r.fullName)),
            h('span.list-end', {}, r.isPrivate ? h('span.cmp-tag', {}, 'private') : '', here && r.url === `https://github.com/${here}` ? h('span.cmp-tag.here', {}, 'this floor') : ''),
          ),
        );
      }),
      ...(shown.length > 60 ? [muted(`${shown.length - 60} more: type to find one.`)] : []),
      ...(!shown.length ? [muted('None match.')] : []),
    );
  };
  filter.addEventListener('input', paintRepos);
  void factoryFetch<{ repositories: FactoryRepoChoice[] }>('computers', '/repositories').then(
    (r) => {
      repos = r.repositories;
      paintRepos();
    },
    (err: Error) => {
      reposError = `Couldn’t list repositories: ${err.message}`;
      repos = [];
      paintRepos();
    },
  );

  const out = h('p.cmp-out', { role: 'status' });
  const create = actionButton(
    'Create',
    'Make it in Factory',
    async () => {
      const common = { provider: provider.value || undefined, repos: [...picked], autoInstallDeps: autoDeps.checked };
      if (bulk) {
        const quantity = Number(qtyIn.value);
        const namePrefix = prefixIn.value.trim();
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > BULK_MAX) throw new Error(`Make 1 to ${BULK_MAX} at a time`);
        if (!NAME_PREFIX.test(namePrefix)) throw new Error('The prefix is lower-case letters, digits and hyphens, starting with a letter');
        const r = await factoryFetch<{ computers: FactoryComputer[]; error?: string }>('computers', '/bulk', { method: 'POST', body: { ...common, quantity, namePrefix } });
        if (r.error && !r.computers.length) throw new Error(r.error);
        toast(`Making ${r.computers.length} Droid Computer${r.computers.length === 1 ? '' : 's'}${r.error ? ` (${r.error})` : ''}`, r.error ? 'warn' : 'info');
        go({ kind: 'list' });
        return undefined;
      }
      const name = nameIn.value.trim();
      if (!name) throw new Error('Give it a name');
      const r = await factoryFetch<{ computer: FactoryComputer | null }>('computers', '', { method: 'POST', body: { ...common, name, remoteUser: userIn.value.trim() || undefined } });
      if (r.computer) go({ kind: 'detail', id: r.computer.id });
      else go({ kind: 'list' });
      return undefined;
    },
    out,
    'primary',
  );
  const modeTabs = h('div.seg', { role: 'group', 'aria-label': 'How many' }, one, several);
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => go({ kind: 'list' }) }, 'Cancel');
  const setMode = (b: boolean) => {
    bulk = b;
    one.classList.toggle('on', !b);
    several.classList.toggle('on', b);
    one.setAttribute('aria-pressed', String(!b));
    several.setAttribute('aria-pressed', String(b));
    single.classList.toggle('hidden', b);
    multi.classList.toggle('hidden', !b);
  };
  one.addEventListener('click', () => setMode(false));
  several.addEventListener('click', () => setMode(true));
  setMode(false);
  paintRepos();

  const render = () => {
    const providers = store.factory.computers.providers.length ? store.factory.computers.providers : ['e2b'];
    if (provider.options.length !== providers.length) provider.replaceChildren(...providers.map((p) => h('option', { value: p }, p)));
  };
  return {
    nodes: [
      h(
        'div.stack.loose.cmp-pane-inner',
        {},
        h(
          'div.section',
          {},
          h('div.eyebrow', {}, 'New Droid Computer'),
          h('p.cmp-lede', {}, 'A managed Droid Computer: Factory runs it in the cloud, clones the repositories you pick and installs their dependencies. It sleeps when idle and wakes when it’s used.'),
        ),
        h('div.stack', {}, field('How many', modeTabs), single, multi, h('div.cmp-fields', {}, field('Provider', provider)), autoDepsToggle),
        h('div.field', {}, h('label', {}, 'Repositories'), filter, repoList, chosen),
        out,
      ),
    ],
    footer: [cancel, create],
    render,
  };
}
