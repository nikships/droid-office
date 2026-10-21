import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JUKEBOX_TUNES, STREAM, checkStreamUrl, trackTitle, tuneById, type JukeboxState } from '../shared/jukebox.js';

interface Saved {
  /** Distinguishes the app's state from an older Home floor using the same file. */
  scope?: 'office';
  on: boolean;
  track: string;
  url?: string;
  by?: string;
  /** When the track started, on this machine's clock. */
  startedAt: number;
}

/**
 * The office-wide jukebox, saved in the office's .droid-office/jukebox.json. It only says what's on and
 * since when; every browser plays it for itself, from the same point.
 */
export class Jukebox {
  private s: Saved = { on: false, track: JUKEBOX_TUNES[0].id, startedAt: Date.now() };
  private file: string;

  constructor(dataDir: string, legacyDirs: readonly string[] = []) {
    this.file = path.join(dataDir, 'jukebox.json');
    const current = this.read(this.file);
    const wasFloor = legacyDirs.some((dir) => path.resolve(dir) === path.resolve(dataDir));
    if (existsSync(this.file) && (!wasFloor || !current || current.scope === 'office')) {
      this.s = current ?? this.s;
      return;
    }
    // Keep the newest playing selection from the old per-floor jukeboxes, without restarting it.
    const saved = legacyDirs
      .map((dir) => this.read(path.join(dir, 'jukebox.json')))
      .filter((s): s is Saved => !!s)
      .sort((a, b) => Number(b.on) - Number(a.on) || b.startedAt - a.startedAt)[0];
    if (saved) {
      this.s = saved;
      this.save();
    }
  }

  state(): JukeboxState {
    const { on, track, url, by, startedAt } = this.s;
    return { on, track, ...(url && track === STREAM ? { url } : {}), ...(by ? { by } : {}), startedAt, elapsed: Math.max(0, Date.now() - startedAt) };
  }

  /** What's on, for toasts: “Rainy Window”, or where a stream comes from. */
  title(): string {
    return trackTitle(this.s);
  }

  /** Puts on a tune, a stream, or (with neither) whatever it had. Says whether anything changed, or why it can't. */
  play(input: { track?: unknown; url?: unknown }, by: string): { changed: boolean } | { error: string } {
    if (input.url !== undefined && input.url !== '') {
      const u = checkStreamUrl(input.url);
      if ('error' in u) return u;
      this.set({ on: true, track: STREAM, url: u.url, by });
    } else if (input.track !== undefined) {
      if (typeof input.track !== 'string' || !tuneById(input.track)) return { error: "The jukebox doesn't have that one" };
      this.set({ on: true, track: input.track, by });
    } else {
      if (this.s.on) return { changed: false };
      this.set({ ...this.s, on: true, by });
    }
    return { changed: true };
  }

  /** On to the next tune; from a stream, back to the first one. */
  skip(by: string) {
    const i = JUKEBOX_TUNES.findIndex((t) => t.id === this.s.track);
    this.set({ on: true, track: JUKEBOX_TUNES[(i + 1) % JUKEBOX_TUNES.length].id, by });
  }

  stop(by: string): boolean {
    if (!this.s.on) return false;
    this.s = { ...this.s, on: false, by };
    this.save();
    return true;
  }

  private set(s: Omit<Saved, 'startedAt'>) {
    this.s = { ...s, startedAt: Date.now() };
    this.save();
  }

  private read(file: string): Saved | undefined {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>;
      const url = s.track === STREAM ? checkStreamUrl(s.url) : undefined;
      if (s.track === STREAM ? !url || 'error' in url : typeof s.track !== 'string' || !tuneById(s.track)) return;
      return {
        ...(s.scope === 'office' ? { scope: 'office' } : {}),
        on: s.on === true,
        track: s.track!,
        ...(url && 'url' in url ? { url: url.url } : {}),
        ...(typeof s.by === 'string' ? { by: s.by.slice(0, 24) } : {}),
        startedAt: typeof s.startedAt === 'number' && Number.isFinite(s.startedAt) ? s.startedAt : Date.now(),
      };
    } catch {
      // a broken file just means a quiet lounge
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify({ ...this.s, scope: 'office' }, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
