/** The categories down the side of Settings, grouped so a setting's place can be guessed: what is only yours, what workers do, and what the whole office shares. */
export type SettingsPane = 'you' | 'sound' | 'graphics' | 'workers' | 'models' | 'subagents' | 'orchestrator' | 'connections' | 'office' | 'phone';

/** The sidebar groups, in order. Every pane belongs to exactly one. */
export type SettingsSection = 'Personal' | 'Workers' | 'Office';

/**
 * Where Settings opens: the walkable 3D office, the web companion in a browser, or the companion in
 * the Mac app on the office's own computer. The companions leave out what only the 3D office draws or
 * plays, and only the Mac app's companion is the office's own page, which pairing devices requires.
 */
export type SettingsSurface = 'office' | 'companion' | 'mac-companion';

export interface PaneDef {
  id: SettingsPane;
  icon: string;
  label: string;
  section: SettingsSection;
  scope: string;
  blurb: string;
  /** The blurb in a companion, where the pane holds less. */
  companionBlurb?: string;
}

export const SETTINGS_PANES: PaneDef[] = [
  { id: 'you', icon: '🧍', label: 'You', section: 'Personal', scope: 'Just you', blurb: 'Your character, what you hold and the mouse. Kept in this browser.' },
  { id: 'sound', icon: '🔊', label: 'Sound & alerts', section: 'Personal', scope: 'Just you', blurb: 'How loud the office is for you, and how it tells you a worker needs you.' },
  { id: 'graphics', icon: '🖥️', label: 'Display', section: 'Personal', scope: 'Just you', blurb: 'How this screen draws the office.' },
  { id: 'workers', icon: '🤖', label: 'Workers', section: 'Workers', scope: 'Everyone', blurb: 'Where new workers start, how many run, when they leave, how their worktrees are set up and what the office tells them.' },
  { id: 'models', icon: '🧠', label: 'Models', section: 'Workers', scope: 'Everyone', blurb: 'The model a worker starts on, and which models the pickers offer.' },
  { id: 'subagents', icon: '🧭', label: 'Subagents & visits', section: 'Workers', scope: 'Everyone', blurb: 'Workers that hire workers at the desks near them, and workers visiting each other’s desks.' },
  {
    id: 'orchestrator',
    icon: '🛰️',
    label: 'Orchestrator',
    section: 'Workers',
    scope: 'Office-wide',
    blurb: 'The building’s own agent in Mission Control: whether it runs, the model it runs on, its conversation and its brief.',
  },
  {
    id: 'connections',
    icon: '🔌',
    label: 'Connections',
    section: 'Office',
    scope: 'Office-wide',
    blurb: 'Droid and Factory, the Claude or ChatGPT plans you already pay for, Gemini, Linear and Jira. Connect once; every floor uses them.',
    companionBlurb: 'Droid and Factory, the Claude or ChatGPT plans you already pay for, and Gemini. Connect once; every floor uses them.',
  },
  {
    id: 'office',
    icon: '🏢',
    label: 'Office & floors',
    section: 'Office',
    scope: 'Office-wide',
    blurb: 'Where the elevator finds projects, the sky outside, updates and developer tools.',
    companionBlurb: 'Where the elevator finds projects, and updates to the Mac app.',
  },
  { id: 'phone', icon: '📱', label: 'Phone & web', section: 'Office', scope: 'Your devices', blurb: 'Droid Office for Android, the web companion, and bots on your Tailscale devices.' },
];

/** Pane ids Settings used before a reorganization, and where those settings live now. Old links and callers keep working. */
const SETTINGS_PANE_ALIASES: Record<string, SettingsPane> = { factory: 'connections', subscriptions: 'connections', building: 'office', notify: 'sound' };

/** Where a pane id (current, or one from before a reorganization) lives now. */
export function resolveSettingsPane(want: string | undefined): SettingsPane | undefined {
  if (!want) return undefined;
  return SETTINGS_PANES.find((p) => p.id === want)?.id ?? SETTINGS_PANE_ALIASES[want];
}

/** Settings only the 3D office has: your character and controls, its sound, how it draws, Linear and Jira (shown on its issue board) and the sky. */
const OFFICE = ['office'] as const;
/** Pairing devices and the Tailscale MCP: the office takes them only from its own page on its own computer (`ownPage` in server.ts), so the Mac app's companion has them and a browser's doesn't. */
const OWN_COMPUTER = ['office', 'mac-companion'] as const;

export interface CardDef {
  pane: SettingsPane;
  title: string;
  keywords: string;
  /** The surfaces that show it; every one when absent. */
  on?: readonly SettingsSurface[];
}

/** Which category each setting lives in, and the words a search for it can use. The page is built from these titles. */
export const SETTINGS_CARDS = [
  { pane: 'you', title: 'Your character', keywords: 'avatar appearance look name character profile', on: OFFICE },
  { pane: 'you', title: 'What 7 puts in your hand', keywords: 'wand magnum gun weapon sidearm 7 hand', on: OFFICE },
  { pane: 'you', title: 'Look sensitivity', keywords: 'mouse sensitivity speed look turn view', on: OFFICE },
  { pane: 'you', title: 'Raw mouse input', keywords: 'mouse raw pointer acceleration look turn', on: OFFICE },
  { pane: 'sound', title: 'Office sounds', keywords: 'volume mute typing thunder audio sound', on: OFFICE },
  { pane: 'sound', title: 'Jukebox', keywords: 'music volume mute songs', on: OFFICE },
  { pane: 'sound', title: 'Alert sounds', keywords: 'volume mute tone alert needs input finished tests fail', on: OFFICE },
  { pane: 'sound', title: 'Desktop notifications', keywords: 'browser notifications permission alert desktop', on: OFFICE },
  { pane: 'graphics', title: 'Renderer', keywords: 'classic remastered renderer draw graphics display', on: OFFICE },
  { pane: 'graphics', title: 'HDR', keywords: 'hdr edr highlights brightness display remastered', on: OFFICE },
  { pane: 'graphics', title: 'Render resolution', keywords: 'resolution scale sharp pixels upscale graphics display classic', on: OFFICE },
  { pane: 'graphics', title: 'Temporal anti-aliasing', keywords: 'taa anti-aliasing edges smooth graphics classic', on: OFFICE },
  { pane: 'graphics', title: 'Sharpening', keywords: 'sharpen crisp upscale taa graphics classic', on: OFFICE },
  { pane: 'graphics', title: 'Frame rate limit', keywords: 'fps frame rate limit 40 60 120 performance graphics', on: OFFICE },
  { pane: 'graphics', title: 'Performance overlay', keywords: 'fps gpu frame pacing stats overlay diagnostics performance', on: OFFICE },
  { pane: 'graphics', title: 'Overhead lights', keywords: 'lights brightness ceiling lamps lighting dark', on: OFFICE },
  { pane: 'workers', title: 'Where fresh workers start', keywords: 'fresh workers branch main floor branch checkout start' },
  { pane: 'workers', title: 'Worker limit', keywords: 'limit most workers at once max ceiling hire' },
  { pane: 'workers', title: 'Workers whose pull request merged', keywords: 'merged pull request go home leave stay worker cleanup' },
  { pane: 'workers', title: 'Worktree setup', keywords: 'worktree setup install command copy files new worker floor' },
  { pane: 'workers', title: 'Prompts', keywords: 'prompts edit wording handoffs reviews sign writer subagent visit brief' },
  { pane: 'workers', title: 'Worker labels', keywords: 'subject task summary activity sign writer model reasoning interval refresh conversation' },
  { pane: 'models', title: 'Default worker', keywords: 'default worker model effort agent new hire' },
  { pane: 'models', title: 'Remember models at desks', keywords: 'remember seat desk model effort hire', on: OFFICE },
  { pane: 'models', title: 'Models shown in pickers', keywords: 'models hide hidden pickers visibility list' },
  { pane: 'subagents', title: 'Office MCP', keywords: 'droid office mcp tools subagents whiteboard cards visits on off' },
  { pane: 'subagents', title: 'Subagents', keywords: 'subagents hire team lead on off team_hire' },
  { pane: 'subagents', title: 'Team size', keywords: 'team size most subagents per lead max' },
  { pane: 'subagents', title: 'Where subagents work', keywords: 'subagents worktree checkout lead branch' },
  { pane: 'subagents', title: 'Waking the lead', keywords: 'waking lead wake report subagent rest' },
  { pane: 'subagents', title: 'Droid’s Task tool', keywords: 'task tool droid builtin subagent refuse deny team_hire' },
  { pane: 'subagents', title: 'Subagent worker', keywords: 'subagent default worker model effort lead' },
  { pane: 'subagents', title: 'Models leads can pick', keywords: 'subagent models leads pick limit notes credit' },
  { pane: 'subagents', title: 'Visits between workers', keywords: 'visits visit_roster workers desks talk handoff ask' },
  { pane: 'orchestrator', title: 'Orchestrator', keywords: 'orchestrator mission control building agent on off' },
  { pane: 'orchestrator', title: 'Orchestrator model', keywords: 'orchestrator model effort reasoning mission control' },
  { pane: 'orchestrator', title: 'New conversation', keywords: 'orchestrator new conversation reset forget start over fresh session' },
  { pane: 'orchestrator', title: 'Orchestrator brief', keywords: 'orchestrator brief prompt instructions edit mission control' },
  { pane: 'connections', title: 'Droid', keywords: 'droid version update sign in install agent account factory' },
  { pane: 'connections', title: 'Factory API key', keywords: 'factory api key connect cloud computers sessions credits ci autowiki' },
  { pane: 'connections', title: 'DroidProxy', keywords: 'droidproxy subscriptions claude chatgpt plan menu bar install start' },
  { pane: 'connections', title: 'Accounts', keywords: 'subscription accounts claude chatgpt plans usage connect remove' },
  { pane: 'connections', title: 'Models in Droid', keywords: 'subscription models droidproxy droid list update' },
  {
    pane: 'connections',
    title: 'Gemini Decisions API',
    keywords: 'gemini decision decisions api key google aistudio living 3d reactions postures mood lighting aura vibes noise gate wakeup wake filter inter-agent chatter batch hold lead nudge',
  },
  { pane: 'connections', title: 'Linear', keywords: 'linear connect api key workspace tickets issues issue board', on: OFFICE },
  { pane: 'connections', title: "This floor's Linear team", keywords: 'linear team project floor issue board tickets', on: OFFICE },
  { pane: 'connections', title: 'Linear autopilot', keywords: 'linear autopilot automatic hire workers tickets todo backlog triage', on: OFFICE },
  { pane: 'connections', title: 'Jira', keywords: 'jira connect atlassian account tickets issue board', on: OFFICE },
  { pane: 'connections', title: "This floor's Jira epic", keywords: 'jira epic floor issue board tickets', on: OFFICE },
  { pane: 'office', title: 'Workspace folder', keywords: 'workspace folder projects elevator floors git look for' },
  { pane: 'office', title: 'Outside', keywords: 'outside sky weather clock time city', on: OFFICE },
  { pane: 'office', title: 'Host desktop app', keywords: 'host desktop mac app update version install restart' },
  { pane: 'office', title: 'Source hot reload', keywords: 'source hot reload development build reload local vite developer', on: OFFICE },
  { pane: 'phone', title: 'Droid Office for Android', keywords: 'android phone pair pairing qr app mobile', on: OWN_COMPUTER },
  { pane: 'phone', title: 'Web companion', keywords: 'web companion dashboard browser pair desktop link', on: OWN_COMPUTER },
  { pane: 'phone', title: 'Tailscale MCP', keywords: 'tailscale mcp external remote bot openclaw grok grokbot agent serve url key connection', on: OWN_COMPUTER },
] as const satisfies readonly CardDef[];

export type SettingsCardTitle = (typeof SETTINGS_CARDS)[number]['title'];

const shows = (card: CardDef, surface: SettingsSurface) => !card.on || card.on.includes(surface);

/** The settings a surface shows, in sidebar order. */
export function settingsCards(surface: SettingsSurface = 'office'): (typeof SETTINGS_CARDS)[number][] {
  return SETTINGS_CARDS.filter((c) => shows(c, surface));
}

/** The categories a surface shows: those with at least one of its settings, with the blurb that fits it. */
export function settingsPanes(surface: SettingsSurface = 'office'): PaneDef[] {
  const cards = settingsCards(surface);
  return SETTINGS_PANES.filter((p) => cards.some((c) => c.pane === p.id)).map((p) => (surface !== 'office' && p.companionBlurb ? { ...p, blurb: p.companionBlurb } : p));
}

/** One search hit: the setting, and the pane a click should open. */
export interface SettingsHit {
  pane: SettingsPane;
  title: SettingsCardTitle;
}

/**
 * The settings a search finds, in sidebar order. Every word in the query must appear in the
 * setting's title, its pane's label or section, or its keywords, so "jira epic" and "hide models"
 * both land. An empty query finds nothing (the caller shows the panes instead). Only `surface`'s settings count.
 */
export function searchSettings(query: string, surface: SettingsSurface = 'office'): SettingsHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const paneOf = new Map(SETTINGS_PANES.map((p) => [p.id, p]));
  return settingsCards(surface)
    .filter((c) => {
      const pane = paneOf.get(c.pane)!;
      const hay = `${c.title} ${pane.label} ${pane.section} ${c.keywords}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((c) => ({ pane: c.pane, title: c.title }));
}

/** The category arrow keys, Home and End land on, among `surface`'s. Anything else is left alone. */
export function settingsPaneAfter(current: SettingsPane, key: string, surface: SettingsSurface = 'office'): SettingsPane | null {
  const panes = settingsPanes(surface);
  if (key === 'Home') return panes[0].id;
  if (key === 'End') return panes[panes.length - 1].id;
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[key];
  if (!step) return null;
  const i = panes.findIndex((p) => p.id === current);
  if (i < 0) return null;
  return panes[(i + step + panes.length) % panes.length].id;
}
