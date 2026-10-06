import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WEATHERS, type Weather } from '../shared/protocol.js';
import { MAX_WORKER_LIMIT, parseWorkerLimit } from './machine.js';

export interface Config {
  /** The office's own folder: the building's data lives in its .droid-office. */
  dir: string;
  dataDir: string;
  /** Where the office looks for existing checkouts to add as floors, unless another folder is picked (see defaultProjectsDir). */
  projectsDir: string;
  /** The folder that is always a floor (the CLI sets the home folder; unset in tests so they never touch it). */
  homeFloor?: string;
  /** Where the Droid subagents skill goes (the CLI sets ~/.factory/skills; unset in tests so they never touch it). */
  skillsDir?: string;
  /** --projects / DROID_OFFICE_PROJECTS: picks the workspace folder, as ⚙️ Settings in the office does. */
  projects?: string;
  /** Started as `droid-office <dir>`: that checkout is a floor of its own (it's also `dir`). */
  project?: string;
  host: string;
  port: number;
  agentCmd: string;
  agentArgs: string[];
  tls?: { cert: string; key: string };
  trustProxy: boolean;
  /** This machine's public address (set by deploy/aws.sh): the Services board's owner SSH hint. */
  publicHost?: string;
  /** The most workers the office runs at once, across every floor; ⚙️ Settings can't go past it. */
  maxWorkers?: number;
  /** Slack / Discord webhook to post to when a worker needs input or finishes ('' turns it off). */
  webhook?: string;
  /** Where the office is: its sun and live weather follow this city's forecast. */
  city?: string;
  /** Weather pinned for good, instead of made up or forecast. */
  weather?: Weather;
}

const HELP = `droid-office — a 3D office where you hire Droid workers at desks and work in their live terminals

Usage:
  droid-office [options]
  droid-office [dir] [options]
  droid-office setup [--projects <dir>] [--project <repo>]...
  droid-office prune [dir] [--dry-run] [--force]

Runs the office. Every project is a floor of the building: ride the elevator and
pick one of the git checkouts you already have in your workspace folder. The
office uses it where it is (it never clones or copies a repository). Workers,
terminals, boards and the task queue on a floor all belong to that checkout.

The first time it starts in a terminal with no floors, it walks you through
which folder your projects are in and which of them to open first.

Started from anywhere, the office keeps its data in --home. Given a [dir] (or
started in a project where an office already ran), it keeps its data in
<dir>/.droid-office as it always has, and that project starts out as a floor
(it can be taken off in the elevator like any other).

Commands:
  setup                   Pick the folder your projects are in and which of them
                          are floors: a walkthrough in a terminal, or just
                          --projects / --project for scripts (see setup --help)
  prune                   Remove leftover worker worktrees (.droid-office/worktrees/)
                          and their office/* branches. Anything with uncommitted
                          changes or unpushed commits is kept unless --force is given.

Options:
      --home <dir>        Where the office keeps its data when no [dir] is given
                          (default ~/droid-office, env DROID_OFFICE_HOME)
      --projects <dir>    The workspace folder: where the office looks for your
                          existing git checkouts to offer as floors. Default a
                          code folder in your home folder (~/Workspace, ~/code,
                          ~/repos…), else the home folder. Env
                          DROID_OFFICE_PROJECTS. Also settable from ⚙️ Settings
                          in the office
  -p, --port <n>          Port to listen on (default 4600, env PORT)
  -H, --host <addr>       Address to bind (default 0.0.0.0)
      --agent <cmd>       The Droid command (default "droid", env DROID_OFFICE_AGENT)
      --agent-args <str>  Extra args for Droid, e.g. "--auto medium"
      --tls-cert <file>   Serve HTTPS with this certificate (PEM)
      --tls-key <file>    ...and this private key (PEM)
      --self-signed       Serve HTTPS with a generated self-signed certificate
      --trust-proxy       Trust X-Forwarded-* headers (behind Caddy/nginx)
      --max-workers <n>   Run at most this many workers at once, across every
                          floor (env DROID_OFFICE_MAX_WORKERS). Hiring past it
                          is refused. It can be lowered from ⚙️
                          Settings, but not raised past this
      --webhook <url>     Post to this Slack or Discord webhook when a worker
                          needs input or finishes (env DROID_OFFICE_WEBHOOK).
                          Also settable from ⚙️ Settings in the office; "" turns it off
      --city <name>       Put the office in a real city, e.g. "Berlin" or
                          "Portland, Oregon" (env DROID_OFFICE_CITY): the weather
                          outside follows its live forecast from open-meteo.com
                          (it is always night). Without it the weather is made up
      --weather <kind>    Pin the weather: clear, cloudy, rain, storm, snow or
                          fog (env DROID_OFFICE_WEATHER)
  -h, --help              Show this help
`;

function takeValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`droid-office: ${flag} needs a value`);
    process.exit(2);
  }
  return v;
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Where the office lives when it isn't started in a project: ~/droid-office, or $DROID_OFFICE_HOME. */
export function officeHome(): string {
  return path.resolve(process.env.DROID_OFFICE_HOME || path.join(os.homedir(), 'droid-office'));
}

/** Folders people keep their code in, in the home folder: the first one that's there is the default workspace folder. */
const CODE_FOLDERS = ['Workspace', 'workspace', 'Developer', 'code', 'Code', 'projects', 'Projects', 'repos', 'src', 'dev', 'git', 'GitHub', 'github'];

/** A code folder that's already in `home`, else `fallback`. */
export function suggestedFolder(fallback: string, home = os.homedir()): string {
  let names: string[] = [];
  try {
    names = readdirSync(home);
  } catch {
    return fallback;
  }
  for (const name of CODE_FOLDERS) {
    const dir = path.join(home, name);
    try {
      if (names.includes(name) && statSync(dir).isDirectory()) return dir;
    } catch {
      // a broken link
    }
  }
  return fallback;
}

/**
 * Where the office looks for checkouts to add as floors unless another folder is picked: a code
 * folder in the home folder if there is one, else the home folder itself.
 */
export function defaultProjectsDir(): string {
  return suggestedFolder(os.homedir());
}

/** Keep the office's own data out of git without touching the project's .gitignore. */
export function excludeFromGit(dir: string) {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const exclude = path.resolve(dir, gitDir, 'info', 'exclude');
    const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!cur.split('\n').some((l) => l.trim() === '.droid-office/' || l.trim() === '.droid-office')) {
      mkdirSync(path.dirname(exclude), { recursive: true });
      appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.droid-office/\n`);
    }
  } catch {
    // not a git repo; nothing to exclude
  }
}

export function loadConfig(argv: string[]): Config {
  let project = '';
  let home = officeHome();
  let homeGiven = !!process.env.DROID_OFFICE_HOME;
  let projects = process.env.DROID_OFFICE_PROJECTS ? path.resolve(process.env.DROID_OFFICE_PROJECTS) : '';
  let port = Number(process.env.PORT) || 4600;
  let host = '0.0.0.0';
  let agentCmd = process.env.DROID_OFFICE_AGENT || 'droid';
  let agentArgs: string[] = splitArgs(process.env.DROID_OFFICE_AGENT_ARGS || '');
  let tlsCert = '';
  let tlsKey = '';
  let selfSigned = false;
  let trustProxy = false;
  let maxWorkers = process.env.DROID_OFFICE_MAX_WORKERS || '';
  let webhook = process.env.DROID_OFFICE_WEBHOOK;
  let city = process.env.DROID_OFFICE_CITY || '';
  let weather = process.env.DROID_OFFICE_WEATHER || '';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        process.stdout.write(HELP);
        return process.exit(0);
      case '-p':
      case '--port':
        port = Number(takeValue(argv, i++, a));
        break;
      case '-H':
      case '--host':
        host = takeValue(argv, i++, a);
        break;
      case '--agent':
        agentCmd = takeValue(argv, i++, a);
        break;
      case '--agent-args':
        // Its value is flags itself ("--model opus"), so a leading -- doesn't mean the value is missing.
        if (argv[i + 1] === undefined) takeValue(argv, i, a);
        agentArgs = splitArgs(argv[++i]);
        break;
      case '--tls-cert':
        tlsCert = takeValue(argv, i++, a);
        break;
      case '--tls-key':
        tlsKey = takeValue(argv, i++, a);
        break;
      case '--self-signed':
        selfSigned = true;
        break;
      case '--trust-proxy':
        trustProxy = true;
        break;
      case '--max-workers':
        maxWorkers = takeValue(argv, i++, a);
        break;
      case '--webhook':
        webhook = takeValue(argv, i++, a);
        break;
      case '--home':
        home = path.resolve(takeValue(argv, i++, a));
        homeGiven = true;
        break;
      case '--projects':
        projects = path.resolve(takeValue(argv, i++, a));
        break;
      case '--city':
        city = takeValue(argv, i++, a);
        break;
      case '--weather':
        weather = takeValue(argv, i++, a);
        break;
      default:
        if (a.startsWith('-')) {
          console.error(`droid-office: unknown option ${a}\n`);
          process.stderr.write(HELP);
          process.exit(2);
        }
        project = path.resolve(a);
    }
  }

  // An office already runs in this project (started here before there were floors): carry on with
  // it and its workers, rather than open an empty building somewhere else.
  const cwd = process.cwd();
  if (!project && !homeGiven && cwd !== home && existsSync(path.join(cwd, '.droid-office', 'config.json'))) project = cwd;
  if (project && !existsSync(project)) {
    console.error(`droid-office: directory not found: ${project}`);
    process.exit(2);
  }
  const dir = project || home;
  const projectsDir = defaultProjectsDir();
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('droid-office: invalid --port');
    process.exit(2);
  }
  const workerLimit = maxWorkers ? parseWorkerLimit(maxWorkers) : undefined;
  if (maxWorkers && workerLimit === undefined) {
    console.error(`droid-office: --max-workers needs a whole number from 1 to ${MAX_WORKER_LIMIT}, e.g. --max-workers 6`);
    process.exit(2);
  }
  weather = weather.trim().toLowerCase();
  if (weather && !(WEATHERS as readonly string[]).includes(weather)) {
    console.error(`droid-office: --weather is one of ${WEATHERS.join(', ')}`);
    process.exit(2);
  }

  const dataDir = path.join(dir, '.droid-office');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (project) excludeFromGit(dir);

  // The file's presence says an office ran here (see above); it keeps no secrets. LAN access
  // is a per-start token in memory (see lan.ts), and old password state left here is dropped.
  const cfgPath = path.join(dataDir, 'config.json');
  writeFileSync(cfgPath, '{}\n', { mode: 0o600 });

  let tls: Config['tls'];
  if (tlsCert || tlsKey) {
    if (!tlsCert || !tlsKey) {
      console.error('droid-office: --tls-cert and --tls-key go together');
      process.exit(2);
    }
    tls = { cert: readFileSync(tlsCert, 'utf8'), key: readFileSync(tlsKey, 'utf8') };
  } else if (selfSigned) {
    tls = { cert: '', key: '' }; // filled in by ensureSelfSigned()
  }

  return {
    dir,
    dataDir,
    projectsDir,
    projects: projects || undefined,
    project: project || undefined,
    host,
    port,
    agentCmd,
    agentArgs,
    tls,
    trustProxy,
    publicHost: process.env.DROID_OFFICE_PUBLIC_HOST || undefined,
    maxWorkers: workerLimit,
    webhook,
    city: city.trim() || undefined,
    weather: (weather as Weather) || undefined,
  };
}

export async function ensureSelfSigned(cfg: Config): Promise<void> {
  if (!cfg.tls || cfg.tls.cert) return;
  const certPath = path.join(cfg.dataDir, 'tls-cert.pem');
  const keyPath = path.join(cfg.dataDir, 'tls-key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) {
    cfg.tls = { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
    return;
  }
  const selfsigned = await import('selfsigned');
  const gen = (selfsigned as any).generate ?? (selfsigned as any).default?.generate;
  const pems = await gen([{ name: 'commonName', value: 'droid-office' }], { days: 825, keySize: 2048 });
  writeFileSync(certPath, pems.cert, { mode: 0o600 });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  cfg.tls = { cert: pems.cert, key: pems.private };
}
