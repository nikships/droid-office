import type { FactoryComputer } from '../../shared/factory-computers';
import {
  buildRunning,
  canStartFrom,
  ENV_NAME,
  ENV_NAME_MAX,
  ENV_PHASE_WORD,
  ENV_SCRIPT_MAX,
  environmentPhase,
  unbuiltChanges,
  type EnvironmentPhase,
  type FactoryEnvBuild,
  type FactoryEnvironment,
  type FactoryEnvLog,
  type FactoryEnvRepo,
} from '../../shared/factory-environments';
import { factoryFetch } from '../factory';
import { store } from '../state';
import { h, timeAgo, toast } from './dom';
import type { View } from './factory-computers';
import { actionButton, duration, floorRepo, floorSlug, onPick, repoPicker, type Section, shortRepo } from './factory-pane';
import { choices, field, toggle } from './kit';

// The Computers window's Environments tab (factory-computers.ts): every Factory Environment with
// its build, one Environment's build log, the computers started from it and its scripts, and the
// form that makes or edits one. Actions are routes of the environments feature
// (src/server/factory/environments.ts); the list is store.factory.environments.

type Go = (v: View) => void;

const envPill = (p: EnvironmentPhase) => h('span.pill.env-phase', { class: p }, ENV_PHASE_WORD[p]);
const TRIGGER_WORD: Record<string, string> = { create: 'First build', edit: 'Rebuilt after an edit', manual: 'Rebuilt by hand', scheduled: 'Scheduled rebuild', 'base-update': 'Rebuilt for a new base image' };
// "Factory default (Factory managed)" says Factory twice: name the provider only when the image doesn't.
const sourceName = (src: { name: string; providerName?: string } | undefined) => {
  if (!src) return '';
  const by = src.providerName?.split(' ')[0];
  return by && !src.name.startsWith(by) ? `${src.name} (${src.providerName})` : src.name;
};
const call = (id: string, path: string, init: Parameters<typeof factoryFetch>[2] = { method: 'POST' }) => factoryFetch('environments', `/${encodeURIComponent(id)}${path}`, init);

/** Every computer that was started from `envId`, listed ones first. */
function computersFrom(envId: string): FactoryComputer[] {
  const s = store.factory.computers;
  return [...s.items, ...s.instances].filter((c) => c.environmentId === envId);
}

/** The cloud worker on this floor using a computer, if any. */
function workerOn(computerId: string) {
  for (const w of store.workers.values()) if (w.cloud?.computerId === computerId) return w;
  return undefined;
}

/** What its build is doing, in a few words: "built 2h ago", "building for 1m 20s". */
function buildLine(e: FactoryEnvironment): string {
  const b = e.latestBuild;
  const p = environmentPhase(e);
  if (b && buildRunning(b)) {
    const since = b.startedAt ?? b.createdAt;
    return `${b.status === 'queued' ? 'queued' : b.status === 'validating' ? 'validating' : 'building'} for ${duration(Date.now() - since)}`;
  }
  if (p === 'failed' || p === 'update-failed') return `build failed ${b?.finishedAt ? timeAgo(b.finishedAt) : ''}`.trim();
  return e.lastSuccessfulBuildAt ? `built ${timeAgo(e.lastSuccessfulBuildAt)}` : 'not built yet';
}

// ---- The side list -----------------------------------------------------------------------------

export function envRows(view: View, go: Go): HTMLElement[] {
  const s = store.factory.environments;
  const instances = store.factory.computers.instances;
  const overview = h(
    'li.list-row',
    { role: 'option', tabindex: 0, 'aria-selected': String(view.kind === 'envs'), class: view.kind === 'envs' ? 'on' : '', title: 'What Environments are, and the computers started from them' },
    h('span.list-icon', {}, '▦'),
    h('span.list-main', {}, h('span.list-title', {}, 'Overview'), h('span.list-meta', {}, `${instances.length} instance${instances.length === 1 ? '' : 's'} running`)),
  );
  onPick(overview, () => go({ kind: 'envs' }));
  let items: HTMLElement[];
  if (!s.fetchedAt && !s.items.length) items = s.error ? [h('li.note.bad', {}, s.error)] : [0, 1].map(() => h('li.skeleton.cmp-skeleton', { 'aria-hidden': 'true' }));
  else if (!s.items.length) items = [h('li.empty-state.cmp-side-empty', {}, h('b', {}, 'No Environments yet'), h('p', {}, 'Make one with + New Environment.'))];
  else
    items = [...s.items]
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
      .map((e) => {
        const on = (view.kind === 'env' || view.kind === 'env-edit') && view.id === e.id;
        const n = computersFrom(e.id).length;
        const meta = [e.scope === 'organization' ? 'organization' : 'just you', `${e.repositories.length} repo${e.repositories.length === 1 ? '' : 's'}`, buildLine(e), n ? `${n} computer${n === 1 ? '' : 's'}` : '']
          .filter(Boolean)
          .join(' · ');
        const li = h(
          'li.list-row',
          { role: 'option', tabindex: 0, 'aria-selected': String(on), class: on ? 'on' : '', title: `Open ${e.name}` },
          h('span.list-icon', { 'aria-hidden': 'true' }, '⧉'),
          h('span.list-main', {}, h('span.list-title', { title: e.name }, e.name, e.isDefault ? h('span.env-default', { title: 'The organization’s default Environment' }, ' ★') : ''), h('span.list-meta', { title: meta }, meta)),
          h('span.list-end', {}, envPill(environmentPhase(e))),
        );
        onPick(li, () => go({ kind: 'env', id: e.id }));
        return li;
      });
  return [overview, h('li.cmp-list-label', { role: 'presentation' }, 'Environments'), ...items];
}

// ---- The overview ------------------------------------------------------------------------------

/** A computer started from an Environment, as a row with who uses it and a delete. */
function instanceRow(c: FactoryComputer, out: HTMLElement, go: Go): HTMLElement {
  const w = workerOn(c.id);
  const meta = [c.unlisted ? 'unlisted' : 'listed', c.status, c.createdAt ? `made ${timeAgo(c.createdAt)}` : '', w ? `${w.name} works on it` : ''].filter(Boolean).join(' · ');
  const del = actionButton(
    'Delete',
    `Delete ${c.name}`,
    async () => {
      const why = w ? `${w.name} works on it: deleting it ends ${w.name}’s session. ` : '';
      if (!confirm(`Delete ${c.name}? ${why}Its sessions are archived. This can’t be undone.`)) return undefined;
      await factoryFetch('computers', `/${encodeURIComponent(c.id)}`, { method: 'DELETE', body: { confirm: c.name } });
      return `Deleted ${c.name}.`;
    },
    out,
    'danger sm',
  );
  const open = !c.unlisted ? h('button.btn.ghost.sm', { type: 'button', title: `Open ${c.name} in the Computers tab`, onclick: () => go({ kind: 'detail', id: c.id }) }, 'Open') : null;
  return h(
    'li.list-row.env-instance',
    {},
    h('span.list-icon', { 'aria-hidden': 'true' }, '☁'),
    h('span.list-main', {}, h('span.list-title', { title: c.name }, c.name), h('span.list-meta', { title: meta }, meta)),
    h('span.list-end', {}, open, del),
  );
}

export function envOverview(go: Go): Section {
  const out = h('p.cmp-out', { role: 'status' });
  const groups = h('div.stack');
  const compare = h(
    'div.env-compare',
    {},
    h(
      'div.env-compare-col',
      {},
      h('div.eyebrow', {}, '⧉ An Environment'),
      h('p.cmp-lede', {}, 'A recipe Factory builds and checks once: a base image, your repositories with their install scripts, and a machine setup script. It runs nothing itself.'),
    ),
    h(
      'div.env-compare-col',
      {},
      h('div.eyebrow', {}, '☁ A Droid Computer'),
      h('p.cmp-lede', {}, 'A machine that runs sessions. Started from an Environment, it’s ready in seconds with everything installed, where a plain one clones and installs as it’s made.'),
    ),
  );
  const how = h(
    'p.cmp-muted',
    {},
    'Hire a cloud worker on an Environment (Runs on in the hire dialog) and it gets a fresh unlisted computer of its own, which is deleted when it goes home. Factory’s web app starts its sessions on one the same way.',
  );
  const render = () => {
    const envs = store.factory.environments;
    const inst = [...store.factory.computers.items, ...store.factory.computers.instances].filter((c) => c.environmentId);
    const known = new Set(envs.items.map((e) => e.id));
    const byEnv = new Map<string, FactoryComputer[]>();
    for (const c of inst) byEnv.set(c.environmentId!, [...(byEnv.get(c.environmentId!) ?? []), c]);
    const blocks: HTMLElement[] = [];
    for (const e of envs.items) {
      const list = byEnv.get(e.id);
      if (!list?.length) continue;
      blocks.push(
        h(
          'section.section',
          {},
          h('div.row.between.cmp-section-head', {}, h('div.eyebrow', {}, `From ${e.name}`), h('button.btn.ghost.sm', { type: 'button', title: `Open ${e.name}`, onclick: () => go({ kind: 'env', id: e.id }) }, 'View Environment')),
          h('ul.list.boxed', {}, ...list.map((c) => instanceRow(c, out, go))),
        ),
      );
    }
    const orphans = inst.filter((c) => !known.has(c.environmentId!));
    if (orphans.length && envs.fetchedAt)
      blocks.push(
        h(
          'section.section',
          {},
          h('div.eyebrow.warn', {}, 'From an Environment that was deleted'),
          h('p.note.warn', {}, `${orphans.length === 1 ? 'This computer was' : 'These computers were'} started from an Environment that’s gone. ${orphans.length === 1 ? 'It keeps' : 'They keep'} running until deleted.`),
          h('ul.list.boxed', {}, ...orphans.map((c) => instanceRow(c, out, go))),
        ),
      );
    if (!blocks.length) blocks.push(h('p.cmp-muted', {}, envs.fetchedAt ? 'No computers started from an Environment right now.' : 'Reading your Environments…'));
    groups.replaceChildren(...blocks);
  };
  return {
    nodes: [h('div.stack.loose.cmp-pane-inner', {}, h('div.section', {}, h('div.eyebrow', {}, 'Environments and computers'), compare, how), h('div.section', {}, h('div.eyebrow', {}, 'Computers started from an Environment'), groups, out))],
    render,
  };
}

// ---- One Environment ---------------------------------------------------------------------------

/** Its latest build's stages, as Factory reports them: queued, building the image, validating, live. */
function buildSteps(b: FactoryEnvBuild | undefined): HTMLElement[] {
  if (!b) return [h('li.list-row.cmp-muted', {}, h('span.list-main', {}, h('span.list-meta', {}, 'No build yet.')))];
  const order = ['queued', 'building', 'validating', 'succeeded'];
  const at = b.status === 'failed' || b.status === 'superseded' ? -1 : order.indexOf(b.status);
  const failedAt = b.status === 'failed' ? (b.failureCategory === 'validation' ? 2 : b.startedAt ? 1 : 0) : -1;
  const stage = (i: number, name: string, took: string) => {
    const state = failedAt === i ? 'bad' : b.status === 'superseded' ? 'wait' : at > i || (at === i && i === 3) ? 'ok' : at === i ? 'run' : failedAt > i ? 'ok' : 'wait';
    return h(
      'li.list-row.cmp-step',
      { class: state },
      h('span.list-icon.mark', {}, state === 'ok' ? '✓' : state === 'bad' ? '✗' : state === 'run' ? '…' : '○'),
      h('span.list-main', {}, h('span.list-title', {}, name), state === 'bad' && b.failureReason ? h('span.list-meta.why', {}, b.failureReason) : null),
      h('span.list-end.took', {}, took),
    );
  };
  const end = b.finishedAt ?? Date.now();
  return [
    stage(0, 'Queued', b.startedAt ? duration(b.startedAt - b.createdAt) : ''),
    stage(1, 'Building the image', b.startedAt ? duration(end - b.startedAt) : ''),
    stage(2, 'Validating: Droid, repositories, git and gh', ''),
    stage(3, b.status === 'superseded' ? 'Superseded by a newer build' : 'Live: new computers start from it', b.promotedAt ? timeAgo(b.promotedAt) : ''),
  ];
}

/** A build log as lines, with Factory's validation passes and failures picked out. */
function logLines(text: string): HTMLElement[] {
  return text
    .split('\n')
    .map((line) => h('span.env-log-line', { class: /\b(failed|error|EACCES|denied)\b/i.test(line) ? 'bad' : /\bpassed\b|Build finished|completed$/.test(line) ? 'ok' : /^\[validation\]/.test(line) ? 'val' : '' }, `${line}\n`));
}

export function envDetail(id: string, go: Go): Section {
  const titleEl = h('h3.cmp-title');
  const badges = h('div.row.cmp-badges');
  const idEl = h('span.cmp-id', { title: 'Its id in Factory' });
  const facts = h('dl.cmp-facts');
  const out = h('p.cmp-out', { role: 'status' });
  const failure = h('p.note.bad.hidden', { role: 'alert' });
  const pending = h('p.note.info.hidden');
  const env = () => store.factory.environments.items.find((e) => e.id === id);

  const startOne = h('button.btn.primary.sm', { type: 'button', title: 'Make a listed Droid Computer from this Environment', onclick: () => go({ kind: 'new', environmentId: id }) }, '+ Computer from it');
  const rebuild = actionButton(
    'Rebuild',
    'Build it again: the repositories at their newest commits, and its scripts',
    async () => {
      await call(id, '/rebuild');
      return 'Building. New computers keep starting from the last good build until this one passes.';
    },
    out,
    'sm',
  );
  const cancel = actionButton(
    'Stop build',
    'Stop the build that’s running',
    async () => {
      if (!confirm(`Stop ${env()?.name ?? 'its'} build?`)) return undefined;
      await call(id, '/cancel');
      return 'Stopping the build.';
    },
    out,
    'sm',
  );
  const makeDefault = actionButton(
    'Make default',
    'Make this the organization’s default Environment',
    async () => {
      await factoryFetch('environments', '/default', { method: 'PUT', body: { environmentId: id } });
      return `${env()?.name ?? 'It'} is the default now.`;
    },
    out,
    'sm',
  );
  const edit = h('button.btn.sm', { type: 'button', title: 'Change its repositories, scripts or name', onclick: () => go({ kind: 'env-edit', id }) }, 'Edit');
  const actions = h('div.row.wrap.cmp-actions', {}, startOne, rebuild, cancel, makeDefault, edit);
  const head = h('div.cmp-head', {}, h('div.row.between.cmp-head-row', {}, h('div.cmp-head-title', {}, titleEl, badges), idEl), actions);

  const steps = h('ol.list.boxed.cmp-steps');
  const stepsCard = h('section.section', {}, h('div.eyebrow', {}, 'Latest build'), steps);

  // The log: read when the pane opens, and every few seconds while it builds.
  const log = h('pre.env-log', { tabindex: 0, 'aria-label': 'Build log' });
  const logNote = h('p.field-hint');
  let logTimer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;
  const readLog = async () => {
    clearTimeout(logTimer);
    try {
      const r = await factoryFetch<{ log: FactoryEnvLog | null }>('environments', `/${encodeURIComponent(id)}/log`);
      if (gone) return;
      const l = r.log;
      if (!l) log.replaceChildren(h('span.env-log-line', {}, 'No log yet.'));
      else if (l.withheld) log.replaceChildren(h('span.env-log-line', {}, 'Factory held this build’s log back.'));
      else {
        const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
        log.replaceChildren(...logLines(l.excerpt.trimEnd() || '(empty)'));
        if (stick) log.scrollTop = log.scrollHeight;
      }
      logNote.textContent = `${l?.truncated ? 'The last few thousand characters of the log' : 'The whole log'}. Factory masks secrets in it.`;
    } catch (err) {
      if (!gone) log.replaceChildren(h('span.env-log-line.bad', {}, `Couldn’t read the log: ${(err as Error).message}`));
    }
    if (!gone && buildRunning(env()?.latestBuild)) logTimer = setTimeout(() => void readLog(), 5000);
  };
  const refreshLog = h('button.btn.ghost.sm', { type: 'button', onclick: () => void readLog() }, 'Refresh');
  const logCard = h('section.section', {}, h('div.row.between.cmp-section-head', {}, h('div.eyebrow', {}, 'Build log'), refreshLog), log, logNote);

  const instOut = h('p.cmp-out', { role: 'status' });
  const instances = h('ul.list.boxed');
  const instCard = h('section.section', {}, h('div.eyebrow', {}, 'Computers started from it'), instances, instOut);

  const scripts = h('div.stack.tight');
  const scriptsCard = h('section.section', {}, h('div.row.between.cmp-section-head', {}, h('div.eyebrow', {}, 'Scripts'), h('button.btn.ghost.sm', { type: 'button', onclick: () => go({ kind: 'env-edit', id }) }, 'Edit')), scripts);

  const confirmIn = h('input.input', { type: 'text', 'aria-label': 'Type the Environment’s name to delete it', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const delOut = h('p.cmp-out');
  const del = actionButton(
    'Delete',
    'Delete this Environment for good',
    async () => {
      await call(id, '', { method: 'DELETE', body: { confirm: confirmIn.value.trim() } });
      toast(`Deleted ${confirmIn.value.trim()}`);
      go({ kind: 'envs' });
      return undefined;
    },
    delOut,
    'danger',
  );
  const dangerNote = h('p.cmp-lede');
  const danger = h('section.section.cmp-danger', {}, h('div.eyebrow', {}, 'Delete'), dangerNote, h('div.cmp-inline-form.two', {}, confirmIn, del), delOut);
  confirmIn.addEventListener('input', () => (del.disabled = confirmIn.value.trim() !== env()?.name));

  const body = [facts, actions, failure, pending, stepsCard, logCard, instCard, scriptsCard, danger];
  let lastBuild = '';
  let scriptsKey = '';
  const render = () => {
    const s = store.factory.environments;
    const e = env();
    if (!e) {
      titleEl.textContent = s.fetchedAt ? 'That Environment isn’t there any more.' : 'Reading it…';
      badges.replaceChildren();
      idEl.textContent = '';
      for (const n of body) n.classList.add('hidden');
      return;
    }
    for (const n of body) n.classList.remove('hidden');
    const phase = environmentPhase(e);
    const b = e.latestBuild;
    titleEl.textContent = e.name;
    titleEl.title = e.name;
    badges.replaceChildren(
      envPill(phase),
      h('span.cmp-tag', {}, e.scope === 'organization' ? 'Organization' : 'Just you'),
      e.isDefault ? h('span.cmp-tag.here', { title: 'Factory starts sessions here unless told otherwise' }, '★ Default') : '',
    );
    idEl.textContent = e.id;
    const fact = (k: string, v: string | Node, cls = '') => [h('div.cmp-fact', { class: cls }, h('dt', {}, k), h('dd', {}, v))];
    const ran = b?.startedAt && b.finishedAt ? duration(b.finishedAt - b.startedAt) : '';
    facts.replaceChildren(
      ...fact('Status', `${ENV_PHASE_WORD[phase]} · ${buildLine(e)}`),
      ...fact('Built on', sourceName(e.source) || '—'),
      ...fact('Last build', b ? [b.trigger ? (TRIGGER_WORD[b.trigger] ?? b.trigger) : 'Build', ran ? `took ${ran}` : '', b.createdAt ? timeAgo(b.createdAt) : ''].filter(Boolean).join(' · ') : '—'),
      ...fact('Created', e.createdAt ? `${new Date(e.createdAt).toLocaleDateString()} (${timeAgo(e.createdAt)})` : '—'),
      ...fact(
        'Repositories',
        e.repositories.length
          ? h(
              'span.cmp-codes',
              {},
              ...e.repositories.map((r) => {
                const at = b?.repos.find((x) => x.url === r.url);
                return h('code', { title: at ? `${r.url} at ${at.branch} ${at.commit}` : r.url }, `${shortRepo(r.url)}${at?.commit ? ` @ ${at.commit.slice(0, 7)}` : ''}`);
              }),
            )
          : 'None',
        'wide',
      ),
    );
    const failing = phase === 'failed' || phase === 'update-failed';
    failure.textContent = failing
      ? `${phase === 'update-failed' ? 'The latest build failed, so new computers still start from the last good one. ' : 'It has never built, so nothing can start from it yet. '}${b?.failureReason ?? e.failureReason ?? 'The log below says why.'}`
      : '';
    failure.classList.toggle('hidden', !failing);
    pending.textContent = unbuiltChanges(e) && !buildRunning(b) ? 'Its saved repositories differ from what the live build has: Rebuild to use them.' : '';
    pending.classList.toggle('hidden', !pending.textContent);
    startOne.toggleAttribute('disabled', !canStartFrom(e));
    rebuild.classList.toggle('hidden', buildRunning(b));
    cancel.classList.toggle('hidden', !buildRunning(b));
    makeDefault.classList.toggle('hidden', e.isDefault);
    steps.replaceChildren(...buildSteps(b));
    // A new build, or one that just ended: read its log again.
    const buildKey = `${b?.id}:${b?.status}`;
    if (buildKey !== lastBuild) {
      lastBuild = buildKey;
      void readLog();
    }
    const from = computersFrom(e.id);
    instances.replaceChildren(...(from.length ? from.map((c) => instanceRow(c, instOut, go)) : [h('li.list-row.cmp-muted', {}, h('span.list-main', {}, h('span.list-meta', {}, 'None right now.')))]));
    const key = JSON.stringify([e.setupScript, e.repositories]);
    if (key !== scriptsKey) {
      scriptsKey = key;
      const block = (label: string, text: string) =>
        h('details.env-script', {}, h('summary', {}, label, h('span.env-script-size', {}, text.trim() ? `${text.split('\n').length} lines` : 'empty')), h('pre.env-code', {}, text.trim() || '(empty)'));
      scripts.replaceChildren(block('Machine setup script', e.setupScript), ...e.repositories.map((r) => block(`${shortRepo(r.url)} install script`, r.script)));
    }
    dangerNote.textContent = `Deleting ${e.name} can’t be undone. Computers already started from it keep running until you delete them. Type its name to delete it.`;
    confirmIn.placeholder = e.name;
    del.disabled = confirmIn.value.trim() !== e.name;
  };
  return {
    nodes: [h('div.stack.loose.cmp-pane-inner', {}, h('div.stack.tight', {}, head, out), ...body.filter((n) => n !== actions))],
    render,
    dispose: () => {
      gone = true;
      clearTimeout(logTimer);
    },
  };
}

// ---- A new Environment, or one edited ----------------------------------------------------------

export function envForm(go: Go, id?: string): Section {
  const was = id ? store.factory.environments.items.find((e) => e.id === id) : undefined;
  const nameIn = h('input.input', {
    type: 'text',
    'aria-label': 'Name',
    maxlength: ENV_NAME_MAX,
    spellcheck: 'false',
    value:
      was?.name ??
      `${floorSlug()
        .slice(0, ENV_NAME_MAX - 4)
        .replace(/-+$/, '')}-env`,
  }) as HTMLInputElement;
  const scope = choices(
    'env-scope',
    [
      { value: 'organization', title: 'Organization', description: 'Everyone in it can start computers from it', icon: '🏢' },
      { value: 'user', title: 'Just you', description: 'Only your sessions see it', icon: '👤' },
    ],
    'organization',
  );
  // Ticked for the first one, which is only known once the list has loaded, unless the owner set it.
  let defaultSet = false;
  const defaultToggle = toggle({ label: 'Make it the organization’s default', description: 'Factory starts sessions on it unless told otherwise.', checked: !store.factory.environments.items.length, onChange: () => (defaultSet = true) });
  const setup = h('textarea.input.env-code-in', {
    rows: 10,
    spellcheck: 'false',
    'aria-label': 'Machine setup script',
    placeholder: 'sudo apt-get install -y jq\nnpm install -g agent-browser',
    maxlength: ENV_SCRIPT_MAX,
  }) as HTMLTextAreaElement;
  setup.value = was?.setupScript ?? '';
  const setupCount = h('span.env-count');
  const counted = (ta: HTMLTextAreaElement, el: HTMLElement) => {
    const paint = () => {
      el.textContent = `${ta.value.length.toLocaleString()} / ${ENV_SCRIPT_MAX.toLocaleString()}`;
      el.classList.toggle('bad', ta.value.length > ENV_SCRIPT_MAX * 0.95);
    };
    ta.addEventListener('input', paint);
    paint();
  };
  counted(setup, setupCount);

  // Repositories, each with its install script (kept while it's unticked, in case it's ticked again).
  const picked = new Set<string>((was?.repositories ?? []).map((r) => r.url));
  const here = floorRepo();
  if (!was && here) picked.add(`https://github.com/${here}`);
  const scriptsByUrl = new Map<string, { ta: HTMLTextAreaElement; count: HTMLElement }>();
  const repoScripts = h('div.stack.tight');
  const scriptFor = (url: string) => {
    let script = scriptsByUrl.get(url);
    if (!script) {
      const ta = h('textarea.input.env-code-in', { rows: 4, spellcheck: 'false', 'aria-label': `Install script for ${shortRepo(url)}`, placeholder: 'npm ci', maxlength: ENV_SCRIPT_MAX }) as HTMLTextAreaElement;
      ta.value = was?.repositories.find((r) => r.url === url)?.script ?? '';
      script = { ta, count: h('span.env-count') };
      counted(ta, script.count);
      scriptsByUrl.set(url, script);
    }
    return script;
  };
  const paintScripts = () => {
    repoScripts.replaceChildren(
      ...(picked.size
        ? [...picked].map((url) => {
            const { ta, count } = scriptFor(url);
            return h('div.field', {}, h('label.env-script-label', {}, h('span', {}, `${shortRepo(url)} · runs in its clone`), count), ta);
          })
        : [h('p.cmp-muted', {}, 'No repositories: computers from it start with none cloned.')]),
    );
  };
  const picker = repoPicker(picked, paintScripts);
  paintScripts();

  const out = h('p.cmp-out', { role: 'status' });
  const repositories = (): FactoryEnvRepo[] => [...picked].map((url) => ({ url, script: scriptFor(url).ta.value }));
  const save = actionButton(
    was ? 'Save' : 'Create',
    was ? 'Save it; a change to its repositories or scripts starts a build' : 'Make it in Factory and start its first build',
    async () => {
      const name = nameIn.value.trim();
      if (!ENV_NAME.test(name)) throw new Error('The name is lower-case letters, digits and hyphens, starting with a letter and not ending with a hyphen');
      if (!was) {
        const r = await factoryFetch<{ id: string | null }>('environments', '', { method: 'POST', body: { name, scope: scope.value(), makeDefault: defaultToggle.input.checked, setupScript: setup.value, repositories: repositories() } });
        go(r.id ? { kind: 'env', id: r.id } : { kind: 'envs' });
        return undefined;
      }
      const body: Record<string, unknown> = {};
      if (name !== was.name) body.name = name;
      const repos = repositories();
      const key = (rs: FactoryEnvRepo[]) => JSON.stringify(rs.map((r) => [r.url, r.script]).sort());
      if (key(repos) !== key(was.repositories)) body.repositories = repos;
      if (setup.value !== was.setupScript) body.setupScript = setup.value;
      if (!Object.keys(body).length) return 'Nothing changed.';
      await factoryFetch('environments', `/${encodeURIComponent(was.id)}`, { method: 'PATCH', body });
      go({ kind: 'env', id: was.id });
      return undefined;
    },
    out,
    'primary',
  );
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => go(was ? { kind: 'env', id: was.id } : { kind: 'envs' }) }, 'Cancel');
  const source = h('p.field-hint');
  const render = () => {
    if (!was && !defaultSet && store.factory.environments.fetchedAt) defaultToggle.input.checked = !store.factory.environments.items.length;
    const src = was?.source ?? store.factory.environments.sources[0];
    source.textContent = src ? `Built on ${sourceName(src)}: Ubuntu with Node, Python, git, gh and Droid, as factory-user with sudo.` : '';
  };
  return {
    nodes: [
      h(
        'div.stack.loose.cmp-pane-inner',
        {},
        h(
          'div.section',
          {},
          h('div.eyebrow', {}, was ? `Edit ${was.name}` : 'New Environment'),
          h(
            'p.cmp-lede',
            {},
            was
              ? 'Saving a change to its repositories or scripts starts a new build. Computers keep starting from the last good build until the new one passes.'
              : 'Factory builds it once: the base image, then your setup script, then each repository cloned and its install script run in the clone. It checks the result works before any computer starts from it.',
          ),
          source,
        ),
        h('div.stack', {}, field('Name', nameIn, 'Lower-case letters, digits and hyphens.'), ...(was ? [] : [h('div.field', {}, h('label', {}, 'Who sees it'), scope), defaultToggle])),
        h('div.field', {}, h('label', {}, 'Repositories'), ...picker.nodes),
        h('div.section', {}, h('div.eyebrow', {}, 'Install scripts'), repoScripts),
        h('div.field', {}, h('label.env-script-label', {}, h('span', {}, 'Machine setup script · runs first, from the home folder, under bash -euo pipefail'), setupCount), setup),
        out,
      ),
    ],
    footer: [cancel, save],
    render,
  };
}
