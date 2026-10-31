import type { Net } from '../net';
import { store, type Settings, type Sidearm } from '../state';
import { askNotifyPermission, notifyPermission, type DesktopNotifier } from '../notify';
import { SUBAGENT_MAX_PER_LEAD, type AgentChoice, type SubagentSettings } from '../../shared/protocol';
import { SETTINGS_CARDS, SETTINGS_PANES, searchSettings, settingsPaneAfter, type SettingsCardTitle, type SettingsPane } from '../../shared/settings-nav';
import { claimEscape, h, openModal, timeAgo } from './dom';
import { onJiraSetup } from './jira';
import { disclosure, field, toggle as kitToggle } from './kit';
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

/** The sidearm 7 puts in your hand: its button, and what it does. */
const SIDEARMS: [Sidearm, string, string][] = [
  ['wand', '🪄 Droid wand', 'Flick a spell at a worker to open its terminal; five spells on 1–5. A fully charged spell sends it home.'],
  ['magnum', '🔫 .44 Magnum', 'Fire at a worker to open its terminal. Hold for a charged shot that sends it home and deletes its worktree and branch.'],
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

/** A card from SETTINGS_CARDS, so a setting can't show up without a category (and search can find it). */
const card = (title: SettingsCardTitle, parts: RowParts) => setting(title, parts);

/** Rows under an eyebrow, in one bordered block. */
const group = (title: string | null, ...rows: Node[]) => h('div.settings-group', {}, title ? h('h4.group-title', {}, title) : null, h('div.group', {}, ...rows));

/** Rows that only mean something with the row above them: indented under it, and hidden with it. */
const nest = (...rows: Node[]) => h('div.group-nest', {}, ...rows);

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
  // ---- You ----------------------------------------------------------------------------------------
  const character = h('button.btn', { type: 'button' }, 'Change look & name');
  const sidearmNote = desc();
  const sidearm = radios<Sidearm>(
    'What 7 puts in your hand',
    SIDEARMS.map(([value, label]) => [value, label] as const),
    () => settings.sidearm,
    (value) => {
      settings = { ...settings, sidearm: value };
      onChange(settings);
      paintSidearm();
    },
  );
  const paintSidearm = () => {
    sidearm.paint();
    sidearmNote.textContent = SIDEARMS.find(([value]) => value === settings.sidearm)?.[2] ?? '';
  };
  paintSidearm();

  // ---- Sound & alerts -----------------------------------------------------------------------------
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
  const alertRow = h('div.row', {}, alertPlay, alertMute);
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
  const notifySample = h('button.btn.sm', { type: 'button', onclick: () => notifier.sample() }, 'Try one');
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
          'Turn on',
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
          ? 'Your browser blocks notifications from the office. Allow them in the site settings (left of the address), then open Settings again.'
          : 'When a worker needs you or finishes while you’re in another tab or app. Click one to jump to that worker’s terminal.';
  };
  paintNotify();

  // ---- Display ------------------------------------------------------------------------------------
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
  const sharpenRow = card('Sharpening', { desc: sharpenNote, control: sharpen.row });
  // Remastered draws every pixel with its own anti-aliasing, so these three only show under Classic.
  const classicRows = nest(
    card('Render resolution', { desc: scaleNote, control: scale.row }),
    card('Temporal anti-aliasing', { desc: desc('Blends each frame into the ones before to smooth edges and win back detail below 100%. Fast motion can smear a little; off uses 4× MSAA.'), control: taa.el }),
    sharpenRow,
  );
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
    classicRows.classList.toggle('hidden', remastered);
    hdrRows.classList.toggle('hidden', !remastered);
    scaleNote.textContent =
      g.scale >= 1
        ? 'Every pixel of your screen. Lower it to draw fewer and upscale them, for less GPU work a frame.'
        : `Draws ${Math.round(g.scale * g.scale * 100)}% of your screen’s pixels and upscales them${g.taa ? ' with TAA' : '; turn on TAA to win back detail'}.`;
    const native = g.scale >= 1 && !g.taa;
    sharpenRow.classList.toggle('muted', native);
    sharpen.slider.disabled = native;
    sharpenNote.textContent = native ? 'Only applies below 100% or with TAA on.' : 'Wins back what upscaling and TAA soften.';
  };

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
    rendererNote.textContent = renderer?.remastered() ? 'Full resolution with 2× MSAA and baked bounce light: natural color, soft light from screens and lamps.' : 'Toon shading and ink outlines, at the resolution and anti-aliasing below.';
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
  const hdrRows = nest(card('HDR', { desc: hdrNote, control: hdrToggle.el }));
  function paintHdr() {
    hdrToggle.paint();
    hdrNote.textContent = renderer?.hdrNote() || 'Highlights up to 4× brighter than white on an EDR display. Stays SDR where the display or browser can’t.';
  }
  const onHdrStatus = () => paintHdr();
  window.addEventListener('office:hdr', onHdrStatus);
  paintRenderer();
  paintHdr();

  // ---- Workers ------------------------------------------------------------------------------------
  // Where a fresh worker starts: the latest main, or the branch the checkout is on.
  const freshNote = desc();
  const fresh = radios(
    'Where fresh workers start',
    [
      [true, 'Latest floor branch'],
      [false, 'Checkout’s branch'],
    ] as const,
    () => store.freshMain.on,
    (on) => net.send({ t: 'freshMain.set', on }),
  );
  const paintFresh = () => {
    fresh.paint();
    freshNote.textContent = store.freshMain.on
      ? 'From the latest floor branch: the repository default, unless the floor menu picks another. Subagents start where their lead says.'
      : 'From the branch the checkout is on, unless the floor menu picks one. Subagents start where their lead says.';
  };
  paintFresh();

  // The most workers the office runs at once, across every floor.
  const limitInput = h('input.input.setting-number', { type: 'text', inputmode: 'numeric', 'aria-label': 'Most workers at once', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const limitSave = h('button.btn', { type: 'button' }, 'Set');
  const limitClear = h('button.btn.ghost', { type: 'button' });
  const limitRow = h('div.row', {}, h('div.input-group', {}, limitInput, limitSave), limitClear);
  const limitNote = desc();
  const paintLimit = () => {
    const m = store.machine;
    limitInput.placeholder = m.limit !== undefined ? String(m.limit) : m.ceiling ? `1 to ${m.ceiling}` : 'e.g. 6';
    limitClear.textContent = m.ceiling ? `Back to ${m.ceiling}` : 'No limit';
    limitClear.classList.toggle('hidden', !m.set);
    limitNote.textContent =
      m.limit === undefined
        ? `No limit: a worker for every free seat. ${m.workers} working now, across every floor.`
        : `At most ${m.limit} at once across every floor, shells and board agents included (${m.workers} now). Hiring past it is refused.`;
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

  // Whether a worker whose pull request merged goes home by itself.
  const leaveNote = desc();
  const leave = radios(
    'Workers whose pull request merged',
    [
      [true, 'Go home'],
      [false, 'Stay'],
    ] as const,
    () => store.leaveOnMerge.on,
    (on) => net.send({ t: 'leaveOnMerge.set', on }),
  );
  const paintLeave = () => {
    leave.paint();
    leaveNote.textContent = store.leaveOnMerge.on
      ? 'Once idle with its terminal closed, a merged worker goes home and its worktree and branch are deleted. Uncommitted or unpushed work is kept.'
      : 'A merged worker stays at its desk, outlined in purple, until you send it home.';
  };
  paintLeave();

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
      [true, 'This floor’s own'],
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
        ? 'Set for this floor, in place of the repository’s.'
        : r.setupFrom === 'repo' || r.copyFrom === 'repo'
          ? `From ${SETUP_FILE}${st.include ? ` and ${INCLUDE_FILE}` : ''} in the repository.`
          : r.setupFrom === 'detected'
            ? `Detected from its lockfiles; commit a ${SETUP_FILE} to pin it.`
            : `Nothing to install was detected; commit a ${SETUP_FILE} to say what runs.`;
    setupNote.textContent = `On this floor, a new worktree ${describeSetup(r, (c) => `“${c}”`)}. ${from} The agent starts once it’s done, even if it fails.`;
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

  // Every prompt the office writes for workers, subagents and visits included, in one editor.
  const promptsOpen = h('button.btn.sm', { type: 'button', onclick: () => openPromptEditor(net) }, 'Edit prompts…');
  const promptsNote = desc();
  const paintPrompts = () => {
    const n = rewrittenPrompts();
    promptsNote.textContent = `What the office tells workers for you: handoffs, reviews, board agents, subagent briefs, visits and the sign writer. ${n ? `${n} rewritten.` : 'All as the office wrote them.'}`;
  };
  paintPrompts();

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
      s.skillError ??
      (s.on
        ? 'Droid workers learn to put cards on the floor’s Whiteboard and read your marks, from the droid-office-whiteboard skill.'
        : 'Not in ~/.factory/skills. Workers can still learn it from office-whiteboard help when you point them there.');
  };
  paintBoardSkill();

  // Worker labels: the form folds away; its summary says what they're doing now.
  const workerLabels = workerLabelSettings(net);
  const labels = disclosure('Configure', workerLabels.element);
  const paintLabels = () => {
    const s = store.workerLabels.settings;
    labels.meta.textContent = s.on ? `On · ${s.implementation === 'custom' ? 'custom script' : (modelBadge(s.model, undefined) ?? s.model)} · every ${s.intervalSeconds} s` : 'Off';
  };
  paintLabels();

  // ---- Models -------------------------------------------------------------------------------------
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
    agentBack.classList.toggle('hidden', !picked);
    agentBack.textContent = `Back to ${store.project?.agentCmd.split(' ')[0].split(/[\\/]/).pop() ?? 'the --agent'}`;
    if (!agentTouched) agent.set(officeChoice());
    agentNote.textContent = `What a new worker runs when nobody picks a model. The hire and ask windows remember their own picks per desk.${picked ? '' : ' Now it’s the agent the office started with, on its own default model.'}`;
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

  const modelVisibility = hiddenModelSettings(net);
  const pickerModels = disclosure('Choose models', modelVisibility.element);
  const paintPickerModels = () => {
    const n = store.hiddenModels.length;
    pickerModels.meta.textContent = n ? `${n} hidden` : 'All shown';
  };
  paintPickerModels();

  // ---- Subagents & visits -------------------------------------------------------------------------
  const subSet = (patch: Partial<SubagentSettings>) => net.send({ t: 'subagents.set', settings: { ...subagentSettings(), ...patch } });
  const subOn = toggle(
    'Subagents',
    () => store.subagents.on,
    (on) => subSet({ on }),
  );
  const subNote = desc();
  const subWho = radios(
    'Who can hire',
    [
      [true, 'Lead and desk workers'],
      [false, 'Only the lead'],
    ] as const,
    () => store.subagents.deskWorkers,
    (deskWorkers) => subSet({ deskWorkers }),
  );
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
      [false, 'Lead’s checkout'],
    ] as const,
    () => store.subagents.worktree,
    (worktree) => subSet({ worktree }),
  );
  const subWake = radios(
    'Waking the lead',
    [
      [true, 'Wake it'],
      [false, 'Let it check'],
    ] as const,
    () => store.subagents.wakeLead,
    (wakeLead) => subSet({ wakeLead }),
  );

  // What a subagent runs when its lead doesn't say: every model droid lists.
  const subFallback = () => store.subagents.agent ?? officeChoice();
  const subAgent = agentFields('subagent-agent', subFallback());
  let subAgentTouched = false;
  subAgent.element.addEventListener('change', () => (subAgentTouched = true));
  subAgent.element.addEventListener('input', () => (subAgentTouched = true));
  const subAgentSave = h('button.btn.sm.primary', { type: 'button' }, 'Save');
  const subAgentBack = h('button.btn.sm', { type: 'button' }, 'Use the default worker');
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
  const subModelsMore = disclosure('Choose models', subModels.element);

  const subSkill = toggle(
    'Subagents skill installed',
    () => store.subagents.skill,
    (skill) => subSet({ skill }),
  );
  const subSkillNote = desc();
  const visitsOn = toggle(
    'Visits between workers',
    () => store.subagents.visits ?? true,
    (visits) => subSet({ visits }),
  );
  const visitsNote = desc();

  const subOptions = nest(
    card('Who can hire', { desc: desc('The Team lead can always hire.'), control: subWho.row }),
    card('Team size', { desc: subSizeNote, control: subSize.row }),
    card('Where subagents work', { desc: desc('Own worktrees let subagents change files side by side, each on its own branch. A lead can still ask with --worktree or --no-worktree.'), control: subTree.row }),
    card('Waking the lead', { desc: desc('When a subagent reports back, a resting lead is nudged to read it. A busy lead hears it when it next stops.'), control: subWake.row }),
    card('Subagent worker', { desc: subAgentNote, below: [subAgent.element, h('div.row', {}, subAgentSave, subAgentBack)] }),
    card('Models leads can pick', { desc: subModelsNote, below: [subModelsMore] }),
    card('Subagents skill', { desc: subSkillNote, control: subSkill.el }),
  );

  const paintSubagents = () => {
    const s = store.subagents;
    for (const r of [subOn, subWho, subSize, subTree, subWake, subSkill, visitsOn]) r.paint();
    subOptions.classList.toggle('hidden', !s.on);
    subNote.textContent = s.on
      ? 'A lead runs office-workers hire and the subagent sits at the nearest free desk with its own terminal. It reports back, and its lead sends it home.'
      : 'Hiring is refused. Subagents already working carry on and can still report back.';
    subSizeNote.textContent = `Up to ${s.maxPerLead} per lead at once; the worker limit still counts each one.`;
    if (!subAgentTouched) subAgent.set(subFallback());
    subAgentBack.classList.toggle('hidden', !s.agent);
    subAgentNote.textContent = s.agent
      ? `Subagents start on ${choiceLabel(s.agent)} unless their lead asks for another with --model or --effort.`
      : `Subagents start on the default worker (${choiceLabel(officeChoice())}, Models → Default worker) unless their lead asks for another with --model or --effort.`;
    subModels.paint(s.models);
    const n = s.models?.length ?? 0;
    subModelsMore.meta.textContent = n ? `${n} picked` : 'Any model';
    subModelsNote.textContent = n
      ? `Leads choose from these ${n} by your notes and each model’s credit multiplier; hire refuses any other. The subagent worker is always allowed.`
      : 'Leads may give a subagent any model. Pick some to limit them, with a note on what each is for.';
    subSkillNote.textContent =
      s.skillError ??
      (s.skill
        ? 'Desk workers learn to hire from the droid-office-subagents skill. The Team lead always knows from its brief.'
        : 'Not in ~/.factory/skills. Desk workers hire only when you point them at office-workers; the Team lead always knows.');
    visitsNote.textContent =
      (s.visits ?? true)
        ? 'Workers you hired find each other with office-visit, walk over, read each other’s screens, and tell, ask or hand off work. An urgent message cancels the other worker’s turn.'
        : 'Every office-visit command is refused, and visits under way end.';
  };
  paintSubagents();

  // ---- Connections --------------------------------------------------------------------------------
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
  const epicCard = card("This floor's Jira epic", { desc: epicNote, below: [epicRow, epicFail] });
  let editingJira = false;
  let jiraBusy: '' | 'connect' | 'epic' = '';
  let jiraError = '';
  let epicError = '';
  const paintJira = () => {
    const { connection, epic } = store.jira;
    jiraForm.classList.toggle('hidden', !!connection && !editingJira);
    jiraCancel.classList.toggle('hidden', !connection);
    jiraActions.classList.toggle('hidden', !connection || editingJira);
    jiraConnect.disabled = jiraBusy === 'connect';
    jiraConnect.textContent = jiraBusy === 'connect' ? 'Checking…' : 'Connect';
    jiraFail.classList.toggle('hidden', !jiraError);
    jiraFail.textContent = jiraError;
    jiraNote.textContent = connection
      ? `Reading ${connection.site} as ${connection.name === connection.email ? connection.email : `${connection.name} (${connection.email})`}. The office only reads Jira; it never changes a ticket.`
      : 'Connect with your site, email and an API token from https://id.atlassian.com/manage-profile/security/api-tokens (read:jira-work is enough). Each floor then picks its own epic.';
    epicCard.classList.toggle('hidden', !connection || !store.floor);
    epicRemove.classList.toggle('hidden', !epic);
    epicSave.disabled = jiraBusy === 'epic';
    epicSave.textContent = jiraBusy === 'epic' ? 'Checking…' : 'Set epic';
    if (!epicInput.value && epic) epicInput.value = epic.key;
    epicFail.classList.toggle('hidden', !epicError);
    epicFail.textContent = epicError;
    epicNote.textContent = epic
      ? `This floor’s issue board has a Jira tab for ${epic.key}${epic.summary ? ` (“${epic.summary}”)` : ''}, in To Do, In Progress and Done.`
      : 'Give this floor an epic and its issue board gets a Jira tab with the epic’s tickets.';
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

  const droid = droidSettings(net);
  const factoryKey = factoryKeySettings(net);
  const subscriptions = subscriptionsSettings(net);
  const subscriptionGroup = group('Subscriptions', card('DroidProxy', subscriptions.proxy), card('Accounts', subscriptions.accounts), card('Models in Droid', subscriptions.models));
  subscriptions.hideWhenUnsupported(subscriptionGroup);

  // ---- Office & floors ----------------------------------------------------------------------------
  // Where the elevator looks for existing git projects on the office's machine.
  const dirInput = h('input.input', { type: 'text', placeholder: '~/Workspace', 'aria-label': 'Workspace folder', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const dirSave = h('button.btn', { type: 'button' }, 'Save');
  const dirDefault = h('button.btn.ghost', { type: 'button' }, 'Use the default');
  const dirRow = h('div.row.wrap', {}, h('div.input-group.grow', {}, dirInput, dirSave), dirDefault);
  const dirNote = desc();
  const paintDir = () => {
    const { dir, custom } = store.projectsDir;
    dirInput.value = dir;
    dirDefault.classList.toggle('hidden', !custom);
    dirNote.textContent = 'The elevator lists the git projects in this folder, up to four levels deep, and opens your pick as a floor right where it is. Nothing is cloned or copied.';
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
  const sourceReload = hotReloadSettings();

  // ---- Phone & web --------------------------------------------------------------------------------
  // Droid Office for Android: the pairing QR code is its own window, over this one.
  const phoneOpen = h('button.btn.primary', { type: 'button' }, 'Pair a phone…');
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

  // ---- The panes ----------------------------------------------------------------------------------
  const panes: Record<SettingsPane, Node[]> = {
    you: [
      group('Profile', card('Your character', { desc: desc('How you look and the name above your head.'), control: character })),
      group(
        'Controls',
        card('What 7 puts in your hand', { desc: sidearmNote, control: sidearm.row }),
        card('Look sensitivity', { desc: desc('How far the view turns for the same mouse movement. 1× is the office’s own speed.'), control: lookRow }),
        card('Raw mouse input', {
          desc: desc('Skips macOS pointer acceleration, so the same hand movement always turns the view the same amount. Applies the next time the office captures the mouse.'),
          control: rawMouse.el,
        }),
      ),
      group(
        'Shortcuts',
        card('Prompt chips', {
          desc: desc('One tap fills a prompt box.'),
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
        'Volume',
        card('Office sounds', { desc: desc('Typing, thunder and the rest of the room. Muting it silences alerts too.'), control: soundRow }),
        card('Jukebox', { desc: desc('Your own volume; the music is louder near the jukebox.'), control: musicRow }),
      ),
      group('Alerts', card('Alert sounds', { desc: desc('A short tone when a worker needs you, finishes, or its tests fail.'), control: alertRow }), card('Desktop notifications', { desc: notifyNote, control: notifyRow })),
    ],
    graphics: [
      group('Quality', card('Renderer', { desc: rendererNote, control: rendererPick.row }), hdrRows, classicRows),
      group(
        'Performance',
        card('Frame rate limit', {
          desc: desc('The most frames a second while something moves; 40, 60 and 120 fit a 120 Hz display evenly. A still office idles lower.'),
          control: fpsCap.row,
        }),
        card('Performance overlay', { desc: desc('Bottom right: frame rate and pacing, GPU time and load, and the render resolution.'), control: stats.el }),
      ),
      group('Lighting', card('Overhead lights', { desc: desc('How bright the ceiling lights are. At 0% the moon, the screens and the bounce light are all that light the room.'), control: overhead.row })),
    ],
    workers: [
      group(
        'Hiring',
        card('Where fresh workers start', { desc: freshNote, control: fresh.row }),
        card('Worker limit', { desc: limitNote, control: limitRow }),
        card('Workers whose pull request merged', { desc: leaveNote, control: leave.row }),
      ),
      group('Worktrees', card('Worktree setup', { desc: setupNote, control: setupMode.row, below: [setupFail, setupForm, setupActions] })),
      group(
        'Guidance',
        card('Prompts', { desc: promptsNote, control: promptsOpen }),
        card('Whiteboard skill', { desc: boardSkillNote, control: boardSkill.el }),
        card('Worker labels', { desc: desc('A task subject and a one-line summary over each local worker, written by a small model as it works.'), below: [labels] }),
      ),
    ],
    models: [
      group(
        null,
        card('Default worker', { desc: agentNote, below: [agent.element, agentActions] }),
        card('Models shown in pickers', { desc: desc('Hide the models you never use from every picker on desktop, web and Android. Running workers and saved defaults stay as they are.'), below: [pickerModels] }),
      ),
    ],
    subagents: [group('Subagents', card('Subagents', { desc: subNote, control: subOn.el }), subOptions), group('Visits', card('Visits between workers', { desc: visitsNote, control: visitsOn.el }))],
    connections: [
      group('Factory', card('Droid', droid.parts), card('Factory API key', factoryKey.key)),
      subscriptions.unsupported,
      subscriptionGroup,
      group('Jira', card('Jira', { desc: jiraNote, below: [jiraForm, jiraFail, jiraActions] }), epicCard),
    ],
    office: [
      group(
        null,
        card('Workspace folder', { desc: dirNote, below: [dirRow] }),
        ...(outside
          ? [
              card('Outside', {
                desc: desc(outside.live ? 'The office’s clock, and the live weather where it is.' : 'The office’s clock, and made-up weather. Start the office with --city for a real forecast.'),
                control: outsideNow(outside.now),
              }),
            ]
          : []),
      ),
      group(
        'App',
        card('Host desktop app', {
          desc: desc('Check for a signed update to the Mac app. Workers keep running while it restarts.'),
          control: h('button.btn', { type: 'button', onclick: openHostUpdate }, 'Check for updates…'),
        }),
        card('Source hot reload', { desc: sourceReload.note, below: [sourceReload.element] }),
      ),
    ],
    phone: [
      group(
        null,
        card('Droid Office for Android', { desc: h('span.stack.tight', {}, desc('Hire, watch and prompt workers from your phone. A paired phone keeps working after restarts.'), phoneStatus), control: phoneOpen }),
        card('Web companion', { desc: h('span.stack.tight', {}, desc('Your workers, their terminals and the Whiteboard in any desktop browser, at /dashboard.'), webStatus), control: webOpen }),
      ),
    ],
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
  /** Flashes a setting's row. One hidden with the setting it hangs off (Classic rows under Remastered, subagent options while they're off, the epic before Jira is connected) flashes that setting instead. */
  const flashRow = (title: string) => {
    const hit = rowByTitle.get(title);
    if (!hit) return;
    let row = hit.row;
    if (!row.getClientRects().length) {
      // The row the nest hangs off is the nearest setting row before it (another nest, like HDR before Classic's, can sit between).
      let parent = row.closest('.group-nest')?.previousElementSibling;
      while (parent && !parent.matches('.group-row')) parent = parent.previousElementSibling;
      row = parent instanceof HTMLElement && parent.getClientRects().length ? parent : (row.closest('.group')?.querySelector<HTMLElement>(':scope > .group-row') ?? row);
    }
    clearTimeout(flashTimer);
    for (const el of bodies.get(hit.pane)?.querySelectorAll('.group-row.flash') ?? []) el.classList.remove('flash');
    row.classList.add('flash');
    row.scrollIntoView({ block: 'center' });
    flashTimer = setTimeout(() => row.classList.remove('flash'), 2000);
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
        h('p', {}, hits.length ? `${hits.length} setting${hits.length === 1 ? ' matches' : 's match'} “${query}”. Pick one to jump to it.` : `No settings match “${query}”. Try a setting's name, like “Jira”, “models” or “volume”.`),
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
  const offStore = [
    store.on('leaveOnMerge', paintLeave),
    store.on('freshMain', paintFresh),
    store.on('machine', paintLimit),
    store.on('projectsDir', paintDir),
    store.on('jira', paintJira),
    store.on('prompts', paintAgent),
    store.on('prompts', paintPrompts),
    store.on('prompts', paintSubagents),
    store.on('subagents', paintSubagents),
    store.on('whiteboardSkill', paintBoardSkill),
    store.on('workerLabels', paintLabels),
    store.on('hiddenModels', paintPickerModels),
    offSetup,
    ...offWorktreeSetup,
  ];
  const modal = openModal(el, {
    doing: '⚙️ in settings',
    onClose: () => {
      offSearchEscape();
      clearTimeout(flashTimer);
      wide.removeEventListener('change', orient);
      for (const off of offStore) off();
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
