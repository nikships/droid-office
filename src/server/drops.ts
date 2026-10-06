import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPT_IMAGE_ID } from '../shared/drops.js';

/** The folder in drops/ for pictures waiting on a prompt: not a worker's, so pruning leaves it be. */
const STAGED = 'staged';

/** The name ending a picture dropped without one gets, so the agent can tell it's a picture. */
const PICTURE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/**
 * Files dropped or pasted into a worker's terminal from a browser (see shared/drops.ts), kept in
 * .droid-office/drops/<worker id>/ so the program there can open them by path. They go with the worker.
 */
export class DropStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'drops');
  }

  /** Keeps a file dropped into a worker's terminal; where it is now, or undefined if it couldn't be. */
  save(workerId: string, name: string, type: string, body: Buffer): string | undefined {
    const dir = this.folder(workerId);
    if (!dir) return undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${randomBytes(4).toString('hex')}-${dropName(name, type)}`);
      writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
      return file;
    } catch {
      return undefined;
    }
  }

  remove(workerId: string) {
    const dir = this.folder(workerId);
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }

  /** Deletes what was dropped for workers that are no longer at a desk. Pictures waiting for a prompt to be sent stay. */
  prune(keep: Set<string>) {
    try {
      for (const id of readdirSync(this.dir)) if (id !== STAGED && !keep.has(id)) this.remove(id);
    } catch {
      // no folder yet
    }
  }

  /**
   * Keeps a picture pasted into a prompt that hasn't been sent yet; its id, or undefined when it
   * isn't a picture or couldn't be kept. It waits in .droid-office/drops/staged/<id>/ until the prompt
   * is sent (see adopt) or the person takes it out again (see unstage).
   */
  stage(name: string, body: Buffer): string | undefined {
    const ext = pictureExt(body);
    if (!ext) return undefined;
    const id = randomBytes(8).toString('hex');
    const dir = path.join(this.dir, STAGED, id);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stem = dropName(name, '').replace(/\.[^.]*$/, '');
      writeFileSync(path.join(dir, `${stem}${ext}`), body, { mode: 0o600, flag: 'wx' });
      return id;
    } catch {
      return undefined;
    }
  }

  /** Throws away pictures that were never sent, or were taken out of the prompt. */
  unstage(ids: readonly string[]) {
    for (const id of ids) {
      if (!PROMPT_IMAGE_ID.test(id)) continue;
      try {
        rmSync(path.join(this.dir, STAGED, id), { recursive: true, force: true });
      } catch {
        // already gone
      }
    }
  }

  /**
   * Copies staged pictures to a worker's own drops (they stay staged: a prompt for several workers
   * adopts them once each), in the order given. Where each is now; one that's gone is left out.
   */
  adopt(workerId: string, ids: readonly string[]): string[] {
    const paths: string[] = [];
    for (const id of ids) {
      const file = this.staged(id);
      if (!file) continue;
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        continue;
      }
      const kept = this.save(workerId, path.basename(file), '', body);
      if (kept) paths.push(kept);
    }
    return paths;
  }

  private staged(id: string): string | undefined {
    if (!PROMPT_IMAGE_ID.test(id)) return undefined;
    const dir = path.join(this.dir, STAGED, id);
    try {
      const [name] = readdirSync(dir);
      return name ? path.join(dir, name) : undefined;
    } catch {
      return undefined;
    }
  }

  private folder(workerId: string): string | undefined {
    return /^[\w-]{1,64}$/.test(workerId) ? path.join(this.dir, workerId) : undefined;
  }
}

/** The name ending a picture should have, read from its first bytes rather than taken on the browser's word; undefined for anything else. */
export function pictureExt(body: Buffer): string | undefined {
  if (body.length > 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return '.jpg';
  if (body.length > 6 && (body.subarray(0, 6).toString('latin1') === 'GIF87a' || body.subarray(0, 6).toString('latin1') === 'GIF89a')) return '.gif';
  if (body.length > 12 && body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return undefined;
}

/**
 * A dropped file's name, safe to type into a terminal: its letters and digits kept, anything else a
 * dash, and a picture's name ending added when it came without one (a pasted screenshot can).
 */
export function dropName(name: string, type: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext =
    dot > 0
      ? base
          .slice(dot)
          .toLowerCase()
          .replace(/[^.a-z0-9]/g, '')
          .slice(0, 12)
      : '';
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${stem || 'file'}${ext.length > 1 ? ext : (PICTURE_EXT[type.split(';')[0].trim().toLowerCase()] ?? '')}`;
}
