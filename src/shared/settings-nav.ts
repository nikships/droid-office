/** The categories down the side of Settings, grouped so a setting's place can be guessed: what is only yours, what workers do, and what the whole office shares. */
export type SettingsPane = 'you' | 'sound' | 'graphics' | 'notify' | 'workers' | 'subagents' | 'connections' | 'office' | 'phone';

/** The sidebar groups, in order. Every pane belongs to exactly one. */
export type SettingsSection = 'Personal' | 'Workers' | 'Office';

export const SETTINGS_PANES: { id: SettingsPane; icon: string; label: string; section: SettingsSection; scope: string; blurb: string }[] = [
  { id: 'you', icon: '🧍', label: 'You', section: 'Personal', scope: 'Just you', blurb: 'How you look, what you hold and how you look around, and your own prompt shortcuts. Only this browser remembers these.' },
  { id: 'sound', icon: '🔊', label: 'Sound', section: 'Personal', scope: 'Just you', blurb: 'How loud the office, its alert tones and the jukebox are for you.' },
  { id: 'graphics', icon: '🖥️', label: 'Display', section: 'Personal', scope: 'Just you', blurb: 'How the office is drawn on this screen: which renderer, how sharp, how many frames a second, the lights, and the readout that shows it.' },
  {
    id: 'notify',
    icon: '🔔',
    label: 'Notifications',
    section: 'Personal',
    scope: 'Just you',
    blurb: 'Get desktop notifications when a worker needs input or finishes while you are in another tab or app.',
  },
  {
    id: 'workers',
    icon: '🤖',
    label: 'Workers',
    section: 'Workers',
    scope: 'Everyone',
    blurb: 'What workers run and start on, where a fresh one starts, how many run at once, when they go home, what the office tells them, and how their worktrees are set up.',
  },
  {
    id: 'subagents',
    icon: '🧭',
    label: 'Subagents & visits',
    section: 'Workers',
    scope: 'Everyone',
    blurb: 'Workers that hire workers, and workers visiting each other’s desks. A lead splits up a big job and hires subagents at the desks nearest it; ask the Team lead at its kiosk on the east wall, or any worker at a desk.',
  },
  {
    id: 'connections',
    icon: '🔌',
    label: 'Connections',
    section: 'Office',
    scope: 'Office-wide',
    blurb: 'The accounts the office works through: Factory, the Claude or ChatGPT plan you already pay for, and Jira. Connect them once here; every floor uses them.',
  },
  { id: 'office', icon: '🏢', label: 'Office & floors', section: 'Office', scope: 'Office-wide', blurb: 'The sky and clock outside, where the elevator looks for projects to make into floors, and reloading a local office from its source.' },
  {
    id: 'phone',
    icon: '📱',
    label: 'Phone & web',
    section: 'Office',
    scope: 'Your devices',
    blurb: 'Droid Office for Android and the web companion: hire workers, watch their terminals and prompt them from your phone or another computer’s browser, on your Wi-Fi or over Tailscale.',
  },
];

/** Pane ids Settings used before the reorganization, and where those settings live now. Old links and callers keep working. */
const SETTINGS_PANE_ALIASES: Record<string, SettingsPane> = { factory: 'connections', subscriptions: 'connections', building: 'office' };

/** Where a pane id (current, or one from before the reorganization) lives now. */
export function resolveSettingsPane(want: string | undefined): SettingsPane | undefined {
  if (!want) return undefined;
  return SETTINGS_PANES.find((p) => p.id === want)?.id ?? SETTINGS_PANE_ALIASES[want];
}

/** Which category each setting lives in, and the words a search for it can use. The page is built from these titles. */
export const SETTINGS_CARDS = [
  { pane: 'you', title: 'Your character', keywords: 'avatar appearance look name character profile' },
  { pane: 'you', title: 'What 7 puts in your hand', keywords: 'wand magnum gun weapon sidearm 7 hand' },
  { pane: 'you', title: 'Raw mouse input', keywords: 'mouse raw pointer acceleration look turn' },
  { pane: 'you', title: 'Look sensitivity', keywords: 'mouse sensitivity speed look turn view' },
  { pane: 'you', title: 'Prompt chips', keywords: 'chips presets shortcuts quick prompts tap fill prompt box' },
  { pane: 'sound', title: 'Office sounds', keywords: 'volume mute typing thunder audio sound' },
  { pane: 'sound', title: 'Alert sounds', keywords: 'volume mute tone alert needs input finished tests fail' },
  { pane: 'sound', title: 'Jukebox', keywords: 'music volume mute songs' },
  { pane: 'graphics', title: 'Renderer', keywords: 'classic remastered renderer draw graphics display' },
  { pane: 'graphics', title: 'HDR', keywords: 'hdr edr highlights brightness display remastered' },
  { pane: 'graphics', title: 'Render resolution', keywords: 'resolution scale sharp pixels upscale graphics display' },
  { pane: 'graphics', title: 'Temporal anti-aliasing', keywords: 'taa anti-aliasing edges smooth graphics' },
  { pane: 'graphics', title: 'Sharpening', keywords: 'sharpen crisp upscale taa graphics' },
  { pane: 'graphics', title: 'Frame rate limit', keywords: 'fps frame rate limit 40 60 120 performance graphics' },
  { pane: 'graphics', title: 'Overhead lights', keywords: 'lights brightness ceiling lamps lighting dark' },
  { pane: 'graphics', title: 'Performance overlay', keywords: 'fps gpu frame pacing stats overlay diagnostics performance' },
  { pane: 'notify', title: 'Desktop notifications', keywords: 'browser notifications permission alert desktop' },
  { pane: 'workers', title: 'Droid', keywords: 'droid version update sign in install agent account factory' },
  { pane: 'workers', title: 'Default worker', keywords: 'default worker model effort agent new hire board agents' },
  { pane: 'workers', title: 'Models shown in pickers', keywords: 'models hide hidden pickers visibility list' },
  { pane: 'workers', title: 'Worker labels', keywords: 'subject task summary activity sign writer model reasoning interval refresh conversation' },
  { pane: 'workers', title: 'Where fresh workers start', keywords: 'fresh workers branch main floor branch checkout start' },
  { pane: 'workers', title: 'Prompts', keywords: 'prompts edit wording handoffs reviews board agents sign writer' },
  { pane: 'workers', title: 'Worker limit', keywords: 'limit most workers at once max ceiling hire' },
  { pane: 'workers', title: 'Workers whose pull request merged', keywords: 'merged pull request go home leave stay worker cleanup' },
  { pane: 'workers', title: 'Worktree setup', keywords: 'worktree setup install command copy files new worker floor' },
  { pane: 'subagents', title: 'Subagents', keywords: 'subagents hire team lead on off office-workers' },
  { pane: 'subagents', title: 'Subagent worker', keywords: 'subagent default worker model effort lead' },
  { pane: 'subagents', title: 'Models leads can pick', keywords: 'subagent models leads pick limit notes credit' },
  { pane: 'subagents', title: 'Team size', keywords: 'team size most subagents per lead max' },
  { pane: 'subagents', title: 'Where subagents work', keywords: 'subagents worktree checkout lead branch' },
  { pane: 'subagents', title: 'Waking the lead', keywords: 'waking lead wake report subagent rest' },
  { pane: 'subagents', title: 'Visits between workers', keywords: 'visits office-visit workers desks talk handoff ask' },
  { pane: 'subagents', title: 'Droid skill', keywords: 'droid skill subagents installed factory skills' },
  { pane: 'subagents', title: 'Whiteboard skill', keywords: 'whiteboard skill cards board factory skills' },
  { pane: 'connections', title: 'Factory API key', keywords: 'factory api key connect cloud computers sessions credits ci autowiki' },
  { pane: 'connections', title: 'DroidProxy', keywords: 'droidproxy subscriptions claude chatgpt plan menu bar install start' },
  { pane: 'connections', title: 'Accounts', keywords: 'subscription accounts claude chatgpt plans usage connect remove' },
  { pane: 'connections', title: 'Models in Droid', keywords: 'subscription models droidproxy droid list update' },
  { pane: 'connections', title: 'Jira', keywords: 'jira connect atlassian account tickets issue board' },
  { pane: 'connections', title: "This floor's Jira epic", keywords: 'jira epic floor issue board tickets' },
  { pane: 'office', title: 'Outside', keywords: 'outside sky weather clock time city' },
  { pane: 'office', title: 'Workspace folder', keywords: 'workspace folder projects elevator floors git look for' },
  { pane: 'office', title: 'Host desktop app', keywords: 'host desktop mac app update version install restart' },
  { pane: 'office', title: 'Source hot reload', keywords: 'source hot reload development build reload local vite developer' },
  { pane: 'phone', title: 'Droid Office for Android', keywords: 'android phone pair pairing qr app mobile' },
  { pane: 'phone', title: 'Web companion', keywords: 'web companion dashboard browser pair desktop link' },
] as const satisfies readonly { pane: SettingsPane; title: string; keywords: string }[];

export type SettingsCardTitle = (typeof SETTINGS_CARDS)[number]['title'];

/** One search hit: the setting, and the pane a click should open. */
export interface SettingsHit {
  pane: SettingsPane;
  title: SettingsCardTitle;
}

/**
 * The settings a search finds, in sidebar order. Every word in the query must appear in the
 * setting's title, its pane's label or section, or its keywords, so "jira epic" and "hide models"
 * both land. An empty query finds nothing (the caller shows the panes instead).
 */
export function searchSettings(query: string): SettingsHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const paneOf = new Map(SETTINGS_PANES.map((p) => [p.id, p]));
  return SETTINGS_CARDS.filter((c) => {
    const pane = paneOf.get(c.pane)!;
    const hay = `${c.title} ${pane.label} ${pane.section} ${c.keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).map((c) => ({ pane: c.pane, title: c.title }));
}

/** The category arrow keys, Home and End land on. Anything else is left alone. */
export function settingsPaneAfter(current: SettingsPane, key: string): SettingsPane | null {
  if (key === 'Home') return SETTINGS_PANES[0].id;
  if (key === 'End') return SETTINGS_PANES[SETTINGS_PANES.length - 1].id;
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[key];
  if (!step) return null;
  const i = SETTINGS_PANES.findIndex((p) => p.id === current);
  return SETTINGS_PANES[(i + step + SETTINGS_PANES.length) % SETTINGS_PANES.length].id;
}
