import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow = /^(?:\.github\/workflows\/release\.yml|\.github\/scripts\/release-[^/]+\.mjs)$/;
const packages = /^package(?:-lock)?\.json$/;
const config = /^(?:tsconfig[^/]*\.json|vite\.config\.ts)$/;
const mobileConfig = /^(?:(?:metro|babel|react-native)\.config\.cjs|index\.mobile\.js)$/;

export function checksFor(files, { manual = false, androidVersionChanged = false } = {}) {
  const changed = files.filter((file) => !file.endsWith('/AGENTS.md'));
  const touches = (pattern) => changed.some((file) => pattern.test(file));
  const all = manual || touches(workflow);
  return {
    node:
      all ||
      touches(packages) ||
      touches(config) ||
      touches(mobileConfig) ||
      touches(
        /^(?:src\/|bin\/|tests\/|native\/|\.husky\/|android\/app\/src\/main\/assets\/|tools\/(?:props|frame-bench)\/|tools\/android-[^/]+\.mjs$|README\.md$|docs\/guide\/|biome\.jsonc$|\.env\.example$|\.gitignore$|\.agents\/skills\/(?:office-clone|office-3d-testing|office-thermals|performance-proof)\/|\.agents\/skills\/office-video-capture\/references\/example-launch\/example-composition\.html$)/,
      ),
    website: all || touches(packages) || touches(/^(?:website\/|firebase\.json$|\.firebaserc$|biome\.jsonc$)/),
    // The client is shipped inside the Mac app, even though Linux can build its static files.
    mac: all || touches(packages) || touches(config) || touches(/^(?:src\/(?!mobile\/)|bin\/|build\/|native\/|android\/app\/src\/main\/assets\/model-icons\/|electron-builder\.yml$)/),
    // React Native and the bundled management panels consume root npm, shared and web sources.
    android: all || androidVersionChanged || touches(packages) || touches(mobileConfig) || touches(/^(?:android\/(?!docs\/|.*\.md$)|src\/(?:mobile|shared|client)\/|tsconfig\.mobile\.json$|tools\/android-[^/]+\.mjs$)/),
  };
}

export function changedFiles(eventName, event, git) {
  if (eventName === 'workflow_dispatch') return [];
  if (eventName === 'pull_request') {
    // Three dots exclude changes that landed on the base after this branch diverged.
    return git(['diff', '--name-only', '-z', '--no-renames', `${event.pull_request.base.sha}...${event.pull_request.head.sha}`, '--'])
      .split('\0')
      .filter(Boolean);
  }
  if (eventName === 'push') {
    // Compare the whole push, including multiple commits and merge commits, not just HEAD^.
    const args = /^0+$/.test(event.before) ? ['ls-tree', '-r', '--name-only', '-z', event.after] : ['diff', '--name-only', '-z', '--no-renames', event.before, event.after, '--'];
    return git(args).split('\0').filter(Boolean);
  }
  throw new Error(`Unsupported release event: ${eventName}`);
}

export function androidVersionChanged(files, eventName, event, git, minor) {
  if (!files.includes('package.json')) return false;
  const base = eventName === 'pull_request' ? git(['merge-base', event.pull_request.base.sha, event.pull_request.head.sha]).trim() : event.before;
  return (
    /^0+$/.test(base) ||
    JSON.parse(git(['show', `${base}:package.json`]))
      .version.split('.')
      .slice(0, 2)
      .join('.') !== minor
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const files = changedFiles(process.env.GITHUB_EVENT_NAME, event, git);
  const minor = JSON.parse(readFileSync('package.json', 'utf8')).version.split('.').slice(0, 2).join('.');
  const checks = checksFor(files, {
    manual: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
    androidVersionChanged: androidVersionChanged(files, process.env.GITHUB_EVENT_NAME, event, git, minor),
  });
  const version = `${minor}.${git(['rev-list', '--count', 'HEAD']).trim()}`;
  console.log(JSON.stringify({ files, checks, version }, null, 2));
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${Object.entries({ ...checks, version })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}
