import type { FactoryRepoChoice } from '../../shared/factory-computers';
import { factoryFetch } from '../factory';
import { store } from '../state';
import { h } from './dom';

// What the Computers window's two tabs share (factory-computers.ts, factory-environments.ts): its
// panes, buttons that run an action, list rows you pick, and the repository picker.

/** What a pane shows; `footer` is its buttons on the right of the window's footer. */
export type Section = { nodes: Node[]; render(): void; dispose?(): void; footer?: Node[] };

/** Click, Enter or Space on a list row. */
export function onPick(row: HTMLElement, pick: () => void) {
  row.addEventListener('click', pick);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick();
    }
  });
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A button that runs `run` with its label swapped for "…" meanwhile, its result or error in `out`. */
export function actionButton(label: string, title: string, run: () => Promise<string | undefined>, out: HTMLElement, cls = ''): HTMLButtonElement {
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
export function floorRepo(): string | undefined {
  const f = store.floors.find((x) => x.id === store.floor);
  return f?.repo && store.project?.forge !== 'gitlab' && /^[\w.-]+\/[\w.-]+$/.test(f.repo) ? f.repo : undefined;
}

/** The floor's name the way Factory names things: lower case, digits and hyphens. */
export function floorSlug(): string {
  return (
    (store.floors.find((f) => f.id === store.floor)?.name ?? 'office')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'office'
  );
}

export const shortRepo = (url: string) => url.replace(/^https:\/\/github\.com\//, '');

/**
 * Picks repositories from the ones Factory's GitHub app sees (the computers feature's
 * /repositories), the picked ones first. `picked` holds their URLs and is changed in place.
 */
export function repoPicker(picked: Set<string>, onChange: () => void = () => {}) {
  const here = floorRepo();
  let repos: FactoryRepoChoice[] | null = null;
  let reposError = '';
  const filter = h('input.input', { type: 'search', placeholder: 'Find a repository…', 'aria-label': 'Find a repository', spellcheck: 'false' }) as HTMLInputElement;
  const list = h('ul.list.boxed.cmp-repos');
  const muted = (text: string, cls = '') => h('li.list-row.cmp-muted', { class: cls }, h('span.list-main', {}, h('span.list-meta', {}, text)));
  const paint = () => {
    if (reposError) return list.replaceChildren(muted(reposError, 'bad'));
    if (!repos) return list.replaceChildren(...[0, 1, 2].map(() => h('li.skeleton.cmp-skeleton', { 'aria-label': 'Reading the repositories Factory sees…' })));
    const q = filter.value.trim().toLowerCase();
    const all = [...repos];
    for (const u of picked) if (!all.some((r) => r.url === u)) all.unshift({ fullName: shortRepo(u), url: u });
    const shown = all.filter((r) => !q || r.fullName.toLowerCase().includes(q)).sort((a, b) => Number(picked.has(b.url)) - Number(picked.has(a.url)));
    list.replaceChildren(
      ...shown.slice(0, 60).map((r) => {
        const box = h('input', { type: 'checkbox', checked: picked.has(r.url) }) as HTMLInputElement;
        box.addEventListener('change', () => {
          if (box.checked) picked.add(r.url);
          else picked.delete(r.url);
          paint();
          onChange();
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
  filter.addEventListener('input', paint);
  void factoryFetch<{ repositories: FactoryRepoChoice[] }>('computers', '/repositories').then(
    (r) => {
      repos = r.repositories;
      paint();
    },
    (err: Error) => {
      reposError = `Couldn’t list repositories: ${err.message}`;
      paint();
    },
  );
  paint();
  return { nodes: [filter, list], paint };
}
