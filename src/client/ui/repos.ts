import type { WorkerInfo } from '../../shared/protocol';
import { isBusy } from '../../shared/status';
import { store } from '../state';
import { h, openModal } from './dom';

// A worker across repositories (see WorkerInfo.repos): one task in worktrees of several floors'
// projects, all on the same branch, with a pull request in each repository it commits to.

/** Each of a worker's repositories, its own floor's first (no `floor`): the folder in its workspace, and its pull request. */
export function workerRepos(w: WorkerInfo): { floor?: string; name: string; pr?: { number: number; url: string } }[] {
  if (!w.worktree) return [];
  return [{ name: w.worktree.path.split(/[\\/]/).pop() || 'project', pr: w.pr }, ...(w.repos ?? []).map((r) => ({ floor: r.floor, name: r.name, pr: r.pr }))];
}

export interface RepoPullsActions {
  /** Its own floor's pull request, in the PR window. */
  openPull(number: number, url: string): void;
  /** Push and open the ones still missing ('worker.pr'). */
  openMissing(): void;
  /** The Changes window, on that repository's tab. */
  changes(repo?: string): void;
}

/**
 * O at the desk of a worker across repositories, once it has a pull request: each repository with
 * its pull request (or none yet) and its changes, and a button that opens the missing ones.
 */
export function openRepoPulls(workerId: string, actions: RepoPullsActions) {
  const title = h('h2');
  const note = h('p.repo-pulls-note');
  const list = h('ul.list.boxed.repo-pulls');
  const close = h('button.btn.ghost', { type: 'button' }, 'Close');
  const missing = h('button.btn.primary', { type: 'button' }, 'Open the missing PRs');
  const el = h('div.modal.md', { role: 'dialog', 'aria-label': 'Pull requests' }, h('header', {}, title), h('div.body.stack', {}, note, list), h('footer', {}, h('span.grow'), close, missing));

  const render = () => {
    const w = store.workers.get(workerId);
    if (!w?.worktree) return modal.close();
    const repos = workerRepos(w);
    title.textContent = `🔀 ${w.name}'s pull requests`;
    note.replaceChildren(
      `One change across ${repos.length} repositories, each on `,
      h('code.wt-branch', { title: w.worktree.branch }, w.worktree.branch),
      '. Each repository it commits to gets a pull request of its own, and each one lists the others.',
    );
    list.replaceChildren(
      ...repos.map((r) => {
        const floor = r.floor ? store.floors.find((f) => f.id === r.floor)?.name : store.currentFloor()?.name;
        const pr = r.pr;
        return h(
          'li.list-row',
          {},
          h('span.list-icon', { 'aria-hidden': 'true' }, '📁'),
          h('span.list-main', {}, h('span.list-title', { title: r.name }, r.name), h('span.list-meta', {}, floor ? `${floor} floor${r.floor ? '' : ' · this one'}` : 'no longer in the building')),
          h(
            'span.list-end',
            {},
            pr
              ? h('button.btn.sm', { type: 'button', title: 'Open it', onclick: () => (r.floor ? window.open(pr.url, '_blank', 'noopener') : (modal.close(), actions.openPull(pr.number, pr.url))) }, `#${pr.number}${r.floor ? ' ↗' : ''}`)
              : h('span.pill', {}, 'No PR yet'),
            h('button.btn.sm', { type: 'button', title: `What ${w.name} changed in ${r.name}`, onclick: () => (modal.close(), actions.changes(r.floor)) }, 'Changes'),
          ),
        );
      }),
    );
    const busy = isBusy(w.status);
    missing.classList.toggle(
      'hidden',
      repos.every((r) => r.pr),
    );
    missing.disabled = !!w.prOpening || busy;
    missing.textContent = w.prOpening ? 'Opening…' : 'Open the missing PRs';
    missing.title = busy ? `${w.name} is still at it — wait until it's done` : 'Pushes the branch in each repository with commits and no pull request yet, and opens one there';
  };

  const unsub = store.on('workers', () => render());
  const modal = openModal(el, { doing: '🔀 looking over pull requests', onClose: () => unsub() });
  close.addEventListener('click', () => modal.close());
  missing.addEventListener('click', () => actions.openMissing());
  render();
  setTimeout(() => close.focus(), 30);
}
