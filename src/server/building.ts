import { execFileSync, spawn } from 'node:child_process';
import { type Dirent, accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FLOOR_PALETTES, MAX_FLOORS, forgeOf, normalizeRepo, parseGitHubUrl } from '../shared/floors.js';
import { moveFloor } from '../shared/floor-order.js';
import type { FolderChoice, ProjectsDirState, RepoChoice } from '../shared/protocol.js';
import { isGitlabHost } from './gitlab.js';

/** A floor as floors.json keeps it. */
export interface FloorDef {
  id: string;
  name: string;
  /** owner/name on GitHub, host/group/…/project on GitLab. */
  repo?: string;
  dir: string;
  palette: number;
  addedBy: string;
  addedAt: number;
}

/** The workspace folder picked in ⚙️ Settings (or with --projects), as projects-folder.json keeps it. */
interface PickedDir {
  dir: string;
  by: string;
  at: number;
}

/** The checkout the office was started in, once it's been taken off the building (local-floor.json). */
interface LocalOff {
  dir: string;
  by: string;
  at: number;
}

/** What the elevator's folder browser shows of one folder. */
export interface FolderListing {
  dir: string;
  shown: string;
  git: boolean;
  /** Why this folder can't be added where it is: a checkout outside the workspace folder. */
  blocked?: string;
  parent?: string;
  folders: FolderChoice[];
  more?: boolean;
  error?: string;
}

/** The most folders the folder browser lists in one folder. */
const MAX_FOLDERS = 500;
/** How long the list of checkouts found in the workspace folder is reused before the folder is searched again. */
const REPOS_TTL_MS = 30_000;
const MAX_REPOS = 1000;
/** How many folders deep under the workspace folder a checkout is looked for (owner/repo is two; GitLab groups go deeper). */
const SCAN_DEPTH = 4;
/** The most directory entries one search reads, so a workspace folder as big as the home folder can't stall the office. */
const SCAN_ENTRIES = 20_000;
/** Folders that hold no projects and are big or private enough to skip when the workspace folder is the home folder. */
const SCAN_SKIP = new Set(['node_modules', 'Library', 'Applications', 'Movies', 'Music', 'Pictures', 'Downloads', 'AppData']);
/** Maximum time a single `git clone` / `gh repo clone` is allowed to run before aborting. */
const CLONE_TIMEOUT_MS = 300_000;
/** Cap captured stderr/stdout from clone commands so progress bars never exhaust memory. */
const MAX_CLONE_OUTPUT = 16_384;

/**
 * The floors of the building, saved in <office>/.droid-office/floors.json: which projects there are,
 * where their checkouts live, and how each floor is painted. Existing folders open in place without
 * copying; pasting a GitHub repository URL clones into the workspace folder (picked in ⚙️ Settings,
 * kept in projects-folder.json) and opens it as a floor in one step.
 */
export class Building {
  private defs: FloorDef[] = [];
  private file: string;
  private pickedFile: string;
  private picked?: PickedDir;
  private repoCache?: { at: number; repos: Promise<RepoChoice[]> };
  /** Target paths currently being cloned, so concurrent requests never race into the same folder. */
  private cloning = new Set<string>();
  /** The checkout the office was started in (see ensureLocal), and the repository it's a checkout of. */
  private local?: { dir: string; repo?: string };
  /** The floor that checkout is, while it is one. */
  private localId?: string;
  private localFile: string;
  /** The folder whose floor is always in the building (see ensureHome). */
  private homeDir = path.resolve(os.homedir());
  /** That checkout was taken off the building: a restart doesn't put it back. */
  private localOff?: LocalOff;

  constructor(
    /** The office's own data folder. */
    dataDir: string,
    /** Where checkouts are looked for unless another folder was picked. */
    private defaultProjectsDir: string,
  ) {
    this.file = path.join(dataDir, 'floors.json');
    this.pickedFile = path.join(dataDir, 'projects-folder.json');
    this.localFile = path.join(dataDir, 'local-floor.json');
    this.load();
    this.loadPicked();
    this.loadLocalOff();
  }

  /** The workspace folder: where checkouts are looked for. Floors elsewhere stay when it moves. */
  get projectsDir(): string {
    return this.picked?.dir ?? this.defaultProjectsDir;
  }

  projectsDirState(): ProjectsDirState {
    return { dir: tildify(this.projectsDir), custom: !!this.picked, by: this.picked?.by, at: this.picked?.at };
  }

  /** Looks for checkouts in `raw` from now on ('~' is the home folder; '' goes back to the default). Returns why it can't, if it can't. */
  setProjectsDir(raw: string, by: string): string | undefined {
    const text = raw.trim();
    let dir = this.defaultProjectsDir;
    if (text) {
      const typed = untildify(text);
      if (!path.isAbsolute(typed)) return 'Use a full path, like ~/Workspace';
      dir = path.resolve(typed);
    }
    if (dir !== this.defaultProjectsDir) {
      const why = unreadable(dir);
      if (why) return why;
    }
    this.picked = dir === this.defaultProjectsDir ? undefined : { dir, by, at: Date.now() };
    this.repoCache = undefined;
    try {
      writeFileSync(this.pickedFile, JSON.stringify(this.picked ?? {}, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`droid-office: couldn't save the workspace folder: ${(err as Error).message}`);
    }
    return undefined;
  }

  list(): FloorDef[] {
    // One open floor per checkout. An alias saved next to the real path stays in floors.json until
    // that floor is taken off, so loading does not delete it, but it is not a second floor: two of
    // them would share that checkout's .droid-office and overwrite each other's pictures.
    const seen = new Set<string>();
    const active: FloorDef[] = [];
    for (const def of this.defs) {
      const key = checkoutKey(def.dir);
      if (seen.has(key)) continue;
      seen.add(key);
      active.push(def);
    }
    return active;
  }

  /** Persist the numbered order. Keep aliases behind their open floor, and never report a failed save as success. */
  reorder(floor: string, before: string | null): string | undefined {
    const ordered = moveFloor(this.list(), floor, before);
    if (!ordered) return 'That floor is no longer in the building. Reopen the floor list and try again.';
    const next = ordered.flatMap((f) => this.defs.filter((d) => checkoutKey(d.dir) === checkoutKey(f.dir)));
    if (next.length === this.defs.length && next.every((d, i) => d === this.defs[i])) return undefined;
    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch (err) {
      console.error(`droid-office: couldn't save the floor order: ${(err as Error).message}`);
      try {
        rmSync(temp, { force: true });
      } catch {
        // A blocked temporary path must not turn a refused reorder into an exception.
      }
      return "Couldn't save the floor order. Nothing was reordered.";
    }
    this.defs = next;
    return undefined;
  }

  /**
   * Makes the checkout the office was started in a floor, if it isn't one yet: `droid-office <dir>`
   * has always meant that project. A symlink to a checkout that already has a floor is that floor,
   * and the path already saved is left as it was. Once someone takes it off the building it stays
   * off (the office still keeps its own data in it), until its repository is added again from the elevator.
   */
  ensureLocal(dir: string, by: string): FloorDef | undefined {
    const abs = path.resolve(dir);
    const known = this.knownCheckout(abs);
    this.local = { dir: abs, repo: known?.repo ?? originRepo(abs) };
    if (known) {
      this.localId = known.id;
      if (this.localOff) this.setLocalOff(undefined);
      return known;
    }
    if (this.localOff && checkoutKey(this.localOff.dir) === checkoutKey(abs)) return undefined;
    // Named after its folder, as the office always called it.
    const def = this.newDef(path.basename(abs), this.local.repo, abs, by);
    this.defs.unshift(def);
    this.localId = def.id;
    this.save();
    return def;
  }

  /**
   * Makes sure the home folder is a floor. It is added once, after the floors there already are
   * so none of them change number, and it can't be taken off (see remove). A home folder that is
   * already a floor, added by hand or through another path to the same directory, counts as it.
   * Returns the floor, or undefined when the building is full.
   */
  ensureHome(home = os.homedir()): FloorDef | undefined {
    const dir = path.resolve(home);
    this.homeDir = dir;
    const known = this.knownCheckout(dir);
    if (known) return known;
    if (this.list().length >= MAX_FLOORS) {
      console.error(`droid-office: the building is full (${MAX_FLOORS} floors), so the home floor (${tildify(dir)}) can't be added`);
      return undefined;
    }
    const def = this.newDef('Home', originRepo(dir), dir, 'the office');
    this.defs.push(def);
    this.save();
    return def;
  }

  /** The home folder's floor, which is always there. */
  isHome(id: string): boolean {
    const def = this.defs.find((d) => d.id === id);
    return !!def && checkoutKey(def.dir) === checkoutKey(this.homeDir);
  }

  /** Whether any floor is a project the owner added, rather than just the home floor. */
  hasProjects(): boolean {
    return this.defs.some((d) => !this.isHome(d.id));
  }

  /** The office keeps its own data in this floor's checkout. */
  isLocal(id: string): boolean {
    return id === this.localId;
  }

  /**
   * Takes a floor off the building. Its checkout stays where it is, with its workers and
   * pictures in its .droid-office folder: adding the checkout again moves back in. An alias saved
   * for that same checkout comes off with the open floor, so a restart does not open a floor the
   * office never started. Returns the floor, or why it can't.
   */
  remove(id: string, by = '?'): FloorDef | string {
    const def = this.defs.find((d) => d.id === id);
    if (!def) return 'No such floor';
    if (this.isHome(id)) return `${def.name} is the home floor: it's always in the building`;
    const opened = this.list().some((d) => d.id === id);
    const key = checkoutKey(def.dir);
    // The server only starts the open floor. Its aliases go with it. A suppressed alias removed by
    // id drops only that row, and the open floor stays.
    this.defs = this.defs.filter((d) => (opened ? checkoutKey(d.dir) !== key : d.id !== id));
    if (this.isLocal(id)) {
      this.localId = undefined;
      this.setLocalOff({ dir: def.dir, by, at: Date.now() });
    }
    this.save();
    return def;
  }

  /**
   * Makes a folder that already exists a floor, where it is: nothing is cloned, copied or moved.
   * `input` is its full path. A git checkout has to be in the workspace folder (or be the checkout
   * the office was started in). A plain folder, one without a `.git` of its own, can be anywhere the
   * office can read and write. A symlink to a folder that already has a floor is that floor: the
   * path already saved is left as it was. Returns the floor, or why there's none.
   */
  add(input: string, by: string): FloorDef | string {
    const text = input.trim();
    if (!text) return 'Pick a project from the list, browse to a folder, or type its full path, like ~/Workspace/my-project';
    const typed = untildify(text);
    if (!path.isAbsolute(typed)) return 'Use the folder’s full path, like ~/Workspace/my-project';
    const dir = path.resolve(typed);
    const shown = tildify(dir);
    if (!existsSync(dir)) return `${shown} doesn't exist`;
    const git = isCheckout(dir);
    const why = plainProblem(dir) ?? (git ? this.outsideWorkspace(dir) : undefined);
    if (why) return why;
    const known = this.knownCheckout(dir);
    if (known) return `${shown} already has a floor (${known.name})`;
    // A saved alias is not a second floor, so it does not fill the building.
    if (this.list().length >= MAX_FLOORS) return `The building is full (${MAX_FLOORS} floors)`;
    const repo = git ? originRepo(dir) : undefined;
    // The path as given is what is saved, not its real path, so a later start still finds it as written.
    const def = this.newDef(repo?.split('/').pop() ?? path.basename(dir), repo, dir, by);
    this.defs.push(def);
    // The office's own checkout, taken off before: it moves back in where it is, including through an alias the workspace allows.
    if (this.localOff && checkoutKey(this.localOff.dir) === checkoutKey(dir)) {
      this.localId = def.id;
      this.setLocalOff(undefined);
    }
    this.save();
    return def;
  }

  /**
   * Clones a GitHub repository URL into the workspace folder (`projectsDir/<repo>`) and adds it as a floor.
   * If `projectsDir/<repo>` is already a checkout of the same repository, it is added directly without cloning again.
   */
  async cloneAndAdd(rawUrl: string, by: string): Promise<FloorDef | string> {
    const parsed = parseGitHubUrl(rawUrl);
    if (!parsed) return 'Use a valid GitHub repository URL, like https://github.com/owner/repo';
    const root = path.resolve(this.projectsDir);
    const targetDir = path.resolve(root, parsed.name);
    if (!within(targetDir, root) || targetDir === root) return 'Invalid repository name';

    if (existsSync(targetDir)) {
      if (isCheckout(targetDir) && originRepo(targetDir)?.toLowerCase() === parsed.repo.toLowerCase()) {
        return this.add(targetDir, by);
      }
      const existingRepo = isCheckout(targetDir) ? originRepo(targetDir) : undefined;
      const shown = tildify(targetDir);
      return existingRepo ? `${shown} already exists (${existingRepo}). Pick another workspace folder or add it directly.` : `${shown} already exists. Remove or rename it, or pick another workspace folder.`;
    }

    if (this.list().length >= MAX_FLOORS) return `The building is full (${MAX_FLOORS} floors)`;
    if (this.cloning.has(targetDir)) return `Already cloning ${parsed.repo} into ${tildify(targetDir)}`;

    if (!existsSync(root)) {
      try {
        mkdirSync(root, { recursive: true });
      } catch (err) {
        return `Couldn't create ${tildify(root)}: ${(err as Error).message}`;
      }
    }
    try {
      if (!statSync(root).isDirectory()) return `${tildify(root)} isn't a folder`;
      accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      return `${tildify(root)} isn't a folder the office can write to`;
    }

    this.cloning.add(targetDir);
    try {
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      const gitRes = await runCloneCommand('git', ['clone', '--', parsed.cloneUrl, targetDir], root, gitEnv);
      if (!gitRes.ok || !isCheckout(targetDir)) {
        cleanupPartialClone(targetDir);
        if (gitRes.enoent) return "git is not installed on the office's machine";
        if (!parsed.ssh && shouldFallbackToGh(gitRes.output)) {
          const ghRes = await runCloneCommand('gh', ['repo', 'clone', parsed.repo, targetDir], root, { ...gitEnv, GH_PROMPT_DISABLED: '1' });
          if (!ghRes.ok || !isCheckout(targetDir)) {
            cleanupPartialClone(targetDir);
            const detail = ghRes.enoent || ghRes.ok ? gitRes.output : ghRes.output || gitRes.output;
            return friendlyCloneError(parsed.repo, detail, parsed.ssh);
          }
        } else {
          return friendlyCloneError(parsed.repo, gitRes.output, parsed.ssh);
        }
      }
      this.repoCache = undefined;
      return this.add(targetDir, by);
    } finally {
      this.cloning.delete(targetDir);
    }
  }

  /** The floor for this checkout, following symlinks, if one is already saved. */
  private knownCheckout(dir: string): FloorDef | undefined {
    const key = checkoutKey(dir);
    return this.defs.find((d) => checkoutKey(d.dir) === key);
  }

  /** The checkouts in the workspace folder that could become floors, most recently active first. */
  async repos(refresh = false): Promise<RepoChoice[]> {
    const cached = this.repoCache;
    if (cached && !refresh && Date.now() - cached.at < REPOS_TTL_MS) return cached.repos;
    const repos = findCheckouts(this.projectsDir);
    this.repoCache = { at: Date.now(), repos };
    return repos;
  }

  /** Why checkout `dir` can't be a floor where it is, if it can't: it has to be in the workspace folder. */
  private outsideWorkspace(dir: string): string | undefined {
    // The started-in checkout can be put back by the path it was saved as, even outside the workspace.
    // Any other path, including a symlink, still has to land inside the workspace after resolving it.
    const back = this.localOff && path.resolve(this.localOff.dir) === dir;
    if (back || within(realPath(dir), realPath(this.projectsDir))) return undefined;
    return `${tildify(dir)} isn't in the workspace folder (${tildify(this.projectsDir)}). Pick another workspace folder in ⚙️ Settings`;
  }

  /** The folders in `raw` (the workspace folder when unset), hidden ones left out, for the elevator's folder browser. */
  async folders(raw?: string): Promise<FolderListing> {
    const text = raw?.trim() ?? '';
    const typed = text ? untildify(text) : this.projectsDir;
    if (!path.isAbsolute(typed)) return { dir: this.projectsDir, shown: tildify(this.projectsDir), git: false, folders: [], error: 'Use a full path, like ~/Workspace' };
    const dir = path.resolve(typed);
    const up = path.dirname(dir);
    const git = isCheckout(dir);
    const blocked = (existsSync(dir) ? plainProblem(dir) : undefined) ?? (git ? this.outsideWorkspace(dir) : undefined);
    const base = { dir, shown: tildify(dir), git, ...(blocked ? { blocked } : {}), ...(up !== dir ? { parent: up } : {}) };
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { ...base, folders: [], error: `${base.shown} can't be opened` };
    }
    const visible = entries.filter((e) => !e.name.startsWith('.')).map((e) => ({ e, full: path.join(dir, e.name) }));
    // A symlink counts when it leads to a folder.
    const isDir = await Promise.all(
      visible.map(
        ({ e, full }) =>
          e.isDirectory() ||
          (e.isSymbolicLink() &&
            stat(full).then(
              (s) => s.isDirectory(),
              () => false,
            )),
      ),
    );
    const folders: FolderChoice[] = visible.filter((_, i) => isDir[i]).map(({ e, full }) => ({ name: e.name, dir: full, git: false }));
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    const listed = folders.slice(0, MAX_FOLDERS);
    for (const f of listed) f.git = isCheckout(f.dir);
    return { ...base, folders: listed, ...(folders.length > MAX_FOLDERS ? { more: true } : {}) };
  }

  private newDef(name: string, repo: string | undefined, dir: string, by: string): FloorDef {
    const taken = new Set(this.defs.map((d) => d.id));
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'floor';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    // The first look nobody has, so floors side by side never match; then round again.
    const used = new Set(this.defs.map((d) => d.palette));
    const free = FLOOR_PALETTES.findIndex((_, i) => !used.has(i));
    const palette = free >= 0 ? free : this.defs.length % FLOOR_PALETTES.length;
    return { id, name, repo, dir, palette, addedBy: by, addedAt: Date.now() };
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FloorDef>[];
      const ids = new Set<string>();
      for (const s of Array.isArray(saved) ? saved : []) {
        if (typeof s.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(s.id) || ids.has(s.id) || typeof s.dir !== 'string' || !path.isAbsolute(s.dir)) continue;
        ids.add(s.id);
        this.defs.push({
          id: s.id,
          name: typeof s.name === 'string' && s.name ? s.name.slice(0, 100) : path.basename(s.dir),
          repo: normalizeRepo(s.repo),
          dir: s.dir,
          palette: Number.isInteger(s.palette) && (s.palette as number) >= 0 ? (s.palette as number) : 0,
          addedBy: typeof s.addedBy === 'string' ? s.addedBy : '?',
          addedAt: typeof s.addedAt === 'number' ? s.addedAt : Date.now(),
        });
      }
    } catch (err) {
      console.error(`droid-office: ${this.file} couldn't be read, so the building starts empty: ${(err as Error).message}`);
    }
  }

  private loadPicked() {
    try {
      const saved = JSON.parse(readFileSync(this.pickedFile, 'utf8')) as Partial<PickedDir>;
      if (typeof saved.dir === 'string' && path.isAbsolute(saved.dir)) {
        this.picked = { dir: saved.dir, by: typeof saved.by === 'string' ? saved.by : '?', at: typeof saved.at === 'number' ? saved.at : Date.now() };
      }
    } catch {
      // never picked: the default
    }
  }

  private loadLocalOff() {
    try {
      const saved = JSON.parse(readFileSync(this.localFile, 'utf8')) as Partial<LocalOff>;
      if (typeof saved.dir === 'string' && path.isAbsolute(saved.dir)) {
        this.localOff = { dir: saved.dir, by: typeof saved.by === 'string' ? saved.by : '?', at: typeof saved.at === 'number' ? saved.at : Date.now() };
      }
    } catch {
      // never taken off
    }
  }

  private setLocalOff(off: LocalOff | undefined) {
    this.localOff = off;
    try {
      if (off) writeFileSync(this.localFile, JSON.stringify(off, null, 2), { mode: 0o600 });
      else rmSync(this.localFile, { force: true });
    } catch (err) {
      console.error(`droid-office: couldn't save ${this.localFile}: ${(err as Error).message}`);
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.defs, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`droid-office: couldn't save the floors: ${(err as Error).message}`);
    }
  }
}

/** A path under the home folder as ~/…, for showing people. */
export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function untildify(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** `dir` is `parent` or somewhere under it. */
function within(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** A git checkout of its own: `.git` (a folder, or a worktree's file) in the folder itself, not in a folder it's inside. */
export function isCheckout(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

/** Why a folder that isn't a checkout can't be a floor, if it can't: the floor keeps its .droid-office in it. */
function plainProblem(dir: string): string | undefined {
  const shown = tildify(dir);
  const real = realPath(dir);
  if (path.dirname(real) === real) return `${shown} is the top of the disk: pick a folder in it`;
  if (real.split(path.sep).includes('.droid-office')) return `${shown} is inside the office's own data`;
  try {
    if (!statSync(dir).isDirectory()) return `${shown} isn't a folder`;
    accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    return `${shown} isn't a folder the office can read and write`;
  }
  return undefined;
}

/** Why the office can't look for checkouts in `dir`, if it can't. */
function unreadable(dir: string): string | undefined {
  try {
    if (!statSync(dir).isDirectory()) return `${tildify(dir)} isn't a folder`;
    accessSync(dir, constants.R_OK | constants.X_OK);
  } catch {
    return `${tildify(dir)} isn't a folder the office can read`;
  }
  return undefined;
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The real directory a checkout path names, so a symlink alias is the same checkout as its target. */
function checkoutKey(dir: string): string {
  return realPath(path.resolve(dir));
}

/** The repository a remote URL points at, on GitHub or on a GitLab instance. */
function remoteRepo(url: string): string | undefined {
  if (/github\.com[/:]/i.test(url)) return normalizeRepo(url);
  const host = /^(?:(?:https?|ssh|git):\/\/)?(?:[\w.~%-]+@)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::\d+)?[/:]/.exec(url.trim())?.[1];
  return host && isGitlabHost(host) ? normalizeRepo(url) : undefined;
}

/** The GitHub or GitLab repository a checkout's origin points at; none for a folder inside someone else's checkout. */
export function originRepo(dir: string): string | undefined {
  if (!isCheckout(dir)) return undefined;
  const configured = configOrigin(dir);
  if (configured) {
    const parsed = remoteRepo(configured);
    if (parsed) return parsed;
  }
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return remoteRepo(url);
  } catch {
    return undefined;
  }
}

/** The URL of a checkout's origin remote, read from its git config (cheaper than running git for every folder found). */
export function configOrigin(dir: string): string | undefined {
  let configPath = path.join(dir, '.git', 'config');
  try {
    const dotGit = path.join(dir, '.git');
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (match) {
        const gitDir = path.resolve(dir, match[1]);
        const commonFile = path.join(gitDir, 'commondir');
        const commonDir = existsSync(commonFile) ? path.resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
        configPath = path.join(commonDir, 'config');
      }
    }
  } catch {
    // fall back to default path
  }
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return undefined;
  }
  let inOrigin = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) inOrigin = /^\[remote\s+"origin"\]/.test(t);
    else if (inOrigin) {
      const m = /^url\s*=\s*(.+)$/.exec(t);
      if (m) return m[1].trim();
    }
  }
  return undefined;
}

/** Git checkouts in `root` (or `root` itself), down to SCAN_DEPTH folders, most recently active first. Never descends into a checkout. */
async function findCheckouts(root: string): Promise<RepoChoice[]> {
  const found: RepoChoice[] = [];
  let budget = SCAN_ENTRIES;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= MAX_REPOS || budget <= 0) return;
    const git = await stat(path.join(dir, '.git')).catch(() => undefined);
    if (git) {
      const url = configOrigin(dir);
      const repo = url ? remoteRepo(url) : undefined;
      found.push({ name: repo ?? path.basename(dir), dir, repo, forge: forgeOf(repo), activeAt: git.mtime.toISOString() });
      return;
    }
    if (depth >= SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    budget -= entries.length;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SCAN_SKIP.has(e.name)) await visit(path.join(dir, e.name), depth + 1);
    }
  };
  await visit(root, 0);
  return found.sort((a, b) => (b.activeAt ?? '').localeCompare(a.activeAt ?? '') || a.dir.localeCompare(b.dir));
}

interface CloneCommandResult {
  ok: boolean;
  output: string;
  enoent?: boolean;
}

function cleanupPartialClone(targetDir: string) {
  try {
    rmSync(targetDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup after failed clone
  }
}

function runCloneCommand(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = CLONE_TIMEOUT_MS): Promise<CloneCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (result: CloneCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const append = (chunk: Buffer | string) => {
      output += String(chunk);
      if (output.length > MAX_CLONE_OUTPUT) output = output.slice(-MAX_CLONE_OUTPUT);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return finish({ ok: false, output: (err as Error).message, enoent: code === 'ENOENT' });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, 5000);
    }, timeoutMs);
    child.stderr?.on('data', append);
    child.stdout?.on('data', append);
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish({ ok: false, output: err.message, enoent: code === 'ENOENT' });
    });
    child.on('close', (code) => {
      if (timedOut) return finish({ ok: false, output: 'Cloning timed out after 5 minutes' });
      finish({ ok: code === 0, output: output.trim() });
    });
  });
}

function shouldFallbackToGh(raw: string): boolean {
  return /authentication|could not read username|terminal prompts disabled|repository not found|access denied|permission denied|403|401/i.test(raw);
}

function friendlyCloneError(repo: string, raw: string, ssh: boolean): string {
  if (/timed out/i.test(raw)) return `Cloning ${repo} timed out. Try again or clone it manually in a terminal.`;
  if (/permission denied \(publickey\)|host key verification failed/i.test(raw)) {
    return `SSH authentication failed for ${repo}. Check your SSH key on the office's machine, or paste the HTTPS URL instead.`;
  }
  if (/authentication failed|could not read username|terminal prompts disabled|invalid username or token/i.test(raw)) {
    return `Couldn't authenticate with GitHub to clone ${repo}. Sign in with \`gh auth login\` or configure git credentials on the office's machine.`;
  }
  if (/repository not found|does not exist|could not resolve to a repository/i.test(raw)) {
    return ssh ? `Couldn't find ${repo} on GitHub. Check the URL and your SSH access to the repository.` : `Couldn't find ${repo} on GitHub. Check the URL and your GitHub access (sign in with \`gh auth login\` for private repositories).`;
  }
  if (/could not resolve host|unable to access|failed to connect|network is unreachable/i.test(raw)) {
    return `Couldn't reach GitHub to clone ${repo}. Check the office's network connection.`;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^cloning into /i.test(l));
  const detail = lines.slice(-2).join(' ');
  return detail ? `Couldn't clone ${repo}: ${detail}` : `Couldn't clone ${repo}`;
}
