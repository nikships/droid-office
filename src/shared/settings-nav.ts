/** The categories down the side of Settings. */
export type SettingsPane = 'you' | 'sound' | 'notify' | 'building' | 'factory' | 'workers' | 'subagents' | 'phone';

export const SETTINGS_PANES: { id: SettingsPane; icon: string; label: string; blurb: string }[] = [
  { id: 'you', icon: '🧍', label: 'You', blurb: 'How you look, how you see the office, and what you hold.' },
  { id: 'sound', icon: '🔊', label: 'Sound', blurb: 'How loud the office is for you.' },
  { id: 'notify', icon: '🔔', label: 'Notifications', blurb: 'Hear about a worker that needs someone, or finished, while you’re somewhere else.' },
  { id: 'building', icon: '🏢', label: 'Building', blurb: 'The sky, Jira, where the elevator looks for projects, and local source reload.' },
  {
    id: 'factory',
    icon: '🏭',
    label: 'Factory',
    blurb: 'Connect the office to Factory with an API key: its cloud computers, Droid sessions and credits, CI automations and AutoWiki, on the office’s walls and in its windows.',
  },
  { id: 'workers', icon: '🤖', label: 'Workers', blurb: 'What workers start on and from, how many run at once, when they go home, what the office tells them and how their worktrees are set up.' },
  {
    id: 'subagents',
    icon: '🧭',
    label: 'Subagents',
    blurb:
      'Workers that hire workers: a lead splits up a big job and hires subagents, who sit down at the desks nearest it, each with its own laptop and terminal, and report back to it. Ask the Team lead at its kiosk on the east wall, or any worker at a desk.',
  },
  { id: 'phone', icon: '📱', label: 'Phone', blurb: 'Droid Office for Android: hire workers, watch their terminals and prompt them from your phone, on your Wi-Fi or over Tailscale.' },
];

/** Which category each setting lives in. The page is built from these titles. */
export const SETTINGS_CARDS = [
  { pane: 'you', title: 'Your character' },
  { pane: 'you', title: 'What 7 puts in your hand' },
  { pane: 'sound', title: 'Office sounds' },
  { pane: 'sound', title: 'Jukebox' },
  { pane: 'notify', title: 'Desktop notifications' },
  { pane: 'notify', title: 'Channel notifications (Slack / Discord)' },
  { pane: 'building', title: 'Outside' },
  { pane: 'building', title: 'Jira' },
  { pane: 'building', title: "This floor's Jira epic" },
  { pane: 'building', title: 'Workspace folder' },
  { pane: 'building', title: 'Source hot reload' },
  { pane: 'factory', title: 'Factory API key' },
  { pane: 'workers', title: 'Default worker' },
  { pane: 'workers', title: 'Where fresh workers start' },
  { pane: 'workers', title: 'Prompts' },
  { pane: 'workers', title: 'Worker limit' },
  { pane: 'workers', title: 'Workers whose pull request merged' },
  { pane: 'workers', title: 'Worktree setup' },
  { pane: 'subagents', title: 'Subagents' },
  { pane: 'subagents', title: 'Subagent worker' },
  { pane: 'subagents', title: 'Team size' },
  { pane: 'subagents', title: 'Where subagents work' },
  { pane: 'subagents', title: 'Waking the lead' },
  { pane: 'subagents', title: 'Droid skill' },
  { pane: 'phone', title: 'Droid Office for Android' },
] as const satisfies readonly { pane: SettingsPane; title: string }[];

export type SettingsCardTitle = (typeof SETTINGS_CARDS)[number]['title'];

/** The category arrow keys, Home and End land on. Anything else is left alone. */
export function settingsPaneAfter(current: SettingsPane, key: string): SettingsPane | null {
  if (key === 'Home') return SETTINGS_PANES[0].id;
  if (key === 'End') return SETTINGS_PANES[SETTINGS_PANES.length - 1].id;
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[key];
  if (!step) return null;
  const i = SETTINGS_PANES.findIndex((p) => p.id === current);
  return SETTINGS_PANES[(i + step + SETTINGS_PANES.length) % SETTINGS_PANES.length].id;
}
