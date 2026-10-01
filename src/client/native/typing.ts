/**
 * A keyboard paired to the headset, in the headset app: there is no workspace and no on-screen
 * keyboard, so its keys type into the world. They go to the terminal of the laptop you are at or
 * aiming at, where they show on that laptop's own screen, or onto a board agent's kiosk screen while
 * you are talking to it. No office shortcut ever sees them, so a key never opens anything.
 *
 * Which one, for each key:
 * 1. what either controller's ray is on: an occupied desk's laptop, or a kiosk;
 * 2. the kiosk whose agent you greeted, while you are still at it;
 * 3. the laptop you last typed into or used, while you are still near it;
 * 4. the nearest occupied desk in front of you, within reach.
 * The one that takes a key stays linked (its screen lights up) until you walk away from it.
 */

import type { KeyLike } from '../vr/physical-keys';

export type TypingTarget = { kind: 'laptop'; workerId: string } | { kind: 'kiosk'; deskId: string };

export interface TypingWorld {
  /** The laptop or kiosk under either controller's ray (in reach), if any. */
  aimed(): TypingTarget | null;
  /** The kiosk you are talking to, if you are still at it. */
  talking(): string | null;
  /** The laptop you are standing at: the nearest occupied desk ahead of you, within reach. */
  nearest(): TypingTarget | null;
  /** Whether a linked target still takes keys: the worker is still there, and you are still near it. */
  near(target: TypingTarget): boolean;
}

export interface TypingSink {
  /** Bytes for a worker's terminal (a physical keyboard's, already encoded). */
  terminal(workerId: string, bytes: string, key: KeyLike): void;
  /** A key at a kiosk: its screen keeps the draft until Enter sends it. */
  kiosk(deskId: string, bytes: string, key: KeyLike): void;
  /** The linked laptop or kiosk changed: its screen lights, the old one goes dark. */
  linked(next: TypingTarget | null, prev: TypingTarget | null): void;
}

export const sameTarget = (a: TypingTarget | null, b: TypingTarget | null): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && (a.kind === 'laptop' ? a.workerId === (b as { workerId: string }).workerId : a.deskId === (b as { deskId: string }).deskId));

export class NativeTyping {
  private link: TypingTarget | null = null;

  constructor(
    private readonly world: TypingWorld,
    private readonly sink: TypingSink,
  ) {}

  /** The laptop or kiosk that takes keys now (linked, lit). */
  get linked(): TypingTarget | null {
    return this.link;
  }

  /** Where the next key would go. */
  target(): TypingTarget | null {
    const aimed = this.world.aimed();
    if (aimed) return aimed;
    const kiosk = this.world.talking();
    if (kiosk) return { kind: 'kiosk', deskId: kiosk };
    if (this.link && this.world.near(this.link)) return this.link;
    return this.world.nearest();
  }

  /** A key from the paired keyboard. False when nothing in the world takes it (it is dropped). */
  key(bytes: string, key: KeyLike): boolean {
    const t = this.target();
    if (!t) return false;
    this.setLink(t);
    if (t.kind === 'laptop') this.sink.terminal(t.workerId, bytes, key);
    else this.sink.kiosk(t.deskId, bytes, key);
    return true;
  }

  /** Using a laptop (the trigger at its desk) links it, so the next key goes there. */
  use(target: TypingTarget) {
    this.setLink(target);
  }

  /** Each frame: walking away from the linked laptop, or its worker leaving, unlinks it. */
  update() {
    if (this.link && !this.world.near(this.link)) this.setLink(null);
  }

  /** Floor changes and resets: nothing stays linked. */
  clear() {
    this.setLink(null);
  }

  private setLink(next: TypingTarget | null) {
    if (sameTarget(next, this.link)) return;
    const prev = this.link;
    this.link = next;
    this.sink.linked(next, prev);
  }
}

/**
 * What a kiosk's screen shows while you type to its agent: the draft as typed, and what Enter
 * sends. Plain text only: Enter sends, Backspace deletes, Escape clears; other control keys and
 * cursor movement type nothing.
 */
export class KioskDraft {
  private text = '';

  constructor(private readonly max = 2000) {}

  get value(): string {
    return this.text;
  }

  /** One key. `send` gets the whole draft on Enter (and the draft empties); true when the draft changed or was sent. */
  key(key: KeyLike, send: (text: string) => void): boolean {
    if (key.metaKey) return false;
    if (key.key === 'Enter') {
      const text = this.text.trim();
      if (!text) return false;
      this.text = '';
      send(text);
      return true;
    }
    if (key.key === 'Backspace') {
      if (!this.text) return false;
      this.text = key.ctrlKey || key.altKey ? this.text.replace(/\S*\s*$/, '') : [...this.text].slice(0, -1).join('');
      return true;
    }
    if (key.key === 'Escape') {
      if (!this.text) return false;
      this.text = '';
      return true;
    }
    if ([...key.key].length !== 1 || (key.ctrlKey && !key.altGraph)) return false;
    if (this.text.length >= this.max) return false;
    this.text += key.key;
    return true;
  }

  clear() {
    this.text = '';
  }
}
