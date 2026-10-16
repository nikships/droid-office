export const macSteps = ['Download Droid-Office-<version>-arm64.dmg from the latest release.', 'Open it and drag Droid Office into Applications.', 'Launch it. The office starts, opens full screen and keeps itself up to date.'];

export const requirements = [
  { name: 'git', note: 'on your PATH' },
  { name: 'droid', note: 'Droid CLI, signed in' },
  { name: 'gh / glab', note: 'for the GitHub or GitLab boards' },
];

export const devCommands = `git clone https://github.com/nikships/droid-office.git
cd droid-office
npm ci
npm run dev`;

export const pocketSteps = [
  { title: 'Install the APK', body: 'Grab Droid-Office-<version>.apk from the latest release.' },
  { title: 'Scan to pair', body: 'In the office, open Settings → Phone and scan the code.' },
  { title: 'Answer from anywhere', body: 'On your Wi-Fi or over Tailscale. Reply to a worker right from the notification.' },
];
