import { MEETING_PATTERNS, MEETING_PATTERN_IDS, outputProblem, slugify } from '../../shared/meetings';
import type { Meeting, MeetingPattern, MeetingTurn } from '../../shared/protocol';
import type { Net } from '../net';
import { store, words } from '../state';
import { meetingStage } from '../world/meeting';
import { h, openModal, timeAgo, toast, STATUS_LABEL, type Modal } from './dom';
import { colorDot } from './kit';
import { confirmDialog } from './prompt';
import { promptImages } from './images';
import { agentPicker } from './models';
import { officePrompt } from './prompts';
import { issueVars } from './boards';

/** What a meeting called from an issue, a PR or a task starts out with. */
export interface MeetingPreset {
  pattern?: MeetingPattern;
  prompt?: string;
  title?: string;
  pr?: number;
  issue?: number;
}

export interface MeetingActions {
  openTerminal(workerId: string): void;
  /** Push the meeting's branch and open a pull request for it, through the head of the table's worker. */
  openPr(workerId: string): void;
}

/** A meeting about an issue: the form filled in with it. */
export function issueMeeting(n: number, title: string): MeetingPreset {
  return { issue: n, title: `#${n} ${title}`, prompt: officePrompt('issue.meeting', issueVars({ number: n, title })) };
}

const PART_LABEL: Record<MeetingTurn['state'], string> = { waiting: 'up next', sent: 'handed over', working: 'on it', done: 'written' };

/**
 * The meeting room's window. With a meeting at the table it shows how it's going (and stops it, or
 * clears the table once it's over); otherwise, or with a preset from an issue or a PR, it's the form
 * that calls one.
 */
export function openMeeting(net: Net, actions: MeetingActions, preset?: MeetingPreset) {
  const close = h('button.btn.icon.close', { 'aria-label': 'Close' }, '✕');
  const title = h('h2', {}, 'Meeting room');
  const sub = h('p.sub');
  const body = h('div.body.meeting');
  const foot = h('footer');
  const el = h('div.modal.lg.meeting-window', { role: 'dialog', 'aria-label': 'Meeting room' }, h('header', {}, h('div.titles', {}, title, sub), close), body, foot);
  let view: 'status' | 'form' = preset || !store.meeting.current ? 'form' : 'status';
  let form: ReturnType<typeof meetingForm> | null = null;
  const render = () => {
    if (view === 'status' && store.meeting.current) {
      form?.images.discard();
      form = null;
      title.textContent = 'Meeting room';
      sub.textContent = 'Workers around the table, and what they’re writing.';
      renderStatus(store.meeting.current, body, foot, net, actions, () => {
        view = 'form';
        render();
      });
      return;
    }
    if (!form) {
      form = meetingForm(
        net,
        preset,
        () => modal.close(),
        () => {
          view = 'status';
          render();
        },
      );
      title.textContent = 'Call a meeting';
      sub.textContent = 'Seat a few workers at the table to settle a question or split a task.';
      body.replaceChildren(form.body);
      foot.replaceChildren(...form.foot);
    }
    form.refresh();
  };
  const offs = [store.on('meeting', render), store.on('workers', () => view === 'status' && render()), store.on('pulls', () => form?.refresh())];
  const modal: Modal = openModal(el, {
    doing: '🤝 at the meeting room',
    onClose: () => {
      offs.forEach((off) => off());
      form?.images.discard();
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
}

function renderStatus(m: Meeting, body: HTMLElement, foot: HTMLElement, net: Net, actions: MeetingActions, callAnother: () => void) {
  const p = MEETING_PATTERNS[m.pattern];
  const running = m.status === 'running';
  const pill = h('span.pill', { class: running ? 'working' : m.status === 'done' ? 'done' : 'needs_input' }, running ? 'in a meeting' : m.status);
  const seats = h(
    'ul.list.boxed.meeting-seats',
    {},
    ...m.seats.map((s, i) => {
      const w = s.workerId ? store.workers.get(s.workerId) : undefined;
      const t = m.turns.find((x) => x.seat === i);
      const part = running ? (t ? `${PART_LABEL[t.state]}: ${t.doing}` : 'listening') : '';
      return h(
        'li.list-row',
        {},
        h('span.list-icon', {}, colorDot(w?.color ?? 'var(--text-tertiary)')),
        h(
          'div.list-main',
          {},
          h('div.list-title', {}, s.role, h('span.meeting-who', {}, s.workerName ?? '…'), i === 0 ? h('span.meeting-crown', { title: 'Head of the table' }, '👑') : null),
          h('div.list-meta', { title: t?.file ?? '' }, part || (i === 0 ? 'Head of the table' : 'At the table')),
        ),
        h(
          'div.list-end',
          {},
          w ? h('span.pill', { class: w.status }, STATUS_LABEL[w.status]) : h('span.pill.exited', {}, 'gone home'),
          w ? h('button.btn.sm', { type: 'button', onclick: () => actions.openTerminal(w.id) }, 'Terminal') : null,
        ),
      );
    }),
  );
  const where = m.worktree ? h('span.meeting-branch', { title: m.worktree.branch }, h('code', {}, m.worktree.branch), m.commit ? ` · committed ${m.commit}` : '') : null;
  const review = m.review?.url
    ? h('a', { href: m.review.url, target: '_blank', rel: 'noopener noreferrer' }, `The review on ${words().pr} ${words().ref(m.pr ?? 0)} ↗`)
    : m.review?.error
      ? h('span.meeting-error', {}, `Couldn't post the review: ${m.review.error}`)
      : null;
  body.replaceChildren(
    h(
      'div.stack.loose',
      {},
      ...present(
        h(
          'div.meeting-head',
          {},
          h('div.row.wrap', {}, pill, h('span.meeting-kind', {}, h('span', { 'aria-hidden': 'true' }, p.icon), p.label)),
          h('h3.meeting-title', { title: m.prompt }, m.title),
          h(
            'p.meeting-line',
            {},
            running
              ? `${meetingStage(m)} · called by ${m.calledBy} ${timeAgo(new Date(m.startedAt).toISOString())}`
              : m.status === 'done'
                ? `Wrote ${m.output} in ${m.round} round${m.round === 1 ? '' : 's'}`
                : `Stopped in round ${m.round}: ${m.reason ?? 'stopped'}`,
          ),
        ),
        h('section.section', {}, h('div.eyebrow', {}, 'At the table'), seats),
        h(
          'section.section',
          {},
          h('div.eyebrow', {}, 'Output'),
          h(
            'div.meeting-out',
            {},
            h('div.meeting-out-head', {}, h('code', { title: m.output }, m.output), where, review),
            h('pre.meeting-preview', {}, m.preview?.trim() ? m.preview : running ? 'Nothing written yet.' : 'Nothing was written.'),
          ),
        ),
        store.meeting.past.length
          ? h(
              'details.section.meeting-past',
              {},
              h('summary.eyebrow', {}, `Earlier meetings (${store.meeting.past.length})`),
              h('ul.list.boxed', {}, ...store.meeting.past.map((r) => h('li.list-row', { title: `Called by ${r.calledBy}` }, h('div.list-main', {}, h('div.list-title', {}, r.title), h('div.list-meta.meeting-summary', {}, r.summary))))),
            )
          : null,
      ),
    ),
  );
  const head = m.seats[0]?.workerId ? store.workers.get(m.seats[0].workerId) : undefined;
  foot.replaceChildren(
    ...present(
      h('span.grow', {}, running ? 'The workers stay at the table after it ends, so you can read their terminals.' : 'Clearing the room sends the workers home. A committed output stays on its branch.'),
      running
        ? h(
            'button.btn',
            { type: 'button', onclick: () => confirmDialog('Stop the meeting?', `The workers stop where they are and stay at the table. ${m.output} is only there if it was written.`, 'Stop it', () => net.send({ t: 'meeting.stop' })) },
            'Stop meeting',
          )
        : null,
      !running && m.commit && head?.worktree
        ? h('button.btn', { type: 'button', title: `Push ${m.worktree?.branch} and open a ${words().pull}`, onclick: () => actions.openPr(head.id) }, head.pr ? `${words().pr} ${words().ref(head.pr.number)}` : `Open ${words().pr}`)
        : null,
      !running ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'meeting.clear' }) }, 'Clear the room') : null,
      !running ? h('button.btn.primary', { type: 'button', onclick: callAnother }, 'Call a meeting…') : null,
    ),
  );
}

const present = (...xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => x !== null);

/** The form that calls a meeting: the pattern, what it's about, who sits down, the output, the bounds. */
function meetingForm(net: Net, preset: MeetingPreset | undefined, done: () => void, back: () => void) {
  let pattern: MeetingPattern = preset?.pattern ?? 'debate';
  let roles: string[] = [];
  let outputTouched = false;
  const patterns = h('div.seg.meeting-patterns', { role: 'radiogroup', 'aria-label': 'Pattern' });
  const blurb = h('p.field-hint.meeting-blurb');
  const about = h('textarea.input', {
    id: 'meeting-about',
    rows: 4,
    placeholder: 'The question to settle, or the task to do: e.g. “Should workers use A* or a navmesh?”',
    'aria-label': 'What the meeting is about',
  }) as HTMLTextAreaElement;
  about.value = preset?.prompt ?? '';
  const images = promptImages(about);
  const titleIn = h('input.input', { id: 'meeting-title', type: 'text', placeholder: 'The first line, otherwise', maxlength: 100, 'aria-label': 'Title' }) as HTMLInputElement;
  titleIn.value = preset?.title ?? '';
  const outputIn = h('input.input', { id: 'meeting-output', type: 'text', 'aria-label': 'Output file', spellcheck: 'false' }) as HTMLInputElement;
  const outputNote = h('p.field-hint');
  const prSel = h('select.select', { id: 'meeting-pr', 'aria-label': 'Pull request' }) as HTMLSelectElement;
  const prRow = h('div.field', {}, h('label', { for: 'meeting-pr' }, 'Pull request'), prSel);
  const partsIn = h('textarea.input', { id: 'meeting-parts', rows: 3, placeholder: 'src/server/\nsrc/client/\nsrc/shared/', 'aria-label': 'Parts', spellcheck: 'false' }) as HTMLTextAreaElement;
  const partsRow = h('div.field', {}, h('label', { for: 'meeting-parts' }, 'Parts, one per line'), partsIn, h('p.field-hint', {}, 'Handed out to the mappers in turn: files, folders, modules or issues.'));
  const count = h('span.meeting-count', { 'aria-live': 'polite' });
  const minus = h('button.btn.icon', { type: 'button', 'aria-label': 'Fewer workers' }, '−');
  const plus = h('button.btn.icon', { type: 'button', 'aria-label': 'More workers' }, '+');
  const roleList = h('div.meeting-roles');
  const roundsIn = h('input.input.meeting-rounds', { id: 'meeting-rounds', type: 'number', 'aria-label': 'Rounds' }) as HTMLInputElement;
  const roundsNote = h('p.field-hint');
  const models = agentPicker('meeting-models', 'meeting');
  const busy = h('p.note.warn', { hidden: true, role: 'status' });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Start the meeting');
  const cancel = h('button.btn.ghost', { type: 'button', onclick: store.meeting.current ? back : done }, store.meeting.current ? '← Back' : 'Cancel');

  const def = () => MEETING_PATTERNS[pattern];
  const slug = () => slugify(titleIn.value.trim() || about.value.trim().split('\n')[0] || 'meeting', 32);
  const pr = () => Number(prSel.value) || undefined;
  const syncOutput = () => {
    if (!outputTouched) outputIn.value = def().output(slug(), pr());
    const problem = outputProblem(outputIn.value.trim());
    outputNote.textContent = problem
      ? problem
      : pattern === 'review'
        ? 'It ends when this file is written; the office then posts it on the PR as one review.'
        : store.project?.branch
          ? 'It ends when this file is written; the office commits it on the meeting’s own branch.'
          : 'It ends when this file is written.';
    outputNote.className = problem ? 'field-error' : 'field-hint';
  };
  const renderRoles = () => {
    const d = def();
    count.textContent = String(roles.length);
    minus.toggleAttribute('disabled', roles.length <= d.seats.min);
    plus.toggleAttribute('disabled', roles.length >= d.seats.max);
    roleList.replaceChildren(
      ...roles.map((r, i) => {
        const input = h('input.input', { type: 'text', value: r, maxlength: 40, 'aria-label': `Role ${i + 1}` }) as HTMLInputElement;
        input.addEventListener('input', () => (roles[i] = input.value));
        return h('div.meeting-role', {}, h('span.meeting-seat', { title: i === 0 ? 'Head of the table' : `Seat ${i + 1}` }, i === 0 ? '👑' : `${i + 1}`), input);
      }),
    );
  };
  const pickPattern = (p: MeetingPattern) => {
    pattern = p;
    const d = def();
    roles = d.roles.slice(0, d.seats.default);
    for (const b of patterns.children) b.classList.toggle('on', (b as HTMLElement).dataset.pattern === p);
    for (const b of patterns.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.pattern === p));
    blurb.textContent = d.blurb;
    roundsIn.min = String(d.rounds.min);
    roundsIn.max = String(d.rounds.max);
    roundsIn.value = String(d.rounds.default);
    roundsIn.disabled = d.rounds.min === d.rounds.max;
    roundsNote.textContent = d.roundsNote;
    prRow.classList.toggle('hidden', d.needs !== 'pr');
    partsRow.classList.toggle('hidden', d.needs !== 'parts');
    renderRoles();
    syncOutput();
  };
  for (const id of MEETING_PATTERN_IDS) {
    const d = MEETING_PATTERNS[id];
    patterns.append(h('button.btn', { type: 'button', role: 'radio', 'data-pattern': id, title: d.blurb, onclick: () => pickPattern(id) }, h('span.meeting-pattern-icon', { 'aria-hidden': 'true' }, d.icon), d.label));
  }
  minus.addEventListener('click', () => {
    if (roles.length > def().seats.min) roles.pop();
    renderRoles();
  });
  plus.addEventListener('click', () => {
    if (roles.length < def().seats.max) roles.push(def().roles[roles.length] ?? `Worker ${roles.length + 1}`);
    renderRoles();
  });
  outputIn.addEventListener('input', () => {
    outputTouched = true;
    syncOutput();
  });
  titleIn.addEventListener('input', syncOutput);
  about.addEventListener('input', syncOutput);
  prSel.addEventListener('change', syncOutput);

  const eyebrow = (no: string, text: string) => h('div.eyebrow', {}, h('span.no', {}, no), text);
  const bodyEl = h(
    'form.meeting-form.stack.loose',
    {},
    busy,
    h('section.section', {}, eyebrow('01', 'Pattern'), h('div.field', {}, patterns, blurb)),
    h(
      'section.section.stack',
      {},
      eyebrow('02', 'The topic'),
      h('div.field', {}, h('label', { for: 'meeting-about' }, 'What’s it about?'), about, images.element),
      h('div.field', {}, h('label', { for: 'meeting-title' }, 'Title (optional)'), titleIn),
      prRow,
      partsRow,
    ),
    h(
      'section.section.stack',
      {},
      eyebrow('03', 'The table'),
      h('div.field', {}, h('div.row.between', {}, h('label', {}, 'Workers at the table'), h('div.row.meeting-stepper', { role: 'group', 'aria-label': 'Workers at the table' }, minus, count, plus)), roleList),
      h('div.field', {}, h('label', { for: 'meeting-rounds' }, 'Round limit'), roundsIn, roundsNote),
      models.element,
    ),
    h('section.section', {}, eyebrow('04', 'The output'), h('div.field', {}, h('label', { for: 'meeting-output' }, 'Output file'), outputIn, outputNote)),
  ) as HTMLFormElement;
  bodyEl.noValidate = true;
  images.dropZone(bodyEl);

  let waiting = false;
  const send = () => {
    if (waiting || store.meeting.current?.status === 'running') return;
    const prompt = about.value.trim();
    if (!prompt && !images.ids().length && !images.busy()) return about.focus();
    if (def().needs === 'pr' && !pr()) return prSel.focus();
    const parts = partsIn.value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (def().needs === 'parts' && parts.length < roles.length - 1) {
      toast(`List at least ${roles.length - 1} parts, one per line, or seat fewer workers`, 'warn');
      return partsIn.focus();
    }
    const output = outputIn.value.trim();
    if (outputProblem(output)) return outputIn.focus();
    // A picture still going up goes to the meeting once it's there.
    if (images.busy()) {
      waiting = true;
      void images.settled().then(() => {
        waiting = false;
        send();
      });
      return;
    }
    const picked = images.take();
    net.send({
      t: 'meeting.start',
      pattern,
      prompt,
      title: titleIn.value.trim() || undefined,
      output,
      roles: roles.map((r) => r.trim()),
      parts: def().needs === 'parts' ? parts : undefined,
      pr: def().needs === 'pr' ? pr() : undefined,
      issue: preset?.issue,
      rounds: Number(roundsIn.value) || undefined,
      model: models.model(),
      effort: models.effort(),
      images: picked.length ? picked : undefined,
    });
    toast(`🤝 Calling the ${def().label} meeting: the workers are heading for the meeting room`);
    done();
  };
  bodyEl.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  submit.addEventListener('click', (e) => {
    e.preventDefault();
    send();
  });

  /** Keeps what depends on the board and the room up to date: the open PRs, and whether the room is free. */
  const refresh = () => {
    const open = store.pulls.items.filter((p) => p.state === 'OPEN');
    const want = prSel.value || (preset?.pr ? String(preset.pr) : '');
    const opts: (readonly [string, string])[] = open.map((p) => [String(p.number), `#${p.number} ${p.title}`] as const);
    if (preset?.pr && !open.some((p) => p.number === preset.pr)) opts.unshift([String(preset.pr), `#${preset.pr}`]);
    const key = JSON.stringify(opts);
    if (prSel.dataset.key !== key) {
      prSel.dataset.key = key;
      prSel.replaceChildren(
        h('option', { value: '' }, open.length || preset?.pr ? `Pick a ${words().pull}…` : `No open ${words().pull}s`),
        ...opts.map(([v, label]) => h('option', { value: v }, label.length > 70 ? `${label.slice(0, 69)}…` : label)),
      );
      prSel.value = want;
      syncOutput();
    }
    const m = store.meeting.current;
    const taken = m?.status === 'running';
    busy.textContent = taken ? `The room is busy with “${m.title}” until it ends or someone stops it.` : m ? `Starting this sends the last meeting’s workers home.` : '';
    busy.hidden = !busy.textContent;
    submit.toggleAttribute('disabled', taken);
  };
  pickPattern(pattern);
  if (preset?.pr) prSel.value = String(preset.pr);
  refresh();
  setTimeout(() => (preset?.prompt ? titleIn : about).focus(), 0);
  return { body: bodyEl, images, foot: [h('span.grow', {}, 'Few rounds and one file at the end keep meetings short.'), cancel, submit], refresh };
}
