import { clock, eventLabel, isLive, pipelineGroups, pipelinePolicy, runTime, stateWord, waitTime, type PipelineDetail, type PipelineJob, type PipelineRun, type PipelineWorkflow, type RunState } from '../../shared/pipelines';
import type { ServerMsg } from '../../shared/protocol';
import type { Net } from '../net';
import { store, words } from '../state';
import { h, openModal, timeAgo, toast } from './dom';
import { emptyState, field, toggle } from './kit';
import { confirmDialog } from './prompt';

// The Pipelines window behind the 02 PIPELINES board: the floor's GitHub Actions runs or GitLab
// pipelines down the side (running, waiting, then the latest finished), the picked run's jobs and
// steps beside them, and from there re-run, cancel or start a workflow by hand.

export interface PipelinesActions {
  /** Ask the Pipeline agent at its kiosk, starting from `initial`. */
  askAgent(initial?: string): void;
}

export interface PipelinesOpen {
  /** Open on this run. */
  runId?: number;
  /** Open on the Run workflow form. */
  run?: boolean;
}

type Done = Extract<ServerMsg, { t: 'pipelines.done' }>;
type Detail = Extract<ServerMsg, { t: 'pipelines.detail' }>;
const doneWaiters = new Set<(msg: Done) => void>();
const detailWaiters = new Set<(msg: Detail) => void>();

/** Main feeds server messages through here so an open Pipelines window hears back. */
export function routePipelinesMessage(msg: ServerMsg) {
  if (msg.t === 'pipelines.done') for (const w of doneWaiters) w(msg);
  if (msg.t === 'pipelines.detail') for (const w of detailWaiters) w(msg);
}

const MARK: Record<RunState, string> = { pending: '○', running: '', success: '✓', failure: '✗', cancelled: '⊘', skipped: '↷' };

/** A run's or job's state as a mark: a spinner while it runs. */
function mark(state: RunState): HTMLElement {
  if (state === 'running') return h('span.spinner.pl-spin', { 'aria-label': 'running' });
  return h('span.pl-mark', { class: state, 'aria-label': state }, MARK[state]);
}

function statePill(run: Pick<PipelineRun, 'state' | 'status'>): HTMLElement {
  return h('span.pill.pl-pill', { class: run.state }, stateWord(run));
}

function link(href: string | undefined, text: string, cls?: string): HTMLElement {
  return href ? h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer', title: text }, text) : h('span', { class: cls }, text);
}

/** How long a job or step ran, or has been running. */
function span(startedAt: string | undefined, completedAt: string | undefined, state: RunState, now: number): string {
  if (!startedAt) return '';
  const a = Date.parse(startedAt);
  const b = completedAt ? Date.parse(completedAt) : isLive(state) ? now : Number.NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? clock(Math.max(0, b - a)) : '';
}

/** A job's or step's time, which the window's clock ticks on while it runs. */
function timeEl(x: { startedAt?: string; completedAt?: string; state: RunState }, now: number): HTMLElement {
  const live = x.state === 'running' && x.startedAt && !x.completedAt;
  return h('span.pl-time', live ? { 'data-since': x.startedAt } : {}, span(x.startedAt, x.completedAt, x.state, now));
}

/** A run's time for its row: how long it has waited, has run, or ran. */
function runClock(r: PipelineRun, now: number): string {
  if (r.state === 'pending') return clock(waitTime(r, now));
  const t = runTime(r, now);
  return t ? clock(t) : '';
}

export function openPipelines(net: Net, actions: PipelinesActions, opts: PipelinesOpen = {}) {
  const policy = () => pipelinePolicy(store.project?.forge);
  const title = () => policy().copy.windowTitle;
  /** GitLab's form is variables for one pipeline; GitHub's picks a workflow and its inputs. */
  const variables = () => policy().form === 'variables';
  let picked: number | null = opts.runId ?? null;
  let form = !!opts.run;
  /** Each run's jobs as last read, with the run's updatedAt then, so a change reads them again. */
  const details = new Map<number, { detail?: PipelineDetail; error?: string; updatedAt: string; at: number }>();
  const asking = new Set<number>();
  /** Re-run or cancel sent and not answered yet, by run id. */
  const busy = new Map<number, string>();
  /** Jobs whose steps you opened or closed, by job id. */
  const opened = new Map<number, boolean>();

  const h2 = h('h2');
  const sub = h('p.sub.pl-sub');
  const refresh = h('button.btn.sm', { type: 'button', title: 'Look again now' }, 'Refresh') as HTMLButtonElement;
  const runBtn = h('button.btn.sm.accent', { type: 'button' }, '▶ Run workflow') as HTMLButtonElement;
  const side = h('nav.pl-side', { 'aria-label': 'Runs' });
  const pane = h('div.pl-pane');
  const foot = h('span.grow.pl-foot');
  const ask = h('button.btn', { type: 'button', title: 'Ask the Pipeline agent at the kiosk by the board' }, '🚀 Ask the Pipeline agent');
  const heal = toggle({
    label: '🩹 Auto-heal',
    checked: store.autoHeal.on,
    onChange: (on) => {
      // The roof and the lobby have no floor, so there is nothing for this switch to turn on.
      if (!store.currentFloor()) {
        heal.input.checked = store.autoHeal.on;
        return;
      }
      if (store.autoHeal.on !== on) net.send({ t: 'autoHeal.set', on });
    },
  });
  const paintHeal = () => {
    const { on, by, at } = store.autoHeal;
    heal.input.checked = on;
    const set = by ? `\n${on ? 'Turned on' : 'Turned off'} by ${by}${at ? ` ${timeAgo(at)}` : ''}` : '';
    heal.title = `A run that fails wakes the Pipeline agent: it finds the root cause and hires a worker who fixes it and pushes. This floor only.${set}`;
  };
  const el = h(
    'div.modal.xl.pl-window',
    { role: 'dialog', 'aria-label': 'Pipelines' },
    h('header', {}, h('div.titles', {}, h2, sub), h('div.actions', {}, refresh, runBtn)),
    h('div.body.flush.split.pl-split', {}, side, pane),
    h('footer', {}, foot, heal, ask),
  );

  refresh.addEventListener('click', () => {
    net.send({ t: 'pipelines.refresh' });
    if (picked !== null) fetchDetail(picked, true);
  });
  runBtn.addEventListener('click', () => {
    form = true;
    render();
  });
  ask.addEventListener('click', () => {
    const run = current();
    modal.close();
    actions.askAgent(run && !form ? `About ${run.workflow} #${run.number} (${run.url}): ` : undefined);
  });

  const current = (): PipelineRun | undefined => store.pipelines.runs.find((r) => r.id === picked);

  function fetchDetail(id: number, force = false) {
    const run = store.pipelines.runs.find((r) => r.id === id);
    if (!run || asking.has(id)) return;
    const had = details.get(id);
    // Read again when the run moved on, and every few seconds while it's going.
    const stale = !had || had.updatedAt !== run.updatedAt || (isLive(run.state) && Date.now() - had.at > 5000);
    if (!force && !stale) return;
    asking.add(id);
    net.send({ t: 'pipelines.detail', id });
  }

  const onDetail = (msg: Detail) => {
    asking.delete(msg.id);
    const run = store.pipelines.runs.find((r) => r.id === msg.id);
    details.set(msg.id, { detail: msg.detail, error: msg.error, updatedAt: run?.updatedAt ?? '', at: Date.now() });
    if (msg.id === picked) render();
  };
  const onDone = (msg: Done) => {
    if (msg.id !== undefined) busy.delete(msg.id);
    if (msg.action === 'run') {
      runPending = false;
      if (msg.error) runError = msg.error;
      else {
        form = false;
        runError = '';
        // The new run shows up in a moment; pick the newest then.
        pickNewest = Date.now();
      }
    } else if (msg.error) toast(`Couldn't ${msg.action === 'rerun' ? 're-run' : 'cancel'} it: ${msg.error}`, 'error');
    else if (msg.id !== undefined) {
      details.delete(msg.id);
      net.send({ t: 'pipelines.refresh' });
    }
    render();
  };
  detailWaiters.add(onDetail);
  doneWaiters.add(onDone);
  let pickNewest = 0;
  let runPending = false;
  let runError = '';

  // --- The side list ------------------------------------------------------------------------------

  const runRow = (r: PipelineRun, now: number) => {
    const row = h(
      'button.list-row.pl-run',
      { type: 'button', class: [r.state, r.id === picked && !form ? 'on' : ''].filter(Boolean).join(' '), 'data-run': String(r.id), title: `${r.workflow} #${r.number}: ${r.title}` },
      h('span.list-icon', {}, mark(r.state)),
      h('span.list-main', {}, h('span.list-title.pl-run-title', {}, h('span.pl-wf', {}, r.workflow), h('span.pl-num', {}, `#${r.number}`)), h('span.list-meta.pl-run-meta', {}, r.title || r.branch)),
      h('span.list-end.pl-run-end', {}, h('span', { 'data-clock': String(r.id) }, runClock(r, now)), h('small', {}, r.state === 'pending' ? stateWord(r) : timeAgo(r.updatedAt))),
    );
    row.addEventListener('click', () => {
      picked = r.id;
      form = false;
      render();
    });
    return row;
  };

  const paintSide = (now: number) => {
    const { running, pending, recent } = pipelineGroups(store.pipelines.runs);
    const group = (label: string, runs: PipelineRun[]) => (runs.length ? [h('div.eyebrow.pl-group', {}, label, h('span.count', {}, String(runs.length))), ...runs.map((r) => runRow(r, now))] : []);
    const scroll = side.scrollTop;
    side.replaceChildren(...group('Running', running), ...group('Waiting', pending), ...group('Recent', recent));
    side.scrollTop = scroll;
  };

  // --- The picked run ------------------------------------------------------------------------------

  const jobBlock = (j: PipelineJob, now: number) => {
    const auto = j.state === 'failure' || j.state === 'running';
    const open = opened.get(j.id) ?? auto;
    const head = h(
      'button.pl-job-head',
      { type: 'button', 'aria-expanded': String(open), disabled: !j.steps.length },
      mark(j.state),
      h('span.pl-job-name', { title: j.name }, j.name),
      j.stage ? h('span.pl-stage', {}, j.stage) : null,
      j.allowFailure && j.state === 'failure' ? h('span.pl-stage', { title: 'A failure here does not fail the pipeline' }, 'allowed to fail') : null,
      h('span.grow'),
      j.state === 'pending' ? h('span.pl-time', {}, j.status.replace(/_/g, ' ')) : timeEl(j, now),
      j.steps.length ? h('span.pl-caret', { 'aria-hidden': 'true' }, open ? '▾' : '▸') : null,
    );
    head.addEventListener('click', () => {
      opened.set(j.id, !open);
      render();
    });
    const steps = open ? h('ol.pl-steps', {}, ...j.steps.map((s) => h('li.pl-step', { class: s.state }, mark(s.state), h('span.pl-step-no', {}, String(s.number)), h('span.pl-step-name', { title: s.name }, s.name), timeEl(s, now)))) : null;
    return h('li.pl-job', { class: j.state }, head, steps, j.url ? h('div.pl-job-link', {}, link(j.url, policy().copy.jobLog)) : null);
  };

  const paintRun = (r: PipelineRun, now: number) => {
    const d = details.get(r.id);
    const live = isLive(r.state);
    const wait = busy.get(r.id);
    const jobsOf = d?.detail?.jobs ?? [];
    const failedJobs = jobsOf.filter((j) => j.state === 'failure' && !j.allowFailure).length;
    const buttons: HTMLElement[] = [];
    if (live) {
      buttons.push(
        h(
          'button.btn.sm.danger',
          {
            type: 'button',
            disabled: !!wait,
            onclick: () =>
              confirmDialog(`Cancel ${r.workflow} #${r.number}?`, `Its jobs stop where they are on ${words().site}.`, 'Cancel it', () => {
                busy.set(r.id, 'Cancelling…');
                net.send({ t: 'pipelines.cancel', id: r.id });
                render();
              }),
          },
          wait ?? 'Cancel run',
        ),
      );
    } else {
      const rerun = (failed: boolean) => {
        busy.set(r.id, 'Starting…');
        net.send({ t: 'pipelines.rerun', id: r.id, failed });
        render();
      };
      if (r.state === 'failure' || r.state === 'cancelled') buttons.push(h('button.btn.sm', { type: 'button', disabled: !!wait, title: policy().copy.retryTitle, onclick: () => rerun(true) }, wait ?? policy().copy.retryLabel));
      buttons.push(h('button.btn.sm.primary', { type: 'button', disabled: !!wait, title: policy().copy.rerunTitle, onclick: () => rerun(false) }, wait && r.state !== 'failure' ? wait : policy().copy.rerunLabel));
    }
    const facts: [string, Node | string][] = [
      ['Branch', r.branch || '—'],
      ['Commit', r.sha ? r.sha.slice(0, 7) : '—'],
      ['Started by', `${eventLabel(r.event)}${r.actor ? ` · @${r.actor}` : ''}`],
      [r.state === 'pending' ? 'Waiting' : live ? 'Running for' : 'Took', h('span', { 'data-clock': String(r.id) }, runClock(r, now) || '—')],
      ['Created', timeAgo(r.createdAt)],
    ];
    if (r.attempt && r.attempt > 1) facts.push(['Attempt', String(r.attempt)]);
    if (r.path) facts.push(['File', r.path]);
    let jobs: HTMLElement;
    if (d?.error) jobs = h('p.note.bad', {}, `Couldn't read its jobs: ${d.error}`);
    else if (!d?.detail) jobs = h('div.stack.tight', {}, ...[0, 1, 2].map(() => h('div.skeleton.pl-skeleton')));
    else if (!jobsOf.length) jobs = h('p.pl-quiet', {}, r.state === 'pending' ? 'No jobs have started yet.' : 'No jobs.');
    else jobs = h('ul.pl-jobs', {}, ...jobsOf.map((j) => jobBlock(j, now)));
    const done = jobsOf.filter((j) => !isLive(j.state)).length;
    pane.replaceChildren(
      h(
        'div.pl-hero',
        {},
        h('div.row.pl-hero-top', {}, statePill(r), h('span.pl-hero-wf', {}, r.workflow), h('span.pl-num', {}, `#${r.number}`), h('span.grow'), link(r.url, `Open on ${words().site} ↗`, 'pl-open')),
        h('h3.pl-title', { title: r.title }, r.title || r.workflow),
        h('dl.pl-facts', {}, ...facts.map(([k, v]) => h('div.pl-fact', {}, h('dt', {}, k), h('dd', { title: typeof v === 'string' ? v : undefined }, v)))),
        h('div.row.wrap.pl-buttons', {}, ...buttons),
      ),
      h('section.section.pl-jobs-sec', {}, h('div.eyebrow', {}, 'Jobs', jobsOf.length ? h('span.count', {}, `${done}/${jobsOf.length}`) : null, failedJobs ? h('span.pl-failed', {}, `${failedJobs} failed`) : null), jobs),
    );
  };

  // --- Run a workflow by hand -------------------------------------------------------------------

  let formEl: HTMLElement | null = null;
  let formWorkflow = '';
  const paintForm = () => {
    const p = store.pipelines;
    const manual = p.workflows.filter((w) => w.manual && w.active);
    if (!manual.length) {
      formEl = null;
      pane.replaceChildren(
        emptyState(
          '▶',
          'Nothing here can be started by hand',
          p.workflows.length ? 'Add a workflow_dispatch trigger to a workflow in .github/workflows, and it shows up here with its inputs.' : 'No workflows found in .github/workflows yet.',
          h('button.btn', { type: 'button', onclick: () => ((form = false), render()) }, 'Back to the runs'),
        ),
      );
      return;
    }
    // The form is built once and kept while it's open, so a board refresh doesn't wipe what you typed.
    if (formEl && pane.contains(formEl)) {
      const err = formEl.querySelector('.pl-run-error');
      if (err) err.textContent = runError;
      const go = formEl.querySelector<HTMLButtonElement>('.pl-go');
      if (go) {
        go.disabled = runPending;
        go.textContent = runPending ? 'Starting…' : '▶ Run workflow';
      }
      return;
    }
    if (!manual.some((w) => w.id === formWorkflow)) formWorkflow = manual[0].id;
    const branches = [...new Set([p.defaultBranch, ...p.runs.map((r) => r.branch)].filter((b): b is string => !!b))];
    const select = h('select.select', {}, ...manual.map((w) => h('option', { value: w.id, selected: w.id === formWorkflow }, variables() ? w.name : `${w.name} · ${w.id}`))) as HTMLSelectElement;
    const ref = h('input.input', { type: 'text', value: p.defaultBranch ?? '', placeholder: p.defaultBranch ?? 'main', list: 'pl-branches', spellcheck: false, autocomplete: 'off' }) as HTMLInputElement;
    const datalist = h('datalist', { id: 'pl-branches' }, ...branches.map((b) => h('option', { value: b })));
    const inputsBox = h('div.stack.pl-inputs');
    let read: () => Record<string, string> = () => ({});
    const paintInputs = () => {
      const wf = manual.find((w) => w.id === select.value) as PipelineWorkflow;
      formWorkflow = wf.id;
      if (variables()) {
        const vars = h('textarea.input.pl-vars', { rows: 4, placeholder: 'DEPLOY=staging\nDEBUG=1', spellcheck: false }) as HTMLTextAreaElement;
        inputsBox.replaceChildren(field('Variables', vars, 'One KEY=value a line, passed to the pipeline as CI/CD variables.'));
        read = () => Object.fromEntries(vars.value.split('\n').flatMap((l) => (l.includes('=') ? [[l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]] : [])));
        return;
      }
      if (!wf.inputs.length) {
        inputsBox.replaceChildren(h('p.pl-quiet', {}, `${wf.name} takes no inputs.`));
        read = () => ({});
        return;
      }
      const getters: (() => [string, string])[] = [];
      inputsBox.replaceChildren(
        ...wf.inputs.map((input) => {
          const label = `${input.name}${input.required ? ' *' : ''}`;
          if (input.type === 'boolean') {
            const t = toggle({ label: input.name, description: input.description, checked: input.default === 'true' });
            getters.push(() => [input.name, t.input.checked ? 'true' : 'false']);
            return t;
          }
          if (input.type === 'choice' && input.options?.length) {
            const s = h('select.select', {}, ...input.options.map((o) => h('option', { value: o, selected: o === input.default }, o))) as HTMLSelectElement;
            getters.push(() => [input.name, s.value]);
            return field(label, s, input.description);
          }
          const i = h('input.input', { type: input.type === 'number' ? 'number' : 'text', value: input.default ?? '', required: input.required, spellcheck: false }) as HTMLInputElement;
          getters.push(() => [input.name, i.value]);
          return field(label, i, input.description);
        }),
      );
      read = () => Object.fromEntries(getters.map((g) => g()));
    };
    select.addEventListener('change', paintInputs);
    paintInputs();
    const go = h('button.btn.accent.pl-go', { type: 'submit' }, '▶ Run workflow') as HTMLButtonElement;
    const back = h('button.btn.ghost', { type: 'button', onclick: () => ((form = false), (runError = ''), render()) }, 'Back');
    const f = h(
      'form.stack.pl-form',
      {},
      h('div.pl-form-head', {}, h('h3', {}, policy().copy.runTitle), h('p', {}, policy().copy.runBlurb)),
      variables() ? null : field('Workflow', select),
      field('Branch or tag', ref, p.defaultBranch ? `Empty runs it on ${p.defaultBranch}.` : undefined),
      datalist,
      inputsBox,
      h('p.field-error.pl-run-error', { role: 'alert' }, runError),
      h('div.row.pl-form-foot', {}, h('span.grow'), back, go),
    ) as HTMLFormElement;
    f.noValidate = true;
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (runPending) return;
      runPending = true;
      runError = '';
      net.send({ t: 'pipelines.run', workflow: select.value, ref: ref.value.trim(), inputs: read() });
      render();
    });
    formEl = f;
    pane.replaceChildren(f);
    setTimeout(() => (variables() ? ref : select).focus(), 30);
  };

  // --- All of it ----------------------------------------------------------------------------------

  const render = () => {
    const p = store.pipelines;
    const now = Date.now();
    h2.textContent = title();
    const { running, pending } = pipelineGroups(p.runs);
    const repo = store.project?.remote?.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1') ?? '';
    sub.textContent = p.error ? p.error : [repo, running.length ? `${running.length} running` : '', pending.length ? `${pending.length} waiting` : ''].filter(Boolean).join(' · ');
    sub.title = sub.textContent;
    sub.classList.toggle('bad', !!p.error);
    refresh.disabled = p.loading;
    refresh.textContent = p.loading ? 'Reading…' : 'Refresh';
    runBtn.classList.toggle('on', form);
    runBtn.textContent = policy().copy.runButton;
    foot.textContent = p.fetchedAt ? `Read ${timeAgo(p.fetchedAt)} · every few seconds while something runs` : '';
    if (pickNewest && p.runs.length) {
      const newest = [...p.runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      if (Date.parse(newest.createdAt) > pickNewest - 60_000) {
        picked = newest.id;
        pickNewest = 0;
      }
    }
    if (picked === null || !current()) {
      const first = [...running, ...pending, ...pipelineGroups(p.runs).recent][0];
      picked = first?.id ?? null;
    }
    paintSide(now);
    if (form) return paintForm();
    formEl = null;
    const run = current();
    if (!run) {
      const loading = p.loading && !p.fetchedAt;
      pane.replaceChildren(loading ? h('div.stack.tight', {}, ...[0, 1, 2, 3].map(() => h('div.skeleton.pl-skeleton'))) : emptyState('🚀', p.error ? "Can't read the runs" : 'No runs yet', p.error ?? policy().copy.emptyWindow));
      return;
    }
    fetchDetail(run.id);
    paintRun(run, now);
  };

  const onKey = (e: KeyboardEvent) => {
    if (form || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, select')) return;
    const { running, pending, recent } = pipelineGroups(store.pipelines.runs);
    const order = [...running, ...pending, ...recent];
    const i = order.findIndex((r) => r.id === picked);
    const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    picked = next.id;
    render();
    side.querySelector(`[data-run="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  el.addEventListener('keydown', onKey);

  const unsubs = [store.on('pipelines', render), store.on('project', render), store.on('autoHeal', paintHeal)];
  // Clocks tick on running and waiting runs, without rebuilding what you might be clicking.
  const tick = setInterval(() => {
    const now = Date.now();
    for (const c of el.querySelectorAll<HTMLElement>('[data-clock]')) {
      const run = store.pipelines.runs.find((r) => String(r.id) === c.dataset.clock);
      if (run && isLive(run.state)) c.textContent = runClock(run, now);
    }
    for (const c of el.querySelectorAll<HTMLElement>('[data-since]')) c.textContent = clock(Math.max(0, now - Date.parse(c.dataset.since ?? '')));
    const run = current();
    if (run && isLive(run.state) && !form) fetchDetail(run.id);
  }, 1000);
  const modal = openModal(el, {
    doing: '🚀 at the pipelines board',
    onClose: () => {
      unsubs.forEach((u) => u());
      clearInterval(tick);
      detailWaiters.delete(onDetail);
      doneWaiters.delete(onDone);
    },
  });
  // Opening the window is a good moment to look again.
  if (Date.now() - store.pipelines.fetchedAt > 10_000) net.send({ t: 'pipelines.refresh' });
  render();
  paintHeal();
  el.tabIndex = -1;
  if (!form) setTimeout(() => el.focus(), 30);
}
