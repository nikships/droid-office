import type { Net } from '../net';
import { store, type Settings, type Sidearm } from '../state';
import { askNotifyPermission, notifyPermission, type DesktopNotifier } from '../notify';
import { SUBAGENT_MAX_PER_LEAD, type AgentChoice, type SubagentSettings } from '../../shared/protocol';
import { SETTINGS_CARDS, SETTINGS_PANES, searchSettings, settingsPaneAfter, type SettingsCardTitle, type SettingsPane } from '../../shared/settings-nav';
import { claimEscape, h, openModal, timeAgo } from './dom';
import { onJiraSetup } from './jira';
import { choices, field, toggle as kitToggle } from './kit';
import { agentFields, modelBadge, officeChoice } from './models';
import { subagentModelPicker } from './subagent-models';
import { openPromptEditor, rewrittenPrompts } from './prompts';
import { hotReloadSettings } from './hot-reload';
import { presetEditor } from './prompt-box';
import { factoryKeySettings } from './factory-settings';
import { subscriptionsSettings } from './subscriptions-settings';
import { droidSettings } from './droid-settings';
import { hiddenModelSettings } from './hidden-models';
import { workerLabelSettings } from './worker-labels';
import { openHostUpdate } from './host-update';
import { openPhone, pairedPhones } from './phone';
import { companionState, openCompanion } from './companion';
import type { PairingState } from '../../shared/devices';
import type { PairedDevice } from '../../shared/devices';
import { INCLUDE_FILE, SETUP_FILE, describeSetup, parsePatterns } from '../../shared/worktree-setup';
import {
  FPS_CAPS,
  LOOK_SENSITIVITY_MAX,
  LOOK_SENSITIVITY_MIN,
  LOOK_SENSITIVITY_STEP,
  OVERHEAD_STEP,
  RENDER_SCALE_MIN,
  RENDER_SCALE_STEP,
  normalizeLookSensitivity,
  normalizeOverhead,
  normalizeScale,
  type FpsCap,
  type GraphicsSettings,
} from '../graphics';

const SIDEARMS: [Sidearm, string, string, string][] = [
  ['wand', '🪄', 'Droid wand', 'Flick a spell at a worker to open its terminal. Five spells on 1–5.'],
  ['magnum', '🔫', '.44 Magnum', 'Fire at a worker to open its terminal. Hold for a charged dismissal.'],
];

export type { SettingsPane };

/** What a settings row holds besides its title: a description under it, a control on its right, and anything wide (a form, a picker) full width under the label. */
interface RowParts {
  desc?: Node | null;
  control?: Node | null;
  below?: Node[];
}

/** One setting as a row: its name and a description on the left, whatever sets it on the right. */
const setting = (title: string, { desc, control, below = [] }: RowParts) =>
  h('div.group-row', { class: below.length ? 'block' : '' }, h('div.group-label', {}, h('b', {}, title), desc), control ? h('div.setting-control', {}, control) : null, ...below);

/** A card from SETTINGS_CARDS, so a setting can't show up without a category. */
const card = (title: SettingsCardTitle, parts: RowParts) => setting(title, parts);

/** Rows under an eyebrow, in one bordered block. */
const group = (title: string | null, ...rows: Node[]) => h('div.settings-group', {}, title ? h('h4.group-title', {}, title) : null, h('div.group', {}, ...rows));

/** A setting's description, its text set by whoever paints it. */
const desc = (text = '') => h('small', {}, text);

/** Where Settings was last, so it opens there again. */
let lastPane: SettingsPane = 'you';

/** An on/off switch for one setting; `paint` sets it from `now`. */
function toggle(label: string, now: () => boolean, pick: (on: boolean) => void) {
  const el = kitToggle({
    label,
    bare: true,
    onChange: (on) => {
      if (on !== now()) pick(on);
    },
  });
  return { el, paint: () => (el.input.checked = now()) };
}

/** A row of radio buttons for one setting; `paint` redraws it from `now`. */
function radios<T>(label: string, options: readonly (readonly [T, string])[], now: () => T, pick: (value: T) => void) {
  const row = h('div.seg', { role: 'radiogroup', 'aria-label': label });
  const paint = () => {
    const at = now();
    row.replaceChildren(
      ...options.map(([value, text]) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(at === value),
            class: at === value ? 'on' : '',
            onclick: () => {
              if (now() !== value) pick(value);
            },
          },
          text,
        ),
      ),
    );
  };
  return { row, paint };
}

/** The sky and clock outside as a quiet value: its leading weather glyph spaced from the words. */
const outsideNow = (now: string) => {
  const icon = now.match(/^\p{Extended_Pictographic}\uFE0F?/u)?.[0] ?? '';
  return h('span.outside-now', {}, icon ? h('span.outside-icon', { 'aria-hidden': 'true' }, icon) : null, h('span', {}, now.slice(icon.length)));
};

/** A worker choice in words: "Droid on Opus 5.5 · High", or Droid's own default. */
function choiceLabel(c: AgentChoice): string {
  const badge = modelBadge(c.model, c.effort);
  return badge ? `Droid on ${badge}` : 'Droid on its default model';
}

/** The Subagents settings as the office keeps them, without who set them or where the skill is. */
function subagentSettings(): SubagentSettings {
  const { on, deskWorkers, skill, worktree, maxPerLead, wakeLead, visits, agent, models } = store.subagents;
  return { on, deskWorkers, skill, worktree, maxPerLead, wakeLead, visits: visits ?? true, ...(agent ? { agent } : {}), ...(models?.length ? { models } : {}) };
}

/**
 * `outside` describes the sky over the office (see describeSky), once the server has said. `first` opens on that category instead of the last one.
 * `hireForSetup` opens the hire window with a task to write the repository's worktree setup.
 * `previewAlerts` plays the three worker tones, so the mute can be checked by ear.
 */
export function openSettings(
  net: Net,
  settings: Settings,
  onChange: (s: Settings) => void,
  onCharacter: () => void,
  previewSound: () => void,
  previewAlerts: () => void,
  notifier: DesktopNotifier,
  outside?: { now: string; live: boolean },
  first?: SettingsPane,
  hireForSetup?: () => void,
  renderer?: { remastered: () => boolean; set: (remastered: boolean) => void; hdr: () => boolean; setHdr: (on: boolean) => void; hdrNote: () => string },
) {
  /** A volume slider with its mute button. Dragging it turns the sound back on; letting go plays `preview`. */
  const volumeRow = (label: string, level: 'volume' | 'music', muted: 'muted' | 'musicMuted', preview?: () => void) => {
    const slider = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': label });
    const pct = h('span.vol-pct');
    const mute = h('button.btn.sm', { type: 'button' });
    const row = h('div.volume', {}, mute, slider, pct);
    const paint = () => {
      const v = Math.round(settings[level] * 100);
      slider.value = String(v);
      slider.style.setProperty('--fill', `${v}%`);
      pct.textContent = settings[muted] ? 'Muted' : `${v}%`;
      mute.textContent = settings[muted] ? 'Unmute' : 'Mute';
      mute.setAttribute('aria-pressed', String(settings[muted]));
      mute.classList.toggle('danger', settings[muted]);
      row.classList.toggle('muted', settings[muted]);
    };
    paint();
    slider.addEventListener('input', () => {
      settings = { ...settings, [level]: Number(slider.value) / 100, [muted]: false };
      onChange(settings);
      paint();
    });
    if (preview) slider.addEventListener('change', preview);
    mute.addEventListener('click', () => {
      settings = { ...settings, [muted]: !settings[muted] };
      onChange(settings);
      paint();
      if (!settings[muted]) preview?.();
    });
    return row;
  };
  const soundRow = volumeRow('Office sounds volume', 'volume', 'muted', previewSound);
  const musicRow = volumeRow('Jukebox volume', 'music', 'musicMuted');
  const alertMute = h('button.btn.sm', { type: 'button' });
  const alertPlay = h('button.btn.sm', { type: 'button' }, 'Play');
  const alertRow = h('div.row', {}, alertMute, alertPlay);
  const paintAlerts = () => {
    alertMute.textContent = settings.alertsMuted ? 'Unmute' : 'Mute';
    alertMute.setAttribute('aria-pressed', String(settings.alertsMuted));
    alertMute.setAttribute('aria-label', settings.alertsMuted ? 'Unmute alert sounds' : 'Mute alert sounds');
    alertMute.classList.toggle('danger', settings.alertsMuted);
    alertPlay.toggleAttribute('disabled', settings.alertsMuted);
  };
  paintAlerts();
  alertMute.addEventListener('click', () => {
    settings = { ...settings, alertsMuted: !settings.alertsMuted };
    onChange(settings);
    paintAlerts();
    if (!settings.alertsMuted) previewAlerts();
  });
  alertPlay.addEventListener('click', () => previewAlerts());

  // Desktop notifications: this browser's permission, then your own on/off.
  const notifyRow = h('div.row');
  const notifyNote = desc();
  const notifyToggle = toggle(
    'Desktop notifications',
    () => notifyPermission() === 'granted' && settings.notify,
    (notify) => {
      settings = { ...settings, notify };
      onChange(settings);
      paintNotify();
    },
  );
  const notifySample = h('button.btn.sm', { type: 'button', onclick: () => notifier.sample() }, 'Show me one');
  const paintNotify = () => {
    const perm = notifyPermission();
    const on = perm === 'granted' && settings.notify;
    notifyRow.replaceChildren();
    if (perm === 'default') {
      notifyRow.append(
        h(
          'button.btn.sm.primary',
          {
            type: 'button',
            onclick: async () => {
              if ((await askNotifyPermission()) === 'granted') {
                settings = { ...settings, notify: true };
                onChange(settings);
                notifier.sample();
              }
              paintNotify();
            },
          },
          'Turn on notifications',
        ),
      );
    } else if (perm === 'granted') {
      notifyToggle.paint();
      if (on) notifyRow.append(notifySample);
      notifyRow.append(notifyToggle.el);
    }
    notifyNote.textContent =
      perm === 'unsupported'
        ? 'This browser can’t show notifications from the office here. They need https or localhost (an SSH tunnel counts).'
        : perm === 'denied'
          ? 'Your browser blocks notifications from the office. Allow them in the site settings (the icon left of the address), then open this again.'
          : 'When a worker needs input or finishes while you’re elsewhere, you get a notification; click it to jump to that worker’s terminal. The tab title counts the waiting workers while this tab is in the background.';
  };
  paintNotify();

  // The worker a new one starts on when whoever starts it picks no model.
  const agent = agentFields('office-agent', officeChoice());
  let agentTouched = false;
  agent.element.addEventListener('change', () => (agentTouched = true));
  agent.element.addEventListener('input', () => (agentTouched = true));
  const agentSave = h('button.btn.sm.primary', { type: 'button' }, 'Save');
  const agentBack = h('button.btn.sm', { type: 'button' });
  const agentActions = h('div.row', {}, agentSave, agentBack);
  const agentNote = desc();
  const paintAgent = () => {
    const picked = store.prompts.agent;
    const now = officeChoice();
    agentBack.classList.toggle('hidden', !picked);
    agentBack.textContent = `Back to ${store.project?.agentCmd.split(' ')[0].split(/[\\/]/).pop() ?? 'the --agent'}`;
    if (!agentTouched) agent.set(now);
    agentNote.textContent =
      'What a worker starts on when nobody picks one. The hire and ask windows remember their own picks per desk.' +
      (picked ? ` Set by ${picked.by} ${timeAgo(picked.at)}.` : ' It’s the agent the office was started with, on its own default model.');
  };
  paintAgent();
  agentSave.addEventListener('click', () => {
    agentTouched = false;
    net.send({ t: 'prompts.agent', choice: agent.choice() });
  });
  agentBack.addEventListener('click', () => {
    agentTouched = false;
    net.send({ t: 'prompts.agent', choice: null });
  });

  // The prompts the office writes for workers by itself, for the whole office.
  const promptsOpen = h('button.btn.sm', { type: 'button', onclick: () => openPromptEditor(net) });
  const promptsNote = desc();
  const paintPrompts = () => {
    const n = rewrittenPrompts();
    promptsOpen.textContent = 'Edit prompts…';
    const status = n ? `${n} of them rewritten.` : 'All as the office wrote them.';
    promptsNote.textContent = `What the office tells workers for you: handoffs, reviews, board buttons, board agents and the sign writer. ${status}`;
  };
  paintPrompts();

  // The most workers the office runs at once, across every floor.
  const limitInput = h('input.input.setting-number', { type: 'text', inputmode: 'numeric', 'aria-label': 'Most workers at once', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const limitSave = h('button.btn', { type: 'button' }, 'Set limit');
  const limitClear = h('button.btn.ghost', { type: 'button' });
  const limitRow = h('div.row', {}, h('div.input-group', {}, limitInput, limitSave), limitClear);
  const limitNote = desc();
  const paintLimit = () => {
    const m = store.machine;
    limitInput.placeholder = m.ceiling ? `1 to ${m.ceiling}` : 'e.g. 6';
    limitClear.textContent = m.ceiling ? `Back to ${m.ceiling}` : 'No limit';
    limitClear.classList.toggle('hidden', !m.set);
    const now =
      m.limit === undefined
        ? `No limit: the office hires a worker for every free seat. ${m.workers} ${m.workers === 1 ? 'is' : 'are'} here now, across every floor.`
        : `At most ${m.limit} worker${m.limit === 1 ? '' : 's'} at once, across every floor (${m.workers} now), shells and board agents too. Hiring past that is refused.`;
    const from = m.set ? ` Set by ${m.set.by} ${timeAgo(m.set.at)}.` : '';
    limitNote.textContent = now + from;
  };
  paintLimit();
  const saveLimit = () => {
    const n = Number(limitInput.value.trim());
    if (!limitInput.value.trim() || !Number.isInteger(n) || n < 1) return limitInput.focus();
    net.send({ t: 'machine.limit', limit: n });
    limitInput.value = '';
  };
  limitSave.addEventListener('click', saveLimit);
  limitInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveLimit();
  });
  limitClear.addEventListener('click', () => net.send({ t: 'machine.limit', limit: null }));

  // Whether a worker whose pull request merged goes home by itself, for everyone.
  const leaveRow = h('div.seg', { role: 'radiogroup', 'aria-label': 'Workers whose pull request merged' });
  const leaveNote = desc();
  const paintLeave = () => {
    const { on, by, at } = store.leaveOnMerge;
    leaveRow.replaceChildren(
      ...(
        [
          [true, 'Go home'],
          [false, 'Stay'],
        ] as const
      ).map(([value, label]) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(on === value),
            class: on === value ? 'on' : '',
            onclick: () => {
              if (store.leaveOnMerge.on !== value) net.send({ t: 'leaveOnMerge.set', on: value });
            },
          },
          label,
        ),
      ),
    );
    const now = on
      ? 'Once its pull request merges, a worker goes home when it is idle and nobody has its terminal open, and its worktree and branch are deleted. Worktrees with uncommitted or unpushed changes are kept.'
      : 'A merged worker stays at its desk, outlined in purple, until someone sends it home. Turning this on sends the already-merged ones too.';
    leaveNote.textContent = `${now}${by ? ` Set by ${by}${at ? ` ${timeAgo(at)}` : ``}.` : ``}`;
  };
  paintLeave();

  // Where a fresh worker starts: the latest main, or the branch the checkout is on. For everyone.
  const freshRow = h('div.seg', { role: 'radiogroup', 'aria-label': 'Where fresh workers start' });
  const freshNote = desc();
  const paintFresh = () => {
    const { on, by, at } = store.freshMain;
    freshRow.replaceChildren(
      ...(
        [
          [true, 'Latest floor branch'],
          [false, 'Checkout’s branch'],
        ] as const
      ).map(([value, label]) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(on === value),
            class: on === value ? 'on' : '',
            onclick: () => {
              if (store.freshMain.on !== value) net.send({ t: 'freshMain.set', on: value });
            },
          },
          label,
        ),
      ),
    );
    const now = on
      ? 'New workers start from the latest floor branch (the repository default unless picked in the top-left floor menu). The checkout switches safely for workers without worktrees. Subagents start where their lead says.'
      : 'Without a floor branch override, new worktrees start from the checkout’s branch and the checkout stays put. A branch picked in the top-left floor menu takes priority. Subagents start where their lead says.';
    freshNote.textContent = `${now}${by ? ` Set by ${by}${at ? ` ${timeAgo(at)}` : ``}.` : ``}`;
  };
  paintFresh();

  // How new worktrees on this floor are made ready: the repository's own setup, the detected one, or the floor's.
  const setupNote = desc();
  const setupFail = h('p.note.bad', { role: 'alert' });
  const setupCmd = h('input.input', { type: 'text', placeholder: 'npm ci', 'aria-label': 'Setup command', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const setupCopy = h('textarea.input', { rows: 3, placeholder: '/.env\n/.env.local', 'aria-label': 'Files to copy', spellcheck: 'false' }) as HTMLTextAreaElement;
  const setupSave = h('button.btn.sm.primary', { type: 'button' }, 'Save');
  const setupCancel = h('button.btn.sm.ghost', { type: 'button' }, 'Cancel');
  const setupForm = h(
    'div.stack.tight',
    {},
    field('Setup command', setupCmd, 'One command line, run in the new worktree in the worker’s terminal before the agent starts. Empty runs nothing.'),
    field('Files to copy', setupCopy, 'Gitignore patterns of untracked files in the checkout to copy into the new worktree, one per line. Empty copies nothing.'),
    h('div.row', {}, setupSave, setupCancel),
  );
  const setupHire = h('button.btn.sm', { type: 'button' }, 'Have a worker set it up…');
  const setupActions = h('div.row.wrap', {}, setupHire);
  /** Set here is picked but not saved yet. */
  let setupDraft = false;
  const setupMode = radios(
    'Where the worktree setup comes from',
    [
      [false, 'Automatic'],
      [true, 'Set for this floor'],
    ] as const,
    () => setupDraft || !!store.worktreeSetup?.override,
    (own) => {
      const st = store.worktreeSetup;
      if (!own) {
        setupDraft = false;
        if (st?.override) net.send({ t: 'worktreeSetup.set', setup: null });
        return paintSetup();
      }
      setupDraft = true;
      setupCmd.value = st?.resolved.setup ?? '';
      setupCopy.value = (st?.resolved.copy ?? []).join('\n');
      paintSetup();
      setupCmd.focus();
    },
  );
  const paintSetup = () => {
    const st = store.worktreeSetup;
    const git = !!st?.git;
    setupMode.paint();
    setupMode.row.classList.toggle('hidden', !git);
    setupActions.classList.toggle('hidden', !git || !hireForSetup);
    const own = !!st?.override;
    setupForm.classList.toggle('hidden', !git || !(setupDraft || own));
    setupCancel.classList.toggle('hidden', !setupDraft || own);
    const repoError = st?.repo && 'error' in st.repo ? st.repo.error : undefined;
    setupFail.classList.toggle('hidden', !repoError);
    setupFail.textContent = repoError ? `${repoError}. New worktrees go by the lockfiles until it’s fixed.` : '';
    if (!st) {
      setupNote.textContent = store.floor ? 'Reading this floor’s checkout…' : 'Take the elevator to a floor to set up its worktrees.';
      return;
    }
    if (!git) {
      setupNote.textContent = 'This floor’s project isn’t a git checkout, so its workers don’t get worktrees.';
      return;
    }
    const r = st.resolved;
    const from =
      r.setupFrom === 'office'
        ? `Set for this floor${st.override?.by ? ` by ${st.override.by}` : ''}${st.override?.at ? ` ${timeAgo(st.override.at)}` : ''}, in place of the repository’s.`
        : r.setupFrom === 'repo' || r.copyFrom === 'repo'
          ? `From ${SETUP_FILE}${st.include ? ` and ${INCLUDE_FILE}` : ''} in the repository.`
          : r.setupFrom === 'detected'
            ? `Detected from its lockfiles. Commit a ${SETUP_FILE} to say exactly what runs, or have a worker write one.`
            : `Nothing to install was detected. Commit a ${SETUP_FILE} to say what runs, or have a worker write one.`;
    setupNote.textContent = `A new worktree on this floor ${describeSetup(r, (c) => `“${c}”`)}. ${from} The setup shows in the worker’s terminal; the agent starts once it’s done, even if it fails.`;
  };
  paintSetup();
  setupSave.addEventListener('click', () => {
    setupDraft = false;
    net.send({ t: 'worktreeSetup.set', setup: { setup: setupCmd.value.trim(), copy: parsePatterns(setupCopy.value) } });
  });
  setupCancel.addEventListener('click', () => {
    setupDraft = false;
    paintSetup();
  });
  setupHire.addEventListener('click', () => {
    modal.close();
    hireForSetup?.();
  });
  net.send({ t: 'worktreeSetup.get' });
  const offWorktreeSetup = [
    store.on('worktreeSetup', paintSetup),
    store.on('floor', () => {
      setupDraft = false;
      paintSetup();
      if (store.floor) net.send({ t: 'worktreeSetup.get' });
    }),
  ];

  // Where the elevator looks for existing git projects on the office's machine.
  const dirInput = h('input.input', { type: 'text', placeholder: '~/Workspace', 'aria-label': 'Workspace folder', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const dirSave = h('button.btn', { type: 'button' }, 'Save');
  const dirDefault = h('button.btn.ghost', { type: 'button' }, 'Use the default');
  const dirRow = h('div.row.wrap', {}, h('div.input-group.grow', {}, dirInput, dirSave), dirDefault);
  const dirNote = desc();
  const paintDir = () => {
    const { dir, custom, by, at } = store.projectsDir;
    dirInput.value = dir;
    dirDefault.classList.toggle('hidden', !custom);
    dirNote.textContent =
      `The elevator lists the git projects in ${dir}, up to four folders deep, and opens your pick as a floor, right where it is. Nothing is cloned or copied; the floors you have stay put.` +
      (custom && by && at ? ` Set by ${by} ${timeAgo(at)}.` : '');
  };
  paintDir();
  const saveDir = () => {
    const dir = dirInput.value.trim();
    if (!dir) return dirInput.focus();
    if (dir !== store.projectsDir.dir) net.send({ t: 'floor.projectsDir', dir });
  };
  dirSave.addEventListener('click', saveDir);
  dirInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveDir();
  });
  dirDefault.addEventListener('click', () => net.send({ t: 'floor.projectsDir', dir: '' }));

  // Jira: the office's one account (a read-only token is enough), and the epic this floor's issue board shows.
  const jiraSite = h('input.input', { type: 'text', placeholder: 'https://your-site.atlassian.net', 'aria-label': 'Jira Cloud site', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const jiraEmail = h('input.input', { type: 'email', placeholder: 'you@example.com', 'aria-label': 'Atlassian account email', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const jiraToken = h('input.input', { type: 'password', placeholder: 'Read-only is enough', 'aria-label': 'Atlassian API token', spellcheck: 'false', autocomplete: 'new-password' }) as HTMLInputElement;
  const jiraConnect = h('button.btn.primary', { type: 'button' }, 'Connect') as HTMLButtonElement;
  const jiraCancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const jiraForm = h('div.stack.tight.jira-form', {}, field('Site', jiraSite), field('Account email', jiraEmail), field('API token', jiraToken), h('div.row', {}, jiraConnect, jiraCancel));
  const jiraChange = h('button.btn.sm', { type: 'button' }, 'Change');
  const jiraRemove = h('button.btn.sm.danger', { type: 'button' }, 'Remove');
  const jiraActions = h('div.row', {}, jiraChange, jiraRemove);
  const jiraNote = desc();
  const jiraFail = h('p.note.bad', { role: 'alert' });
  const epicInput = h('input.input', { type: 'text', placeholder: 'Epic key, e.g. EDP-168', 'aria-label': 'Jira epic for this floor', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const epicSave = h('button.btn', { type: 'button' }, 'Set epic') as HTMLButtonElement;
  const epicRemove = h('button.btn.ghost', { type: 'button' }, 'Remove epic');
  const epicRow = h('div.row.wrap', {}, h('div.input-group.grow', {}, epicInput, epicSave), epicRemove);
  const epicNote = desc();
  const epicFail = h('p.note.bad', { role: 'alert' });
  let editingJira = false;
  let jiraBusy: '' | 'connect' | 'epic' = '';
  let jiraError = '';
  let epicError = '';
  /** The epic's own card, hidden until the office is connected and you're on a floor. */
  let epicCard: HTMLElement | null = null;
  const paintJira = () => {
    const { connection, epic } = store.jira;
    const onFloor = !!store.floor;
    jiraForm.classList.toggle('hidden', !!connection && !editingJira);
    jiraCancel.classList.toggle('hidden', !connection);
    jiraActions.classList.toggle('hidden', !connection || editingJira);
    jiraConnect.disabled = jiraBusy === 'connect';
    jiraConnect.textContent = jiraBusy === 'connect' ? 'Checking…' : 'Connect';
    jiraFail.classList.toggle('hidden', !jiraError);
    jiraFail.textContent = jiraError;
    jiraNote.textContent = connection
      ? `Reading ${connection.site} as ${connection.name === connection.email ? connection.email : `${connection.name} (${connection.email})`}, set up by ${connection.by} ${timeAgo(connection.at)}. The office only reads Jira; it never changes a ticket.`
      : 'Connect with a site, an email and an API token from https://id.atlassian.com/manage-profile/security/api-tokens — read-only (scope read:jira-work) is enough. The token stays on the office’s machine; each floor then picks its own epic.';
    const showEpic = !!connection && onFloor;
    epicCard?.classList.toggle('hidden', !showEpic);
    epicRemove.classList.toggle('hidden', !epic);
    epicSave.disabled = jiraBusy === 'epic';
    epicSave.textContent = jiraBusy === 'epic' ? 'Checking…' : 'Set epic';
    if (!epicInput.value && epic) epicInput.value = epic.key;
    epicFail.classList.toggle('hidden', !epicError);
    epicFail.textContent = epicError;
    epicNote.textContent = epic
      ? `This floor’s issue board has a Jira tab for ${epic.key}${epic.summary ? ` (“${epic.summary}”)` : ''}: all of its tickets, in To Do, In Progress and Done. Set by ${epic.by} ${timeAgo(epic.at)}.`
      : 'Give this floor a Jira epic and its issue board gets a Jira tab with all of the epic’s tickets, in To Do, In Progress and Done.';
  };
  const offSetup = onJiraSetup((msg) => {
    if (msg.step === 'connect') {
      jiraBusy = '';
      jiraError = msg.error ?? '';
      if (msg.ok) {
        editingJira = false;
        jiraToken.value = '';
      }
    } else {
      jiraBusy = '';
      epicError = msg.error ?? '';
    }
    paintJira();
  });
  paintJira();
  const connectJira = () => {
    if (!jiraSite.value.trim()) return jiraSite.focus();
    if (!jiraEmail.value.trim()) return jiraEmail.focus();
    if (!jiraToken.value.trim()) return jiraToken.focus();
    jiraBusy = 'connect';
    jiraError = '';
    net.send({ t: 'jira.connect', site: jiraSite.value.trim(), email: jiraEmail.value.trim(), token: jiraToken.value.trim() });
    paintJira();
  };
  jiraConnect.addEventListener('click', connectJira);
  jiraToken.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectJira();
  });
  jiraChange.addEventListener('click', () => {
    editingJira = true;
    jiraSite.value = store.jira.connection?.site ?? '';
    jiraEmail.value = store.jira.connection?.email ?? '';
    paintJira();
    jiraToken.focus();
  });
  jiraCancel.addEventListener('click', () => {
    editingJira = false;
    jiraError = '';
    jiraToken.value = '';
    paintJira();
  });
  jiraRemove.addEventListener('click', () => {
    if (confirm('Disconnect the office from Jira? Every floor’s Jira tab goes away until someone connects it again.')) net.send({ t: 'jira.disconnect' });
  });
  const saveEpic = () => {
    const key = epicInput.value.trim();
    if (!key) return epicInput.focus();
    jiraBusy = 'epic';
    epicError = '';
    net.send({ t: 'jira.epic', key });
    paintJira();
  };
  epicSave.addEventListener('click', saveEpic);
  epicInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveEpic();
  });
  epicRemove.addEventListener('click', () => {
    epicInput.value = '';
    net.send({ t: 'jira.epic', key: '' });
  });

  // How workers hire subagents, for the whole office.
  const subSet = (patch: Partial<SubagentSettings>) => net.send({ t: 'subagents.set', settings: { ...subagentSettings(), ...patch } });
  const subOn = toggle(
    'Subagents',
    () => store.subagents.on,
    (on) => subSet({ on }),
  );
  const subWho = radios(
    'Who can hire',
    [
      [true, 'Lead and desk workers'],
      [false, 'Only the lead'],
    ] as const,
    () => store.subagents.deskWorkers,
    (deskWorkers) => subSet({ deskWorkers }),
  );
  const subNote = desc();
  const subPrompts = h('button.btn.sm', { type: 'button', onclick: () => openPromptEditor(net, 'subagent.brief') }, 'Edit prompts…');

  // What a subagent runs when its lead doesn't say: every model droid lists.
  const subFallback = () => store.subagents.agent ?? officeChoice();
  const subAgent = agentFields('subagent-agent', subFallback());
  let subAgentTouched = false;
  subAgent.element.addEventListener('change', () => (subAgentTouched = true));
  subAgent.element.addEventListener('input', () => (subAgentTouched = true));
  const subAgentSave = h('button.btn.sm.primary', { type: 'button' }, 'Save');
  const subAgentBack = h('button.btn.sm', { type: 'button' }, 'Back to the default worker');
  const subAgentNote = desc();
  subAgentSave.addEventListener('click', () => {
    subAgentTouched = false;
    subSet({ agent: subAgent.choice() });
  });
  subAgentBack.addEventListener('click', () => {
    subAgentTouched = false;
    subSet({ agent: undefined });
  });

  const subModels = subagentModelPicker((models) => subSet({ models }));
  const subModelsNote = desc();

  const subSize = radios(
    'Most subagents per lead',
    Array.from({ length: SUBAGENT_MAX_PER_LEAD }, (_, i) => [i + 1, String(i + 1)] as const),
    () => store.subagents.maxPerLead,
    (maxPerLead) => subSet({ maxPerLead }),
  );
  const subSizeNote = desc();
  const subTree = radios(
    'Where subagents work',
    [
      [true, 'Own worktree'],
      [false, "Lead's checkout"],
    ] as const,
    () => store.subagents.worktree,
    (worktree) => subSet({ worktree }),
  );
  const subTreeNote = desc('Own worktrees let subagents change files side by side, each on a branch you can merge or hand back. A lead can still ask for the other with --worktree or --no-worktree.');
  const subWake = radios(
    'Waking the lead',
    [
      [true, 'Wake it'],
      [false, 'Let it check'],
    ] as const,
    () => store.subagents.wakeLead,
    (wakeLead) => subSet({ wakeLead }),
  );
  const subWakeNote = desc('When a subagent reports back, a resting lead is nudged to read the news with office-workers wait. A busy lead hears it the next time it stops.');
  // Visits between the floor's independent workers (office-visit), for the whole office.
  const visitsOn = toggle(
    'Visits between workers',
    () => store.subagents.visits ?? true,
    (visits) => subSet({ visits }),
  );
  const visitsNote = desc();
  const visitPrompts = h('button.btn.sm', { type: 'button', onclick: () => openPromptEditor(net, 'visit.ask') }, 'Edit prompts…');
  const subSkill = toggle(
    'Droid skill installed',
    () => store.subagents.skill,
    (skill) => subSet({ skill }),
  );
  const subSkillNote = desc();
  // The Whiteboard's skill, for the whole office.
  const boardSkill = toggle(
    'Whiteboard skill installed',
    () => store.whiteboardSkill.on,
    (on) => net.send({ t: 'whiteboardSkill.set', on }),
  );
  const boardSkillNote = desc();
  const paintBoardSkill = () => {
    const s = store.whiteboardSkill;
    boardSkill.paint();
    boardSkillNote.textContent =
      (s.skillError
        ? s.skillError
        : s.on
          ? `Droid workers learn to push cards to the floor's Whiteboard and read your marks from the droid-office-whiteboard skill${s.skillPath ? ` at ${s.skillPath}` : ''}. It only applies in office sessions.`
          : 'The droid-office-whiteboard skill is not in ~/.factory/skills. Every agent still has office-whiteboard on its PATH: point it there and it reads office-whiteboard help.') +
      (s.by && s.at ? ` Set by ${s.by} ${timeAgo(s.at)}.` : '');
  };
  paintBoardSkill();

  const paintSubagents = () => {
    const s = store.subagents;
    for (const r of [subOn, subWho, subSize, subTree, subWake, subSkill, visitsOn]) r.paint();
    visitsNote.textContent =
      (s.visits ?? true)
        ? 'Workers you hired (not subagents) can see each other on a roster with office-visit, walk to each other’s desks, read each other’s screens, and tell, ask and hand off work. A normal message waits for the other worker’s turn to end; an urgent one cancels the turn and goes in as its next prompt.'
        : 'Every office-visit command is refused, and visits under way end. Workers can still hire and run subagents.';
    subWho.row.classList.toggle('disabled', !s.on);
    subNote.textContent =
      (s.on
        ? 'A lead runs office-workers hire and the subagent sits at the nearest free desk, with its own laptop and a terminal you can open. It works, reports back, and its lead sends it home when the work is in.'
        : 'Hiring is refused. Subagents already working carry on and can still report back to their leads.') + (s.by && s.at ? ` Set by ${s.by} ${timeAgo(s.at)}.` : '');
    if (!subAgentTouched) subAgent.set(subFallback());
    subAgentBack.classList.toggle('hidden', !s.agent);
    subAgentNote.textContent = s.agent
      ? `Subagents start on ${choiceLabel(s.agent)} unless their lead asks for something else with --model or --effort.`
      : `Subagents start on the office’s default worker (${choiceLabel(officeChoice())}, from Workers → Default worker) unless their lead asks for something else with --model or --effort. The picker lists every model droid can run: your own models, Factory’s and legacy ones.`;
    subModels.paint(s.models);
    subModelsNote.textContent = s.models?.length
      ? `Leads choose each subagent’s model from these ${s.models.length}, by your notes and each model’s credit multiplier (office-workers models), and hire refuses any other. The subagent worker above is always allowed.`
      : 'Leads may give a subagent any model droid lists, choosing by each one’s strengths and credit multiplier. Tick models to limit them to those, and add a note on what each is for: the lead reads it when it picks.';
    subSizeNote.textContent = `A lead can have at most ${s.maxPerLead} subagent${s.maxPerLead === 1 ? '' : 's'} on the floor at once; sending one home frees its place. The office's worker limit still counts every one.`;
    subSkillNote.textContent = s.skillError
      ? s.skillError
      : !s.on
        ? 'Subagents are off, so the droid-office-subagents skill is out of ~/.factory/skills until they are back on.'
        : s.skill
          ? `Desk workers learn to hire from the droid-office-subagents skill${s.skillPath ? ` at ${s.skillPath}` : ``}. It only applies in office sessions; the Team lead always knows from its brief.`
          : 'The droid-office-subagents skill is not in ~/.factory/skills. Desk workers hire when you point them at office-workers; the Team lead always knows from its brief.';
  };
  paintSubagents();

  // Droid Office for Android: the pairing QR code is its own window, over this one.
  const phoneOpen = h('button.btn.primary', { type: 'button' }, 'Pair a phone…');
  const phoneNote = desc('The pairing QR code, the addresses it carries, and your paired phones, where you can forget one. A paired phone keeps working after the office restarts.');
  const phoneStatus = h('span.setting-meta', {}, 'Checking for paired phones…');
  const paintPhones = (list: PairedDevice[] | string) => {
    if (typeof list === 'string') phoneStatus.textContent = list;
    else if (!list.length) phoneStatus.textContent = 'No phones paired yet.';
    else phoneStatus.textContent = `${list.length} paired: ${list.map((d) => `${d.name} (seen ${timeAgo(d.lastSeenAt)})`).join(', ')}.`;
  };
  void pairedPhones().then(paintPhones);
  phoneOpen.addEventListener('click', () => openPhone(paintPhones));

  // The web companion: /dashboard in a desktop browser. Its links and paired browsers are their own window.
  const webOpen = h('button.btn.primary', { type: 'button' }, 'Links & browsers…');
  const webNote = desc('Your workers, their live terminals and the Whiteboard in any desktop browser, at /dashboard on this office’s address: this computer, your Wi-Fi or Tailscale. Browsers pair once and keep working after restarts.');
  const webStatus = h('span.setting-meta', {}, 'Checking the web companion…');
  const paintWeb = (s: PairingState | string) => {
    if (typeof s === 'string') webStatus.textContent = s;
    else {
      const n = s.devices.filter((d) => d.kind === 'browser').length;
      webStatus.textContent = `${s.companion ? 'On' : 'Off'} · ${n ? `${n} browser${n === 1 ? '' : 's'} paired` : 'no browsers paired'} · ${s.local.replace(/^https?:\/\//, '')}/dashboard`;
    }
  };
  void companionState().then(paintWeb);
  webOpen.addEventListener('click', () => openCompanion(paintWeb));

  const sidearm = choices(
    'sidearm',
    SIDEARMS.map(([value, icon, title, description]) => ({ value, icon, title, description })),
    settings.sidearm,
    (value) => {
      settings = { ...settings, sidearm: value as Sidearm };
      onChange(settings);
    },
    { rows: true },
  );

  // Graphics: how this browser draws the office.
  const graphicsSet = (g: Partial<GraphicsSettings>) => {
    settings = { ...settings, graphics: { ...settings.graphics, ...g } };
    onChange(settings);
    paintGraphics();
  };
  const percentSlider = (label: string, min: number, step: number, pick: (v: number) => void) => {
    const slider = h('input', { type: 'range', min, max: 100, step, 'aria-label': label });
    const pct = h('span.vol-pct');
    slider.addEventListener('input', () => pick(Number(slider.value) / 100));
    return { slider, pct, row: h('div.volume', {}, slider, pct) };
  };
  const scale = percentSlider('Render resolution', RENDER_SCALE_MIN * 100, RENDER_SCALE_STEP * 100, (v) => graphicsSet({ scale: normalizeScale(v) }));
  const sharpen = percentSlider('Sharpening', 0, 5, (v) => graphicsSet({ sharpen: v }));
  const overhead = percentSlider('Overhead lights', 0, OVERHEAD_STEP * 100, (v) => graphicsSet({ overhead: normalizeOverhead(v) }));
  const scaleNote = desc();
  const sharpenNote = desc();
  const taaNote = desc('Moves each frame by a fraction of a pixel and blends it into the frames before, following the camera. Smooths edges and recovers detail below 100%; something moving fast can smear a little. Off, edges use 4× MSAA.');
  const taa = toggle(
    'Temporal anti-aliasing',
    () => settings.graphics.taa,
    (on) => graphicsSet({ taa: on }),
  );
  const fpsCap = radios<FpsCap>(
    'Frame rate limit',
    FPS_CAPS.map((fps) => [fps, `${fps} FPS`] as const),
    () => settings.graphics.fpsCap,
    (fps) => graphicsSet({ fpsCap: fps }),
  );
  const stats = toggle(
    'Performance overlay',
    () => settings.graphics.stats,
    (on) => graphicsSet({ stats: on }),
  );
  const rawMouse = toggle(
    'Raw mouse input',
    () => settings.graphics.rawMouse,
    (on) => graphicsSet({ rawMouse: on }),
  );
  const lookMin = LOOK_SENSITIVITY_MIN * 100;
  const lookMax = LOOK_SENSITIVITY_MAX * 100;
  const look = h('input', { type: 'range', min: lookMin, max: lookMax, step: LOOK_SENSITIVITY_STEP * 100, 'aria-label': 'Look sensitivity' });
  const lookValue = h('span.vol-pct');
  look.addEventListener('input', () => graphicsSet({ lookSensitivity: normalizeLookSensitivity(Number(look.value) / 100) }));
  const lookRow = h('div.volume', {}, look, lookValue);
  const resolutionRow = card('Render resolution', { desc: scaleNote, control: scale.row });
  const taaRow = card('Temporal anti-aliasing', { desc: taaNote, control: taa.el });
  const sharpenRow = card('Sharpening', { desc: sharpenNote, control: sharpen.row });
  /** Remastered ignores these three. They stay visible, with the Classic values saved behind them. */
  const lockClassic = (remastered: boolean) => {
    for (const row of [resolutionRow, taaRow, sharpenRow]) row.classList.toggle('muted', remastered);
    scale.slider.disabled = remastered;
    taa.el.input.disabled = remastered;
    if (remastered) sharpen.slider.disabled = true;
  };
  const paintGraphics = () => {
    const g = settings.graphics;
    const lookPct = Math.round(g.lookSensitivity * 100);
    look.value = String(lookPct);
    look.style.setProperty('--fill', `${((lookPct - lookMin) / (lookMax - lookMin)) * 100}%`);
    lookValue.textContent = `${g.lookSensitivity.toFixed(2)}×`;
    for (const [s, v] of [
      [scale, g.scale],
      [sharpen, g.sharpen],
      [overhead, g.overhead],
    ] as const) {
      const p = Math.round(v * 100);
      s.slider.value = String(p);
      s.slider.style.setProperty('--fill', `${((p - Number(s.slider.min)) / (100 - Number(s.slider.min))) * 100}%`);
      s.pct.textContent = `${p}%`;
    }
    taa.paint();
    fpsCap.paint();
    stats.paint();
    rawMouse.paint();
    const remastered = renderer?.remastered() ?? false;
    const upscaling = g.taa ? ' with TAA' : '. Turn on TAA to bring back the detail a plain stretch loses';
    if (remastered) {
      scaleNote.textContent = 'Classic only. Remastered always draws every pixel of the screen.';
      taaNote.textContent = 'Classic only. Remastered uses 2× MSAA and ignores this.';
      sharpen.row.classList.remove('muted');
      sharpenNote.textContent = 'Classic only. Remastered does not sharpen.';
    } else {
      scaleNote.textContent =
        g.scale >= 1
          ? 'The office draws every pixel of your screen. Lower it to draw fewer and upscale them: the GPU does less work for each frame.'
          : `The office draws ${Math.round(g.scale * g.scale * 100)}% of your screen’s pixels and upscales them${upscaling}.`;
      taaNote.textContent =
        'Moves each frame by a fraction of a pixel and blends it into the frames before, following the camera. Smooths edges and recovers detail below 100%; something moving fast can smear a little. Off, edges use 4× MSAA.';
      const native = g.scale >= 1 && !g.taa;
      sharpen.row.classList.toggle('muted', native);
      sharpen.slider.disabled = native;
      sharpenNote.textContent = native
        ? 'Only applies to an upscaled or TAA image. At 100% without TAA the office draws straight to the screen.'
        : 'Contrast-adaptive sharpening on the final image, to win back what upscaling and TAA soften.';
    }
    lockClassic(remastered);
  };
  paintGraphics();

  const rendererNote = desc();
  const rendererPick = radios<boolean>(
    'Renderer',
    [
      [false, 'Classic'],
      [true, 'Remastered'],
    ],
    () => renderer?.remastered() ?? false,
    (on) => {
      renderer?.set(on);
      paintRenderer();
    },
  );
  const paintRenderer = () => {
    rendererPick.paint();
    rendererNote.textContent = renderer?.remastered()
      ? 'Drawn at the screen’s own resolution, with 2× MSAA and baked global illumination (a probe every 1.4 m, two extra bounces). Natural color, subtle light from screens and lamps, no sharpening. The three rows below are for Classic and do nothing while this is on. The frame rate limit and the overlay still apply.'
      : 'The office the way it has always drawn: toon shading, ink outlines and the resolution and anti-aliasing settings below.';
    paintGraphics();
  };
  const hdrNote = desc();
  const hdrToggle = toggle(
    'HDR',
    () => renderer?.hdr() ?? false,
    (on) => {
      renderer?.setHdr(on);
      paintHdr();
    },
  );
  function paintHdr() {
    hdrToggle.paint();
    const why = renderer?.hdrNote() ?? '';
    hdrNote.textContent = why || 'Highlights brighter than white on an EDR display, up to 4× white. Off keeps standard range. Applies when Remastered is on; where the display or browser can’t, the picture stays SDR.';
  }
  const onHdrStatus = () => paintHdr();
  window.addEventListener('office:hdr', onHdrStatus);
  paintRenderer();
  paintHdr();
  const character = h('button.btn', { type: 'button' }, 'Change your look & name');
  epicCard = card("This floor's Jira epic", { desc: epicNote, below: [epicRow, epicFail] });
  paintJira();
  const sourceReload = hotReloadSettings();
  const factoryKey = factoryKeySettings(net);
  const subscriptions = subscriptionsSettings(net);
  const subscriptionGroups = [
    group('DroidProxy', card('DroidProxy', subscriptions.proxy)),
    group('Subscription accounts', card('Accounts', subscriptions.accounts)),
    group('Subscription models', card('Models in Droid', subscriptions.models)),
  ];
  subscriptions.hideWhenUnsupported(...subscriptionGroups);
  const droid = droidSettings(net);
  const modelVisibility = hiddenModelSettings(net);
  const workerLabels = workerLabelSettings(net);
  const panes: Record<SettingsPane, Node[]> = {
    you: [
      group('Profile', card('Your character', { desc: desc('How you look and the name above your head.'), control: character })),
      group(
        'Controls',
        card('What 7 puts in your hand', { desc: desc('A normal hit opens the worker’s terminal. Only a fully charged shot sends it home and deletes its owned worktree and branch.'), below: [sidearm] }),
        card('Raw mouse input', {
          desc: desc(
            'Looking around follows the mouse’s own movement, without the pointer acceleration macOS adds, so the same hand movement always turns the view the same amount. Where the browser can’t, the mouse works as usual. Takes effect the next time the office captures the mouse.',
          ),
          control: rawMouse.el,
        }),
        card('Look sensitivity', {
          desc: desc('How far the view turns for the same mouse movement while the office has the mouse. 1× is the office’s own speed; lower turns slower, higher faster. Raw input on or off, it applies at once.'),
          control: lookRow,
        }),
      ),
      group(
        'Shortcuts',
        card('Prompt chips', {
          desc: desc('One tap fills a prompt box. Kept in this browser, not on the office.'),
          below: [
            presetEditor(settings.presets, (presets) => {
              settings = { ...settings, presets };
              onChange(settings);
            }),
          ],
        }),
      ),
    ],
    sound: [
      group(
        null,
        card('Office sounds', { desc: desc('Workers typing and thunder. Muting this silences the worker tones too.'), control: soundRow }),
        card('Alert sounds', { desc: desc('A short tone when a worker needs you, finishes, or its tests fail. Mute them without silencing the rest of the office.'), control: alertRow }),
        card('Jukebox', { desc: desc('Louder near the jukebox. This slider is only your volume.'), control: musicRow }),
      ),
    ],
    graphics: [
      group('Renderer', card('Renderer', { desc: rendererNote, control: rendererPick.row }), card('HDR', { desc: hdrNote, control: hdrToggle.el })),
      group('Resolution', resolutionRow, taaRow, sharpenRow),
      group(
        'Frame rate',
        card('Frame rate limit', {
          desc: desc(
            'The most frames a second the office draws while something moves. 40, 60 and 120 each fit a 120 Hz display evenly. A lower limit costs the GPU less; a 60 Hz display shows at most 60. A still office still drops to a few frames a second.',
          ),
          control: fpsCap.row,
        }),
      ),
      group(
        'Lighting',
        card('Overhead lights', {
          desc: desc(
            'How bright the office’s ceiling lights are, and how much they light the room. At 0% they are off and the room is lit only by the moon, the screens and the bounce light. Both renderers; Remastered re-bakes its bounce light after a change.',
          ),
          control: overhead.row,
        }),
      ),
      group(
        'Diagnostics',
        card('Performance overlay', {
          desc: desc(
            'Bottom right: frames per second and the frame rate limit, the frame pacing of the last five seconds (p50, p95 and p99 time between frames, frames that missed their refresh and refreshes that showed a frame again), the GPU time each frame costs and how busy that keeps the GPU, the Mac’s whole-GPU load (the Activity Monitor numbers, on the office’s own Mac), and the render resolution.',
          ),
          control: stats.el,
        }),
      ),
    ],
    notify: [group('Just you', card('Desktop notifications', { desc: notifyNote, control: notifyRow }))],
    workers: [
      group('Agent', card('Droid', droid.parts), card('Default worker', { desc: agentNote, below: [agent.element, agentActions] }), card('Models shown in pickers', { below: [modelVisibility.element] })),
      group('Activity', card('Worker labels', { below: [workerLabels.element] })),
      group(
        'Hiring',
        card('Where fresh workers start', { desc: freshNote, control: freshRow }),
        card('Worker limit', { desc: limitNote, control: limitRow }),
        card('Workers whose pull request merged', { desc: leaveNote, control: leaveRow }),
      ),
      group('Guidance', card('Prompts', { desc: promptsNote, control: promptsOpen })),
      group('Worktrees', card('Worktree setup', { desc: setupNote, control: setupMode.row, below: [setupFail, setupForm, setupActions] })),
    ],
    subagents: [
      group(
        'Hiring',
        card('Subagents', { desc: subNote, control: subOn.el }),
        setting('Who can hire', { desc: desc('The Team lead can always hire; desk workers too, when allowed.'), control: subWho.row }),
        setting('Subagent prompts', { desc: desc('What the office tells the Team lead and its subagents.'), control: subPrompts }),
      ),
      group(
        'How they work',
        card('Subagent worker', { desc: subAgentNote, below: [subAgent.element, h('div.row', {}, subAgentSave, subAgentBack)] }),
        card('Models leads can pick', { desc: subModelsNote, below: [subModels.element] }),
        card('Team size', { desc: subSizeNote, control: subSize.row }),
        card('Where subagents work', { desc: subTreeNote, control: subTree.row }),
        card('Waking the lead', { desc: subWakeNote, control: subWake.row }),
      ),
      group(
        'Visits',
        card('Visits between workers', { desc: visitsNote, control: visitsOn.el }),
        setting('Visit prompts', { desc: desc('What a worker’s session gets when another worker tells, asks or hands it something.'), control: visitPrompts }),
      ),
      group('Droid', card('Droid skill', { desc: subSkillNote, control: subSkill.el }), card('Whiteboard skill', { desc: boardSkillNote, control: boardSkill.el })),
    ],
    connections: [
      subscriptions.unsupported,
      group('Factory', card('Factory API key', factoryKey.key)),
      factoryKey.reach,
      ...subscriptionGroups,
      group('Jira', card('Jira', { desc: jiraNote, below: [jiraForm, jiraFail, jiraActions] }), epicCard),
    ],
    office: [
      ...(outside
        ? [
            group(
              'Environment',
              card('Outside', {
                desc: desc(outside.live ? 'The office’s clock, and the live weather where it is.' : 'The office’s clock, and weather that comes and goes. Start the office with --city to use a real city’s forecast.'),
                control: outsideNow(outside.now),
              }),
            ),
          ]
        : []),
      group('Floors & projects', card('Workspace folder', { desc: dirNote, below: [dirRow] })),
      group(
        'App',
        card('Host desktop app', {
          desc: desc('Check for a signed update to the Mac app that runs this office. Installing restarts the host while workers keep running.'),
          control: h('button.btn', { type: 'button', onclick: openHostUpdate }, 'Check for updates…'),
        }),
      ),
      group('Developer', card('Source hot reload', { below: [sourceReload.element] })),
    ],
    phone: [group(null, card('Droid Office for Android', { desc: h('span.stack.tight', {}, phoneNote, phoneStatus), control: phoneOpen }), card('Web companion', { desc: h('span.stack.tight', {}, webNote, webStatus), control: webOpen }))],
  };

  // The categories down the side, grouped under Personal / Workers / Office, the one picked on the right.
  // On a phone the row is across the top. The search at the top of the side finds a setting by name
  // without knowing its category, and a pick jumps to its row and flashes it.
  const searchInput = h('input.input.settings-search', { type: 'search', placeholder: 'Search settings…', 'aria-label': 'Search settings' }) as HTMLInputElement;
  const results = h('section.settings-pane.settings-results', { 'aria-label': 'Search results' });
  results.classList.add('hidden');
  const nav = h('nav.settings-nav', { role: 'tablist', 'aria-label': 'Settings' }, h('div.settings-search-wrap', {}, searchInput));
  const tabs = new Map<SettingsPane, HTMLButtonElement>();
  const bodies = new Map<SettingsPane, HTMLElement>();
  let navSection = '';
  for (const p of SETTINGS_PANES) {
    if (p.section !== navSection) {
      navSection = p.section;
      nav.append(h('div.settings-nav-section', { 'aria-hidden': 'true' }, p.section));
    }
    const tab = h(
      'button.settings-tab',
      { type: 'button', role: 'tab', id: `settings-tab-${p.id}`, 'aria-controls': `settings-pane-${p.id}`, onclick: () => show(p.id) },
      h('span.icon', { 'aria-hidden': 'true' }, p.icon),
      h('span', {}, p.label),
    ) as HTMLButtonElement;
    tabs.set(p.id, tab);
    nav.append(tab);
    bodies.set(
      p.id,
      h(
        'section.settings-pane',
        { role: 'tabpanel', id: `settings-pane-${p.id}`, 'aria-labelledby': `settings-tab-${p.id}` },
        h('div.settings-head', {}, h('div.settings-head-row', {}, h('h3', {}, h('span.icon', { 'aria-hidden': 'true' }, p.icon), p.label), h('span.pill', {}, p.scope)), h('p', {}, p.blurb)),
        ...panes[p.id],
      ),
    );
  }
  /** Each card's row, by its title, so a search pick can jump to it. Only rows the registry names count. */
  const rowByTitle = new Map<string, { pane: SettingsPane; row: HTMLElement }>();
  {
    const known = new Set<string>(SETTINGS_CARDS.map((c) => c.title));
    for (const [pane, body] of bodies) {
      for (const row of body.querySelectorAll<HTMLElement>('.group-row')) {
        const title = row.querySelector(':scope > .group-label > b')?.textContent ?? '';
        if (known.has(title) && !rowByTitle.has(title)) rowByTitle.set(title, { pane, row });
      }
    }
  }
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const flashRow = (title: string) => {
    const hit = rowByTitle.get(title);
    if (!hit) return;
    clearTimeout(flashTimer);
    for (const { row } of rowByTitle.values()) row.classList.remove('flash');
    hit.row.classList.add('flash');
    hit.row.scrollIntoView({ block: 'center' });
    flashTimer = setTimeout(() => hit.row.classList.remove('flash'), 2000);
  };
  const show = (id: SettingsPane) => {
    lastPane = id;
    searchInput.value = '';
    results.classList.add('hidden');
    for (const [t, tab] of tabs) {
      tab.classList.toggle('on', t === id);
      tab.setAttribute('aria-selected', String(t === id));
      tab.tabIndex = t === id ? 0 : -1;
    }
    for (const [t, body] of bodies) body.classList.toggle('hidden', t !== id);
    const pane = bodies.get(id)!;
    pane.scrollTop = 0;
    // On a phone the categories are a row across the top that scrolls sideways.
    tabs.get(id)!.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const paintSearch = () => {
    const query = searchInput.value.trim();
    if (!query) return show(lastPane);
    const hits = searchSettings(query);
    const paneLabel = new Map(SETTINGS_PANES.map((p) => [p.id, p]));
    results.replaceChildren(
      h(
        'div.settings-head',
        {},
        h('h3', {}, 'Search results'),
        h('p', {}, hits.length ? `${hits.length} setting${hits.length === 1 ? '' : 's'} match “${query}”. Pick one to jump to it.` : `No settings match “${query}”. Try a setting's name, like “Jira”, “models” or “volume”.`),
      ),
      ...(hits.length
        ? [
            h(
              'div.list.boxed.settings-hit-list',
              {},
              ...hits.map((hit) => {
                const pane = paneLabel.get(hit.pane)!;
                return h(
                  'button.list-row.settings-hit',
                  {
                    type: 'button',
                    onclick: () => {
                      show(hit.pane);
                      flashRow(hit.title);
                    },
                  },
                  h('span.icon', { 'aria-hidden': 'true' }, pane.icon),
                  h('span.list-main', {}, h('span.list-title', {}, hit.title), h('span.list-meta', {}, `${pane.section} · ${pane.label}`)),
                );
              }),
            ),
          ]
        : []),
    );
    for (const tab of tabs.values()) {
      tab.classList.remove('on');
      tab.setAttribute('aria-selected', 'false');
    }
    for (const body of bodies.values()) body.classList.add('hidden');
    results.classList.remove('hidden');
    results.scrollTop = 0;
  };
  searchInput.addEventListener('input', paintSearch);
  const offSearchEscape = claimEscape(searchInput, () => {
    if (!searchInput.value) return false;
    searchInput.value = '';
    show(lastPane);
    return true;
  });
  nav.addEventListener('keydown', (e) => {
    const next = settingsPaneAfter(lastPane, e.key);
    if (!next) return;
    e.preventDefault();
    show(next);
    tabs.get(next)!.focus();
  });
  const wide = window.matchMedia('(min-width: 721px)');
  const orient = () => nav.setAttribute('aria-orientation', wide.matches ? 'vertical' : 'horizontal');
  orient();
  wide.addEventListener('change', orient);

  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h('div.modal.xl.settings', { role: 'dialog', 'aria-label': 'Settings' }, h('header', {}, h('h2', {}, 'Settings'), close), h('div.split.settings-body', {}, nav, ...bodies.values(), results));
  const offLeave = store.on('leaveOnMerge', paintLeave);
  const offFresh = store.on('freshMain', paintFresh);
  const offLimit = [store.on('machine', paintLimit)];
  const offDir = [store.on('projectsDir', paintDir)];
  const offJira = [store.on('jira', paintJira), offSetup];
  const offPrompts = [store.on('prompts', paintAgent), store.on('prompts', paintPrompts), store.on('prompts', paintSubagents), store.on('subagents', paintSubagents), store.on('whiteboardSkill', paintBoardSkill)];
  const modal = openModal(el, {
    doing: '⚙️ in settings',
    onClose: () => {
      offSearchEscape();
      clearTimeout(flashTimer);
      wide.removeEventListener('change', orient);
      offLeave();
      offFresh();
      offLimit.forEach((off) => off());
      offDir.forEach((off) => off());
      offJira.forEach((off) => off());
      offPrompts.forEach((off) => off());
      offWorktreeSetup.forEach((off) => off());
      sourceReload.dispose();
      factoryKey.dispose();
      subscriptions.dispose();
      droid.dispose();
      modelVisibility.dispose();
      workerLabels.dispose();
      window.removeEventListener('office:hdr', onHdrStatus);
    },
  });
  show(first ?? lastPane);
  close.addEventListener('click', () => modal.close());
  character.addEventListener('click', () => {
    modal.close();
    onCharacter();
  });
}
