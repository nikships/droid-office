import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JUKEBOX_TUNES, STREAM, checkStreamUrl, trackTitle, tuneById, type JukeboxState } from '../shared/jukebox.js';

interface Saved {
  on: boolean;
  track: string;
  url?: string;
  by?: string;
  shuffle?: boolean;
  /** When the track started, on this machine's clock. */
  startedAt: number;
}

/**
 * The lounge jukebox on one floor, saved in .droid-office/jukebox.json. It only says what's on and
 * since when; every browser plays it for itself, from the same point.
 */
export class Jukebox {
  private s: Saved = { on: false, track: JUKEBOX_TUNES[0].id, startedAt: Date.now() };
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'jukebox.json');
    this.load();
  }

  state(): JukeboxState {
    const { on, track, url, by, shuffle, startedAt } = this.s;
    return { on, track, ...(url && track === STREAM ? { url } : {}), ...(by ? { by } : {}), ...(shuffle ? { shuffle } : {}), startedAt, elapsed: Math.max(0, Date.now() - startedAt) };
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

  /** On to the next tune (from a stream, the first one), or with shuffle on, any other tune. */
  skip(by: string, random = Math.random) {
    const i = JUKEBOX_TUNES.findIndex((t) => t.id === this.s.track);
    const others = JUKEBOX_TUNES.filter((t) => t.id !== this.s.track);
    const next = this.s.shuffle ? others[Math.floor(random() * others.length) % others.length] : JUKEBOX_TUNES[(i + 1) % JUKEBOX_TUNES.length];
    this.set({ on: true, track: next.id, by });
  }

  /** Turns shuffle on or off. Says whether it changed. */
  setShuffle(on: boolean): boolean {
    if (!!this.s.shuffle === on) return false;
    this.s = { ...this.s, shuffle: on };
    this.save();
    return true;
  }

  stop(by: string): boolean {
    if (!this.s.on) return false;
    this.s = { ...this.s, on: false, by };
    this.save();
    return true;
  }

  private set(s: Omit<Saved, 'startedAt' | 'shuffle'>) {
    this.s = { ...s, ...(this.s.shuffle ? { shuffle: true } : {}), startedAt: Date.now() };
    this.save();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      const url = s.track === STREAM ? checkStreamUrl(s.url) : undefined;
      if (s.track === STREAM ? !url || 'error' in url : typeof s.track !== 'string' || !tuneById(s.track)) return;
      this.s = {
        on: s.on === true,
        track: s.track!,
        ...(url && 'url' in url ? { url: url.url } : {}),
        ...(typeof s.by === 'string' ? { by: s.by.slice(0, 24) } : {}),
        ...(s.shuffle === true ? { shuffle: true } : {}),
        startedAt: typeof s.startedAt === 'number' && Number.isFinite(s.startedAt) ? s.startedAt : Date.now(),
      };
    } catch {
      // a broken file just means a quiet lounge
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.s, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
