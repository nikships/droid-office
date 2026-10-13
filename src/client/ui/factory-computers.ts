import { factoryCan } from '../../shared/factory';
import { BULK_MAX, computerPhase, currentStep, DEFAULT_REMOTE_USER, diskPct, memPct, NAME_MAX, NAME_PREFIX, SECRET_NAME, type ComputerPhase, type FactoryComputer, type FactoryMetricSample } from '../../shared/factory-computers';
import { canStartFrom } from '../../shared/factory-environments';
import { factoryFetch, refreshFactory, watchFactory } from '../factory';
import { store } from '../state';
import { fmtGb, loadColor } from '../world/machine';
import { PHASE_WORD } from '../world/factory-computers';
import { h, openModal, timeAgo, toast } from './dom';
import { envDetail, envForm, envOverview, envRows } from './factory-environments';
import { actionButton, duration, floorRepo, floorSlug, onPick, repoPicker, type Section, shortRepo } from './factory-pane';
import { emptyState, field, toggle } from './kit';

// The Computers window (E at the compute wall, ☰ → Computers), in two tabs. Computers: every Droid
// Computer with its status, one computer's provisioning steps, metrics and actions, the new-computer
// form, and the organization's computer secrets. Environments (factory-environments.ts): what Factory
// builds computers from. Every action is a route of the computers or environments feature
// (src/server/factory/); the lists themselves are store.factory.computers and .environments.

export type View = { kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'new'; environmentId?: string } | { kind: 'envs' } | { kind: 'env'; id: string } | { kind: 'env-new' } | { kind: 'env-edit'; id: string };

type Tab = 'computers' | 'environments';
const tabOf = (v: View): Tab => (v.kind.startsWith('env') ? 'environments' : 'computers');

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

function shortTime(at: number, hours: number): string {
  const d = new Date(at);
  return hours > 24 ? d.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Opens the Computers window, on one computer when `id` is given, or on the Environments tab (one
 * Environment with `envId`). `settings` opens ⚙️ Settings → Factory.
 */
export function openComputers(opts: { settings: () => void; id?: string; tab?: Tab; envId?: string }) {
  let view: View = opts.envId ? { kind: 'env', id: opts.envId } : opts.tab === 'environments' ? { kind: 'envs' } : opts.id ? { kind: 'detail', id: opts.id } : { kind: 'list' };
  const sub = h('p.sub');
  const tabs = h('div.seg.cmp-tabs', { role: 'tablist', 'aria-label': 'Computers or Environments' });
  const add = h('button.btn.primary.sm', { type: 'button' });
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const rows = h('ul.list.cmp-list', { role: 'listbox' });
  const pane = h('section.cmp-pane');
  const split = h('div.split.cmp-split', {}, h('aside.cmp-side', {}, rows), pane);
  const body = h('div.body.flush.cmp-body');
  const foot = h('span.grow');
  const footActions = h('div.row.cmp-foot-actions');
  const el = h(
    'div.modal.xl.computers',
    { role: 'dialog', 'aria-label': 'Droid Computers' },
    h('header', {}, h('div.titles', {}, h('h2', {}, 'Droid Computers'), sub), h('div.actions', {}, tabs, add), close),
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
  add.addEventListener('click', () => go(tabOf(view) === 'environments' ? { kind: 'env-new' } : { kind: 'new' }));

  const paintTabs = () => {
    const tab = tabOf(view);
    const s = store.factory;
    const tabBtn = (t: Tab, label: string, count: number) => {
      const b = h('button.btn.sm', { type: 'button', role: 'tab', class: tab === t ? 'on' : '', 'aria-selected': String(tab === t) }, label, h('span.cmp-tab-count', {}, String(count)));
      b.addEventListener('click', () => tab !== t && go(t === 'environments' ? { kind: 'envs' } : { kind: 'list' }));
      return b;
    };
    tabs.replaceChildren(tabBtn('computers', 'Computers', s.computers.items.length), tabBtn('environments', 'Environments', s.environments.items.length));
    sub.textContent = tab === 'environments' ? 'What Factory builds computers from: an image, your repositories and their setup' : 'Factory’s cloud computers and the machines you connected yourself';
    add.textContent = tab === 'environments' ? '+ New Environment' : '+ New computer';
    add.title = tab === 'environments' ? 'Make a new Factory Environment' : 'Make a new Droid Computer';
    rows.setAttribute('aria-label', tab === 'environments' ? 'Environments' : 'Computers');
  };

  const paintRows = () => {
    if (tabOf(view) === 'environments') return rows.replaceChildren(...envRows(view, go));
    const s = store.factory.computers;
    const envs = store.factory.environments.items;
    const now = Date.now();
    const overviewRow = h(
      'li.list-row.cmp-secrets-row',
      { role: 'option', tabindex: 0, 'aria-selected': String(view.kind === 'list'), class: view.kind === 'list' ? 'on' : '', title: 'Every computer at a glance, and the organization’s computer secrets' },
      h('span.list-icon', {}, '▦'),
      h(
        'span.list-main',
        {},
        h('span.list-title', {}, 'Overview'),
        h('span.list-meta', {}, s.secretsError ? 'secrets unavailable' : `${s.items.length} computer${s.items.length === 1 ? '' : 's'} · ${s.secrets.length} secret${s.secrets.length === 1 ? '' : 's'}`),
      ),
    );
    onPick(overviewRow, () => go({ kind: 'list' }));
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
        const env = c.environmentId ? envs.find((e) => e.id === c.environmentId) : undefined;
        const meta = [
          c.managed ? c.providerType || 'managed' : 'BYOM',
          env ? `from ${env.name}` : '',
          step ? `${step.name}${step.error ? `: ${step.error}` : ''}` : '',
          phase === 'asleep' && m ? `last seen ${timeAgo(m.at)}` : '',
          c.managed && m && phase === 'active' ? `CPU ${Math.round(m.cpuPct)}% · MEM ${memPct(m)}%` : '',
          !m && !step && c.createdAt ? `made ${timeAgo(c.createdAt)}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const on = view.kind === 'detail' && view.id === c.id;
        const li = h(
          'li.list-row',
          { role: 'option', tabindex: 0, 'aria-selected': String(on), class: on ? 'on' : '', title: `Open ${c.name}` },
          h('span.list-icon', { title: c.managed ? 'Factory runs it' : 'Your own machine, connected to Factory' }, c.managed ? '☁️' : '💻'),
          h(
            'span.list-main',
            {},
            h('span.list-title', { title: c.name }, c.name),
            h('span.list-meta', { title: meta }, s.here === c.id ? h('span.cmp-here', { title: 'This is the machine the office runs on' }, 'This machine · ') : null, meta),
          ),
          h('span.list-end', {}, pill(phase)),
        );
        onPick(li, () => go({ kind: 'detail', id: c.id }));
        return li;
      });
    }
    rows.replaceChildren(overviewRow, h('li.cmp-list-label', { role: 'presentation' }, 'Computers'), ...items);
  };

  const make = (v: View): Section => {
    switch (v.kind) {
      case 'detail':
        return detail(v.id, go);
      case 'new':
        return newForm(go, v.environmentId);
      case 'envs':
        return envOverview(go);
      case 'env':
        return envDetail(v.id, go);
      case 'env-new':
        return envForm(go);
      case 'env-edit':
        return envForm(go, v.id);
      default:
        return list(go);
    }
  };

  const paint = () => {
    const conn = store.factory.connection;
    const tab = tabOf(view);
    const s = tab === 'environments' ? store.factory.environments : store.factory.computers;
    const can = factoryCan(conn, tab);
    add.classList.toggle('hidden', !can);
    paintTabs();
    foot.textContent = s.fetchedAt ? `Updated ${timeAgo(s.fetchedAt)}${s.error ? ` · ⚠️ ${s.error}` : ''}${conn.rejected ? ' · ⚠️ Factory rejected the office’s key' : ''}` : '';
    if (!conn.connected || (!can && !conn.rejected)) {
      section?.dispose?.();
      section = undefined;
      footActions.replaceChildren();
      const what = tab === 'environments' ? 'Environments' : 'Droid Computers';
      const why = !conn.connected ? 'Connect the office to Factory to see your Droid Computers and Environments here, make new ones and run workers on them.' : `This Factory key can’t reach ${what}.`;
      body.replaceChildren(emptyState('🖥️', !conn.connected ? 'Not connected to Factory' : `No access to ${what}`, why, h('button.btn.primary', { type: 'button', onclick: () => opts.settings() }, 'Settings → Factory')));
      return;
    }
    if (body.firstElementChild !== split) body.replaceChildren(split);
    paintRows();
    if (!section) {
      section = make(view);
      pane.replaceChildren(...section.nodes);
      pane.scrollTop = 0;
      footActions.replaceChildren(...(section.footer ?? []));
    }
    section.render();
  };

  const stopWatching = watchFactory('computers');
  const stopWatchingEnvs = watchFactory('environments');
  const off = store.on('factory', paint);
  // The ages, and asleep-ness, move on by themselves.
  const tick = setInterval(paint, 30_000);
  const modal = openModal(el, {
    doing: '🖥️ at the compute wall',
    onClose: () => {
      off();
      clearInterval(tick);
      stopWatching();
      stopWatchingEnvs();
      section?.dispose?.();
    },
  });
  close.addEventListener('click', () => modal.close());
  refreshFactory('computers');
  refreshFactory('environments');
  paint();
}

// ---- The overview ------------------------------------------------------------------------------

function list(go: (v: View) => void): Section {
  const stats = h('div.cmp-stats', { role: 'list', 'aria-label': 'Computers by status' });
  const fleet = h('div.cmp-fleet');
  const secrets = secretsCard();
  const stat = (label: string, value: number | string, tone = '', title = '') => h('div.cmp-stat', { role: 'listitem', class: tone, title }, h('span.cmp-stat-value', {}, String(value)), h('span.cmp-stat-label', {}, label));
  const bar = (name: string, pct: number) => {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    return h(
      'div.cmp-bar',
      { class: LOAD_TONE[loadColor(v)] ?? 'ok' },
      h('span.cmp-bar-name', {}, name),
      svg(
        'svg',
        { viewBox: '0 0 100 4', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        svg('rect', { class: 'cmp-bar-track', width: 100, height: 4 }),
        svg('rect', { class: 'cmp-bar-fill', width: v, height: 4 }),
      ) as unknown as HTMLElement,
      h('span.cmp-bar-pct', {}, `${v}%`),
    );
  };
  const render = () => {
    const s = store.factory.computers;
    const envs = store.factory.environments.items;
    const now = Date.now();
    const phases = s.items.map((c) => computerPhase(c, s, now));
    const n = (p: ComputerPhase) => phases.filter((x) => x === p).length;
    stats.replaceChildren(
      stat('Computers', s.items.length),
      stat('Active', n('active'), n('active') ? 'ok' : ''),
      stat('Asleep', n('asleep'), '', 'Factory pauses an idle managed computer; it wakes when it’s used'),
      stat('Starting', n('provisioning') + n('waking'), n('provisioning') + n('waking') ? 'run' : ''),
      stat('Instances', s.instances.length, s.instances.length ? 'run' : '', 'Unlisted computers started from an Environment for a session or a cloud worker (Environments tab)'),
      ...(n('error') ? [stat('Errors', n('error'), 'bad')] : []),
    );
    if (!s.items.length) {
      fleet.replaceChildren(h('p.cmp-muted', {}, s.fetchedAt ? 'No Droid Computers yet. Make one with + New computer, or start one from an Environment.' : 'Reading your computers…'));
    } else {
      fleet.replaceChildren(
        ...s.items.map((c, i) => {
          const phase = phases[i];
          const m = s.metrics[c.id]?.latest;
          const env = c.environmentId ? envs.find((e) => e.id === c.environmentId) : undefined;
          const step = phase === 'provisioning' || phase === 'error' ? currentStep(c) : undefined;
          const tags = [providerTag(c), env ? h('span.cmp-tag.env', { title: `Started from the Environment ${env.name}` }, `⧉ ${env.name}`) : '', s.here === c.id ? h('span.cmp-tag.here', {}, 'This machine') : ''];
          const load =
            c.managed && m && phase === 'active'
              ? h('div.cmp-bars', {}, bar('CPU', m.cpuPct), bar('MEM', memPct(m)), bar('DISK', diskPct(m)))
              : h(
                  'p.cmp-card-note',
                  {},
                  step
                    ? `${step.name}${step.error ? `: ${step.error}` : '…'}`
                    : phase === 'asleep'
                      ? `Asleep${m ? ` · last seen ${timeAgo(m.at)}` : ''}. It wakes when a session starts on it.`
                      : phase === 'waking'
                        ? 'Waking up…'
                        : !c.managed
                          ? `Your own machine${c.remoteUser ? `, as ${c.remoteUser}` : ''}. No metrics for BYOM.`
                          : 'Reading its load…',
                );
          const card = h(
            'button.cmp-card',
            { type: 'button', class: phase, title: `Open ${c.name}` },
            h('span.cmp-card-head', {}, h('span.cmp-card-icon', { 'aria-hidden': 'true' }, c.managed ? '☁️' : '💻'), h('span.cmp-card-name', { title: c.name }, c.name), pill(phase)),
            h('span.cmp-card-tags', {}, ...tags),
            load,
          );
          card.addEventListener('click', () => go({ kind: 'detail', id: c.id }));
          return card;
        }),
      );
    }
    secrets.render();
  };
  const intro = h('div.section', {}, h('div.eyebrow', {}, 'Fleet'), h('p.cmp-lede', {}, 'Factory’s cloud computers (managed) and the machines you connected yourself (BYOM). Pick one for its metrics, provisioning and actions.'));
  return { nodes: [h('div.stack.loose.cmp-pane-inner', {}, h('div.stack', {}, intro, stats, fleet), secrets.node)], render };
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
    const env = c.environmentId ? store.factory.environments.items.find((e) => e.id === c.environmentId) : undefined;
    badges.replaceChildren(pill(phase), providerTag(c), env ? h('span.cmp-tag.env', {}, `⧉ ${env.name}`) : '', s.here === c.id ? h('span.cmp-tag.here', {}, 'This machine') : '');
    idEl.textContent = c.id;
    const fact = (k: string, v: string | Node, cls = '') => [h('div.cmp-fact', { class: cls }, h('dt', {}, k), h('dd', {}, v))];
    facts.replaceChildren(
      ...fact('Status', phase === 'asleep' ? `Asleep${latest ? ` · last seen ${timeAgo(latest.at)}` : ''}` : phase === 'waking' ? 'Waking up' : String(c.status)),
      ...fact('Provider', c.managed ? `${c.providerType} (managed by Factory)` : 'BYOM (your own machine)'),
      ...fact('Created', c.createdAt ? `${new Date(c.createdAt).toLocaleString()} (${timeAgo(c.createdAt)})` : '—'),
      ...fact('Remote user', c.remoteUser ?? '—'),
      ...(c.environmentId ? fact('Environment', env ? h('button.cmp-link', { type: 'button', title: `Open ${env.name}`, onclick: () => go({ kind: 'env', id: env.id }) }, `⧉ ${env.name}`) : 'One that was deleted') : []),
      ...fact('Repositories', c.repos?.length ? h('span.cmp-codes', {}, ...c.repos.map((r) => h('code', { title: r }, r))) : '—', 'wide'),
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

function newForm(go: (v: View) => void, environmentId?: string): Section {
  let bulk = false;
  const one = h('button.btn', { type: 'button' }, 'One');
  const several = h('button.btn', { type: 'button' }, 'Several');
  const floorName = floorSlug();
  const nameIn = h('input.input', { type: 'text', 'aria-label': 'Name', maxlength: NAME_MAX, spellcheck: 'false', value: `${floorName}-computer`.slice(0, NAME_MAX) }) as HTMLInputElement;
  const prefixIn = h('input.input', { type: 'text', 'aria-label': 'Name prefix', maxlength: 58, spellcheck: 'false', value: floorName.replace(/^[^a-z]+/, '') || 'droid' }) as HTMLInputElement;
  const qtyIn = h('input.input', { type: 'number', 'aria-label': 'How many', min: 1, max: BULK_MAX, value: 2 }) as HTMLInputElement;
  const userIn = h('input.input', { type: 'text', 'aria-label': 'Remote user', maxlength: NAME_MAX, spellcheck: 'false', placeholder: DEFAULT_REMOTE_USER }) as HTMLInputElement;
  const provider = h('select.select', { 'aria-label': 'Provider' }) as HTMLSelectElement;
  const autoDepsToggle = toggle({ label: 'Install dependencies when it’s made', description: 'Factory runs each repository’s install step after cloning it.', checked: true });
  const autoDeps = autoDepsToggle.input;
  // Where it starts from: Factory's default image with the repositories picked here, or an Environment that has built.
  const from = h('select.select', { 'aria-label': 'Start from' }) as HTMLSelectElement;
  const fromHint = h('p.field-hint');
  const single = h('div.cmp-fields', {}, field('Name', nameIn), h('div.cmp-plain-only', {}, field('Remote user', userIn)));
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
  const chosen = h('p.field-hint');
  const paintChosen = () => {
    chosen.textContent = picked.size ? `Clones ${[...picked].map(shortRepo).join(', ')}` : 'No repositories: it starts empty.';
  };
  const picker = repoPicker(picked, paintChosen);
  paintChosen();
  const reposField = h('div.field', {}, h('label', {}, 'Repositories'), ...picker.nodes, chosen);
  const modeTabs = h('div.seg', { role: 'group', 'aria-label': 'One computer or several' }, one, several);
  const modeField = field('Computers', modeTabs);
  const plain = h('div.stack', {}, h('div.cmp-fields', {}, field('Provider', provider)), autoDepsToggle, reposField);
  const env = () => store.factory.environments.items.find((e) => e.id === from.value);

  const out = h('p.cmp-out', { role: 'status' });
  const create = actionButton(
    'Create',
    'Make it in Factory',
    async () => {
      const e = env();
      if (e) {
        const name = nameIn.value.trim();
        if (!name) throw new Error('Give it a name');
        const r = await factoryFetch<{ computer: FactoryComputer | null }>('computers', '', { method: 'POST', body: { name, environmentId: e.id } });
        if (r.computer) go({ kind: 'detail', id: r.computer.id });
        else go({ kind: 'list' });
        return undefined;
      }
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
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => go(environmentId ? { kind: 'env', id: environmentId } : { kind: 'list' }) }, 'Cancel');
  const setMode = (b: boolean) => {
    bulk = b;
    one.classList.toggle('on', !b);
    several.classList.toggle('on', b);
    one.setAttribute('aria-pressed', String(!b));
    several.setAttribute('aria-pressed', String(b));
    single.classList.toggle('hidden', b);
    multi.classList.toggle('hidden', !b);
  };
  const paintFrom = () => {
    const e = env();
    plain.classList.toggle('hidden', !!e);
    modeField.classList.toggle('hidden', !!e);
    single.querySelector('.cmp-plain-only')?.classList.toggle('hidden', !!e);
    if (e) setMode(false);
    fromHint.textContent = e
      ? `Ready in seconds: ${e.name}’s build already has ${e.repositories.length ? e.repositories.map((r) => shortRepo(r.url)).join(', ') : 'no repositories'} installed and its setup script run.`
      : 'Factory’s default image. It clones the repositories you pick and installs their dependencies while it’s made.';
  };
  one.addEventListener('click', () => setMode(false));
  several.addEventListener('click', () => setMode(true));
  from.addEventListener('change', paintFrom);
  setMode(false);

  let fromKey = '';
  const render = () => {
    const providers = store.factory.computers.providers.length ? store.factory.computers.providers : ['e2b'];
    if (provider.options.length !== providers.length) provider.replaceChildren(...providers.map((p) => h('option', { value: p }, p)));
    const envs = store.factory.environments.items.filter(canStartFrom);
    const key = envs.map((e) => e.id).join();
    if (key !== fromKey) {
      const was = fromKey ? from.value : (environmentId ?? '');
      fromKey = key;
      from.replaceChildren(h('option', { value: '' }, 'Factory default image'), ...envs.map((e) => h('option', { value: e.id }, `⧉ ${e.name}${e.isDefault ? ' (default)' : ''}`)));
      from.value = envs.some((e) => e.id === was) ? was : '';
      paintFrom();
    }
  };
  return {
    nodes: [
      h(
        'div.stack.loose.cmp-pane-inner',
        {},
        h('div.section', {}, h('div.eyebrow', {}, 'New Droid Computer'), h('p.cmp-lede', {}, 'A managed Droid Computer: Factory runs it in the cloud. It sleeps when idle and wakes when it’s used.')),
        h('div.stack', {}, h('div.field', {}, h('label', {}, 'Start from'), from, fromHint), modeField, single, multi, plain),
        out,
      ),
    ],
    footer: [cancel, create],
    render,
  };
}
