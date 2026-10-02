import { BUZZ_SECONDS, type Caffeine } from '../caffeine';
import { store } from '../state';
import { $, glyphText, h, openModal, STATUS_LABEL } from './dom';
import { usageLabel, usageTitle } from './usage';
import { providerLabel, providerUsageState, resolvedProvider, modelBadge } from './provider';
import { DESK_BY_ID } from '../../shared/layout';
import { controlHintsShown } from '../native/mode';
import { NATIVE_CONTROL_ROWS } from '../native/panel-text';

export function renderWorkers(onOpen: (id: string) => void) {
  const ul = $('workers');
  ul.replaceChildren();
  const workers = [...store.workers.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const w of workers) {
    const provider = w.kind === 'agent' ? providerLabel(w.provider, store.project) : null;
    const providerKind = w.kind === 'agent' ? resolvedProvider(w.provider, store.project) : undefined;
    const usageState = w.kind === 'agent' ? providerUsageState(w.provider, store.project, w.usage) : undefined;
    const usageNote =
      usageState === 'untracked' ? ' · usage untracked' : usageState === 'waiting' && providerKind === 'opencode' ? ' · waiting for metrics' : usageState === 'waiting' && providerKind === 'codex' ? ' · waiting for first report' : '';
    const badge = w.kind === 'agent' ? modelBadge(w.provider, w.activeModel ?? w.model, w.activeEffort ?? w.effort) : undefined;
    const sub = [
      provider && `⚙️ ${provider}${badge ? ` · ${badge}` : ''}${usageNote}`,
      w.worktree && `🌿 ${w.worktree.branch}`,
      w.repos?.length && `🗂️ ${w.repos.length + 1} repos`,
      w.pr && `🔀 PR #${w.pr.number}`,
      w.activity || w.title || w.prompt,
    ]
      .filter(Boolean)
      .join(' · ');
    ul.append(
      h(
        'li',
        { onclick: () => onOpen(w.id), title: `Open ${w.name}'s terminal` },
        h('span.dot', { style: `background:${w.color}` }),
        h('span.name', {}, w.name, sub ? h('span.sub', {}, ...glyphText(sub)) : null, usageState === 'tracked' && w.usage ? h('span.cost', { title: usageTitle(w.usage, providerKind) }, usageLabel(w.usage, providerKind)) : null),
        w.lost ? h('span.pill.lost', { title: 'Its worktree was deleted outside droid-office: open it to fix it' }, 'worktree deleted') : h('span.pill', { class: w.status }, STATUS_LABEL[w.status] ?? w.status),
      ),
    );
  }
  if (!workers.length) ul.append(h('li.empty', {}, controlHintsShown() ? 'Walk up to a desk and press E to hire one' : 'Walk up to a desk to hire one'));
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
  if (document.body.classList.contains('native-xr')) {
    openNativeHelp();
    return;
  }
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
    [
      '🏀',
      'The hoop on the west wall, by the exit door: E at the ball picks it up. Hold E (or the mouse, in first person) and let go when the meter is in the green to sink it. In first person it goes where you look. Q drops it. Everyone on your floor sees your shot',
    ],
    ['🍸', 'The elevator goes up to the rooftop bar: a DJ playing drum and bass under the lights, and the city all around. Press E at the bar for a drink (it goes to your head for a bit) and at the DJ booth for the air horn'],
    ['Drag / wheel', 'Orbit and zoom the camera in third person'],
    ['P', 'Prompt: give a task to a new or existing worker at the desk you face'],
    ['C', 'Changes: what the worker at the desk you face changed — files and diff, commit, discard, open a PR'],
    ['B', 'Open a shared shell (dev servers, git, tests) at an empty desk'],
    ['R', 'Resume a sleeping worker'],
    ['X', 'Send a worker home (frees the desk)'],
    ['F', 'Hang a picture from the web on a wall. Look at a picture and press E to move, edit or take it down'],
    ['Q', 'Put back the issue card in your hands (E at a note on the issues board, or Pick it up in an issue; then E at an empty desk, a worker or the queue board), or drop the basketball'],
    ['O', 'Open a pull request for a worker on its own branch, or see the one it has'],
    ['G / 1–6', 'Emote: hold G, point at one and let go (or tap G and click one), or press 1–6: wave, thumbs up, clap, dance, point, facepalm. Everyone on your floor sees it'],
    ['7', 'Draw the .44 Magnum (or holster it); click to fire at the worker under the crosshair. One shot drops it — confirm the kill or revive it'],
    ['/', 'Search every terminal on your floor, back to before the office last restarted'],
    [typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K', 'Command palette: a few letters find a worker, issue, PR, service, board or action. Enter opens it, Shift+Enter walks you over first'],
    ['Tab', 'The ☰ menu, top right: every window, and what shows on screen. Pin what you use most to the top bar'],
    ['Esc', 'Close any window and get back to looking around. In a terminal, Esc goes to the program (to back out of a menu or interrupt Claude)'],
    ['Shift + Esc', 'Leave a terminal (so does Ctrl + ], the ✕, or Esc after clicking off the terminal)'],
    ['⚙️', 'Settings (in the ☰ menu): switch between first and third person'],
  ];
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'Controls' }, h('header', {}, h('h2', {}, 'Controls'), close), h('div.body', {}, h('div.help-grid', {}, ...rows.flatMap(([k, v]) => [h('span.key', {}, k), h('span', {}, v)]))));
  const modal = openModal(el);
  close.addEventListener('click', () => modal.close());
}

function openNativeHelp() {
  const rows: readonly (readonly [string, string])[] = [
    ['Controllers', 'Galaxy XR motion controllers are required. Look around naturally; the headset tracks your head directly.'],
    ...NATIVE_CONTROL_ROWS,
    ['Find anything', 'Choose Find anything on Home or in the menu to search workers, issues, PRs, services and boards.'],
    ['Workers', 'Use a desk to hire a worker or open its terminal. Home has Prompt, Resume, Changes, Pull request and Send home for each worker, plus Hire a worker and Open a shell.'],
    [
      'Terminal',
      'Type on a keyboard paired to the headset: its keys go to the open terminal or the field you chose. There is no on-screen keyboard. The terminal’s − and + change text size; Picture attaches a screenshot or image from the headset.',
    ],
    ['Issues & PRs', 'Open a board in the office or from Home. Read an issue, pick up its card, assign it to a worker or add it to the queue. PRs keep the desktop conversation, file review and confirmation actions.'],
    ['Held card', 'Aim at a desk or the queue and press the trigger to place the card. Put back in Home returns it to the board. A physical card grab uses the same shared issue.'],
    ['Floors', 'Aim at a physical floor button in the elevator and press the trigger. The Elevator tile and the floor name also open the original floor chooser.'],
    ['Graphics', 'Graphics & performance controls foveation, world resolution, the rendering-detail view and the persistent FPS counter. The app requests 90 Hz; delayed office updates or a lower rate are shown explicitly.'],
  ];
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h(
    'section.modal.native-help',
    { role: 'dialog', 'aria-label': 'Headset controls' },
    h('header', {}, h('h2', {}, 'Headset controls'), close),
    h('div.body', {}, h('div.help-grid', {}, ...rows.flatMap(([label, description]) => [h('strong', {}, label), h('span', {}, description)]))),
  );
  const modal = openModal(el);
  close.addEventListener('click', () => modal.close());
}
