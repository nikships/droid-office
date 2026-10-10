// How a fresh worktree is made ready for its worker: which untracked files are copied over from the
// floor's checkout, and which command runs in it before the agent starts. A repository says so in a
// committed .droid-office.json (and .worktreeinclude), a floor can override that in ⚙️ Settings, and
// without either the office goes by the lockfiles it finds.

/** The repository's own file, at its root: `{ "worktree": { "setup": "npm ci", "copy": ["/.env"] } }`. */
export const SETUP_FILE = '.droid-office.json';
/** Gitignore patterns of untracked files to copy into a new worktree, one per line (other tools read it too). */
export const INCLUDE_FILE = '.worktreeinclude';
/** What's copied when neither the floor nor the repository says: the checkout's own .env files. */
export const DEFAULT_COPY: readonly string[] = ['/.env', '/.env.*'];

/** The `worktree` object of SETUP_FILE. Either field may be left out. */
export interface WorktreeSetupFile {
  /** One shell command line, run in the new worktree. */
  setup?: string;
  /** Gitignore patterns of untracked files in the checkout to copy into the new worktree. */
  copy?: string[];
}

/** A floor's own setup, set in ⚙️ Settings: it replaces the repository's and the detected one. */
export interface WorktreeSetupOverride {
  /** '' runs nothing. */
  setup: string;
  /** [] copies nothing. */
  copy: string[];
  by?: string;
  at?: number;
}

/** Where what runs or what's copied came from. */
export type SetupSource = 'office' | 'repo' | 'detected' | 'default' | 'none';

/** What a new worktree on a floor gets. */
export interface ResolvedSetup {
  /** The command, if anything runs. */
  setup?: string;
  setupFrom: SetupSource;
  /** For a detected command: the lockfiles it went by. */
  detectedFrom?: string[];
  copy: string[];
  copyFrom: SetupSource;
}

/** A floor's worktree setup, for ⚙️ Settings → Workers. */
export interface WorktreeSetupState {
  floor: string;
  /** The floor's project is a git checkout, so its workers can have worktrees. */
  git: boolean;
  /** SETUP_FILE in the floor's checkout, if it has one; `error` when it can't be read. */
  repo?: WorktreeSetupFile & { error?: string };
  /** INCLUDE_FILE's patterns, if the checkout has one. */
  include?: string[];
  /** What the lockfiles in the checkout call for. */
  detected?: { setup: string; from: string[] };
  override?: WorktreeSetupOverride;
  resolved: ResolvedSetup;
}

/**
 * Lockfiles at a repository's root and the install each calls for, lockfile-exact where the tool
 * allows. Only the first JavaScript one counts: a project has one package manager.
 */
const LOCKFILES: readonly { files: string[]; setup: string; js?: boolean }[] = [
  { files: ['bun.lock', 'bun.lockb'], setup: 'bun install --frozen-lockfile', js: true },
  { files: ['pnpm-lock.yaml'], setup: 'pnpm install --frozen-lockfile', js: true },
  { files: ['yarn.lock'], setup: 'yarn install', js: true },
  { files: ['package-lock.json', 'npm-shrinkwrap.json'], setup: 'npm ci', js: true },
  { files: ['uv.lock'], setup: 'uv sync' },
  { files: ['poetry.lock'], setup: 'poetry install' },
  { files: ['Pipfile.lock'], setup: 'pipenv sync --dev' },
  { files: ['Gemfile.lock'], setup: 'bundle install' },
  { files: ['composer.lock'], setup: 'composer install' },
  { files: ['mix.lock'], setup: 'mix deps.get' },
];

/** The install a repository's lockfiles call for (`has` says whether a file is at its root), or nothing. */
export function detectSetup(has: (file: string) => boolean): { setup: string; from: string[] } | undefined {
  const steps: string[] = [];
  const from: string[] = [];
  let js = false;
  for (const l of LOCKFILES) {
    if (l.js && js) continue;
    const file = l.files.find(has);
    if (!file) continue;
    if (l.js) js = true;
    steps.push(l.setup);
    from.push(file);
  }
  return steps.length ? { setup: steps.join(' && '), from } : undefined;
}

/** SETUP_FILE's `worktree` object, or why it can't be used. */
export function parseSetupFile(text: string): WorktreeSetupFile | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { error: `${SETUP_FILE} isn't valid JSON: ${(err as Error).message}` };
  }
  const wt = json && typeof json === 'object' ? (json as Record<string, unknown>).worktree : undefined;
  if (wt === undefined) return {};
  if (!wt || typeof wt !== 'object' || Array.isArray(wt)) return { error: `"worktree" in ${SETUP_FILE} should be an object` };
  const { setup, copy } = wt as Record<string, unknown>;
  if (setup !== undefined && typeof setup !== 'string') return { error: `"worktree.setup" in ${SETUP_FILE} should be a string` };
  if (copy !== undefined && (!Array.isArray(copy) || copy.some((p) => typeof p !== 'string'))) return { error: `"worktree.copy" in ${SETUP_FILE} should be a list of strings` };
  const out: WorktreeSetupFile = {};
  if (setup !== undefined) out.setup = setup.trim();
  if (copy !== undefined) out.copy = cleanPatterns(copy as string[]);
  return out;
}

/** Patterns one per line, as in INCLUDE_FILE: blank lines and # comments left out. */
export function parsePatterns(text: string): string[] {
  return cleanPatterns(text.split(/\r?\n/));
}

function cleanPatterns(list: string[]): string[] {
  return [...new Set(list.map((p) => p.trim()).filter((p) => p && !p.startsWith('#')))];
}

/**
 * What a new worktree gets. The command: the floor's own (even none), else the repository's, else
 * the detected install. The copies: the floor's own (even none), else the repository's list and
 * INCLUDE_FILE together, else DEFAULT_COPY.
 */
export function resolveSetup(o: { override?: WorktreeSetupOverride; repo?: WorktreeSetupFile; include?: string[]; detected?: { setup: string; from: string[] } }): ResolvedSetup {
  const cmd: Pick<ResolvedSetup, 'setup' | 'setupFrom' | 'detectedFrom'> = o.override
    ? { setup: o.override.setup.trim() || undefined, setupFrom: o.override.setup.trim() ? 'office' : 'none' }
    : o.repo?.setup !== undefined
      ? { setup: o.repo.setup || undefined, setupFrom: o.repo.setup ? 'repo' : 'none' }
      : o.detected
        ? { setup: o.detected.setup, setupFrom: 'detected', detectedFrom: o.detected.from }
        : { setupFrom: 'none' };
  const fromRepo = [...(o.repo?.copy ?? []), ...(o.include ?? [])];
  const copy: Pick<ResolvedSetup, 'copy' | 'copyFrom'> = o.override
    ? { copy: cleanPatterns(o.override.copy), copyFrom: 'office' }
    : o.repo?.copy !== undefined || o.include !== undefined
      ? { copy: cleanPatterns(fromRepo), copyFrom: 'repo' }
      : { copy: [...DEFAULT_COPY], copyFrom: 'default' };
  return { ...cmd, ...copy };
}

/** What a new worktree gets, as a phrase ("runs `npm ci` and copies …"); `code` marks a command or pattern. */
export function describeSetup(r: ResolvedSetup, code = (s: string) => `\`${s}\``): string {
  const run = r.setup ? `runs ${code(r.setup)}${r.setupFrom === 'detected' && r.detectedFrom?.length ? ` (from ${r.detectedFrom.join(' and ')})` : ''}` : 'runs no setup command';
  const copy = r.copy.length ? `copies ${r.copy.map(code).join(', ')} from the checkout` : 'copies nothing';
  return `${run} and ${copy}`;
}
