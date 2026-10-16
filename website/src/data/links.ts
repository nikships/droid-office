import type { NavLink } from '../types/content';

export const GITHUB_URL = 'https://github.com/nikships/droid-office';
export const RELEASES_URL = 'https://github.com/nikships/droid-office/releases/latest';
export const UPSTREAM_URL = 'https://github.com/AgentSystemLabs/agent-office';
export const DROID_CLI_URL = 'https://docs.factory.ai/cli/getting-started/quickstart';

const RAW = 'https://raw.githubusercontent.com/nikships/droid-office/main';

export const images = {
  hero: `${RAW}/docs/hero.jpg`,
  desk: `${RAW}/docs/desk.jpg`,
  phoneHome: `${RAW}/android/docs/home.jpg`,
  phoneWorker: `${RAW}/android/docs/worker.jpg`,
  phoneNotification: `${RAW}/android/docs/notification.jpg`,
};

export const navLinks: NavLink[] = [
  { href: '#tour', label: 'Tour' },
  { href: '#agents', label: 'Agents' },
  { href: '#why', label: 'Why' },
  { href: '#pocket', label: 'Android' },
  { href: '#install', label: 'Install' },
];
