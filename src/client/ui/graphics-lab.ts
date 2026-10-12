import { applyPreset, controlLive, formatRange, REMASTER_DEFAULTS, REMASTER_PRESETS, REMASTER_SECTIONS, type RangeControl, type RemasterControl, type RemasterSettings, type SelectControl, snapRange } from '../remaster-settings';
import { h } from './dom';

/** What the corner readout knows, handed over twice a second while the lab is open. */
export interface LabStats {
  fps: number;
  frameMs: number;
  fpsCap: number;
  gpuMs: number | null;
  system: number | null;
  render: { width: number; height: number };
  output: { width: number; height: number };
  calls: number;
  triangles: number;
  textures: number;
  programs: number;
  hdr: string;
  gi: string;
}

export interface LabHost {
  settings(): RemasterSettings;
  /** Applies and saves. Called on every slider step, so it must be cheap. */
  change(s: RemasterSettings): void;
  rebakeGI(): void;
  /** The classic Settings → Graphics pane (resolution, shadows mode, frame rate limit). */
  classicSettings(): void;
  /** The mouse back from the game, so the panel can be used. Nothing else about the game changes. */
  freeMouse(): void;
  /** The keyboard back to the game once a control has been let go of. */
  backToGame(): void;
  hdrNote(): string;
}

/**
 * The Graphics Lab: every Remastered setting, live, in a see-through panel docked on the right. It is not a window
 * (no openModal): the game keeps running, keeps the keyboard, keeps its frame rate and pace, and nothing behind the
 * panel is dimmed or blurred (no backdrop-filter, which would cost the GPU). Opening it only frees the mouse.
 */
export class GraphicsLab {
  readonly el: HTMLElement;
  private readonly rows = new Map<string, { paint: (s: RemasterSettings) => void }>();
  private readonly presetBtns = new Map<string, HTMLButtonElement>();
  private readonly statEls = new Map<keyof LabStats | 'res', HTMLElement>();
  private readonly hdrNoteEl = h('p.glab-note.glab-live');
  private readonly giNoteEl = h('span.glab-meta');
  private readonly presetNote = h('span.glab-meta');
  private open = false;

  constructor(private readonly host: LabHost) {
    const close = h('button.btn.sm.ghost.icon', { type: 'button', 'aria-label': 'Close the Graphics Lab', title: 'Close (`)' }, '✕');
    close.addEventListener('click', () => this.hide());
    const head = h('header.glab-head', {}, h('div.glab-titles', {}, h('h2', {}, 'Graphics Lab'), h('p.glab-sub', {}, 'Remastered renderer · changes apply live')), h('span.key', { title: 'Toggle the Graphics Lab' }, '`'), close);

    const stat = (key: keyof LabStats | 'res', label: string) => {
      const v = h('b', {}, '–');
      this.statEls.set(key, v);
      return h('div.glab-stat', {}, h('span', {}, label), v);
    };
    const stats = h('div.glab-stats', {}, stat('fps', 'FPS'), stat('frameMs', 'Frame'), stat('gpuMs', 'GPU'), stat('system', 'Mac GPU'), stat('res', 'Render'), stat('calls', 'Draws'), stat('triangles', 'Tris'), stat('programs', 'Shaders'));

    const presets = h('div.seg.glab-presets', { role: 'radiogroup', 'aria-label': 'Preset' });
    for (const p of REMASTER_PRESETS) {
      const b = h('button.btn.sm', { type: 'button', role: 'radio', title: p.hint }, p.label);
      b.addEventListener('click', () => {
        this.commit(applyPreset(p.id, this.host.settings()));
        this.host.backToGame();
      });
      this.presetBtns.set(p.id, b);
      presets.append(b);
    }

    const body = h('div.glab-body');
    for (const section of REMASTER_SECTIONS) {
      const sec = h('details.glab-sec', { open: true }, h('summary', {}, h('span.glab-icon', { 'aria-hidden': 'true' }, section.icon), section.title));
      if (section.note) sec.append(h('p.glab-note', {}, section.note));
      if (section.id === 'hdr') sec.append(this.hdrNoteEl);
      for (const c of section.controls) sec.append(this.control(c));
      if (section.id === 'gi') {
        const rebake = h('button.btn.sm', { type: 'button' }, 'Rebake now');
        rebake.addEventListener('click', () => {
          this.host.rebakeGI();
          this.host.backToGame();
        });
        sec.append(h('div.glab-row.glab-actions', {}, this.giNoteEl, rebake));
      }
      body.append(sec);
    }

    const reset = h('button.btn.sm.ghost', { type: 'button', title: 'Back to the Nik preset' }, 'Reset');
    reset.addEventListener('click', () => {
      this.commit(applyPreset('nik', this.host.settings()));
      this.host.backToGame();
    });
    const classic = h('button.btn.sm', { type: 'button', title: 'Frame rate limit, shadow updates and the performance overlay' }, 'Classic settings…');
    classic.addEventListener('click', () => this.host.classicSettings());
    const foot = h('footer.glab-foot', {}, this.presetNote, h('span.grow'), reset, classic);

    this.el = h('aside.glab.hidden', { id: 'graphics-lab', 'aria-label': 'Graphics Lab' }, head, stats, h('div.glab-presetrow', {}, presets), body, foot);
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.hide();
    });
    this.paint();
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  show() {
    this.open = true;
    this.el.classList.remove('hidden');
    this.paint();
    this.host.freeMouse();
  }

  hide() {
    this.open = false;
    this.el.classList.add('hidden');
    this.host.backToGame();
  }

  /** Repaints every control from the settings (after a preset, or a change from elsewhere). */
  paint() {
    const s = this.host.settings();
    for (const { paint } of this.rows.values()) paint(s);
    for (const [id, b] of this.presetBtns) {
      const on = s.enabled ? s.preset === id : id === 'classic';
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.presetNote.textContent = !s.enabled ? 'Classic renderer' : s.preset === 'custom' ? 'Custom' : (REMASTER_PRESETS.find((p) => p.id === s.preset)?.label ?? '');
    this.hdrNoteEl.textContent = this.host.hdrNote();
  }

  /** The live numbers. Only touches the DOM while the panel is open. */
  stats(st: LabStats) {
    if (!this.open) return;
    const set = (k: keyof LabStats | 'res', text: string) => {
      const el = this.statEls.get(k);
      if (el && el.textContent !== text) el.textContent = text;
    };
    set('fps', `${Math.round(st.fps)} / ${st.fpsCap}`);
    set('frameMs', `${st.frameMs.toFixed(1)} ms`);
    set('gpuMs', st.gpuMs === null ? 'n/a' : `${st.gpuMs.toFixed(2)} ms`);
    set('system', st.system === null ? 'n/a' : `${Math.round(st.system)}%`);
    const up = st.render.width !== st.output.width;
    set('res', `${st.render.width}×${st.render.height}${up ? ` → ${st.output.width}×${st.output.height}` : ''}`);
    set('calls', String(st.calls));
    set('triangles', st.triangles >= 1e6 ? `${(st.triangles / 1e6).toFixed(2)} M` : `${Math.round(st.triangles / 1000)} k`);
    set('programs', String(st.programs));
    if (this.giNoteEl.textContent !== st.gi) this.giNoteEl.textContent = st.gi;
    const hdr = this.host.hdrNote();
    if (this.hdrNoteEl.textContent !== hdr) this.hdrNoteEl.textContent = hdr;
  }

  private commit(s: RemasterSettings) {
    this.host.change(s);
    this.paint();
  }

  /** One setting changed by hand: the preset becomes Custom. */
  private set(key: RemasterControl['key'], value: unknown) {
    const cur = this.host.settings();
    const next = { ...cur, [key]: value } as RemasterSettings;
    if (key !== 'debug' && key !== 'pace' && key !== 'enabled') next.preset = 'custom';
    this.commit(next);
  }

  private control(c: RemasterControl): HTMLElement {
    const label = h('div.glab-label', {}, h('b', {}, c.label), h('small', {}, c.hint));
    let input: HTMLElement;
    let paint: (s: RemasterSettings) => void;
    if (c.kind === 'toggle') {
      const box = h('input', { type: 'checkbox', 'aria-label': c.label });
      box.addEventListener('change', () => {
        this.set(c.key, box.checked);
        box.blur();
        this.host.backToGame();
      });
      input = h('label.toggle.glab-toggle', {}, box, h('span.track', { 'aria-hidden': 'true' }));
      paint = (s) => {
        box.checked = !!s[c.key];
      };
    } else if (c.kind === 'range') {
      ({ input, paint } = this.range(c));
    } else {
      ({ input, paint } = this.select(c));
    }
    const row = h('div.glab-row', { 'data-key': c.key }, label, input);
    const paintRow = (s: RemasterSettings) => {
      paint(s);
      row.classList.toggle('off', !controlLive(c, s));
    };
    this.rows.set(c.key, { paint: paintRow });
    return row;
  }

  private range(c: RangeControl) {
    const slider = h('input', { type: 'range', min: c.min, max: c.max, step: c.step, 'aria-label': c.label });
    const value = h('span.glab-value');
    const fill = (v: number) => slider.style.setProperty('--fill', `${((v - c.min) / (c.max - c.min)) * 100}%`);
    slider.addEventListener('input', () => {
      const v = snapRange(c, Number(slider.value));
      value.textContent = formatRange(c, v);
      fill(v);
      this.set(c.key, v);
    });
    // Let go of: the keyboard goes back to walking about.
    slider.addEventListener('change', () => {
      slider.blur();
      this.host.backToGame();
    });
    // A double click puts it back at the Nik preset's value.
    slider.addEventListener('dblclick', () => this.set(c.key, REMASTER_DEFAULTS[c.key]));
    return {
      input: h('div.glab-range', {}, slider, value),
      paint: (s: RemasterSettings) => {
        const v = s[c.key] as number;
        slider.value = String(v);
        value.textContent = formatRange(c, v);
        fill(v);
      },
    };
  }

  private select(c: SelectControl) {
    const sel = h('select.select.glab-select', { 'aria-label': c.label }, ...c.options.map(([v, text]) => h('option', { value: v }, text)));
    sel.addEventListener('change', () => {
      this.set(c.key, sel.value);
      sel.blur();
      this.host.backToGame();
    });
    return {
      input: sel,
      paint: (s: RemasterSettings) => {
        sel.value = String(s[c.key]);
      },
    };
  }
}
