/** The categories down the side of Settings. */
export type SettingsPane = 'you' | 'sound' | 'notify' | 'building' | 'factory' | 'workers' | 'subagents' | 'phone';

/** Who a setting is for. */
export type SettingsScope = 'you' | 'floor' | 'office';

export const SETTINGS_PANES: { id: SettingsPane; icon: string; label: string; blurb: string }[] = [
  { id: 'you', icon: '🧍', label: 'You', blurb: 'How you look and how you see the office.' },
  { id: 'sound', icon: '🔊', label: 'Sound', blurb: 'How loud the office is for you.' },
  { id: 'notify', icon: '🔔', label: 'Notifications', blurb: 'Hear about a worker that needs someone, or finished, while you’re somewhere else.' },
  { id: 'building', icon: '🏢', label: 'Building', blurb: 'The sky, Jira, where the elevator looks for projects, and local source reload.' },
  {
    id: 'factory',
    icon: '🏭',
    label: 'Factory',
    blurb: 'Connect the office to Factory with an API key: its cloud computers, Droid sessions and credits, CI automations and AutoWiki, on the office’s walls and in its windows.',
  },
  { id: 'workers', icon: '🤖', label: 'Workers', blurb: 'What workers start on, how many run at once, when they go home and what the office tells them.' },
  {
    id: 'subagents',
    icon: '🧭',
    label: 'Subagents',
    blurb:
      'Workers that hire workers: a lead splits up a big job and hires subagents, who sit down at the desks nearest it, each with its own laptop and terminal, and report back to it. Ask the Team lead at its kiosk on the east wall, or any worker at a desk.',
  },
  { id: 'phone', icon: '📱', label: 'Phone', blurb: 'Droid Office for Android: hire workers, watch their terminals and prompt them from your phone, on your Wi-Fi or over Tailscale.' },
];

/** The badge by a setting's name, and what it means. */
export const SETTINGS_SCOPE: Record<SettingsScope, readonly [label: string, title: string]> = {
  you: ['Just you', 'Only for you, kept in this browser'],
  floor: ['This floor', 'The same for everyone on this floor'],
  office: ['Everyone', 'The same for everyone in the building'],
};

/** Which category each setting lives in, and who it's for. The page is built from these titles. */
export const SETTINGS_CARDS = [
  { pane: 'you', title: 'Your character', scope: null },
  { pane: 'you', title: 'Camera view', scope: 'you' },
  { pane: 'sound', title: 'Office sounds', scope: 'you' },
  { pane: 'sound', title: 'Jukebox', scope: 'you' },
  { pane: 'notify', title: 'Desktop notifications', scope: 'you' },
  { pane: 'notify', title: 'Channel notifications (Slack / Discord)', scope: 'office' },
  { pane: 'building', title: 'Outside', scope: 'office' },
  { pane: 'building', title: 'Jira', scope: 'office' },
  { pane: 'building', title: "This floor's Jira epic", scope: 'floor' },
  { pane: 'building', title: 'Workspace folder', scope: 'office' },
  { pane: 'building', title: 'Source hot reload', scope: 'office' },
  { pane: 'factory', title: 'Factory API key', scope: 'office' },
  { pane: 'workers', title: 'Default worker', scope: 'office' },
  { pane: 'workers', title: 'Prompts', scope: 'office' },
  { pane: 'workers', title: 'Worker limit', scope: 'office' },
  { pane: 'workers', title: 'Workers whose pull request merged', scope: 'office' },
  { pane: 'subagents', title: 'Subagents', scope: 'office' },
  { pane: 'subagents', title: 'Subagent worker', scope: 'office' },
  { pane: 'subagents', title: 'Team size', scope: 'office' },
  { pane: 'subagents', title: 'Where subagents work', scope: 'office' },
  { pane: 'subagents', title: 'Waking the lead', scope: 'office' },
  { pane: 'subagents', title: 'Droid skill', scope: 'office' },
  { pane: 'phone', title: 'Droid Office for Android', scope: 'office' },
] as const satisfies readonly { pane: SettingsPane; title: string; scope: SettingsScope | null }[];

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
