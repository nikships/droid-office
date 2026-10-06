import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What the Mac app remembers between launches, in its own settings.json (not the office's state). */
export interface DesktopSettings {
  /** The folder the office keeps its data in. Unset until the first launch asks. */
  officeDir?: string;
  /** The port the app starts the office on. Default: 4600, like `droid-office`. */
  port?: number;
}

export const DEFAULT_PORT = 4600;

export function loadSettings(file: string): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const out: DesktopSettings = {};
    if (typeof raw.officeDir === 'string' && raw.officeDir) out.officeDir = raw.officeDir;
    if (Number.isInteger(raw.port) && (raw.port as number) > 0 && (raw.port as number) <= 65535) out.port = raw.port as number;
    return out;
  } catch {
    return {};
  }
}

export function saveSettings(file: string, settings: DesktopSettings) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** The office `droid-office` opens when started with no folder from outside one. */
export function defaultOfficeDir(home = os.homedir()): string {
  return path.join(home, 'droid-office');
}

/**
 * Whether the office in `dir` was started in it as a project (`droid-office <dir>`, or a checkout an
 * office first ran in): the CLI makes that folder a floor, so its floors.json lists it, or
 * local-floor.json remembers it was taken off the building. An office started with `--home dir`
 * never lists its own folder.
 */
export function startedInProject(dir: string): boolean {
  const data = path.join(dir, '.droid-office');
  if (existsSync(path.join(data, 'local-floor.json'))) return true;
  try {
    const floors = JSON.parse(readFileSync(path.join(data, 'floors.json'), 'utf8')) as unknown;
    const abs = path.resolve(dir);
    return Array.isArray(floors) && floors.some((f) => typeof f?.dir === 'string' && path.resolve(f.dir) === abs);
  } catch {
    return false;
  }
}

/**
 * The CLI arguments that open the office in `dir`, the same way on every launch: a project office
 * (see startedInProject) as `droid-office <dir>`, anything else as the office's home (`--home`).
 */
export function officeArgs(dir: string, port: number, home = os.homedir()): string[] {
  const asProject = path.resolve(dir) !== defaultOfficeDir(home) && startedInProject(dir);
  return [...(asProject ? [dir] : ['--home', dir]), '--port', String(port)];
}
