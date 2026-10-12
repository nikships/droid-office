import { FPS_CAPS, type FpsCap } from '../graphics';
import {
  ADVANCED_SETTINGS,
  type AutoPick,
  applyQuality,
  autoQuality,
  type ChoiceOption,
  type ChoiceSetting,
  choiceLive,
  choiceValue,
  DISPLAY_SETTINGS,
  type Impact,
  LEVEL_LABELS,
  LEVELS,
  type Level,
  PICTURE_SETTINGS,
  QUALITY_HINTS,
  QUALITY_SETTINGS,
  qualityOf,
  type RemasterSettings,
  RESOLUTION_MAX,
  RESOLUTION_MIN,
  RESOLUTION_STEP,
  resetRemaster,
  type SystemProfile,
  snapResolution,
  withChoice,
} from '../remaster-settings';
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
  /** Applies and saves. Called on every resolution step, so it must be cheap. */
  change(s: RemasterSettings): void;
  rebakeGI(): void;
  /** The classic Settings → Graphics pane (the Classic renderer's resolution and the overlay). */
  classicSettings(): void;
  /** The mouse back from the game, so the panel can be used. Nothing else about the game changes. */
  freeMouse(): void;
  /** The keyboard back to the game once a control has been let go of. */
  backToGame(): void;
  hdrNote(): string;
  /** The scene's render size at a resolution scale. */
  renderSize(resolution: number): { width: number; height: number };
  fpsCap(): FpsCap;
  setFpsCap(cap: FpsCap): void;
  /** What Auto knows about this machine. */
  profile(): SystemProfile;
}

/** What the description panel says about the row under the pointer. */
interface Info {
  title: string;
  value: string;
  text: string;
  detail: string;
  impact: Impact;
}

/** What a stepper row needs of a setting: the frame rate limit isn't a Remastered setting, but steps the same way. */
type Choices = Pick<ChoiceSetting, 'label' | 'hint' | 'impact' | 'options'>;

interface Row {
  paint(s: RemasterSettings): void;
  info(s: RemasterSettings): Info;
}

const IMPACT_LABEL: Record<Impact, string> = { none: 'No GPU cost', low: 'Low GPU cost', medium: 'Medium GPU cost', high: 'High GPU cost' };
const IMPACT_BARS: Record<Impact, number> = { none: 0, low: 1, medium: 2, high: 3 };
const FPS_OPTIONS: readonly ChoiceOption[] = FPS_CAPS.map((fps) => ({
  value: String(fps),
  label: `${fps} FPS`,
  detail: fps === 120 ? 'Every refresh of a 120 Hz display.' : `Every ${120 / fps === 2 ? 'second' : 'third'} refresh of a 120 Hz display.`,
}));
const formatResolution = (v: number) => `${v.toFixed(1)}×`;

/**
 * The Graphics Lab: the Remastered renderer's settings laid out like a game's graphics menu, live, in a see-through
 * panel docked on the right. An overall quality from Low to Ultra (or Auto, which picks one for this machine) sets
 * every quality setting; changing one by hand makes it Custom. Picture, display and resolution are yours and stay as
 * they are. It is not a window (no openModal): the game keeps running, keeps the keyboard, keeps its frame rate and
 * pace, and nothing behind the panel is dimmed or blurred (no backdrop-filter, which would cost the GPU). Opening it
 * only frees the mouse.
 */
export class GraphicsLab {
  readonly el: HTMLElement;
  private readonly rows: Row[] = [];
  private readonly presetBtns = new Map<Level, HTMLButtonElement>();
  private readonly statEls = new Map<keyof LabStats | 'res', HTMLElement>();
  private readonly hdrNoteEl = h('p.glab-note.glab-live');
  private readonly giNoteEl = h('span.glab-meta');
  private readonly qualityNote = h('p.glab-note.glab-qnote');
  private readonly customPill = h('span.pill.glab-custom', {}, 'Custom');
  private readonly classicNote = h('p.note.info.glab-classic', {}, 'The Classic renderer is on. Pick a quality, or Auto, to switch to Remastered.');
  private readonly statusEl = h('span.glab-meta');
  private readonly resMeta = h('small');
  private readonly info = {
    el: h('div.glab-info', { 'aria-live': 'polite' }),
    title: h('b'),
    value: h('span.glab-info-value'),
    text: h('p'),
    detail: h('p.glab-info-detail'),
    impact: h('span.glab-impact'),
    bars: h('span.glab-bars', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
  };
  /** The row whose description is showing; none shows the overall quality's. */
  private hovered: Row | null = null;
  private auto: AutoPick | null = null;
  private open = false;

  constructor(private readonly host: LabHost) {
    const close = h('button.btn.sm.ghost.icon', { type: 'button', 'aria-label': 'Close the Graphics Lab', title: 'Close (`)' }, '✕');
    close.addEventListener('click', () => this.hide());
    const head = h('header.glab-head', {}, h('div.glab-titles', {}, h('h2', {}, 'Graphics'), h('p.glab-sub', {}, 'Remastered renderer · changes apply live')), h('span.key', { title: 'Toggle the Graphics Lab' }, '`'), close);

    const stat = (key: keyof LabStats | 'res', label: string) => {
      const v = h('b', {}, '–');
      this.statEls.set(key, v);
      return h('div.glab-stat', {}, h('span', {}, label), v);
    };
    const stats = h('div.glab-stats', {}, stat('fps', 'FPS'), stat('frameMs', 'Frame'), stat('gpuMs', 'GPU'), stat('system', 'Mac GPU'), stat('res', 'Render'), stat('calls', 'Draws'), stat('triangles', 'Tris'), stat('programs', 'Shaders'));

    const autoBtn = h('button.btn.sm.accent', { type: 'button', title: 'Pick the quality and resolution for this machine' }, 'Auto');
    autoBtn.addEventListener('click', () => {
      this.detect();
      this.host.backToGame();
    });
    autoBtn.addEventListener('mouseenter', () =>
      this.showInfo({
        title: 'Auto',
        value: '',
        text: 'Picks the overall quality, and the resolution if it has to, from your GPU, the pixels on your screen and your frame rate limit.',
        detail: 'Picture and display settings stay as they are.',
        impact: 'none',
      }),
    );
    autoBtn.addEventListener('mouseleave', () => this.showInfo());
    const presets = h('div.seg.glab-presets', { role: 'radiogroup', 'aria-label': 'Overall quality' });
    for (const lv of LEVELS) {
      const b = h('button.btn.sm', { type: 'button', role: 'radio' }, LEVEL_LABELS[lv]);
      b.addEventListener('click', () => {
        this.commit(applyQuality(lv, this.host.settings()));
        this.host.backToGame();
      });
      b.addEventListener('mouseenter', () =>
        this.showInfo({ title: 'Overall quality', value: LEVEL_LABELS[lv], text: QUALITY_HINTS[lv], detail: 'Sets every quality setting at once. Picture, display and resolution stay as they are.', impact: 'none' }),
      );
      b.addEventListener('mouseleave', () => this.showInfo());
      this.presetBtns.set(lv, b);
      presets.append(b);
    }
    const quality = h('div.glab-quality', {}, h('div.glab-qhead', {}, h('span.glab-eyebrow', {}, 'Overall quality'), this.customPill, h('span.grow'), autoBtn), presets, this.qualityNote);

    const body = h('div.glab-body', {}, this.classicNote);
    const fpsRow = this.choiceRow(
      { label: 'Frame rate limit', hint: 'The most frames a second the office draws while something moves. 40, 60 and 120 each fit a 120 Hz display evenly. A lower limit costs the GPU less.', impact: 'medium', options: FPS_OPTIONS },
      () => String(this.host.fpsCap()),
      (v) => {
        this.host.setFpsCap(Number(v) as FpsCap);
        this.paint();
      },
      () => true,
    );
    const [renderer, ...hdr] = DISPLAY_SETTINGS.map((c) => this.settingRow(c));
    body.append(
      this.section('Display', '🖥️', true, renderer, this.resolutionRow(), fpsRow, ...hdr, this.hdrNoteEl),
      this.section('Quality', '✨', true, ...QUALITY_SETTINGS.map((c) => this.settingRow(c))),
      this.section('Picture', '🎨', true, ...PICTURE_SETTINGS.map((c) => this.settingRow(c))),
      this.section('Advanced', '🧪', false, ...ADVANCED_SETTINGS.map((c) => this.settingRow(c)), this.rebakeRow()),
    );
    body.addEventListener('mouseleave', () => {
      this.hovered = null;
      this.showInfo();
    });

    const { el: infoEl, title, value, text, detail, impact, bars } = this.info;
    infoEl.append(h('div.glab-info-head', {}, title, value), text, detail, h('div.glab-info-cost', {}, bars, impact));

    const reset = h('button.btn.sm.ghost', { type: 'button', title: 'Every setting back to its default: High, 1.0×' }, 'Reset');
    reset.addEventListener('click', () => {
      this.auto = null;
      this.commit(resetRemaster(this.host.settings()));
      this.host.backToGame();
    });
    const classic = h('button.btn.sm', { type: 'button', title: 'The Classic renderer’s resolution and the performance overlay' }, 'Classic settings…');
    classic.addEventListener('click', () => this.host.classicSettings());
    const foot = h('footer.glab-foot', {}, this.statusEl, h('span.grow'), reset, classic);

    this.el = h('aside.glab.hidden', { id: 'graphics-lab', 'aria-label': 'Graphics Lab' }, head, stats, quality, body, infoEl, foot);
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
    const q = qualityOf(s);
    for (const row of this.rows) row.paint(s);
    for (const [lv, b] of this.presetBtns) {
      const on = s.enabled && q === lv;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.customPill.classList.toggle('hidden', !s.enabled || q !== 'custom');
    this.classicNote.classList.toggle('hidden', s.enabled);
    const auto = this.auto && s.enabled && q === this.auto.quality && s.resolution === this.auto.resolution ? this.auto : null;
    if (!auto) this.auto = null;
    this.qualityNote.textContent = !s.enabled ? '' : auto ? this.autoNote(auto) : q === 'custom' ? 'Your own mix of quality settings.' : QUALITY_HINTS[q];
    this.statusEl.textContent = !s.enabled ? 'Classic renderer' : q === 'custom' ? 'Custom' : LEVEL_LABELS[q];
    this.hdrNoteEl.textContent = this.host.hdrNote();
    this.showInfo();
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
    set('res', `${st.render.width}×${st.render.height}`);
    set('calls', String(st.calls));
    set('triangles', st.triangles >= 1e6 ? `${(st.triangles / 1e6).toFixed(2)} M` : `${Math.round(st.triangles / 1000)} k`);
    set('programs', String(st.programs));
    if (this.giNoteEl.textContent !== st.gi) this.giNoteEl.textContent = st.gi;
    const hdr = this.host.hdrNote();
    if (this.hdrNoteEl.textContent !== hdr) this.hdrNoteEl.textContent = hdr;
    this.paintResolutionMeta(this.host.settings().resolution);
  }

  /** Auto: the quality and resolution for this machine. */
  detect() {
    const pick = autoQuality(this.host.profile());
    this.auto = pick;
    this.commit({ ...applyQuality(pick.quality, this.host.settings()), resolution: pick.resolution });
  }

  private autoNote(pick: AutoPick): string {
    const { pixels, fpsCap } = this.host.profile();
    const out = this.host.renderSize(1);
    const res = pick.resolution < 1 ? ` at ${formatResolution(pick.resolution)} resolution` : '';
    return `Auto: ${LEVEL_LABELS[pick.quality]}${res} for ${pick.gpu.name}, ${out.width}×${out.height} (${(pixels / 1e6).toFixed(1)} MP) at ${fpsCap} FPS.`;
  }

  private commit(s: RemasterSettings) {
    this.host.change(s);
    this.paint();
  }

  /** The description panel: the row under the pointer, or else the overall quality. */
  private showInfo(info?: Info) {
    const s = this.host.settings();
    const q = qualityOf(s);
    const shown: Info = info ??
      this.hovered?.info(s) ?? {
        title: 'Overall quality',
        value: !s.enabled ? 'Classic' : q === 'custom' ? 'Custom' : LEVEL_LABELS[q],
        text: !s.enabled ? 'The Classic renderer draws the office as it always has.' : q === 'custom' ? 'Your own mix of quality settings. Pick a quality to go back to a preset.' : QUALITY_HINTS[q],
        detail: 'Point at a setting to see what it does.',
        impact: 'none',
      };
    const { title, value, text, detail, impact, bars } = this.info;
    title.textContent = shown.title;
    value.textContent = shown.value;
    text.textContent = shown.text;
    detail.textContent = shown.detail;
    impact.textContent = IMPACT_LABEL[shown.impact];
    bars.querySelectorAll('i').forEach((b, i) => {
      b.classList.toggle('on', i < IMPACT_BARS[shown.impact]);
    });
  }

  private section(title: string, icon: string, open: boolean, ...children: HTMLElement[]): HTMLElement {
    return h('details.glab-sec', { open }, h('summary', {}, h('span.glab-icon', { 'aria-hidden': 'true' }, icon), title), ...children);
  }

  /** One row: a label on the left and its control on the right, described in the panel while the pointer is over it. */
  private row(label: HTMLElement, control: HTMLElement, paint: (s: RemasterSettings) => void, info: (s: RemasterSettings) => Info, live: (s: RemasterSettings) => boolean): HTMLElement {
    const el = h('div.glab-row', {}, label, control);
    const row: Row = {
      paint: (s) => {
        paint(s);
        const on = live(s);
        el.classList.toggle('off', !on);
        // An arrow at the end of its list stays disabled too.
        for (const b of control.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) b.disabled = !on || b.dataset.end === 'true';
      },
      info,
    };
    el.addEventListener('mouseenter', () => {
      this.hovered = row;
      this.showInfo();
    });
    this.rows.push(row);
    return el;
  }

  /** A setting from remaster-settings. Everything but the renderer switch waits for Remastered. */
  private settingRow(c: ChoiceSetting): HTMLElement {
    return this.choiceRow(
      c,
      () => choiceValue(this.host.settings(), c.key),
      (v) => this.commit(withChoice(this.host.settings(), c.key, v)),
      (s) => c.key === 'enabled' || (s.enabled && choiceLive(c, s)),
    );
  }

  /** A row with a ‹ value › stepper over a list of choices: the arrows step, a click on the value goes to the next one. */
  private choiceRow(c: Choices, get: () => string, pick: (v: string) => void, live: (s: RemasterSettings) => boolean): HTMLElement {
    const opts = c.options;
    const prev = h('button.btn.sm.ghost.icon.glab-arrow', { type: 'button', 'aria-label': `Lower ${c.label}` }, '‹');
    const next = h('button.btn.sm.ghost.icon.glab-arrow', { type: 'button', 'aria-label': `Higher ${c.label}` }, '›');
    const text = h('span.glab-val-text');
    const pips = h('span.glab-pips', { 'aria-hidden': 'true' }, ...opts.map(() => h('i')));
    const val = h('button.glab-val', { type: 'button', 'aria-label': c.label }, text, pips);
    const index = () =>
      Math.max(
        0,
        opts.findIndex((o) => o.value === get()),
      );
    const go = (i: number) => {
      const o = opts[(i + opts.length) % opts.length];
      if (o.value !== get()) pick(o.value);
      this.host.backToGame();
    };
    prev.addEventListener('click', () => go(index() - 1));
    next.addEventListener('click', () => go(index() + 1));
    val.addEventListener('click', () => go(index() + 1));
    const step = h('div.glab-step', { role: 'group', 'aria-label': c.label }, prev, val, next);
    return this.row(
      h('div.glab-label', {}, h('b', {}, c.label)),
      step,
      () => {
        const i = index();
        text.textContent = opts[i].label;
        val.title = opts[i].detail;
        prev.dataset.end = String(i === 0);
        next.dataset.end = String(i === opts.length - 1);
        pips.querySelectorAll('i').forEach((p, n) => {
          p.classList.toggle('on', n <= i);
        });
      },
      () => {
        const o = opts[index()];
        return { title: c.label, value: o.label, text: c.hint, detail: o.detail, impact: c.impact };
      },
      live,
    );
  }

  private resolutionRow(): HTMLElement {
    const slider = h('input', { type: 'range', min: RESOLUTION_MIN, max: RESOLUTION_MAX, step: RESOLUTION_STEP, 'aria-label': 'Resolution' });
    const value = h('span.glab-value');
    const fill = (v: number) => slider.style.setProperty('--fill', `${((v - RESOLUTION_MIN) / (RESOLUTION_MAX - RESOLUTION_MIN)) * 100}%`);
    const show = (v: number) => {
      slider.value = String(v);
      value.textContent = formatResolution(v);
      fill(v);
      this.paintResolutionMeta(v);
    };
    const set = (v: number) => {
      const cur = this.host.settings();
      if (v !== cur.resolution) this.host.change({ ...cur, resolution: v });
      show(v);
      this.paint();
    };
    slider.addEventListener('input', () => set(snapResolution(Number(slider.value))));
    // Let go of: the keyboard goes back to walking about.
    slider.addEventListener('change', () => {
      slider.blur();
      this.host.backToGame();
    });
    // A double click puts it back at the screen's own resolution.
    slider.addEventListener('dblclick', () => set(1));
    return this.row(
      h('div.glab-label', {}, h('b', {}, 'Resolution'), this.resMeta),
      h('div.glab-range', {}, slider, value),
      (s) => show(s.resolution),
      (s) => {
        const r = this.host.renderSize(s.resolution);
        const out = this.host.renderSize(1);
        const how = s.resolution < 1 ? 'upscaled to the screen, which costs less and looks softer' : s.resolution > 1 ? 'supersampled down to the screen: sharper edges and fine detail, at a high cost' : 'the screen’s own resolution';
        return {
          title: 'Resolution',
          value: formatResolution(s.resolution),
          text: 'The share of your screen’s resolution the office draws at. The GPU’s work grows with the square: 0.7× draws half the pixels, 1.5× more than twice as many. Double-click to go back to 1.0×.',
          detail: `${r.width}×${r.height} of ${out.width}×${out.height}, ${how}.`,
          impact: 'high',
        };
      },
      (s) => s.enabled,
    );
  }

  private paintResolutionMeta(v: number) {
    const r = this.host.renderSize(v);
    const text = `${r.width} × ${r.height}`;
    if (this.resMeta.textContent !== text) this.resMeta.textContent = text;
  }

  private rebakeRow(): HTMLElement {
    const rebake = h('button.btn.sm', { type: 'button' }, 'Rebake now');
    rebake.addEventListener('click', () => {
      this.host.rebakeGI();
      this.host.backToGame();
    });
    return this.row(
      h('div.glab-label', {}, h('b', {}, 'Light probes'), h('small', {}, this.giNoteEl)),
      rebake,
      () => {},
      () => ({
        title: 'Light probes',
        value: '',
        text: 'Bakes the global illumination again from scratch and saves it. One bake fits every floor and is kept for the next launch; it bakes by itself only after a quality, light or update change.',
        detail: 'The office stays at full frame rate until the bake is done.',
        impact: 'medium',
      }),
      (s) => s.enabled && s.giQuality !== 'low',
    );
  }
}
