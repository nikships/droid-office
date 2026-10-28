import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { changedImageType, type ChangedFile, type ChangesState, type ServerMsg } from '../../shared/protocol';
import { shipPromptVars } from '../../shared/prompts';
import { isAsleep } from '../../shared/status';
import { loadFonts, TERM_FONT } from '../fonts';
import type { Net, TerminalHold } from '../net';
import { store, words } from '../state';
import { officeUrl } from '../office-http';
import { TERM_THEME } from '../term-theme';
import { h, openModal, toast, type Modal } from './dom';
import { colorDot, emptyState } from './kit';
import { confirmDialog, openPrompt } from './prompt';
import { officePrompt } from './prompts';
import { termFontSize } from './term-font';

// The Changes window at a desk: the files a worker changed and their diff against the branch the
// office was opened on, refreshed while the worker works, with commit / discard / open-a-PR, and
// Commit & open PR, which asks the worker itself to do both. T swaps the diff for its terminal.

let current: { workerId: string; repo(): string | undefined; show(repo?: string): void; logging(): boolean; modal: Modal } | null = null;
const listeners = new Set<(msg: ServerMsg) => void>();

/** Main feeds every server message through here so the open window can pick its own. */
export function routeChangesMessage(msg: ServerMsg) {
  listeners.forEach((fn) => fn(msg));
}

/** Whose changes are on screen (and which of its repositories), so a reconnect can watch them again. */
export function openChangesFor(): { workerId: string; repo?: string } | null {
  return current ? { workerId: current.workerId, repo: current.repo() } : null;
}

/** The worker whose terminal the Changes window is following (T), so a reconnect can attach to it again. */
export function changesLogFor(): string | null {
  return current?.logging() ? current.workerId : null;
}

const STATUS_WORD: Record<ChangedFile['status'], string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', T: 'type changed', '?': 'new file' };

function plusMinus(a: number, d: number, binary = false): HTMLElement {
  if (binary) return h('span.pm', {}, h('span.bin', {}, 'binary'));
  return h('span.pm', {}, h('span.add', {}, `+${a}`), ' ', h('span.del', {}, `−${d}`));
}

/** A file's git status as one letter in a colored box; an untracked file shows as added. */
function statusLetter(f: ChangedFile, title?: string): HTMLElement {
  const letter = f.status === '?' ? 'A' : f.status;
  return h('span.st', { class: letter, title }, letter);
}

/** A path with its folder dimmed, so the file name stands out in a long list. A long folder is cut first, never the name. */
function pathLabel(p: string): HTMLElement {
  const i = p.lastIndexOf('/');
  return h('span.path.list-title', { title: p }, i >= 0 ? h('span.dir', {}, p.slice(0, i + 1)) : null, h('span.name', {}, p.slice(i + 1)));
}

/** Renders a unified diff: hunk headers, added and removed lines, with line numbers. */
function renderDiff(text: string, truncated: boolean): HTMLElement {
  const out = h('div.diff-lines');
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    let cls = 'ctx';
    let o = '';
    let n = '';
    let code = raw;
    if (raw.startsWith('@@')) {
      inHunk = true;
      cls = 'hunk';
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldN = Number(m[1]);
        newN = Number(m[2]);
      }
    } else if (!inHunk || raw.startsWith('diff --git')) {
      inHunk = false;
      // The file names are already in the header; keep only the lines that say something else.
      if (/^(diff --git|index |--- |\+\+\+ |similarity index)/.test(raw)) continue;
      cls = 'meta';
    } else if (raw.startsWith('+')) {
      cls = 'add';
      n = String(newN++);
      code = raw.slice(1);
    } else if (raw.startsWith('-')) {
      cls = 'del';
      o = String(oldN++);
      code = raw.slice(1);
    } else if (raw.startsWith('\\')) cls = 'meta';
    else {
      o = String(oldN++);
      n = String(newN++);
      code = raw.slice(1);
    }
    out.append(h('div.dl', { class: cls }, h('span.ln', {}, o), h('span.ln', {}, n), h('span.code', {}, code)));
  }
  if (truncated) out.append(h('div.dl.meta', {}, h('span.ln'), h('span.ln'), h('span.code', {}, '… the rest of this diff is too long to show here')));
  return out;
}

/** Where one side of a changed picture loads from. The file's signature makes a new URL whenever it changes. */
function imageUrl(workerId: string, repo: string | undefined, f: ChangedFile, side: 'old' | 'new'): string {
  const q = new URLSearchParams({ floor: store.floor ?? '', worker: workerId, path: f.path, side, v: f.sig, ...(repo ? { repo } : {}) });
  return officeUrl(`/api/changes/file?${q}`);
}

/** A changed picture, before and after; new and deleted files only have the one side. */
function renderPreview(workerId: string, repo: string | undefined, f: ChangedFile): HTMLElement {
  const sides: ('old' | 'new')[] = f.status === '?' || f.status === 'A' ? ['new'] : f.status === 'D' ? ['old'] : ['old', 'new'];
  return h(
    'div.img-preview',
    {},
    ...sides.map((side) => {
      const label = side === 'old' ? 'Before' : 'After';
      const size = h('span.size');
      const frame = h('div.img-frame');
      const img = h('img', { src: imageUrl(workerId, repo, f, side), alt: `${side === 'old' ? (f.from ?? f.path) : f.path} (${label.toLowerCase()})` });
      img.addEventListener('load', () => (size.textContent = `${img.naturalWidth} × ${img.naturalHeight}`));
      img.addEventListener('error', () => frame.replaceChildren(h('p', {}, `Couldn't load the picture ${side === 'old' ? 'from before' : 'as it is now'}.`)));
      frame.append(img);
      return h('figure', {}, h('figcaption', {}, h('b', {}, label), size), frame);
    }),
  );
}

/** Why Commit & open PR can't be asked for in this checkout now, or '' when it can. */
function shipBlocker(s: ChangesState, name: string, asleep: boolean, uncommitted: number): string {
  if (asleep) return `${name} is asleep: press R at its desk first`;
  if (!s.branch || !s.prBase) return "This checkout isn't on a branch of its own";
  if (s.pr) return uncommitted ? '' : `Nothing uncommitted to add to ${words().pr} ${words().ref(s.pr.number)}`;
  return uncommitted || s.ahead ? '' : `Nothing on ${s.branch} that ${s.prBase} lacks yet`;
}

/**
 * The Changes window for a worker. A worker across repositories (see WorkerInfo.repos) gets a tab per
 * repository, its own floor's first; `repo` opens on another floor's one.
 */
export function openChanges(net: Net, workerId: string, onTerminal?: () => void, repo?: string) {
  if (current?.workerId === workerId) return current.show(repo);
  const info = store.workers.get(workerId);
  if (!info) return;
  const previous = current;

  let state: ChangesState | null = null;
  let selected: string | null = null;
  /** The signature the shown diff was fetched for; a new one means the file changed underneath. */
  let shownSig: string | null = null;
  let requestedSig = '';
  let loading = false;

  const title = h('h2', {}, `${info.name} · changes`);
  const branch = h('p.sub.hidden');
  const diffViewBtn = h('button.btn.on', { type: 'button', 'aria-pressed': 'true', title: 'The changed files and their diff (T)' }, 'Diff');
  const logViewBtn = h('button.btn', { type: 'button', 'aria-pressed': 'false', title: "The worker's terminal, to watch it (T)" }, 'Log', h('span.key', {}, 'T'));
  const viewSeg = h('span.seg', { role: 'group', 'aria-label': 'Show' }, diffViewBtn, logViewBtn);
  const terminalBtn = h('button.btn', { type: 'button', title: 'Leave Changes for the terminal, to type to the worker' }, 'Terminal');
  const closeBtn = h('button.btn.icon.close', { 'aria-label': 'Close' }, '✕');
  const filesHead = h('div.eyebrow.changes-files-head', {}, 'Changed files');
  const list = h('ul.list', { role: 'listbox', 'aria-label': 'Changed files' });
  const files = h('aside.changes-files', {}, filesHead, list);
  const diffHead = h('div.dh');
  const diffBody = h('div.diff-scroll');
  const diff = h('section.changes-diff', {}, diffHead, diffBody);
  const changesBody = h('div.changes-body', {}, files, diff);
  const logHost = h('div.changes-log.hidden', { 'aria-label': `${info.name}'s terminal` });
  const summary = h('span.grow');
  const discardBtn = h('button.btn', { type: 'button', title: 'Throw away every uncommitted change in this checkout' }, 'Discard all');
  const commitBtn = h('button.btn', { type: 'button', title: 'git add -A && git commit' }, 'Commit…');
  const prSlot = h('span.pr-slot');
  // Only an agent can be asked to ship its work; a shell would run the prompt as a command.
  const shipBtn = info.kind === 'agent' ? h('button.btn.accent', { type: 'button' }, `Commit & open ${words().pr}`) : null;
  const tabs = h('nav.tabs.changes-tabs', { role: 'tablist', 'aria-label': 'Repositories' });
  const el = h(
    'div.modal.full.desk-changes',
    { role: 'dialog', 'aria-label': `${info.name}'s changes`, tabindex: -1 },
    h('header', {}, colorDot(info.color), h('div.titles', {}, title, branch), h('div.actions', {}, viewSeg, onTerminal ? terminalBtn : null), closeBtn),
    tabs,
    changesBody,
    logHost,
    h('footer', {}, summary, discardBtn, commitBtn, prSlot, shipBtn),
  );

  /** The worker's terminal, read-only, made the first time T shows it and attached until the window closes. */
  let term: Terminal | null = null;
  let hold: TerminalHold | undefined;
  let view: 'diff' | 'log' = 'diff';

  const openLog = () => {
    if (term) return term.scrollToBottom();
    const t = new Terminal({ fontFamily: TERM_FONT, fontSize: termFontSize(), lineHeight: 1.1, theme: TERM_THEME, minimumContrastRatio: 4.5, cursorBlink: false, disableStdin: true, scrollback: 5000, allowProposedApi: true });
    const unicode = new Unicode11Addon();
    t.loadAddon(unicode);
    t.unicode.activeVersion = '11';
    // Keys belong to the window (T, Esc), never to the program in the terminal.
    t.attachCustomKeyEventHandler(() => false);
    term = t;
    void loadFonts().then(() => {
      if (current?.modal !== modal || term !== t) return;
      t.open(logHost);
      // The PTY is shared and sized by whoever types to it, so this view takes its size rather than fitting.
      const w = store.workers.get(workerId);
      if (w) t.resize(w.cols, w.rows);
      // Its own snapshot, even when a terminal pane already holds this worker.
      hold = net.acquireTerminal(workerId, { snapshot: true });
    });
  };

  const setView = (next: 'diff' | 'log') => {
    if (next === view) return;
    view = next;
    for (const [btn, on] of [
      [diffViewBtn, next === 'diff'],
      [logViewBtn, next === 'log'],
    ] as const) {
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    changesBody.classList.toggle('hidden', next === 'log');
    logHost.classList.toggle('hidden', next !== 'log');
    if (next === 'log') openLog();
    el.focus();
  };
  diffViewBtn.addEventListener('click', () => setView('diff'));
  logViewBtn.addEventListener('click', () => setView('log'));

  /** The task card as a commit message or pull request text: its name, then its summary. */
  const taskText = () => {
    const task = store.workers.get(workerId)?.task;
    return task ? [task.name.trim(), task.summary.trim()].filter(Boolean).join('\n\n') : '';
  };

  const where = () => (state?.dir ? state.dir : 'the project folder');

  const requestDiff = () => {
    const f = state?.files.find((x) => x.path === selected);
    if (!selected || !f) return;
    loading = true;
    requestedSig = f.sig;
    net.send({ t: 'changes.diff', workerId, path: selected, repo });
  };

  const select = (p: string | null) => {
    if (p === selected) return;
    selected = p;
    shownSig = null;
    renderList();
    renderDiffHead();
    diffBody.replaceChildren();
    if (p) requestDiff();
    else renderEmpty();
  };

  const renderEmpty = () => {
    diffHead.replaceChildren();
    if (!state) return diffBody.replaceChildren(h('div.empty-state', {}, h('span.spinner')));
    if (state.error) return diffBody.replaceChildren(emptyState('🚧', `Couldn't read ${where()}`, state.error));
    diffBody.replaceChildren(
      emptyState(
        '🌱',
        state.base === 'HEAD' ? `Nothing uncommitted in ${where()}` : `${info.name} hasn't changed anything since ${state.base} yet`,
        'This window follows the checkout as the worker works, so changes show up here as they are made.',
      ),
    );
  };

  const renderList = () => {
    const s = state;
    list.replaceChildren();
    if (!s) return;
    const n = s.files.length;
    filesHead.textContent = n ? `${n}${s.more ? '+' : ''} changed file${n > 1 || s.more ? 's' : ''}` : 'Changed files';
    for (const f of s.files) {
      const li = h(
        'li.list-row',
        { class: f.path === selected ? 'on' : '', role: 'option', 'aria-selected': f.path === selected ? 'true' : 'false', tabindex: -1, onclick: () => select(f.path) },
        h('span.list-icon', {}, statusLetter(f, STATUS_WORD[f.status])),
        h('span.list-main', {}, pathLabel(f.path)),
        h('span.list-end', {}, h('span.dirty', f.uncommitted ? { class: 'on', title: 'Not committed yet' } : {}), plusMinus(f.additions, f.deletions, f.binary)),
      );
      list.append(li);
    }
    if (s.more) list.append(h('li.list-row.more', {}, `…and ${s.more} more`));
    list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  };

  const renderDiffHead = () => {
    const f = state?.files.find((x) => x.path === selected);
    if (!f) return diffHead.replaceChildren();
    const discardOne = h('button.btn.sm', { type: 'button', title: 'Throw away the uncommitted changes to this file' }, 'Discard');
    discardOne.addEventListener('click', () =>
      confirmDialog(`Discard the changes to ${f.path.split('/').pop()}?`, `This puts ${f.path} back to the last commit in ${where()}. ${f.status === '?' ? 'The file is deleted.' : 'Committed changes stay.'}`, 'Discard', () =>
        net.send({ t: 'changes.discard', workerId, path: f.path, repo }),
      ),
    );
    diffHead.replaceChildren(
      statusLetter(f),
      f.from ? h('span.path', { title: `${f.from} → ${f.path}` }, `${f.from} → ${f.path}`) : pathLabel(f.path),
      h('span.word', {}, f.uncommitted ? `${STATUS_WORD[f.status]} · not committed` : STATUS_WORD[f.status]),
      plusMinus(f.additions, f.deletions, f.binary),
    );
    if (f.uncommitted && !state?.busy) diffHead.append(discardOne);
  };

  const renderFooter = () => {
    const s = state;
    const busy = !!s?.busy;
    const uncommitted = s?.files.filter((f) => f.uncommitted).length ?? 0;
    const adds = s?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
    const dels = s?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;
    summary.replaceChildren();
    if (busy) summary.append(h('span.spinner'), h('span', {}, s!.busy!));
    else if (s && !s.error) {
      const bits: (string | HTMLElement)[] = [];
      if (s.files.length) bits.push(plusMinus(adds, dels));
      bits.push(uncommitted ? `${uncommitted} uncommitted` : s.files.length ? 'all committed' : '');
      if (s.ahead) bits.push(`${s.ahead} commit${s.ahead > 1 ? 's' : ''} ahead of ${s.base}`);
      if (!s.dir) bits.push(h('span', { title: "This worker works in the project folder itself, so this is everything uncommitted there — everyone's edits, not just its own." }, 'shared project folder'));
      else bits.push(h('span.where', { title: `Its own worktree at ${s.dir}` }, s.dir));
      summary.append(...bits.filter(Boolean).map((b) => (typeof b === 'string' ? h('span', {}, b) : b)));
    }
    discardBtn.disabled = busy || !uncommitted;
    commitBtn.disabled = busy || !uncommitted;
    commitBtn.textContent = uncommitted ? `Commit ${uncommitted} file${uncommitted > 1 ? 's' : ''}…` : 'Commit…';
    if (shipBtn) {
      const w = store.workers.get(workerId) ?? info;
      const why = s && !busy && !s.error ? shipBlocker(s, w.name, isAsleep(w.status), uncommitted) : '';
      shipBtn.disabled = !s || busy || !!s.error || !!why;
      shipBtn.textContent = s?.pr ? `Commit & push to ${words().ref(s.pr.number)}` : `Commit & open ${words().pr}`;
      shipBtn.title =
        why || `Asks ${w.name} to commit everything here and ${s?.pr ? `push it to ${words().pr} ${words().ref(s.pr.number)}` : `open a ${words().pull} against ${s?.prBase ?? 'the base branch'}`}, with the message from its task card`;
    }
    prSlot.replaceChildren();
    if (!s) return;
    if (s.pr) prSlot.append(h('a.btn.primary', { href: s.pr.url, target: '_blank', rel: 'noopener', title: `Open on ${words().site}` }, `${words().pr} ${words().ref(s.pr.number)} ↗`));
    else if (s.prBase) {
      const why = busy ? '' : uncommitted ? 'Commit first' : !s.ahead ? `Nothing on ${s.branch} that ${s.prBase} lacks yet` : '';
      const pr = h('button.btn.primary', { type: 'button', title: why || `Push ${s.branch} and open a ${words().pull} against ${s.prBase}` }, `Open ${words().pr}…`);
      pr.disabled = busy || !!why;
      pr.addEventListener('click', () =>
        openPrompt({
          title: `Open a ${words().pull}`,
          subtitle: `Pushes ${s.branch} to origin and opens a ${words().pr} against ${s.prBase}. The first line is the title; the rest is the description.`,
          initial: taskText() || (s.subject ?? ''),
          placeholder: 'Title',
          submitLabel: `Open ${words().pr} ↗`,
          recall: false,
          onSubmit: (text) => {
            const [first, ...rest] = text.split('\n');
            net.send({ t: 'changes.pr', workerId, title: first.trim(), body: rest.join('\n').trim(), repo });
          },
        }),
      );
      prSlot.append(pr);
    }
  };

  const renderHeader = () => {
    const w = store.workers.get(workerId);
    if (w) title.textContent = `${w.name} · changes`;
    const s = state;
    if (!s || s.error) branch.textContent = '';
    else branch.textContent = s.base === 'HEAD' ? `🌿 ${s.branch} · uncommitted changes` : `🌿 ${s.branch} · vs ${s.base}`;
    branch.title = branch.textContent;
    branch.classList.toggle('hidden', !branch.textContent);
  };

  const onState = (s: ChangesState) => {
    state = s;
    renderHeader();
    renderFooter();
    const f = selected ? s.files.find((x) => x.path === selected) : undefined;
    if (!f) {
      selected = null;
      shownSig = null;
      renderList();
      if (s.files.length) select(s.files[0].path);
      else renderEmpty();
      return;
    }
    renderList();
    renderDiffHead();
    if (shownSig !== null && shownSig !== f.sig && !loading) requestDiff();
  };

  const onMsg = (msg: ServerMsg) => {
    if (msg.t === 'term.data' && msg.workerId === workerId) term?.write(msg.data);
    else if (msg.t === 'term.snapshot' && msg.workerId === workerId && term) {
      const t = term;
      t.reset();
      t.resize(msg.cols, msg.rows);
      t.write(msg.data, () => t.scrollToBottom());
    } else if (msg.t === 'changes' && msg.state.workerId === workerId && msg.state.repo === repo) onState(msg.state);
    else if (msg.t === 'changes.diff' && msg.workerId === workerId && msg.repo === repo && msg.path === selected) {
      loading = false;
      shownSig = requestedSig;
      const f = state?.files.find((x) => x.path === selected);
      const text = msg.error ? h('div.empty-state', {}, h('p', {}, msg.error)) : renderDiff(msg.diff, msg.truncated);
      const type = f ? changedImageType(f.path) : undefined;
      // A picture's diff only says it differs, so show the picture instead. An SVG is text too: its diff stays below.
      if (f && type) diffBody.replaceChildren(renderPreview(workerId, repo, f), ...(type === 'image/svg+xml' ? [text] : []));
      else diffBody.replaceChildren(text);
      // The file changed again while the diff was on its way: fetch the fresh one.
      if (f && f.sig !== shownSig) requestDiff();
    }
  };

  const move = (delta: number) => {
    if (!state?.files.length) return;
    const i = state.files.findIndex((f) => f.path === selected);
    const next = state.files[Math.max(0, Math.min(state.files.length - 1, i + delta))];
    if (next) select(next.path);
  };
  el.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 't' || e.key === 'T') setView(view === 'diff' ? 'log' : 'diff');
    else if (view === 'log') return;
    else if (e.key === 'ArrowDown' || e.key === 'j') move(1);
    else if (e.key === 'ArrowUp' || e.key === 'k') move(-1);
    else return;
    e.preventDefault();
  });

  discardBtn.addEventListener('click', () => {
    const n = state?.files.filter((f) => f.uncommitted).length ?? 0;
    confirmDialog(
      `Discard all uncommitted changes at ${info.name}'s desk?`,
      `This puts ${n} file${n === 1 ? '' : 's'} in ${where()} back to the last commit and deletes new files. Commits stay.${state?.dir ? '' : " That folder is shared: anyone's uncommitted edits there go too."}`,
      'Discard everything',
      () => net.send({ t: 'changes.discard', workerId, repo }),
    );
  });
  commitBtn.addEventListener('click', () => {
    const n = state?.files.filter((f) => f.uncommitted).length ?? 0;
    openPrompt({
      title: `Commit ${n} file${n === 1 ? '' : 's'}`,
      subtitle: `Stages everything in ${where()} and commits it${state?.branch ? ` on ${state.branch}` : ''}.`,
      initial: taskText(),
      placeholder: 'What changed, and why',
      submitLabel: 'Commit',
      recall: false,
      onSubmit: (text) => net.send({ t: 'changes.commit', workerId, message: text, repo }),
    });
  });
  shipBtn?.addEventListener('click', () => {
    const s = state;
    const w = store.workers.get(workerId);
    if (!s?.branch || !s.prBase || !w) return;
    const { branch: branchName, prBase } = s;
    // Across repositories each checkout is a folder of the workspace the worker starts in.
    const folder = w.repos?.length ? (repo ? w.repos.find((r) => r.floor === repo)?.name : w.worktree?.path.split(/[\\/]/).pop()) : undefined;
    const send = (title: string, summary: string) => {
      const prompt = officePrompt('changes.ship', shipPromptVars(store.project?.forge, { title, summary, branch: branchName, base: prBase, folder, pr: s.pr?.number }));
      net.send({ t: 'worker.prompt', workerId, prompt, queue: w.status === 'working' });
      toast(`🌿 Asked ${w.name} to commit${s.pr ? ` and push to ${words().pr} ${words().ref(s.pr.number)}` : ` and open a ${words().pull}`}`);
      setView('log');
    };
    const name = w.task?.name.trim() ?? '';
    const about = w.task?.summary.trim() ?? '';
    if (name && about) return send(name, about);
    openPrompt({
      title: s.pr ? `Commit & push to ${words().pr} ${words().ref(s.pr.number)}` : `Commit & open a ${words().pull}`,
      subtitle: `${w.name} has no task card to write it from yet, so say what this work is. The first line is the title; the rest is the description. ${w.name} commits it, pushes ${branchName} and ${s.pr ? `updates ${words().pr} ${words().ref(s.pr.number)}` : `opens a ${words().pr} against ${prBase}`}.`,
      initial: taskText() || (s.subject ?? ''),
      placeholder: 'Title',
      submitLabel: `Ask ${w.name}`,
      onSubmit: (text) => {
        const [first, ...rest] = text.split('\n');
        send(first.trim(), rest.join('\n').trim());
      },
    });
  });
  terminalBtn.addEventListener('click', () => {
    onTerminal?.();
    modal.close();
  });

  /** Across repositories: a tab per repository, its own floor's first (no repo), each followed on its own. */
  const renderTabs = () => {
    const w = store.workers.get(workerId) ?? info;
    const repos = w.repos ?? [];
    tabs.classList.toggle('hidden', !repos.length);
    if (!repos.length) return tabs.replaceChildren();
    const own = w.worktree?.path.split(/[\\/]/).pop() ?? 'this project';
    tabs.replaceChildren(
      ...[{ id: undefined as string | undefined, name: own, pr: w.pr }, ...repos.map((r) => ({ id: r.floor as string | undefined, name: r.name, pr: r.pr }))].map((t) =>
        h(
          'button.tab',
          {
            type: 'button',
            role: 'tab',
            class: t.id === repo ? 'on' : '',
            'aria-selected': t.id === repo ? 'true' : 'false',
            title: t.id ? `Its worktree of ${t.name}` : `Its worktree of this floor's project, ${t.name}`,
            onclick: () => show(t.id),
          },
          t.name,
          t.pr ? h('small', {}, `#${t.pr.number}`) : null,
        ),
      ),
    );
  };

  /** Switches to another of its repositories: stops following the one on screen and follows that one. */
  const show = (next?: string) => {
    if (next === repo || (next && !store.workers.get(workerId)?.repos?.some((r) => r.floor === next))) return;
    net.send({ t: 'changes.unwatch', workerId, repo });
    repo = next;
    state = null;
    selected = null;
    shownSig = null;
    loading = false;
    renderTabs();
    renderHeader();
    renderList();
    renderFooter();
    renderEmpty();
    net.send({ t: 'changes.watch', workerId, repo });
  };

  listeners.add(onMsg);
  const unsub = store.on('workers', () => {
    const w = store.workers.get(workerId);
    if (!w) return modal.close();
    renderHeader();
    renderTabs();
    renderFooter();
    // Someone typing in its terminal resized the PTY: follow it, as the terminal window does.
    if (term && hold && (w.cols !== term.cols || w.rows !== term.rows)) term.resize(w.cols, w.rows);
  });
  const modal = openModal(el, {
    doing: `🌿 looking over ${info.name}'s changes`,
    onClose: () => {
      listeners.delete(onMsg);
      unsub();
      net.send({ t: 'changes.unwatch', workerId, repo });
      hold?.release();
      hold = undefined;
      term?.dispose();
      term = null;
      if (current?.modal === modal) current = null;
    },
  });
  current = { workerId, repo: () => repo, show, logging: () => !!hold, modal };
  previous?.modal.close();
  closeBtn.addEventListener('click', () => modal.close());
  if (repo && !info.repos?.some((r) => r.floor === repo)) repo = undefined;
  renderTabs();
  renderHeader();
  renderFooter();
  renderEmpty();
  net.send({ t: 'changes.watch', workerId, repo });
  setTimeout(() => el.focus(), 30);
}
