import { BUZZ_SECONDS, type Caffeine } from '../caffeine';
import { store } from '../state';
import { $, glyphText, h, openModal, STATUS_LABEL } from './dom';
import { modelBadge } from './models';
import { windowHeader } from './kit';
import { cloudLine } from './factory-cloud';
import { DESK_BY_ID } from '../../shared/layout';
import { teamSummary, workersByTeam } from '../../shared/team';
import { PROVIDER_LABEL, processLabel, statusWord } from '../../shared/guests';
import { creditsNote } from '../../shared/factory-sessions';

export function renderWorkers(onOpen: (id: string) => void) {
  const ul = $('workers');
  ul.replaceChildren();
  const workers = workersByTeam(store.workers.values());
  for (const w of workers) {
    const lead = w.lead ? store.workers.get(w.lead) : undefined;
    const team = store.teamOf(w.id);
    const badge = w.kind === 'agent' ? modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : undefined;
    const sub = [
      teamSummary(team),
      w.kind === 'agent' && `⚙️ ${w.guest ? PROVIDER_LABEL[w.guest.provider] : 'Droid'}${badge ? ` · ${badge}` : ''}`,
      w.cloud && cloudLine(w),
      w.cloud?.error && `⚠️ ${w.cloud.error}`,
      w.worktree && `🌿 ${w.worktree.branch}`,
      w.repos?.length && `🗂️ ${w.repos.length + 1} repos`,
      w.pr && `🔀 PR #${w.pr.number}`,
      creditsNote(store.factory.sessions, w.sessionId),
      w.guest && `🚪 outside the office · pid ${w.guest.pid}`,
      w.activity || w.title || w.prompt,
    ]
      .filter(Boolean)
      .join(' · ');
    ul.append(
      h(
        'li',
        {
          onclick: () => onOpen(w.id),
          title: w.cloud
            ? `Open ${w.name}'s window: its session runs on ${w.cloud.computerName}`
            : w.guest
              ? `${w.name} runs outside the office (${processLabel(w.guest)}): see what the office knows of it`
              : lead
                ? `Open ${w.name}'s terminal (a subagent of ${lead.name})`
                : `Open ${w.name}'s terminal`,
          class: lead ? 'subagent' : team.length ? 'lead' : undefined,
          style: lead ? `--lead:${lead.color}` : undefined,
        },
        h('span.dot', { style: `background:${w.color}` }),
        h('span.name', {}, w.name, sub ? h('span.sub', {}, ...glyphText(sub)) : null),
        w.lost ? h('span.pill.lost', { title: 'Its worktree was deleted outside droid-office: open it to fix it' }, 'worktree deleted') : h('span.pill', { class: w.status }, statusWord(w, STATUS_LABEL)),
      ),
    );
  }
  if (!workers.length) ul.append(h('li.empty', {}, 'Walk up to a desk and press E to hire one'));
  // The count is the workers hired onto desks and bean bags (and a meeting's table): the board agents
  // standing at the Issues, PR and queue kiosks are listed but aren't counted.
  const hired = workers.filter((w) => !DESK_BY_ID.get(w.deskId)?.station).length;
  $('worker-count').textContent = hired ? String(hired) : '';
}

let caffeineKey = '';
/** The caffeine meter: a cup per coffee in a row, and a bar that drains over the buzz's minute. */
export function renderCaffeine(caffeine: Caffeine, now: number) {
  const left = caffeine.left(now);
  const jittery = caffeine.jitter(now) > 0;
  const k = `${Math.ceil(left)}|${caffeine.cups}|${jittery}`;
  if (k === caffeineKey) return;
  caffeineKey = k;
  const el = $('caffeine');
  el.classList.toggle('hidden', !left);
  el.classList.toggle('jittery', jittery);
  if (!left) return;
  $('caffeine-cups').textContent = '☕'.repeat(Math.min(caffeine.cups, 3));
  // The bar eases down a second at a time (see its CSS transition), so aim for where it will be in one.
  $('caffeine-fill').style.width = `${(Math.max(0, left - 1) / BUZZ_SECONDS) * 100}%`;
  $('caffeine-left').textContent = `${Math.ceil(left)}s`;
}

/** A row of the help sheet: what it does, a line more about it, and its keys ('or' between two that each do it). */
type HelpRow = [what: string, more: string, keys: string[]];

export function openHelp() {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const sections: [string, HelpRow[]][] = [
    [
      'Move',
      [
        ['Walk', 'Hold Shift to run', ['W', 'A', 'S', 'D']],
        ['Jump', '', ['Space']],
        ['Look around', 'Click to capture the mouse, Esc frees it', ['Mouse']],
        ['Next worker that needs you', 'Whoever has waited longest. Arrows at the screen’s edge point to the ones out of sight', ['N']],
        ['Change floors', 'Every project is a floor: step into the elevator on the north wall, or click the project name top left. It goes up to the rooftop bar too', ['E']],
      ],
    ],
    [
      'Use things',
      [
        ['Use what you look at', 'Hire a worker, open its terminal, read a board, call a meeting, play the jukebox, sit down (walk off to get up)', ['Click', 'or', 'E']],
        ['Ask a board agent', 'One stands at the issues board, the PR board and the task queue. E there and type what you want; O opens its terminal, X sends it home', ['E']],
        ['Put back an issue card', 'Pick one up with E on the issues board or in an issue, then E at an empty desk, a worker or the queue', ['Q']],
        ['Hang a picture', 'From the web, on a wall. E at a picture moves, edits or takes it down', ['F']],
      ],
    ],
    [
      'Workers',
      [
        ['Prompt', 'Give a task to a new or existing worker at the desk you face', ['P']],
        ['Changes', 'Files and diff of the worker you face: commit, discard, open a PR', ['C']],
        ['Shared shell', 'Dev servers, git, tests, at an empty desk', ['B']],
        ['Resume', 'Wake a sleeping worker', ['R']],
        ['Send home', 'Frees the desk', ['X']],
        ['Pull request', 'Open one for a worker on its own branch, or see the one it has', ['O']],
      ],
    ],
    [
      'Windows',
      [
        ['Command palette', 'Find a worker, issue, PR, service, board or action. Shift+Enter walks you there first', mac ? ['⌘', 'K'] : ['Ctrl', 'K']],
        ['Menu', 'Every window, and what shows on screen. Pin what you use most to the top bar', ['Tab']],
        ['Search terminals', 'Every terminal on your floor, back to before the office last restarted', ['/']],
        ['Close a window', 'In a terminal, Esc goes to the program (to back out of a menu or interrupt Droid)', ['Esc']],
        ['Leave a terminal', 'So does Ctrl + ], the ✕, or Esc after clicking off the terminal', ['Shift', 'Esc']],
      ],
    ],
    [
      'Fun',
      [
        ['Emote', 'Hold G and point at one, or press 1–6: wave, thumbs up, clap, dance, point, facepalm. With the Magnum drawn they are its tricks', ['G', 'or', '1–6']],
        ['.44 Magnum', 'Draw or holster it; click to fire at the worker under the crosshair. E revives a downed one; shoot it again to finish it and call the medics', ['7']],
        ['Coffee', 'At the kitchen machine: a minute of quicker walking and higher jumps. Three cups in a row gives you the jitters', ['E']],
        ['Arcade cabinet', 'BLOCKFALL, in the lounge: arrows or WASD move and turn, Space drops, C holds, P pauses. E watches whoever plays; a worker needing input pauses it', ['E']],
        ['The gong', 'Rings when a pull request merges: confetti, and every worker dances on its desk. E bangs it yourself', ['E']],
        ['Rooftop bar', 'Up the elevator: a DJ and the city. E at the bar for a drink, at the DJ booth for the air horn', ['E']],
      ],
    ],
  ];
  const keys = (ks: string[]) => h('span.help-keys', {}, ...ks.map((k) => (k === 'or' ? h('span.help-or', {}, 'or') : h('kbd.key', {}, k))));
  const row = ([what, more, ks]: HelpRow) => h('div.group-row.help-row', {}, h('span.group-label', {}, h('b', {}, what), more ? h('small', {}, more) : null), keys(ks));
  const el = h(
    'div.modal.xl.help',
    { role: 'dialog', 'aria-label': 'Controls' },
    windowHeader('Controls', 'Every key in the office, and what it does'),
    h(
      'div.body',
      {},
      h('div.help-sections', {}, ...sections.map(([name, rows], i) => h('section.section.help-section', {}, h('div.eyebrow', {}, h('span.no', {}, String(i + 1).padStart(2, '0')), name), h('div.group', {}, ...rows.map(row))))),
    ),
  );
  openModal(el);
}
