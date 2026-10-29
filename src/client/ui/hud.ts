import { store, type Sidearm } from '../state';
import { $, h, openModal, STATUS_LABEL } from './dom';
import { droidDisplayName, modelBadge } from './models';
import { modelLogo } from './model-logo';
import { withoutGlyph } from '../world/glyph';
import { windowHeader } from './kit';
import { cloudLine } from './factory-cloud';
import { DESK_BY_ID } from '../../shared/layout';
import { TEAM_MARK, teamStanding, teamSummary, workersByTeam } from '../../shared/team';
import { PROVIDER_LABEL, processLabel, statusWord } from '../../shared/guests';
import { creditsNote } from '../../shared/factory-sessions';
import { workerActivity } from '../../shared/status';

export function renderWorkers(onOpen: (id: string) => void) {
  const ul = $('workers');
  ul.replaceChildren();
  const workers = workersByTeam(store.workers.values());
  for (const w of workers) {
    const lead = w.lead ? store.workers.get(w.lead) : undefined;
    const team = store.teamOf(w.id);
    const model = w.kind === 'agent' ? (w.activeModel ?? w.model) : undefined;
    const badge = w.kind === 'agent' ? modelBadge(model, w.activeEffort ?? w.effort) : undefined;
    const standing = teamStanding(w, (id) => store.workers.get(id));
    const sub = [
      standing && `${TEAM_MARK[standing.badge.emblem]} ${standing.label}`,
      teamSummary(team),
      w.kind === 'agent' && `⚙️ ${w.guest ? PROVIDER_LABEL[w.guest.provider] : 'Droid'}${badge ? ` · ${badge}` : ''}`,
      w.cloud && cloudLine(w),
      w.cloud?.error && `⚠️ ${w.cloud.error}`,
      w.worktree && `🌿 ${w.worktree.branch}`,
      w.repos?.length && `🗂️ ${w.repos.length + 1} repos`,
      w.pr && `🔀 PR #${w.pr.number}`,
      creditsNote(store.factory.sessions, w.sessionId),
      w.guest && `🚪 outside the office · pid ${w.guest.pid}`,
      w.task?.name,
      workerActivity(w) || w.title || w.prompt,
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
        h('span.name', {}, w.name, sub ? h('span.sub', {}, model ? modelLogo({ id: model, name: droidDisplayName(model) }) : null, withoutGlyph(sub)) : null),
        w.lost ? h('span.pill.lost', { title: 'Its worktree was deleted outside droid-office: open it to fix it' }, 'worktree deleted') : h('span.pill', { class: w.status }, statusWord(w, STATUS_LABEL)),
      ),
    );
  }
  if (!workers.length) ul.append(h('li.empty', {}, 'Walk up to a desk and press E to hire one'));
  // The count is the workers hired onto desks and bean bags: the board agents
  // standing at the Issues, PR, Pipelines and Team kiosks are listed but aren't counted.
  const hired = workers.filter((w) => !DESK_BY_ID.get(w.deskId)?.station).length;
  $('worker-count').textContent = hired ? String(hired) : '';
}

/** A row of the help sheet: what it does, a line more about it, and its keys ('or' between two that each do it). */
type HelpRow = [what: string, more: string, keys: string[]];

/** `sidearm` is what `7` puts in your hand (Settings → You), so its row says what it does. */
export function openHelp(sidearm: Sidearm = 'wand') {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const seven: HelpRow =
    sidearm === 'wand'
      ? ['Droid wand', 'Click opens a worker’s terminal, including board agents. Hold for a charged shot to send a worker home. 2 lifts a worker, 3 starts a dance party, and 4 asks one closely aimed worker to ship', ['7']]
      : ['.44 Magnum', 'Draw or holster it; click a worker to open its terminal. Hold for a charged shot to send it skyward', ['7']];
  const sections: [string, HelpRow[]][] = [
    [
      'Move',
      [
        ['Walk', 'Hold Shift to run', ['W', 'A', 'S', 'D']],
        ['Jump', '', ['Space']],
        ['Look around', 'Click to capture the mouse, Esc frees it', ['Mouse']],
        ['Next worker that needs you', 'Whoever has waited longest. Arrows at the screen’s edge point to the ones out of sight', ['N']],
        ['Change floors', 'Every project is a floor: step into the elevator on the north wall, or click the project name top left. It goes up to the roof too', ['E']],
        ['Teleport to a floor', 'Go straight to the numbered floor, keeping your position and view. Command+0 is floor 10. Works in terminals and windows too', ['⌘1–9', '⌘0']],
      ],
    ],
    [
      'Use things',
      [
        ['Use what you look at', 'Hire a worker, open its terminal, read a board, play the jukebox, sit down (walk off to get up)', ['Click', 'or', 'E']],
        ['Ask a board agent', 'One stands at the issues board, the PR board, the Pipelines board and the Team kiosk. E there and type what you want; O opens its terminal, X sends it home', ['E']],
        ['Put back an issue card', 'Pick one up with E on the issues board or in an issue, then E at an empty desk or a worker', ['Q']],
        ['Hang a picture', 'From the web, on a wall. E at a picture moves, edits or takes it down', ['F']],
      ],
    ],
    [
      'Workers',
      [
        ['Prompt', 'Give a task to a new or existing worker at the desk you face', ['P']],
        ['Changes', 'Files and diff of the worker you face: commit, discard, open a PR', ['C']],
        ['Shared shell', 'Dev servers, git, tests, at an empty desk', ['B']],
        ['Previous / next terminal', 'Cycle through this floor’s running agent and shell terminals in desk order, then the boss monitor’s shell. Wraps at either end; stopped workers stay asleep', ['⌘←', '⌘→']],
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
        [
          'Emote',
          `Hold G and point at one, or press 1–6: wave, thumbs up, clap, dance, point, facepalm. ${sidearm === 'wand' ? 'With the wand drawn they are its spells: Lumos, swish and flick, sparkler, ship it, run the build, Protego' : 'With the Magnum drawn they are its tricks'}`,
          ['G', 'or', '1–6'],
        ],
        seven,
        ['The gong', 'Rings when a pull request merges: confetti, and every worker dances on its desk. E bangs it yourself', ['E']],
        ['Rooftop', 'Up the elevator: an empty deck, and the city all around', ['E']],
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
