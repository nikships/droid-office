import { BUZZ_SECONDS, type Caffeine } from '../caffeine';
import { store } from '../state';
import { $, glyphText, h, openModal, STATUS_LABEL } from './dom';
import { modelBadge } from './models';
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

export function openHelp() {
  const rows: [string, string][] = [
    ['W A S D', 'Walk (hold Shift to run)'],
    ['Space', 'Jump'],
    ['☕', 'Press E at the coffee machine in the kitchen for a minute of quicker walking and higher jumps. Three cups in a row gives you the jitters'],
    ['Mouse', 'Look around in first person (click to capture the mouse, Esc to free it)'],
    [
      'Click / E',
      'Use what you look at: hire a worker, open its terminal, read a board, call a meeting in the meeting room, put a song on the jukebox, tee off from the balcony, sit on a couch, a beanbag, a chair or the balcony bench (walk off to get up)',
    ],
    ['🛗', 'Every project is a floor: step into the elevator on the north wall and press E (or click the project name, top left) to go to another one or add a project'],
    ['🤖', 'An agent stands by the issues board, the PR board and the task queue. Press E at one and type what you want: it runs as an agent that knows that board. O there opens its terminal, X sends it home'],
    [
      '🕹️',
      'The arcade cabinet in the lounge plays BLOCKFALL: arrows (or WASD) move and turn, Space drops, C holds, P pauses. Everyone on the floor sees your game on it, and E there watches whoever is playing. One of your workers needing input pauses it',
    ],
    ['🎉', 'Whenever a pull request merges, the gong next to the PR board rings, confetti rains down all over the floor and every worker gets up on its desk for a quick dance. Walk up to the gong and press E to bang it yourself'],
    ['N', "Next worker that needs you: go to whoever has waited longest (needs input, or done and nobody's looked), and again for the next one. Arrows at the edge of the screen point to the ones out of sight"],
    ['🍸', 'The elevator goes up to the rooftop bar: a DJ playing drum and bass under the lights, and the city all around. Press E at the bar for a drink (it goes to your head for a bit) and at the DJ booth for the air horn'],
    ['Drag / wheel', 'Orbit and zoom the camera in third person'],
    ['P', 'Prompt: give a task to a new or existing worker at the desk you face'],
    ['C', 'Changes: what the worker at the desk you face changed — files and diff, commit, discard, open a PR'],
    ['B', 'Open a shared shell (dev servers, git, tests) at an empty desk'],
    ['R', 'Resume a sleeping worker'],
    ['X', 'Send a worker home (frees the desk)'],
    ['F', 'Hang a picture from the web on a wall. Look at a picture and press E to move, edit or take it down'],
    ['Q', 'Put back the issue card in your hands (E at a note on the issues board, or Pick it up in an issue; then E at an empty desk, a worker or the queue board)'],
    ['O', 'Open a pull request for a worker on its own branch, or see the one it has'],
    [
      'G / 1–6',
      'Emote: hold G, point at one and let go (or tap G and click one), or press 1–6: wave, thumbs up, clap, dance, point, facepalm. With the Magnum drawn they are its tricks: twirl, inspect, cylinder spin, yy, blow the smoke off, flip',
    ],
    [
      '7',
      'Draw the .44 Magnum (or holster it; mash it and each press cancels the last); click to fire at the worker under the crosshair. One shot drops it — walk up and press E to revive it, or shoot it again to finish it and call the medics now',
    ],
    ['/', 'Search every terminal on your floor, back to before the office last restarted'],
    [typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K', 'Command palette: a few letters find a worker, issue, PR, service, board or action. Enter opens it, Shift+Enter walks you over first'],
    ['Tab', 'The ☰ menu, top right: every window, and what shows on screen. Pin what you use most to the top bar'],
    ['Esc', 'Close any window and get back to looking around. In a terminal, Esc goes to the program (to back out of a menu or interrupt Droid)'],
    ['Shift + Esc', 'Leave a terminal (so does Ctrl + ], the ✕, or Esc after clicking off the terminal)'],
    ['⚙️', 'Settings (in the ☰ menu): switch between first and third person'],
  ];
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'Controls' }, h('header', {}, h('h2', {}, 'Controls'), close), h('div.body', {}, h('div.help-grid', {}, ...rows.flatMap(([k, v]) => [h('span.key', {}, k), h('span', {}, v)]))));
  const modal = openModal(el);
  close.addEventListener('click', () => modal.close());
}
