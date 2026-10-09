import type { Net } from '../net';
import { store, type Settings } from '../state';
import { askNotifyPermission, notifyPermission, type DesktopNotifier } from '../notify';
import { SUBAGENT_MAX_PER_LEAD, type AgentChoice, type SubagentSettings, type WebhookKind } from '../../shared/protocol';
import { SETTINGS_CARDS, SETTINGS_PANES, SETTINGS_SCOPE, settingsPaneAfter, type SettingsCardTitle, type SettingsPane, type SettingsScope } from '../../shared/settings-nav';
import { h, openModal, timeAgo } from './dom';
import { onJiraSetup } from './jira';
import { field, toggle as kitToggle } from './kit';
import { agentFields, modelBadge, officeChoice } from './models';
import { openPromptEditor, rewrittenPrompts } from './prompts';
import { hotReloadSettings } from './hot-reload';
import { factoryKeySettings } from './factory-settings';
import { openPhone, pairedPhones } from './phone';
import type { PairedDevice } from '../../shared/devices';

const WEBHOOK_NAME: Record<WebhookKind, string> = { slack: 'Slack', discord: 'Discord', other: 'a webhook' };

export type { SettingsPane };

/** What a settings row holds besides its title: a description under it, a control on its right, and anything wide (a form, a picker) full width under the label. */
interface RowParts {
  desc?: Node | null;
  control?: Node | null;
  below?: Node[];
}

/** One setting as a row: its name with who it's for and a description on the left, whatever sets it on the right. */
const setting = (title: string, scope: SettingsScope | null, { desc, control, below = [] }: RowParts) =>
  h(
    'div.group-row',
    { class: below.length ? 'block' : '' },
    h('div.group-label', {}, h('b', {}, h('span', {}, title), scope && h('span.scope', { class: scope, title: SETTINGS_SCOPE[scope][1] }, SETTINGS_SCOPE[scope][0])), desc),
    control ? h('div.setting-control', {}, control) : null,
    ...below,
  );

/** A card from SETTINGS_CARDS, so a setting can't show up without a category and a scope. */
const card = (title: SettingsCardTitle, parts: RowParts) => {
  const meta = SETTINGS_CARDS.find((c) => c.title === title)!;
  return setting(title, meta.scope, parts);
};

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
  const { on, deskWorkers, skill, worktree, maxPerLead, wakeLead, agent } = store.subagents;
  return { on, deskWorkers, skill, worktree, maxPerLead, wakeLead, ...(agent ? { agent } : {}) };
}

/** `outside` describes the sky over the office (see describeSky), once the server has said. `first` opens on that category instead of the last one. */
export function openSettings(net: Net, settings: Settings, onChange: (s: Settings) => void, onCharacter: () => void, previewSound: () => void, notifier: DesktopNotifier, outside?: { now: string; live: boolean }, first?: SettingsPane) {
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
          : 'When a worker needs input or finishes while you’re elsewhere, you get a notification; click it to jump to that worker’s terminal. The tab title counts the waiting workers either way.';
  };
  paintNotify();

  // The office's Slack / Discord webhook, shared by everyone.
  const hookStatus = desc();
  const hookError = h('p.note.bad', { role: 'alert' });
  const hookInput = h('input.input', { type: 'text', placeholder: 'https://hooks.slack.com/services/…', 'aria-label': 'Slack or Discord webhook URL', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const hookSave = h('button.btn', { type: 'button' }, 'Save');
  const hookTest = h('button.btn.sm', { type: 'button' }, 'Send a test');
  const hookRemove = h('button.btn.sm.danger', { type: 'button' }, 'Remove');
  const hookActions = h('div.row', {}, hookTest, hookRemove);
  const paintHook = () => {
    const { webhook, error, lastSentAt } = store.notify;
    hookActions.classList.toggle('hidden', !webhook);
    hookSave.textContent = webhook ? 'Replace' : 'Save';
    hookError.classList.toggle('hidden', !webhook || !error);
    hookError.textContent = webhook && error ? `Posting to ${WEBHOOK_NAME[webhook.kind]} (${webhook.hint}) failed: ${error}` : '';
    hookStatus.textContent = !webhook
      ? 'Paste an incoming webhook from Slack or Discord, and the office posts to that channel when a worker needs input or finishes and nobody has its terminal open.'
      : `Posting to ${WEBHOOK_NAME[webhook.kind]} (${webhook.hint}), set by ${webhook.by} ${timeAgo(webhook.at)}${lastSentAt ? ` · last message ${timeAgo(lastSentAt)}` : ''}.`;
  };
  paintHook();
  const saveHook = () => {
    const url = hookInput.value.trim();
    if (!url) return hookInput.focus();
    net.send({ t: 'notify.webhook', url });
    hookInput.value = '';
  };
  hookSave.addEventListener('click', saveHook);
  hookInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveHook();
  });
  hookTest.addEventListener('click', () => net.send({ t: 'notify.test' }));
  hookRemove.addEventListener('click', () => net.send({ t: 'notify.webhook', url: '' }));

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
      'What a worker starts on when nobody picks one. The hire, queue, meeting and ask windows remember their own picks per desk.' +
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
    promptsNote.textContent = `What the office tells workers for you: handoffs, reviews, board buttons, the queue’s task note, board agents, meetings and the sign writer. ${status}`;
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
  const subSkill = toggle(
    'Droid skill installed',
    () => store.subagents.skill,
    (skill) => subSet({ skill }),
  );
  const subSkillNote = desc();

  const paintSubagents = () => {
    const s = store.subagents;
    for (const r of [subOn, subWho, subSize, subTree, subWake, subSkill]) r.paint();
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

  const character = h('button.btn', { type: 'button' }, 'Change your look & name');
  epicCard = card("This floor's Jira epic", { desc: epicNote, below: [epicRow, epicFail] });
  paintJira();
  const sourceReload = hotReloadSettings();
  const factoryKey = factoryKeySettings(net);
  const panes: Record<SettingsPane, Node[]> = {
    you: [group(null, card('Your character', { desc: desc('How you look and the name above your head.'), control: character }))],
    sound: [
      group(
        null,
        card('Office sounds', { desc: desc('Workers typing, the coffee machine, thunder, and the ding when a worker is done.'), control: soundRow }),
        card('Jukebox', { desc: desc('Everyone on the floor hears the same song, louder near the jukebox; this slider is only your volume.'), control: musicRow }),
      ),
    ],
    notify: [
      group('This browser', card('Desktop notifications', { desc: notifyNote, control: notifyRow })),
      group('The office', card('Channel notifications (Slack / Discord)', { desc: hookStatus, below: [h('div.input-group', {}, hookInput, hookSave), hookError, hookActions] })),
    ],
    building: [
      ...(outside
        ? [
            group(
              'Outside',
              card('Outside', {
                desc: desc(
                  outside.live
                    ? 'Everyone sees the same sky: the office’s clock and the live weather where it is.'
                    : 'Everyone sees the same sky: the office’s clock, and weather that comes and goes. Start the office with --city to use a real city’s forecast.',
                ),
                control: outsideNow(outside.now),
              }),
            ),
          ]
        : []),
      group('Jira', card('Jira', { desc: jiraNote, below: [jiraForm, jiraFail, jiraActions] }), epicCard),
      group('Projects', card('Workspace folder', { desc: dirNote, below: [dirRow] })),
      group('Development', card('Source hot reload', { below: [sourceReload.element] })),
    ],
    factory: [group('Connection', card('Factory API key', factoryKey.key)), factoryKey.reach],
    workers: [
      group('New workers', card('Default worker', { desc: agentNote, below: [agent.element, agentActions] }), card('Prompts', { desc: promptsNote, control: promptsOpen })),
      group('Running', card('Worker limit', { desc: limitNote, control: limitRow }), card('Workers whose pull request merged', { desc: leaveNote, control: leaveRow })),
    ],
    subagents: [
      group(
        'Hiring',
        card('Subagents', { desc: subNote, control: subOn.el }),
        setting('Who can hire', null, { desc: desc('The Team lead can always hire; desk workers too, when allowed.'), control: subWho.row }),
        setting('Subagent prompts', null, { desc: desc('What the office tells the Team lead and its subagents.'), control: subPrompts }),
      ),
      group(
        'How they work',
        card('Subagent worker', { desc: subAgentNote, below: [subAgent.element, h('div.row', {}, subAgentSave, subAgentBack)] }),
        card('Team size', { desc: subSizeNote, control: subSize.row }),
        card('Where subagents work', { desc: subTreeNote, control: subTree.row }),
        card('Waking the lead', { desc: subWakeNote, control: subWake.row }),
      ),
      group('Droid', card('Droid skill', { desc: subSkillNote, control: subSkill.el })),
    ],
    phone: [group(null, card('Droid Office for Android', { desc: h('span.stack.tight', {}, phoneNote, phoneStatus), control: phoneOpen }))],
  };

  // The categories down the side, the one picked on the right. On a phone the row is across the top.
  const nav = h('nav.settings-nav', { role: 'tablist', 'aria-label': 'Settings' });
  const tabs = new Map<SettingsPane, HTMLButtonElement>();
  const bodies = new Map<SettingsPane, HTMLElement>();
  for (const p of SETTINGS_PANES) {
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
        h('div.settings-head', {}, h('h3', {}, h('span.icon', { 'aria-hidden': 'true' }, p.icon), p.label), h('p', {}, p.blurb)),
        ...panes[p.id],
      ),
    );
  }
  const show = (id: SettingsPane) => {
    lastPane = id;
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
  const el = h('div.modal.xl.settings', { role: 'dialog', 'aria-label': 'Settings' }, h('header', {}, h('h2', {}, 'Settings'), close), h('div.split.settings-body', {}, nav, ...bodies.values()));
  const offNotify = store.on('notify', paintHook);
  const offLeave = store.on('leaveOnMerge', paintLeave);
  const offLimit = [store.on('machine', paintLimit)];
  const offDir = [store.on('projectsDir', paintDir)];
  const offJira = [store.on('jira', paintJira), offSetup];
  const offPrompts = [store.on('prompts', paintAgent), store.on('prompts', paintPrompts), store.on('prompts', paintSubagents), store.on('subagents', paintSubagents)];
  const modal = openModal(el, {
    doing: '⚙️ in settings',
    onClose: () => {
      wide.removeEventListener('change', orient);
      offNotify();
      offLeave();
      offLimit.forEach((off) => off());
      offDir.forEach((off) => off());
      offJira.forEach((off) => off());
      offPrompts.forEach((off) => off());
      sourceReload.dispose();
      factoryKey.dispose();
    },
  });
  show(first ?? lastPane);
  close.addEventListener('click', () => modal.close());
  character.addEventListener('click', () => {
    modal.close();
    onCharacter();
  });
}
