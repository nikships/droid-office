import { h } from './dom';

/** How far (px) the mouse has to go from the middle of the wheel before it points at an emote. */
const DEAD_ZONE = 26;
/** From the middle of the wheel to the middle of each emote, px. */
const RADIUS = 104;
/** Letting go of G sooner than this (ms) leaves the wheel open to click; holding it picks on release. */
const TAP_MS = 250;

/** One slice of the wheel: an emote, or a trick with the gun out. */
export interface WheelItem {
  emoji: string;
  label: string;
}

/** What the wheel offers when it opens: its name in the middle, and its slices, numbered 1, 2, 3… */
export interface WheelMenu {
  title: string;
  items: readonly WheelItem[];
}

/**
 * The emote wheel: hold G, point the mouse at an emote and let go (or click it). A quick tap on G
 * leaves it open until you pick one, press G or Esc, or click outside it. Each time it opens it
 * asks `menu` what to offer (the emotes, or the gun's tricks with it drawn).
 */
export class EmoteWheel {
  readonly el: HTMLElement;
  private ring: HTMLElement;
  private items: HTMLElement[] = [];
  private caption: HTMLElement;
  private shown: WheelMenu;
  /** The emote the mouse points at, or -1. */
  private at = -1;
  /** Mouse movement since the wheel opened, while the mouse is captured (there's no cursor then). */
  private aim = { x: 0, y: 0 };
  /** When G went down to open it; 0 once it stays open on its own. */
  private heldAt = 0;
  isOpen = false;

  constructor(
    /** Picked slice `i` (0 is the one at the top, number 1). */
    private onPick: (i: number) => void,
    /** The wheel opened or closed: while it's open, the mouse is for picking, not for looking around. */
    private onToggle: (open: boolean) => void,
    private menu: () => WheelMenu,
  ) {
    this.caption = h('div.middle');
    this.ring = h('div.ring', {}, this.caption);
    this.el = h('div.emote-wheel.hidden', { role: 'menu', 'aria-label': 'Emotes' }, this.ring);
    this.shown = menu();
    this.build();
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const i = this.items.findIndex((b) => b.contains(e.target as Node));
      this.pick(i >= 0 ? i : this.at);
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.isOpen) return;
      if (document.pointerLockElement) {
        // Kept within the ring, so turning back toward another emote answers straight away.
        this.aim.x += e.movementX;
        this.aim.y += e.movementY;
        const d = Math.hypot(this.aim.x, this.aim.y);
        if (d > RADIUS) {
          this.aim.x *= RADIUS / d;
          this.aim.y *= RADIUS / d;
        }
        this.aimAt(this.aim.x, this.aim.y);
      } else if (!this.items.some((b) => b.contains(e.target as Node))) {
        this.aimAt(e.clientX - window.innerWidth / 2, e.clientY - window.innerHeight / 2);
      }
    });
    window.addEventListener('blur', () => this.close());
    this.render();
  }

  /** G went down. */
  press() {
    if (this.isOpen) return this.close();
    const menu = this.menu();
    if (menu.items !== this.shown.items) {
      this.shown = menu;
      this.build();
    }
    this.isOpen = true;
    this.heldAt = performance.now();
    this.aim = { x: 0, y: 0 };
    this.at = -1;
    this.el.classList.remove('hidden');
    this.render();
    this.onToggle(true);
  }

  /** G came back up: pick what it points at, or stay open after a quick tap. */
  release() {
    if (!this.isOpen || !this.heldAt) return;
    if (this.at >= 0) this.pick(this.at);
    else if (performance.now() - this.heldAt < TAP_MS) {
      this.heldAt = 0;
      this.render();
    } else this.close();
  }

  /** A click with the mouse captured (first person): there's no cursor, so it picks what the wheel points at. */
  click() {
    this.pick(this.at);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.heldAt = 0;
    this.el.classList.add('hidden');
    this.onToggle(false);
  }

  /** The slices for the menu shown, clockwise from the top. */
  private build() {
    for (const b of this.items) b.remove();
    const all = this.shown.items;
    const slice = (Math.PI * 2) / all.length;
    this.items = all.map((e, i) => {
      const a = i * slice - Math.PI / 2;
      return h(
        'button.emote',
        { type: 'button', title: `${e.label} (${i + 1})`, 'aria-label': e.label, style: `--x:${Math.cos(a) * RADIUS}px;--y:${Math.sin(a) * RADIUS}px`, onpointermove: () => this.point(i) },
        e.emoji,
        h('span.num', {}, i + 1),
      );
    });
    this.ring.prepend(...this.items);
    this.el.setAttribute('aria-label', `${this.shown.title}s`);
  }

  /** Plays slice `i` (-1 picks nothing) and closes the wheel. */
  private pick(i: number) {
    this.close();
    if (this.shown.items[i]) this.onPick(i);
  }

  private aimAt(x: number, y: number) {
    if (Math.hypot(x, y) < DEAD_ZONE) return this.point(-1);
    const n = this.shown.items.length;
    const a = Math.atan2(y, x) + Math.PI / 2;
    this.point(((Math.round(a / ((Math.PI * 2) / n)) % n) + n) % n);
  }

  private point(i: number) {
    if (i === this.at) return;
    this.at = i;
    this.render();
  }

  private render() {
    this.items.forEach((b, i) => b.classList.toggle('on', i === this.at));
    const e = this.shown.items[this.at];
    const n = this.shown.items.length;
    const how = !e ? `Point at one, or 1–${n}` : this.heldAt ? 'Let go of G' : 'Click';
    this.caption.replaceChildren(h('b', {}, e?.label ?? this.shown.title), h('small', {}, how));
  }
}
