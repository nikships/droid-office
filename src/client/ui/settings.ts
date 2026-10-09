import type { Net } from '../net';
import { store, type Settings, type ViewMode } from '../state';
import { askNotifyPermission, notifyPermission, type DesktopNotifier } from '../notify';
import { SUBAGENT_MAX_PER_LEAD, type AgentChoice, type SubagentSettings, type WebhookKind } from '../../shared/protocol';
import { SETTINGS_CARDS, SETTINGS_PANES, SETTINGS_SCOPE, settingsPaneAfter, type SettingsCardTitle, type SettingsPane, type SettingsScope } from '../../shared/settings-nav';
import { h, openModal, timeAgo } from './dom';
import { onJiraSetup } from './jira';
import { agentFields, modelBadge, officeChoice } from './models';
import { openPromptEditor, rewrittenPrompts } from './prompts';
import { hotReloadSettings } from './hot-reload';
import { factoryKeySettings } from './factory-settings';
import { openPhone, pairedPhones } from './phone';
import type { PairedDevice } from '../../shared/devices';

const VIEWS: [ViewMode, string, string][] = [
  ['first', 'First person', 'See through your own eyes. Click the office to look around with the mouse and click things to use them. Esc frees the mouse.'],
  ['third', 'Third person', 'Follow your character from behind. Drag to orbit the camera, scroll to zoom, and click things to use them.'],
];

const WEBHOOK_NAME: Record<WebhookKind, string> = { slack: 'Slack', discord: 'Discord', other: 'a webhook' };

export type { SettingsPane };

/** One setting: its name and who it's for, then whatever sets it. */
const setting = (title: string, scope: SettingsScope | null, ...body: Node[]) =>
  h('div.setting', {}, h('div.setting-head', {}, h('h4', {}, title), scope && h('span.scope', { class: scope, title: SETTINGS_SCOPE[scope][1] }, SETTINGS_SCOPE[scope][0])), ...body);

/** A card from SETTINGS_CARDS, so a setting can't show up without a category and a scope. */
const card = (title: SettingsCardTitle, ...body: Node[]) => {
  const meta = SETTINGS_CARDS.find((c) => c.title === title)!;
  return setting(title, meta.scope, ...body);
};

/** Where Settings was last, so it opens there again. */
let lastPane: SettingsPane = 'you';

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

/** A droid choice in words: "Droid on Opus 5.5 · High", or Droid's own default. */
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
  const seg = h('div.seg', { role: 'radiogroup', 'aria-label': 'Camera view' });
  const note = h('p.setting-note');
  const paint = () => {
    seg.replaceChildren(
      ...VIEWS.map(([view, label]) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(settings.view === view),
            class: settings.view === view ? 'on' : '',
            onclick: () => {
              if (settings.view === view) return;
              settings = { ...settings, view };
              onChange(settings);
              paint();
            },
          },
          label,
        ),
      ),
    );
    note.textContent = VIEWS.find(([v]) => v === settings.view)![2];
  };
  paint();

  /** A volume slider with its mute button. Dragging it turns the sound back on; letting go plays `preview`. */
  const volumeRow = (label: string, level: 'volume' | 'music', muted: 'muted' | 'musicMuted', preview?: () => void) => {
    const slider = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': label });
    const pct = h('span.vol-pct');
    const mute = h('button.btn', { type: 'button' });
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
  const notifyRow = h('div.seg');
  const notifyNote = h('p.setting-note');
  const paintNotify = () => {
    const perm = notifyPermission();
    const on = perm === 'granted' && settings.notify;
    notifyRow.replaceChildren();
    if (perm === 'default') {
      notifyRow.append(
        h(
          'button.btn.primary',
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
      for (const [value, label] of [
        [true, 'On'],
        [false, 'Off'],
      ] as const) {
        notifyRow.append(
          h(
            'button.btn',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(on === value),
              class: on === value ? 'on' : '',
              onclick: () => {
                settings = { ...settings, notify: value };
                onChange(settings);
                paintNotify();
              },
            },
            label,
          ),
        );
      }
      if (on) notifyRow.append(h('button.btn', { type: 'button', onclick: () => notifier.sample() }, 'Show me one'));
    }
    notifyNote.textContent =
      perm === 'unsupported'
        ? 'This browser can’t show notifications from the office here. They need https or localhost (an SSH tunnel counts).'
        : perm === 'denied'
          ? 'Your browser blocks notifications from the office. Allow them in the site settings (the icon left of the address), then open this again.'
          : 'When a droid needs input or finishes while you’re in another tab or app, you get a notification. Click it to jump to that droid’s terminal. The tab title counts the droids waiting on someone either way.';
  };
  paintNotify();

  // The office's Slack / Discord webhook, shared by everyone.
  const hookStatus = h('p.setting-note');
  const hookInput = h('input', { type: 'text', placeholder: 'https://hooks.slack.com/services/…', 'aria-label': 'Slack or Discord webhook URL', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const hookSave = h('button.btn.primary', { type: 'button' }, 'Save');
  const hookTest = h('button.btn', { type: 'button' }, 'Send a test');
  const hookRemove = h('button.btn.danger', { type: 'button' }, 'Remove');
  const hookActions = h('div.seg', { style: 'margin-top:8px' }, hookTest, hookRemove);
  const paintHook = () => {
    const { webhook, error, lastSentAt } = store.notify;
    hookActions.classList.toggle('hidden', !webhook);
    hookSave.textContent = webhook ? 'Replace' : 'Save';
    hookStatus.classList.toggle('bad', !!error);
    hookStatus.textContent = !webhook
      ? 'Paste an incoming webhook from Slack or Discord, and the office posts to that channel when a droid needs input or finishes and nobody has its terminal open. It’s for everyone in the office.'
      : error
        ? `⚠️ Posting to ${WEBHOOK_NAME[webhook.kind]} (${webhook.hint}) failed: ${error}`
        : `📣 Posting to ${WEBHOOK_NAME[webhook.kind]} (${webhook.hint}), set by ${webhook.by} ${timeAgo(webhook.at)}${lastSentAt ? ` · last message ${timeAgo(lastSentAt)}` : ''}.`;
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

  // The droid a new one starts on when whoever starts it picks no model.
  const agent = agentFields('office-agent', officeChoice());
  let agentTouched = false;
  agent.element.addEventListener('change', () => (agentTouched = true));
  agent.element.addEventListener('input', () => (agentTouched = true));
  const agentSave = h('button.btn.primary', { type: 'button' }, 'Save');
  const agentBack = h('button.btn', { type: 'button' });
  const agentActions = h('div.seg', { style: 'margin-top:8px' }, agentSave, agentBack);
  const agentNote = h('p.setting-note');
  const paintAgent = () => {
    const picked = store.prompts.agent;
    const now = officeChoice();
    agentBack.classList.toggle('hidden', !picked);
    agentBack.textContent = `Back to ${store.project?.agentCmd.split(' ')[0].split(/[\\/]/).pop() ?? 'the --agent'}`;
    if (!agentTouched) agent.set(now);
    agentNote.textContent =
      'What a droid starts on when nobody picks one: tasks the Queue agent adds, and anything else started without a model. The hire, queue, meeting and ask windows keep their own pickers, which remember the last choice at each desk.' +
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

  // The prompts the office writes for droids by itself, for the whole office.
  const promptsOpen = h('button.btn', { type: 'button', onclick: () => openPromptEditor(net) });
  const promptsNote = h('p.setting-note');
  const paintPrompts = () => {
    const n = rewrittenPrompts();
    promptsOpen.textContent = 'Edit the prompts…';
    promptsNote.textContent =
      'What Hand to a droid, Review and the boards’ other buttons tell a droid, the note the queue adds to a task, the board agents’ briefs, the meeting room’s parts and the sign writer’s instructions. ' +
      (n ? `${n} of them rewritten.` : 'All as the office wrote them.');
  };
  paintPrompts();

  // The most droids the office runs at once, across every floor.
  const limitInput = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Most droids at once', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const limitSave = h('button.btn.primary', { type: 'button' }, 'Set limit');
  const limitClear = h('button.btn', { type: 'button' });
  const limitRow = h('div.webhook', {}, limitInput, limitSave, limitClear);
  const limitNote = h('p.setting-note');
  const paintLimit = () => {
    const m = store.machine;
    limitInput.placeholder = m.ceiling ? `1 to ${m.ceiling}` : 'e.g. 6';
    limitClear.textContent = m.ceiling ? `Back to ${m.ceiling}` : 'No limit';
    limitClear.classList.toggle('hidden', !m.set);
    const now =
      m.limit === undefined
        ? `No limit: the office hires a droid for every free seat. ${m.workers} ${m.workers === 1 ? 'is' : 'are'} here now, across every floor.`
        : `At most ${m.limit} droid${m.limit === 1 ? '' : 's'} at once, across every floor (${m.workers} now), shells and board agents too. Hiring past that is refused.`;
    const from = m.set ? ` Set by ${m.set.by} ${timeAgo(m.set.at)}.` : '';
    const cap = m.ceiling ? ` The office was started with --max-workers ${m.ceiling}, so it can't go any higher.` : '';
    limitNote.textContent = now + from + cap;
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

  // Whether a droid whose pull request merged goes home by itself, for everyone.
  const leaveRow = h('div.seg', { role: 'radiogroup', 'aria-label': 'Droids whose pull request merged' });
  const leaveNote = h('p.setting-note');
  const paintLeave = () => {
    const { on, by, at } = store.leaveOnMerge;
    leaveRow.replaceChildren(
      ...(
        [
          [true, 'Go home by themselves'],
          [false, 'Stay until sent home'],
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
      ? 'Once a droid’s pull request merges, it goes home as soon as it isn’t working or waiting on you and nobody has its terminal open, and its worktree and branch are deleted. A worktree with uncommitted changes, or commits that aren’t on the remote, is kept.'
      : 'A droid whose pull request merged stays at its desk, outlined in purple, until someone sends it home. Turned on, the ones already merged go too.';
    leaveNote.textContent = `${now} It’s the same for everyone in the building${by ? `, set by ${by}${at ? ` ${timeAgo(at)}` : ''}` : ''}.`;
  };
  paintLeave();

  // Where the elevator looks for existing git projects on the office's machine.
  const dirInput = h('input', { type: 'text', placeholder: '~/Workspace', 'aria-label': 'Workspace folder', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const dirSave = h('button.btn.primary', { type: 'button' }, 'Save');
  const dirDefault = h('button.btn', { type: 'button' }, 'Use the default');
  const dirRow = h('div.webhook', {}, dirInput, dirSave);
  const dirActions = h('div.seg', { style: 'margin-top:8px' }, dirDefault);
  const dirNote = h('p.setting-note');
  const paintDir = () => {
    const { dir, custom, by, at } = store.projectsDir;
    dirInput.value = dir;
    dirActions.classList.toggle('hidden', !custom);
    dirNote.textContent =
      `The elevator lists the git projects it finds in ${dir} on the office’s machine (up to four folders deep) and opens the one you pick as a floor, right where it is. Nothing is cloned or copied.` +
      (custom && by && at ? ` Set by ${by} ${timeAgo(at)}.` : '') +
      ' Floors you already have stay where they are when you move it.';
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
  const jiraSite = h('input', { type: 'text', placeholder: 'https://your-site.atlassian.net', 'aria-label': 'Jira Cloud site', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const jiraEmail = h('input', { type: 'email', placeholder: 'Email of the account the token belongs to', 'aria-label': 'Atlassian account email', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const jiraToken = h('input', { type: 'password', placeholder: 'API token (read-only is enough)', 'aria-label': 'Atlassian API token', spellcheck: 'false', autocomplete: 'new-password' }) as HTMLInputElement;
  const jiraConnect = h('button.btn.primary', { type: 'button' }, 'Connect') as HTMLButtonElement;
  const jiraCancel = h('button.btn', { type: 'button' }, 'Cancel');
  const jiraForm = h('div.jira-form', {}, jiraSite, jiraEmail, jiraToken, h('div.seg', {}, jiraConnect, jiraCancel));
  const jiraChange = h('button.btn', { type: 'button' }, 'Change');
  const jiraRemove = h('button.btn.danger', { type: 'button' }, 'Remove');
  const jiraActions = h('div.seg', { style: 'margin-top:8px' }, jiraChange, jiraRemove);
  const jiraNote = h('p.setting-note');
  const epicInput = h('input', { type: 'text', placeholder: 'Epic key, e.g. EDP-168', 'aria-label': 'Jira epic for this floor', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const epicSave = h('button.btn.primary', { type: 'button' }, 'Set epic') as HTMLButtonElement;
  const epicRemove = h('button.btn.danger', { type: 'button' }, 'Remove epic');
  const epicRow = h('div.webhook', {}, epicInput, epicSave);
  const epicActions = h('div.seg', { style: 'margin-top:8px' }, epicRemove);
  const epicNote = h('p.setting-note');
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
    jiraNote.classList.toggle('bad', !!jiraError);
    jiraNote.textContent = jiraError
      ? `⚠️ ${jiraError}`
      : connection
        ? `🎫 Reading ${connection.site} as ${connection.name === connection.email ? connection.email : `${connection.name} (${connection.email})`}, set up by ${connection.by} ${timeAgo(connection.at)}. The office only reads Jira; it never changes a ticket.`
        : 'Connect the office to Jira Cloud: a site, an email and an API token from https://id.atlassian.com/manage-profile/security/api-tokens. A read-only token (scope read:jira-work) is enough, since the office only reads. The token stays on the office’s machine and is never shown again. Each floor then picks its own epic.';
    const showEpic = !!connection && onFloor;
    epicCard?.classList.toggle('hidden', !showEpic);
    epicRow.classList.toggle('hidden', !showEpic);
    epicActions.classList.toggle('hidden', !showEpic || !epic);
    epicSave.disabled = jiraBusy === 'epic';
    epicSave.textContent = jiraBusy === 'epic' ? 'Checking…' : 'Set epic';
    if (!epicInput.value && epic) epicInput.value = epic.key;
    epicNote.classList.toggle('hidden', !showEpic);
    epicNote.classList.toggle('bad', !!epicError);
    epicNote.textContent = epicError
      ? `⚠️ ${epicError}`
      : epic
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

  // How droids hire subagents, for the whole office.
  const subSet = (patch: Partial<SubagentSettings>) => net.send({ t: 'subagents.set', settings: { ...subagentSettings(), ...patch } });
  const subOn = radios(
    'Subagents',
    [
      [true, 'Droids can hire'],
      [false, 'Off'],
    ] as const,
    () => store.subagents.on,
    (on) => subSet({ on }),
  );
  const subWho = radios(
    'Who can hire',
    [
      [true, 'The Team lead and desk droids'],
      [false, 'Only the Team lead'],
    ] as const,
    () => store.subagents.deskWorkers,
    (deskWorkers) => subSet({ deskWorkers }),
  );
  const subNote = h('p.setting-note');
  const subPrompts = h('button.btn', { type: 'button', onclick: () => openPromptEditor(net, 'subagent.brief') }, 'Edit the subagent prompts…');

  // What a subagent runs when its lead doesn't say: every model droid lists.
  const subFallback = () => store.subagents.agent ?? officeChoice();
  const subAgent = agentFields('subagent-agent', subFallback());
  let subAgentTouched = false;
  subAgent.element.addEventListener('change', () => (subAgentTouched = true));
  subAgent.element.addEventListener('input', () => (subAgentTouched = true));
  const subAgentSave = h('button.btn.primary', { type: 'button' }, 'Save');
  const subAgentBack = h('button.btn', { type: 'button' }, 'Back to the default droid');
  const subAgentNote = h('p.setting-note');
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
  const subSizeNote = h('p.setting-note');
  const subTree = radios(
    'Where subagents work',
    [
      [true, 'Each in its own worktree'],
      [false, "In the lead's checkout"],
    ] as const,
    () => store.subagents.worktree,
    (worktree) => subSet({ worktree }),
  );
  const subTreeNote = h(
    'p.setting-note',
    {},
    'Its own worktree lets subagents change files side by side without stepping on each other, each on its own branch you can merge or hand back. A lead can still ask for the other with --worktree or --no-worktree.',
  );
  const subWake = radios(
    'Waking the lead',
    [
      [true, 'Wake it when a subagent reports'],
      [false, 'Let it check by itself'],
    ] as const,
    () => store.subagents.wakeLead,
    (wakeLead) => subSet({ wakeLead }),
  );
  const subWakeNote = h(
    'p.setting-note',
    {},
    'When a subagent reports back, finishes or needs input, a lead that is resting gets a short prompt to read the news with office-workers wait. A lead that is busy is told the next time it stops.',
  );
  const subSkill = radios(
    'Droid skill',
    [
      [true, 'Installed'],
      [false, 'Not installed'],
    ] as const,
    () => store.subagents.skill,
    (skill) => subSet({ skill }),
  );
  const subSkillNote = h('p.setting-note');

  const paintSubagents = () => {
    const s = store.subagents;
    for (const r of [subOn, subWho, subSize, subTree, subWake, subSkill]) r.paint();
    subWho.row.classList.toggle('disabled', !s.on);
    subNote.textContent =
      (s.on
        ? 'A lead runs office-workers hire to give a subagent a job. The subagent sits down at the free desk nearest its lead, with its own laptop and a terminal you can open like any droid’s, works, and reports back. Its lead reads the news, sends follow-ups and sends it home when the work is in.'
        : 'Hiring is refused. Subagents already working carry on and can still report back to their leads.') + (s.by && s.at ? ` Set by ${s.by} ${timeAgo(s.at)}.` : '');
    if (!subAgentTouched) subAgent.set(subFallback());
    subAgentBack.classList.toggle('hidden', !s.agent);
    subAgentNote.textContent = s.agent
      ? `Subagents start on ${choiceLabel(s.agent)} unless their lead asks for something else with --model or --effort.`
      : `Subagents start on the office’s default droid (${choiceLabel(officeChoice())}, from Droids → Default droid) unless their lead asks for something else with --model or --effort. The picker lists every model droid can run: your own models, Factory’s and legacy ones.`;
    subSizeNote.textContent = `A lead can have at most ${s.maxPerLead} subagent${s.maxPerLead === 1 ? '' : 's'} on the floor at once; sending one home frees its place. The office's droid limit still counts every one.`;
    subSkillNote.textContent = s.skillError
      ? s.skillError
      : !s.on
        ? 'Subagents are off, so the droid-office-subagents skill is out of ~/.factory/skills until they are back on.'
        : s.skill
          ? `Droids at desks learn how to hire from the droid-office-subagents skill${s.skillPath ? ` at ${s.skillPath}` : ''}. It only applies in sessions the office started; outside Droid Office it tells droid to ignore it. The Team lead always knows from its brief.`
          : 'The droid-office-subagents skill is not in ~/.factory/skills. Droids at desks hire when you tell them to use office-workers (office-workers help explains it), and the Team lead always knows from its brief.';
  };
  paintSubagents();

  // Droid Office for Android: the pairing QR code is its own window, over this one.
  const phoneOpen = h('button.btn.primary', { type: 'button' }, '📱 Pair a phone…');
  const phoneNote = h(
    'p.setting-note',
    {},
    'Shows the QR code to scan with the app, the Wi-Fi and Tailscale addresses it carries, and the phones you paired, where you can forget one. A paired phone keeps working after the office restarts.',
  );
  const phoneStatus = h('p.setting-note', {}, 'Checking for paired phones…');
  const paintPhones = (list: PairedDevice[] | string) => {
    if (typeof list === 'string') phoneStatus.textContent = list;
    else if (!list.length) phoneStatus.textContent = 'No phones paired yet.';
    else phoneStatus.textContent = `${list.length} paired: ${list.map((d) => `${d.name} (seen ${timeAgo(d.lastSeenAt)})`).join(', ')}.`;
  };
  void pairedPhones().then(paintPhones);
  phoneOpen.addEventListener('click', () => openPhone(paintPhones));

  const character = h('button.btn', { type: 'button' }, 'Change your look & name');
  epicCard = card("This floor's Jira epic", epicRow, epicActions, epicNote);
  paintJira();
  const sourceReload = hotReloadSettings();
  const factoryKey = factoryKeySettings(net);
  const panes: Record<SettingsPane, Node[]> = {
    you: [card('Your character', character), card('Camera view', seg, note)],
    sound: [
      card('Office sounds', soundRow, h('p.setting-note', {}, 'Droids typing, the coffee machine, thunder, and the ding when a droid is done.')),
      card('Jukebox', musicRow, h('p.setting-note', {}, 'The jukebox in the lounge. Everyone on the floor hears the same song, louder the closer they are to it; this is how loud it is for you alone.')),
    ],
    notify: [card('Desktop notifications', notifyRow, notifyNote), card('Channel notifications (Slack / Discord)', h('div.webhook', {}, hookInput, hookSave), hookActions, hookStatus)],
    building: [
      ...(outside
        ? [
            card(
              'Outside',
              h('p.outside-now', {}, outside.now),
              h(
                'p.setting-note',
                {},
                outside.live
                  ? 'Everyone sees the same sky: the office’s clock and the live weather where it is.'
                  : 'Everyone sees the same sky: the office’s clock, and weather that comes and goes. Start the office with --city to use a real city’s forecast.',
              ),
            ),
          ]
        : []),
      card('Jira', jiraForm, jiraActions, jiraNote),
      epicCard,
      card('Workspace folder', dirRow, dirActions, dirNote),
      card('Source hot reload', sourceReload.element),
    ],
    factory: [card('Factory API key', ...factoryKey.nodes)],
    workers: [card('Default droid', agent.element, agentActions, agentNote), card('Prompts', promptsOpen, promptsNote), card('Droid limit', limitRow, limitNote), card('Droids whose pull request merged', leaveRow, leaveNote)],
    subagents: [
      card('Subagents', subOn.row, subWho.row, subNote, h('div.seg', { style: 'margin-top:8px' }, subPrompts)),
      card('Subagent droid', subAgent.element, h('div.seg', { style: 'margin-top:8px' }, subAgentSave, subAgentBack), subAgentNote),
      card('Team size', subSize.row, subSizeNote),
      card('Where subagents work', subTree.row, subTreeNote),
      card('Waking the lead', subWake.row, subWakeNote),
      card('Droid skill', subSkill.row, subSkillNote),
    ],
    phone: [card('Droid Office for Android', h('div.seg', {}, phoneOpen), phoneNote, phoneStatus)],
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
      h('section.settings-pane', { role: 'tabpanel', id: `settings-pane-${p.id}`, 'aria-labelledby': `settings-tab-${p.id}` }, h('div.settings-head', {}, h('h3', {}, `${p.icon} ${p.label}`), h('p', {}, p.blurb)), ...panes[p.id]),
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
  const el = h('div.modal.settings', { role: 'dialog', 'aria-label': 'Settings' }, h('header', {}, h('h2', {}, 'Settings'), close), h('div.settings-body', {}, nav, ...bodies.values()));
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
