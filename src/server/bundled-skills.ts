import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BundledSkillEntry, BundledSkillsState } from '../shared/protocol.js';

/** Ownership marker placed right after SKILL.md YAML frontmatter so Droid Office never overwrites user-authored skills. */
export const BUNDLED_SKILL_MARK =
  '<!-- Managed by Droid Office (⚙️ Settings → Workers → Bundled skills). Edits here are overwritten on startup; turn Bundled skills off there to remove them, or keep your own copy in ~/.agents/skills/ to override. -->';

const MANAGED_MANIFEST = '.droid-office-managed.json';
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export interface BundledSkillFile {
  relPath: string;
  content: Buffer;
  executable: boolean;
}

export interface BundledSkillSpec {
  name: string;
  description: string;
  userInvocable: boolean;
  files: BundledSkillFile[];
}

interface ManagedManifest {
  version: 1;
  files: Record<string, string>;
}

/** Locate the bundled `skills/` folder shipped alongside `package.json`, whether running from `src/` or `dist/`. */
export function findBundledSkillsDir(url = import.meta.url): string | undefined {
  let dir = path.dirname(fileURLToPath(url));
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkg.name === 'droid-office') {
        const candidate = path.join(dir, 'skills');
        if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
        return undefined;
      }
    } catch {
      // walk up
    }
  }
  return undefined;
}

/** Parse the frontmatter fields Droid reads (`name`, `description`, `user-invocable`) from a SKILL.md document. */
export function parseSkillFrontmatter(markdown: string): { name: string; description: string; userInvocable: boolean; bodyOffset: number } | undefined {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) return undefined;
  let name = '';
  let description = '';
  let userInvocable = true;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = stripYamlQuotes(line.slice(colon + 1).trim());
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
    else if (key === 'user-invocable') userInvocable = value.toLowerCase() !== 'false';
  }
  if (!name || !description) return undefined;
  return { name, description, userInvocable, bodyOffset: match[0].length };
}

function stripYamlQuotes(value: string): string {
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/** Insert the Droid Office ownership marker immediately after YAML frontmatter so line 1 stays `---`. */
export function withManagedMark(markdown: string): string {
  if (markdown.includes(BUNDLED_SKILL_MARK)) return markdown;
  const parsed = parseSkillFrontmatter(markdown);
  if (!parsed) return `${BUNDLED_SKILL_MARK}\n\n${markdown}`;
  const head = markdown.slice(0, parsed.bodyOffset).replace(/\r?\n?$/, '\n');
  const rest = markdown.slice(parsed.bodyOffset).replace(/^\r?\n/, '');
  return `${head}${BUNDLED_SKILL_MARK}\n\n${rest}`;
}

function collectFiles(rootDir: string, relDir = ''): BundledSkillFile[] {
  const dir = relDir ? path.join(rootDir, relDir) : rootDir;
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const out: BundledSkillFile[] = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === MANAGED_MANIFEST) continue;
    const relPath = relDir ? path.posix.join(relDir, entry.name) : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(rootDir, relPath));
    } else if (entry.isFile()) {
      const st = statSync(full);
      const raw = readFileSync(full);
      const content = relPath === 'SKILL.md' ? Buffer.from(withManagedMark(raw.toString('utf8')), 'utf8') : raw;
      out.push({ relPath, content, executable: (st.mode & 0o111) !== 0 });
    }
  }
  return out;
}

/** Discover every bundled skill under `sourceDir` (each direct subdirectory containing a valid `SKILL.md`). */
export function discoverBundledSkills(sourceDir = findBundledSkillsDir()): BundledSkillSpec[] {
  if (!sourceDir || !existsSync(sourceDir)) return [];
  const specs: BundledSkillSpec[] = [];
  const seen = new Set<string>();
  for (const entry of readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(sourceDir, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const parsed = parseSkillFrontmatter(readFileSync(skillFile, 'utf8'));
    if (!parsed || !SKILL_NAME_RE.test(parsed.name) || seen.has(parsed.name)) continue;
    seen.add(parsed.name);
    specs.push({
      name: parsed.name,
      description: parsed.description,
      userInvocable: parsed.userInvocable,
      files: collectFiles(skillDir),
    });
  }
  specs.sort((a, b) => a.name.localeCompare(b.name));
  return specs;
}

/**
 * Sibling personal skill directories Droid also scans (`~/.agents/skills`, `~/.agent/skills`).
 * Derived from `skillsDir` when it ends with `.factory/skills` so tests using a temp HOME stay isolated.
 */
export function defaultCompatSkillDirs(skillsDir: string): string[] {
  if (path.basename(skillsDir) !== 'skills') return [];
  const factoryDir = path.dirname(skillsDir);
  if (path.basename(factoryDir) !== '.factory') return [];
  const home = path.dirname(factoryDir);
  return [path.join(home, '.agents', 'skills'), path.join(home, '.agent', 'skills')];
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readManifest(dir: string): ManagedManifest | undefined {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, MANAGED_MANIFEST), 'utf8')) as Partial<ManagedManifest>;
    if (raw.version === 1 && raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files)) {
      const files: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.files)) {
        if (typeof k === 'string' && typeof v === 'string' && isSafeRelPath(k)) files[k] = v;
      }
      return { version: 1, files };
    }
  } catch {
    // missing or malformed
  }
  return undefined;
}

function isSafeRelPath(relPath: string): boolean {
  if (!relPath || path.isAbsolute(relPath) || relPath.includes('\0') || relPath.includes('\\') || relPath.includes(':')) return false;
  const parts = relPath.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

function hasManagedSkillMark(skillFile: string): boolean {
  try {
    return readFileSync(skillFile, 'utf8').includes(BUNDLED_SKILL_MARK);
  } catch {
    return false;
  }
}

function pruneEmptyDirs(dir: string, stopAt: string) {
  let current = path.resolve(dir);
  const root = path.resolve(stopAt);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  while (current === root || current.startsWith(prefix)) {
    try {
      if (readdirSync(current).length > 0) break;
      rmdirSync(current);
    } catch {
      break;
    }
    if (current === root) break;
    current = path.dirname(current);
  }
}

/** Remove only files Droid Office previously wrote inside `targetDir`, leaving any user-authored files untouched. */
export function removeManagedSkill(targetDir: string): string | undefined {
  if (!existsSync(targetDir)) return undefined;
  const skillFile = path.join(targetDir, 'SKILL.md');
  const manifest = readManifest(targetDir);
  const hasSkillFile = existsSync(skillFile);
  const markedSkill = hasSkillFile && hasManagedSkillMark(skillFile);
  // If the user replaced SKILL.md with their own unmarked copy, leave the directory untouched.
  if (hasSkillFile && !markedSkill) return undefined;
  if (!manifest && !markedSkill) return undefined;
  try {
    const toRemove = new Set<string>(manifest ? Object.keys(manifest.files) : []);
    if (markedSkill) toRemove.add('SKILL.md');
    for (const rel of toRemove) {
      if (!isSafeRelPath(rel)) continue;
      const full = path.join(targetDir, ...rel.split('/'));
      if (rel !== 'SKILL.md' && manifest && existsSync(full)) {
        const expectedHash = manifest.files[rel];
        if (expectedHash && sha256(readFileSync(full)) !== expectedHash) continue;
      }
      rmSync(full, { force: true });
      pruneEmptyDirs(path.dirname(full), targetDir);
    }
    if (manifest) rmSync(path.join(targetDir, MANAGED_MANIFEST), { force: true });
    pruneEmptyDirs(targetDir, targetDir);
    return undefined;
  } catch (err) {
    return `Couldn't remove bundled skill at ${targetDir}: ${(err as Error).message}`;
  }
}

function writeFileIfChanged(full: string, content: Buffer, executable: boolean) {
  const mode = executable ? 0o755 : 0o644;
  let sameContent = false;
  let sameMode = false;
  try {
    const existing = readFileSync(full);
    sameContent = existing.equals(content);
    const st = statSync(full);
    sameMode = ((st.mode & 0o111) !== 0) === executable;
  } catch {
    // missing
  }
  if (sameContent && sameMode) return;
  mkdirSync(path.dirname(full), { recursive: true });
  if (!sameContent) writeFileSync(full, content, { mode });
  chmodSync(full, mode);
}

export interface SyncBundledSkillsOptions {
  skillsDir: string | undefined;
  sourceDir?: string;
  on: boolean;
  disabled: readonly string[];
  compatDirs?: readonly string[];
}

export interface SyncBundledSkillsResult {
  entries: BundledSkillEntry[];
  problems: string[];
}

/**
 * Sync the bundled skill pack into `skillsDir` (`~/.factory/skills/`):
 * - Respects user overrides in `~/.agents/skills/` and `~/.agent/skills/` (removing any stale managed copy so Droid never shadows them or reports duplicates).
 * - Never overwrites an unmarked user skill in `skillsDir/<name>/SKILL.md`.
 * - Preserves executable bits on supporting scripts such as `babysit-pr/scripts/pr-wait`.
 */
export function syncBundledSkills(options: SyncBundledSkillsOptions): SyncBundledSkillsResult {
  const specs = discoverBundledSkills(options.sourceDir);
  const disabledSet = new Set(options.disabled);
  const problems: string[] = [];
  const entries: BundledSkillEntry[] = [];
  const baseEntry = (spec: BundledSkillSpec, enabled: boolean) => ({
    name: spec.name,
    description: spec.description,
    userInvocable: spec.userInvocable,
    enabled,
  });

  if (!options.skillsDir) {
    for (const spec of specs) {
      const enabled = options.on && !disabledSet.has(spec.name);
      entries.push({ ...baseEntry(spec, enabled), status: enabled ? 'installed' : 'disabled' });
    }
    return { entries, problems };
  }

  const compatDirs = options.compatDirs ?? defaultCompatSkillDirs(options.skillsDir);

  for (const spec of specs) {
    const targetDir = path.join(options.skillsDir, spec.name);
    const skillFile = path.join(targetDir, 'SKILL.md');
    const enabled = options.on && !disabledSet.has(spec.name);

    const compatBase = compatDirs.find((d) => existsSync(path.join(d, spec.name, 'SKILL.md')));
    if (compatBase) {
      const compatOverride = path.join(compatBase, spec.name);
      const problem = removeManagedSkill(targetDir);
      if (problem) problems.push(problem);
      entries.push({ ...baseEntry(spec, enabled), status: 'overridden', overriddenBy: compatOverride });
      continue;
    }

    if (existsSync(skillFile) && !hasManagedSkillMark(skillFile)) {
      rmSync(path.join(targetDir, MANAGED_MANIFEST), { force: true });
      entries.push({ ...baseEntry(spec, enabled), status: 'overridden', overriddenBy: targetDir });
      continue;
    }

    if (!enabled) {
      const problem = removeManagedSkill(targetDir);
      if (problem) problems.push(problem);
      entries.push({
        ...baseEntry(spec, false),
        status: problem ? 'error' : 'disabled',
        ...(problem ? { error: problem } : {}),
      });
      continue;
    }

    try {
      const previous = readManifest(targetDir);
      const nextFiles: Record<string, string> = {};
      for (const file of spec.files) {
        const full = path.join(targetDir, ...file.relPath.split('/'));
        writeFileIfChanged(full, file.content, file.executable);
        nextFiles[file.relPath] = sha256(file.content);
      }
      if (previous) {
        for (const oldRel of Object.keys(previous.files)) {
          if (Object.hasOwn(nextFiles, oldRel) || !isSafeRelPath(oldRel)) continue;
          const oldFull = path.join(targetDir, ...oldRel.split('/'));
          rmSync(oldFull, { force: true });
          pruneEmptyDirs(path.dirname(oldFull), targetDir);
        }
      }
      const manifestBody = Buffer.from(`${JSON.stringify({ version: 1, files: nextFiles } satisfies ManagedManifest, null, 2)}\n`, 'utf8');
      writeFileIfChanged(path.join(targetDir, MANAGED_MANIFEST), manifestBody, false);
      entries.push({ ...baseEntry(spec, true), status: 'installed' });
    } catch (err) {
      const message = `Couldn't install bundled skill ${spec.name} into ${targetDir}: ${(err as Error).message}`;
      problems.push(message);
      entries.push({ ...baseEntry(spec, true), status: 'error', error: message });
    }
  }

  return { entries, problems };
}

interface SavedBundledSkills {
  on: boolean;
  disabled: string[];
  by?: string;
  at?: number;
}

/**
 * Office-wide bundled skills setting and sync controller (⚙️ Settings → Workers → Bundled skills),
 * persisted in `.droid-office/bundled-skills.json`. Enabled by default.
 */
export class BundledSkills {
  private saved: SavedBundledSkills;
  private path: string;
  private entries: BundledSkillEntry[] = [];

  constructor(
    dataDir: string,
    private skillsDir: string | undefined,
    private onState: (state: BundledSkillsState) => void,
    private opts: { sourceDir?: string; compatDirs?: readonly string[] } = {},
  ) {
    this.path = path.join(dataDir, 'bundled-skills.json');
    this.saved = this.restore();
    this.entries = syncBundledSkills({
      skillsDir: undefined,
      sourceDir: this.opts.sourceDir,
      on: this.saved.on,
      disabled: this.saved.disabled,
    }).entries;
  }

  get on(): boolean {
    return this.saved.on;
  }

  state(): BundledSkillsState {
    return {
      on: this.saved.on,
      disabled: [...this.saved.disabled],
      skills: this.entries.map((e) => ({ ...e })),
      ...(this.saved.by ? { by: this.saved.by, at: this.saved.at } : {}),
    };
  }

  /** Reconcile the bundled skills directory with the current setting; returns any filesystem warnings. */
  sync(): string[] {
    const result = syncBundledSkills({
      skillsDir: this.skillsDir,
      sourceDir: this.opts.sourceDir,
      on: this.saved.on,
      disabled: this.saved.disabled,
      compatDirs: this.opts.compatDirs,
    });
    this.entries = result.entries;
    return result.problems;
  }

  set(raw: { on?: unknown; disabled?: unknown }, by: string): string[] {
    const known = new Set(this.entries.map((e) => e.name));
    const on = typeof raw.on === 'boolean' ? raw.on : this.saved.on;
    const disabled = Array.isArray(raw.disabled) ? [...new Set(raw.disabled.filter((v): v is string => typeof v === 'string' && known.has(v)))].sort((a, b) => a.localeCompare(b)) : this.saved.disabled;
    this.saved = { on, disabled, by, at: Date.now() };
    this.persist();
    const problems = this.sync();
    this.onState(this.state());
    return problems;
  }

  private restore(): SavedBundledSkills {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SavedBundledSkills>;
      const on = typeof raw.on === 'boolean' ? raw.on : true;
      const disabled = Array.isArray(raw.disabled) ? [...new Set(raw.disabled.filter((v): v is string => typeof v === 'string' && !!v.trim()))].sort((a, b) => a.localeCompare(b)) : [];
      const state: SavedBundledSkills = { on, disabled };
      if (typeof raw.by === 'string') {
        state.by = raw.by;
        state.at = typeof raw.at === 'number' ? raw.at : 0;
      }
      return state;
    } catch {
      return { on: true, disabled: [] };
    }
  }

  private persist() {
    try {
      mkdirSync(path.dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
