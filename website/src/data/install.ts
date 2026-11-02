export const macSteps = [
  'Download Droid-Office-<version>-arm64.dmg from the latest release.',
  'Open it and drag Droid Office into Applications.',
  'Launch it. The welcome installs and signs in Droid if you need it, then the office opens full screen and keeps itself up to date.',
];

export const requirements = [
  { name: 'macOS 14+', note: 'M-series Pro, Max or Ultra' },
  { name: 'git', note: 'on your PATH' },
  { name: 'droid', note: 'installed by the welcome if missing' },
  { name: 'gh / glab', note: 'for the GitHub or GitLab boards' },
];

export const devCommands = `git clone https://github.com/nikships/droid-office.git
cd droid-office
npm ci
npm run dev`;

export const pocketSteps = [
  { title: 'Install the APK', body: 'Grab Droid-Office-<version>.apk from the latest release.' },
  { title: 'Scan to pair', body: 'In the office, open Settings → Phone & web and scan the code.' },
  { title: 'Answer from anywhere', body: 'On your Wi-Fi or over Tailscale. Answer questions in Asks, or reply to a worker right from the notification.' },
];
