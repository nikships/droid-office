import { capabilityOf } from '../../shared/factory';
import {
  CI_EVENTS,
  CI_KIND_LABEL,
  CI_REVIEW_PATH,
  ciEditProblem,
  ciOutcome,
  customWorkflowPath,
  groupCi,
  runTime,
  triggerLabel,
  type CiEditRequest,
  type CiEditResult,
  type CiEvent,
  type CiKind,
  type CiOutcome,
  type CiRepoGroup,
  type CiRepository,
  type FactoryCiJob,
  type FactoryCiRun,
  type FactoryCiWorkflow,
} from '../../shared/factory-ci';
import { factoryFetch, refreshFactory, watchFactory } from '../factory';
import { store } from '../state';
import { h, openModal, timeAgo, toast, type Modal } from './dom';
import { emptyState, field, toggle } from './kit';
import { confirmDialog } from './prompt';

// The CI automations window, from the board on the north wall (world/factory-ci.ts): every Droid
// workflow Factory found in the account's GitHub repositories with all it knows about each, their
// runs, the workflow pull requests opened through Factory, and adding, changing or removing a
// workflow, which Factory does by opening a pull request.

type Tab = 'workflows' | 'runs' | 'prs';

const OUTCOME_WORD: Record<CiOutcome, string> = { pass: 'passed', fail: 'failed', running: 'running', skipped: 'skipped', unknown: 'finished' };
/** The model aliases Factory's droid-action takes, for the model field's suggestions. */
const MODEL_ALIASES = [
  'anthropic-latest-premium',
  'anthropic-latest-balanced',
  'anthropic-latest-fast',
  'openai-latest-premium',
  'openai-latest-balanced',
  'openai-latest-fast',
  'oss-latest-premium',
  'oss-latest-balanced',
  'oss-latest-fast',
];
const EFFORTS = ['', 'low', 'medium', 'high'];
/** A workflow's GitHub events as the edit's trigger ids, to fill in Change. */
const EVENT_OF_TRIGGER: Record<string, CiEvent> = { pull_request: 'pull-request', pull_request_target: 'pull-request', issue_comment: 'comment-added', push: 'push', check_run: 'checks-completed' };

const github = (repo: string, rest = '') => `https://github.com/${repo}${rest}`;
const link = (href: string | undefined, text: string, cls = '') => (href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls || undefined }, text) : h('span', { class: cls || undefined }, text));
const fileOf = (path: string) => path.split('/').pop() ?? path;

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Whether Factory can change `w` in place: one of the files its own templates write. */
export function ciEditable(w: Pick<FactoryCiWorkflow, 'path'>, kind: CiKind): 'code-review' | 'custom' | undefined {
  if (w.path === CI_REVIEW_PATH && kind === 'review') return 'code-review';
  if (/^\.github\/workflows\/factory-[a-z0-9-]+\.ya?ml$/.test(w.path)) return 'custom';
  return undefined;
}

const READING = 'Reading Factory…';

/** What the window says instead of the workflows when it can't show them, or undefined. */
function blocked(): string | undefined {
  const c = store.factory.connection;
  const ci = store.factory.ci;
  if (!c.connected) return 'Connect Factory in ⚙️ Settings → Factory to see the Droid workflows in your repositories.';
  if (c.rejected) return `Factory turned the key down (${c.rejected}). Check it again in ⚙️ Settings → Factory.`;
  const cap = capabilityOf(c, 'ci');
  if (cap?.status === 'denied') return `The key can’t read CI automations: ${cap.reason ?? 'no access'}.`;
  if (!ci.fetchedAt) return READING;
  if (ci.github === false) return 'Factory’s GitHub integration isn’t connected. Connect it in Factory’s settings (app.factory.ai → Settings → Integrations), then Rescan.';
  return undefined;
}

/** The open window, and how to bring it to its add form. */
let open: { modal: Modal; add: () => void } | undefined;

/**
 * Opens the CI automations window (or brings the open one to `add`). `floorRepo` is this floor's
 * GitHub repository: its workflows come first, and a new workflow goes there unless you pick another.
 */
export function openCiWindow(opts: { floorRepo?: string; add?: boolean } = {}): Modal {
  if (open) {
    if (opts.add) open.add();
    return open.modal;
  }
  let tab: Tab = 'workflows';
  /** The add or change form, while it's open, and its Cancel and submit buttons for the footer. */
  let form: HTMLElement | undefined;
  let formActions: HTMLElement[] = [];
  let done: CiEditResult | undefined;
  let rescanning = false;

  const status = h('p.sub.ci-status');
  const rescan = h('button.btn.sm', { type: 'button', title: 'Look through the repositories again now, past Factory’s 30-minute cache' }, 'Rescan') as HTMLButtonElement;
  const tabButtons: Record<Tab, HTMLButtonElement> = {
    workflows: h('button.tab', { type: 'button', role: 'tab' }) as HTMLButtonElement,
    runs: h('button.tab', { type: 'button', role: 'tab' }) as HTMLButtonElement,
    prs: h('button.tab', { type: 'button', role: 'tab' }) as HTMLButtonElement,
  };
  const tabs = h('nav.tabs.ci-tabs', { role: 'tablist' }, tabButtons.workflows, tabButtons.runs, tabButtons.prs);
  const notice = h('div.note.good.ci-notice', { role: 'status' });
  const body = h('div.body.ci-body');
  const note = h('span.grow');
  const add = h('button.btn.primary', { type: 'button' }, '+ Add a workflow') as HTMLButtonElement;
  const footActions = h('div.row.ci-foot-actions');
  const el = h(
    'div.modal.xl.ci-window',
    { role: 'dialog', 'aria-label': 'CI automations' },
    h('header', {}, h('div.titles', {}, h('h2', {}, 'CI automations'), status), h('div.actions', {}, rescan)),
    tabs,
    notice,
    body,
    h('footer', {}, note, footActions),
  );

  const paintNotice = () => {
    notice.replaceChildren();
    notice.classList.toggle('hidden', !done);
    if (!done) return;
    notice.append(
      done.prUrl
        ? h('span', {}, 'Factory opened ', link(done.prUrl, done.prUrl.replace(/^https:\/\/github\.com\//, '')), ` for ${fileOf(done.path)}. It takes effect once that pull request merges.`)
        : h('span', {}, `${done.message ?? 'Done'} (${fileOf(done.path)} in ${done.repo}).`),
      h('button.btn.icon.sm.ghost.ci-dismiss', { type: 'button', 'aria-label': 'Dismiss', onclick: () => ((done = undefined), paintNotice()) }, '✕'),
    );
  };

  const paint = () => {
    const ci = store.factory.ci;
    const groups = groupCi(ci, opts.floorRepo);
    const runs = [...ci.runs].sort((a, b) => runTime(b) - runTime(a));
    tabButtons.workflows.replaceChildren('Workflows', h('span.n', {}, ci.workflows.length));
    tabButtons.runs.replaceChildren('Runs', h('span.n', {}, runs.length));
    tabButtons.prs.replaceChildren('Workflow PRs', h('span.n', {}, ci.jobs.length));
    for (const [t, b] of Object.entries(tabButtons)) {
      b.classList.toggle('on', !form && t === tab);
      b.setAttribute('aria-selected', String(!form && t === tab));
    }
    const why = blocked();
    status.textContent = ci.error ? ci.error : ci.scannedAt ? `Scanned ${timeAgo(ci.scannedAt)}` : 'Droid in GitHub Actions, from Factory';
    status.title = status.textContent;
    status.classList.toggle('bad', !!ci.error);
    rescan.disabled = rescanning || !!why;
    rescan.textContent = rescanning ? 'Scanning…' : 'Rescan';
    add.disabled = !!why || ci.github === false;
    footActions.replaceChildren(...(form ? formActions : [add]));
    const owners = ci.owners.map((o) => o.login).join(', ');
    note.textContent = form ? '' : ci.fetchedAt ? `Read ${timeAgo(ci.fetchedAt)}${owners ? ` · GitHub: ${owners}` : ''}` : '';
    paintNotice();
    if (form) return;
    if (why === READING) return body.replaceChildren(...[0, 1, 2, 3].map(() => h('div.skeleton.ci-skeleton', { 'aria-label': READING })));
    if (why) return body.replaceChildren(empty('🏭', ci.github === false ? 'GitHub isn’t connected' : 'Nothing to show yet', why));
    if (tab === 'workflows') body.replaceChildren(...(groups.length ? groups.map((g) => repoSection(g)) : [empty('🤖', 'No Droid workflows yet', 'Add one, and Factory opens a pull request with it.')]));
    else if (tab === 'runs') body.replaceChildren(runs.length ? runsTable(runs) : empty('▶', 'No runs yet', 'A run shows here once a Droid workflow runs in GitHub Actions.'));
    else body.replaceChildren(ci.jobs.length ? jobsList(ci.jobs) : empty('⇄', 'No workflow pull requests yet', 'Adding, changing or removing a workflow here opens one.'));
  };

  const empty = (icon: string, title: string, text: string) => emptyState(icon, title, text);

  const repoSection = (g: CiRepoGroup) =>
    h(
      'section.section.ci-repo',
      { class: g.here ? 'here' : undefined },
      h(
        'div.row.between.ci-repo-head',
        {},
        h('h3.row', {}, link(github(g.repo), g.repo, 'ci-repo-name'), g.here ? h('span.ci-here', {}, 'this floor') : null),
        h('button.btn.sm', { type: 'button', onclick: () => startForm({ repo: g.repo }) }, '+ Add'),
      ),
      g.workflows.length ? h('ul.list.boxed.ci-workflows', {}, ...g.workflows.map((x) => workflowCard(x.workflow, x.kind, x.latest))) : h('p.ci-none', {}, 'No Droid workflows here yet.'),
    );

  const workflowCard = (w: FactoryCiWorkflow, kind: CiKind, latest?: FactoryCiRun) => {
    const editable = ciEditable(w, kind);
    const facts: [string, Node | string][] = [
      ['File', link(w.url, w.path)],
      ['Runs on', w.triggers.length ? w.triggers.map(triggerLabel).join(', ') : 'nothing listed'],
    ];
    if (w.cron) facts.push(['Schedule', `${w.cron} (UTC)`]);
    if (w.model) facts.push(['Model', w.model]);
    for (const [k, v] of Object.entries(w.inputs)) facts.push([k, String(v)]);
    if (w.templateId) facts.push(['Template', w.templateId]);
    if (w.author) facts.push(['Last change by', w.authorName ? `${w.authorName} (@${w.author})` : `@${w.author}`]);
    if (w.permission) facts.push(['Your access', w.permission]);
    if (w.sha) facts.push(['Blob', w.sha.slice(0, 7)]);
    const outcome = latest && ciOutcome(latest);
    const change = h('button.btn.sm', { type: 'button', disabled: !editable, title: editable ? 'Change it with a pull request' : 'Factory changes only the files its templates write; change this one on GitHub' }, 'Change');
    change.addEventListener('click', () => startForm({ workflow: w, kind }));
    const remove = h('button.btn.sm.danger', { type: 'button', title: 'Remove it with a pull request that deletes the file' }, 'Remove');
    remove.addEventListener('click', () =>
      confirmDialog('Remove this workflow?', `Factory opens a pull request in ${w.repo} that deletes ${w.path}. Droid stops running there once it merges.`, 'Open the pull request', () =>
        send({ action: 'delete', repo: w.repo, path: w.path }, remove),
      ),
    );
    return h(
      'li.list-row.ci-workflow',
      {},
      h(
        'div.list-main',
        {},
        h('div.list-title.ci-wf-title', {}, h('span.ci-kind', { class: kind }, CI_KIND_LABEL[kind]), h('span.ci-wf-name', { title: w.name }, w.name)),
        latest && outcome
          ? h('div.list-meta.ci-latest', {}, h('span.pill', { class: `ci-${outcome}` }, OUTCOME_WORD[outcome]), link(latest.url, latest.title ?? latest.workflow ?? `Run ${latest.id}`), h('span', {}, timeAgo(runTime(latest))))
          : h('div.list-meta.ci-latest', {}, 'No runs seen yet.'),
        h('dl.ci-facts', {}, ...facts.map(([k, v]) => h('div.ci-fact', {}, h('dt', {}, k), h('dd', {}, v)))),
      ),
      h('div.list-end.ci-wf-actions', {}, change, remove),
    );
  };

  const runsTable = (runs: FactoryCiRun[]) =>
    h(
      'table.ci-runs',
      {},
      h('thead', {}, h('tr', {}, ...['Result', 'Workflow', 'Repository', 'Event', 'For', 'Started', 'Took'].map((c) => h('th', {}, c)))),
      h(
        'tbody',
        {},
        ...runs.map((r) => {
          const o = ciOutcome(r);
          const word = r.conclusion ?? r.status ?? OUTCOME_WORD[o];
          const what = r.pr ? link(r.pr.url ?? (r.repo ? github(r.repo, `/pull/${r.pr.number}`) : undefined), `PR #${r.pr.number}`) : r.sha && r.repo ? link(github(r.repo, `/commit/${r.sha}`), r.sha.slice(0, 7)) : (r.branch ?? '');
          return h(
            'tr',
            {},
            h('td', {}, h('span.pill', { class: `ci-${o}` }, word.replace(/_/g, ' '))),
            h('td', {}, link(r.url, r.workflow ?? r.path ?? r.id), r.title ? h('div.ci-sub', {}, r.title) : null),
            h('td', {}, r.repo ?? ''),
            h('td', {}, r.event ? triggerLabel(r.event) : ''),
            h('td', {}, what, r.branch && r.pr ? h('div.ci-sub', {}, r.branch) : null),
            h('td', {}, runTime(r) ? timeAgo(runTime(r)) : ''),
            h('td', {}, r.durationMs !== undefined ? duration(r.durationMs) : o === 'running' ? '…' : ''),
          );
        }),
      ),
    );

  const jobsList = (jobs: FactoryCiJob[]) =>
    h(
      'ul.list.boxed.ci-jobs',
      {},
      ...jobs.map((j) =>
        h(
          'li.list-row',
          {},
          h(
            'span.list-main',
            {},
            h('span.list-title.ci-wf-title', {}, h('span.ci-kind', {}, j.action === 'create' ? 'Add' : j.action === 'delete' ? 'Remove' : 'Change'), h('span.ci-job-what', {}, `${fileOf(j.path)} in ${j.repo}`)),
            j.error ? h('span.list-meta.bad', {}, j.error) : j.status ? h('span.list-meta', {}, j.status) : null,
          ),
          h('span.list-end', {}, j.prUrl ? link(j.prUrl, `PR #${j.prUrl.split('/').pop()}`) : null, h('span.ci-sub', {}, timeAgo(j.updatedAt ?? j.createdAt ?? 0))),
        ),
      ),
    );

  /** Sends an edit and says what came of it; `button` is busy meanwhile. */
  async function send(req: CiEditRequest, button: HTMLButtonElement, after?: () => void) {
    const problem = ciEditProblem(req);
    if (problem) return toast(problem, 'warn');
    const was = button.textContent;
    button.disabled = true;
    button.textContent = 'Opening the PR…';
    try {
      done = await factoryFetch<CiEditResult>('ci', '/edit', { method: 'POST', body: req });
      after?.();
      tab = 'workflows';
      paint();
    } catch (err) {
      toast(`Factory couldn’t do it: ${(err as Error).message}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = was;
    }
  }

  /** Opens the add form (on `repo`), or the change form for `workflow`. */
  function startForm(what: { repo?: string; workflow?: FactoryCiWorkflow; kind?: CiKind } = {}) {
    const w = what.workflow;
    const editing = w ? ciEditable(w, what.kind ?? 'custom') : undefined;
    const built = buildForm({ ...what, template: editing }, () => {
      form = undefined;
      paint();
    });
    form = built.el;
    formActions = built.actions;
    body.replaceChildren(form);
    paint();
    form.querySelector<HTMLElement>('select, input')?.focus();
  }

  function buildForm(what: { repo?: string; workflow?: FactoryCiWorkflow; template?: 'code-review' | 'custom' }, close: () => void): { el: HTMLElement; actions: HTMLElement[] } {
    const w = what.workflow;
    let template: 'code-review' | 'custom' = what.template ?? 'code-review';
    const repo = h('select.select', { 'aria-label': 'Repository', disabled: !!w }) as HTMLSelectElement;
    const repoNote = h('span');
    const pick = (fullName: string) => repo.append(h('option', { value: fullName }, fullName));
    const wanted = w?.repo ?? what.repo ?? opts.floorRepo;
    if (wanted) pick(wanted);
    if (!w) {
      repoNote.textContent = 'Loading the repositories Factory can see…';
      factoryFetch<{ repositories: CiRepository[] }>('ci', '/repositories')
        .then(({ repositories }) => {
          const chosen = repo.value;
          repo.replaceChildren();
          const names = repositories.filter((r) => r.writable).map((r) => r.fullName);
          if (chosen && !names.some((n) => n.toLowerCase() === chosen.toLowerCase())) names.unshift(chosen);
          for (const n of names) pick(n);
          const match = names.find((n) => n.toLowerCase() === chosen.toLowerCase());
          if (match) repo.value = match;
          repoNote.textContent = `${repositories.length} repositories Factory’s GitHub app can see.`;
        })
        .catch((err: Error) => {
          repoNote.textContent = `Couldn’t list the repositories: ${err.message}`;
        });
    }

    const kindRadio = (value: 'code-review' | 'custom', title: string, sub: string) => {
      const input = h('input', { type: 'radio', name: 'ci-template', value, checked: template === value, disabled: !!w }) as HTMLInputElement;
      input.addEventListener('change', () => {
        template = value;
        sync();
      });
      return h('label.choice', {}, input, h('span.choice-body', {}, h('b', {}, title), h('small', {}, sub)));
    };
    const name = h('input.input', { type: 'text', 'aria-label': 'Name', placeholder: 'Droid Code Review', value: w?.name ?? '', maxlength: '80' }) as HTMLInputElement;
    const given = new Set<CiEvent>(w ? w.triggers.map((t) => EVENT_OF_TRIGGER[t]).filter((e): e is CiEvent => !!e) : ['pull-request']);
    const events = CI_EVENTS.map((e) => {
      const label = toggle({ label: e.label, description: e.on, checked: given.has(e.id) });
      label.input.value = e.id;
      return { id: e.id, box: label.input, label };
    });
    const cron = h('input.input', { type: 'text', 'aria-label': 'Schedule', placeholder: 'none, or a cron like 0 9 * * 1', value: w?.cron ?? '' }) as HTMLInputElement;
    const depth = h('select.select', { 'aria-label': 'Review depth' }, h('option', { value: 'deep' }, 'Deep'), h('option', { value: 'shallow' }, 'Shallow')) as HTMLSelectElement;
    depth.value = w?.inputs.reviewDepth === 'shallow' ? 'shallow' : 'deep';
    const securityToggle = toggle({ label: 'Security review too', description: 'Factory’s security review runs alongside it', checked: w?.inputs.automaticSecurityReview === true });
    securityToggle.classList.add('ci-security');
    const security = securityToggle.input;
    const modelList = h('datalist', { id: 'ci-models' }, ...MODEL_ALIASES.map((m) => h('option', { value: m })));
    const model = h('input.input', { type: 'text', 'aria-label': 'Model', list: 'ci-models', placeholder: 'Factory’s default', value: w?.model ?? '' }) as HTMLInputElement;
    const effort = h('select.select', { 'aria-label': 'Reasoning effort' }, ...EFFORTS.map((e) => h('option', { value: e }, e || 'Default'))) as HTMLSelectElement;
    effort.value = typeof w?.inputs.reasoningEffort === 'string' && EFFORTS.includes(w.inputs.reasoningEffort) ? w.inputs.reasoningEffort : '';
    const prompt = h('textarea.input', { rows: '5', 'aria-label': 'What it does', placeholder: 'What Droid does each time it runs, like “Triage new issues: label them and ask for missing details.”' }) as HTMLTextAreaElement;
    const file = h('code.ci-file');
    const submit = h('button.btn.primary', { type: 'submit', form: 'ci-form' }, w ? 'Open a PR to change it' : 'Open a PR to add it') as HTMLButtonElement;
    const cancel = h('button.btn.ghost', { type: 'button', onclick: close }, 'Cancel');

    const reviewOnly = h('div.ci-row', {}, field('Review depth', depth), securityToggle);
    const customOnly = field('What it does each time', prompt);
    const req = (): CiEditRequest => ({
      action: w ? 'edit' : 'create',
      repo: repo.value,
      ...(w ? { path: w.path } : {}),
      template,
      ...(name.value.trim() ? { name: name.value.trim() } : {}),
      events: events.filter((e) => e.box.checked).map((e) => e.id),
      cron: cron.value.trim(),
      ...(model.value.trim() ? { model: model.value.trim() } : {}),
      ...(effort.value ? { effort: effort.value } : {}),
      ...(template === 'code-review' ? { depth: depth.value as 'deep' | 'shallow', ...(security.checked ? { security: true } : {}) } : { prompt: prompt.value }),
    });
    const sync = () => {
      reviewOnly.classList.toggle('hidden', template !== 'code-review');
      customOnly.classList.toggle('hidden', template !== 'custom');
      name.placeholder = template === 'code-review' ? 'Droid Code Review' : 'Issue triage';
      file.textContent = w?.path ?? (template === 'code-review' ? CI_REVIEW_PATH : customWorkflowPath(name.value.trim() || 'Droid job'));
    };
    name.addEventListener('input', sync);
    sync();

    const el = h(
      'form.ci-form.stack.loose',
      { id: 'ci-form', 'aria-label': w ? `Change ${w.name}` : 'Add a Droid workflow' },
      h('h3.ci-form-title', {}, w ? `Change ${w.name}` : 'Add a Droid workflow'),
      field('Repository', repo, repoNote),
      w
        ? null
        : h(
            'div.choices.ci-templates',
            {},
            kindRadio('code-review', 'Droid code review', 'Reviews every pull request and comments on it (Factory’s template)'),
            kindRadio('custom', 'A Droid job of your own', 'Runs Droid with your prompt on the events or schedule you pick'),
          ),
      field('Name', name),
      h('div.field', {}, h('label', {}, 'Runs on'), h('div.ci-events', {}, ...events.map((e) => e.label))),
      h('div.ci-row', {}, field('Schedule (UTC)', cron), h('span')),
      reviewOnly,
      h('div.ci-row', {}, field('Model', model), field('Reasoning effort', effort)),
      modelList,
      customOnly,
      h('p.note.info', {}, 'Factory writes ', file, ` in ${w?.repo ?? 'the repository'} and opens a pull request with it. Nothing runs until it merges. Manual runs (workflow_dispatch) are always on.`),
    );
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      void send(req(), submit, close);
    });
    return { el, actions: [cancel, submit] };
  }

  for (const [t, b] of Object.entries(tabButtons) as [Tab, HTMLButtonElement][]) {
    b.addEventListener('click', () => {
      tab = t;
      form = undefined;
      paint();
    });
  }
  add.addEventListener('click', () => startForm());
  rescan.addEventListener('click', async () => {
    rescanning = true;
    paint();
    try {
      await factoryFetch('ci', '/rescan', { method: 'POST' });
    } catch (err) {
      toast(`Couldn’t rescan: ${(err as Error).message}`, 'error');
    } finally {
      rescanning = false;
      refreshFactory('ci');
      paint();
    }
  });

  const offState = store.on('factory', paint);
  const stopWatch = watchFactory('ci');
  // The "5m ago"s age while it stays open.
  const timer = setInterval(paint, 30_000);
  paint();
  const modal = openModal(el, {
    doing: 'looking at the CI automations',
    // Esc in the form goes back to the list first.
    escCloses: () => {
      if (!form) return true;
      form = undefined;
      paint();
      return false;
    },
    onClose: () => {
      offState();
      stopWatch();
      clearInterval(timer);
      open = undefined;
    },
  });
  open = { modal, add: () => startForm() };
  if (opts.add) startForm();
  return modal;
}
