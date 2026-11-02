import type { Stat, WhyPoint } from '../types/content';

export const whyPoints: WhyPoint[] = [
  {
    id: 'droid',
    title: 'Droid is the star',
    body: 'Every worker is a Droid session on any model you’ve configured, custom models included, at the reasoning effort you choose. Each desk remembers its pick across restarts.',
  },
  {
    id: 'gitlab',
    title: 'GitLab is first class',
    body: 'A floor can be a GitLab project on gitlab.com or your own host. Merge requests fill the PR board and workers open them with glab.',
  },
  {
    id: 'jira',
    title: 'Jira on the wall',
    body: 'Connect Jira Cloud once with a read-only token and give a floor an epic. Its tickets appear as a tab on the board. The office never writes to Jira.',
  },
  {
    id: 'factory',
    title: 'Built like a Factory',
    body: 'A dark, industrial look in Factory orange. The Mac app opens your office full screen and keeps itself up to date.',
  },
  {
    id: 'companion',
    title: 'One window, two modes',
    body: 'Switch the Mac app between the 3D office and the companion: up to eight workers side by side, each as its Thread or its live terminal. A browser on your Wi-Fi or tailnet can pair with it too.',
  },
  {
    id: 'plans',
    title: 'Runs on the plan you have',
    body: 'The welcome installs Droid and signs it in to Factory. It can also connect the Claude or ChatGPT plan you already pay for, through DroidProxy.',
  },
];

export const stats: Stat[] = [
  { value: '16', label: 'desks per floor' },
  { value: '12', label: 'bean bags for overflow' },
  { value: '8', label: 'subagents per team lead' },
  { value: '3,000', label: 'lines of scrollback per worker' },
];
