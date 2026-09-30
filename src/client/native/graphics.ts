import { h, openModal, type Modal } from '../ui/dom';
import { DEFAULT_NATIVE_GRAPHICS, MIN_NATIVE_RENDER_SCALE, nativeWorldResolution, readNativeGraphics, stepNativeRenderScale, type NativeEyeSize, type NativeGraphicsSettings } from './graphics-settings';
import { nativeFpsCounter, nativePerformanceLabel } from './performance';
import './graphics.css';

const STORAGE_KEY = 'droid-office.native-graphics.v1';
let settings: NativeGraphicsSettings | null = null;
let metrics: unknown;
let modal: Modal | null = null;
let repaint: (() => void) | null = null;
let counter: HTMLElement | null = null;

export function getNativeGraphicsSettings(): NativeGraphicsSettings {
  if (!settings) {
    try {
      settings = readNativeGraphics(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
    } catch {
      settings = { ...DEFAULT_NATIVE_GRAPHICS };
    }
  }
  return settings;
}

function save(next: NativeGraphicsSettings) {
  settings = readNativeGraphics(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The settings still apply for this session when storage is unavailable.
  }
  updateNativeGraphicsMetrics(metrics);
}

export function updateNativeGraphicsMetrics(next: unknown) {
  metrics = next;
  if (!counter?.isConnected) {
    const dock = document.querySelector('.dock');
    if (dock) {
      counter ??= h('span.native-frame-counter.hidden', { role: 'status', 'aria-live': 'off', title: 'Native application frame rate, averaged over the latest measurement window' });
      dock.prepend(counter);
    }
  }
  if (counter) {
    const reading = nativeFpsCounter(metrics);
    counter.classList.toggle('hidden', !getNativeGraphicsSettings().fps);
    counter.classList.toggle('warning', reading.warning);
    if (counter.textContent !== reading.text) counter.textContent = reading.text;
  }
  repaint?.();
}

/** The closed-workspace compositor hint includes the same measured counter. */
export function nativeGraphicsAim(aim: string): string {
  if (!getNativeGraphicsSettings().fps) return aim;
  return [nativeFpsCounter(metrics).text, aim].filter(Boolean).join(' · ');
}

export function openNativeGraphicsSettings(): void {
  if (modal) return;
  const status = h('p.ng-status', { role: 'status', 'aria-live': 'polite' });
  const details = h('p.setting-note.ng-measurements');
  const controls: (() => void)[] = [];
  const choices = <K extends 'foveation' | 'peripheralDensity'>(key: K, label: string, values: readonly (readonly [NativeGraphicsSettings[K], string])[]) => {
    const row = h('div.seg.ng-choices', { role: 'radiogroup', 'aria-label': label });
    const buttons = values.map(([value, title]) => {
      const button = h('button.btn', { type: 'button', role: 'radio', onclick: () => save({ ...getNativeGraphicsSettings(), [key]: value }) }, title);
      row.append(button);
      return { button, value };
    });
    controls.push(() => {
      const m = metrics && typeof metrics === 'object' ? (metrics as Record<string, unknown>) : {};
      for (const { button, value } of buttons) {
        const selected = getNativeGraphicsSettings()[key] === value;
        button.classList.toggle('on', selected);
        button.setAttribute('aria-checked', String(selected));
        button.disabled = (key === 'foveation' && value !== 'off' && m.foveationSupported === false) || (key === 'peripheralDensity' && (getNativeGraphicsSettings().foveation === 'off' || m.foveationSupported === false));
      }
    });
    return row;
  };
  const resolutionValue = h('output.ng-resolution-value', { for: 'ng-render-scale' });
  const resolutionLimits = h('p.setting-note.ng-resolution-limits');
  const resolutionPixels = h('p.ng-resolution-pixels', { id: 'ng-resolution-pixels' });
  const resolutionApplied = h('p.setting-note.ng-resolution-applied', { role: 'status', 'aria-live': 'polite' });
  let previewScale: number | null = null;
  const setResolution = (value: number) => {
    const resolution = nativeWorldResolution(metrics, getNativeGraphicsSettings().renderScale);
    previewScale = null;
    save({ ...getNativeGraphicsSettings(), renderScale: Math.max(MIN_NATIVE_RENDER_SCALE, Math.min(resolution.maxScale, value)) });
  };
  const slider = h('input.ng-resolution-slider', {
    id: 'ng-render-scale',
    type: 'range',
    min: MIN_NATIVE_RENDER_SCALE,
    max: 1,
    step: 'any',
    'aria-labelledby': 'ng-resolution-label',
    'aria-describedby': 'ng-resolution-pixels',
    oninput: () => {
      const max = nativeWorldResolution(metrics, getNativeGraphicsSettings().renderScale).maxScale;
      const value = slider.valueAsNumber;
      previewScale = Math.max(MIN_NATIVE_RENDER_SCALE, Math.min(max, value >= max - 1e-8 ? max : Math.round(value * 100) / 100));
      repaint?.();
    },
    onchange: () => {
      if (previewScale !== null) setResolution(previewScale);
    },
    onpointercancel: () => {
      previewScale = null;
      repaint?.();
    },
    onkeydown: (event) => {
      const e = event as KeyboardEvent;
      const direction = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : null;
      if (direction === null && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const resolution = nativeWorldResolution(metrics, getNativeGraphicsSettings().renderScale);
      setResolution(direction === null ? (e.key === 'Home' ? MIN_NATIVE_RENDER_SCALE : resolution.maxScale) : stepNativeRenderScale(resolution.selectedScale, direction, resolution.maxScale));
    },
  });
  const stepResolution = (direction: -1 | 1) => {
    const resolution = nativeWorldResolution(metrics, getNativeGraphicsSettings().renderScale);
    setResolution(stepNativeRenderScale(resolution.selectedScale, direction, resolution.maxScale));
  };
  const lessResolution = h('button.btn.ng-resolution-step', { type: 'button', 'aria-label': 'Decrease world resolution by 1%', onclick: () => stepResolution(-1) }, '−');
  const moreResolution = h('button.btn.ng-resolution-step', { type: 'button', 'aria-label': 'Increase world resolution by 1%', onclick: () => stepResolution(1) }, '+');
  const recommendedResolution = h('button.btn', { type: 'button', onclick: () => setResolution(1) }, 'Recommended · 100%');
  const maximumResolution = h('button.btn', { type: 'button', onclick: () => setResolution(nativeWorldResolution(metrics, getNativeGraphicsSettings().renderScale).maxScale) }, 'Maximum');
  const foveationNote = h('p.setting-note');
  const fps = h('input', { type: 'checkbox', onchange: () => save({ ...getNativeGraphicsSettings(), fps: fps.checked }) });
  controls.push(() => {
    fps.checked = getNativeGraphicsSettings().fps;
  });
  const sharpScreens = h('input', { type: 'checkbox', onchange: () => save({ ...getNativeGraphicsSettings(), sharpScreens: sharpScreens.checked }) });
  controls.push(() => {
    sharpScreens.checked = getNativeGraphicsSettings().sharpScreens;
  });
  const body = h(
    'div.body',
    {},
    status,
    details,
    h('h3.ng-resolution-heading', { id: 'ng-resolution-label' }, 'World resolution', resolutionValue),
    h('div.ng-resolution-controls', {}, lessResolution, slider, moreResolution),
    resolutionLimits,
    h('div.seg.ng-choices.ng-resolution-presets', { 'aria-label': 'World resolution presets' }, recommendedResolution, maximumResolution),
    resolutionPixels,
    resolutionApplied,
    h('p.setting-note', {}, '100% uses the headset’s recommended eye size. Maximum uses its available world resolution. Higher settings use more GPU time. Workspace text keeps its full resolution.'),
    h('h3', {}, 'Foveated rendering'),
    choices('foveation', 'Foveated rendering', [
      ['off', 'Off'],
      ['performance', 'More headroom'],
      ['balanced', 'Balanced'],
      ['clarity', 'Wider sharp area'],
    ]),
    foveationNote,
    h('label.choice.ng-fps', {}, sharpScreens, h('span', {}, 'Sharper laptop screens')),
    h('p.setting-note', {}, 'Keeps nearby terminal screens at full resolution independently of world detail. Turning this off saves GPU time and uses the normal world rendering.'),
    h('h3', {}, 'Peripheral detail'),
    choices('peripheralDensity', 'Peripheral detail', [
      [0.25, 'Low'],
      [0.4, 'Medium'],
      [0.55, 'High'],
    ]),
    h('p.setting-note', {}, 'Higher detail outside your gaze uses more GPU time. This setting applies when foveation is on. Balanced, recommended resolution and Low detail are the defaults.'),
    h('label.choice.ng-fps', {}, fps, h('span', {}, 'Always show the FPS counter')),
    h('p.setting-note', {}, 'The counter uses the native application’s measured frame rate. Display refresh and delayed office updates are reported separately. The app always requests 90 Hz.'),
  );
  const el = h(
    'section.modal.native-graphics',
    { role: 'dialog', 'aria-label': 'Graphics & performance' },
    h('header', {}, h('h2', {}, 'Graphics & performance')),
    body,
    h('footer', {}, h('button.btn', { type: 'button', onclick: () => save({ ...DEFAULT_NATIVE_GRAPHICS }) }, 'Restore defaults'), h('span.grow', {}, 'Release the slider to apply. Changes take effect shortly on this headset.')),
  );
  const percent = (scale: number) => `${Number((scale * 100).toFixed(1))}%`;
  const pixels = (size: NativeEyeSize) => `${size.width} × ${size.height}`;
  const setText = (el: HTMLElement, text: string) => {
    if (el.textContent !== text) el.textContent = text;
  };
  repaint = () => {
    controls.forEach((fn) => {
      fn();
    });
    const reading = nativePerformanceLabel(metrics);
    const text = reading?.text ?? 'Waiting for native display measurements…';
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle('warning', reading?.warning ?? false);
    const m = metrics && typeof metrics === 'object' ? (metrics as Record<string, unknown>) : {};
    const current = getNativeGraphicsSettings();
    const resolution = nativeWorldResolution(metrics, previewScale ?? current.renderScale);
    const selectedPercent = percent(resolution.selectedScale);
    setText(resolutionValue, selectedPercent);
    if (slider.max !== String(resolution.maxScale)) slider.max = String(resolution.maxScale);
    if (slider.valueAsNumber !== resolution.selectedScale) slider.value = String(resolution.selectedScale);
    slider.setAttribute('aria-valuetext', `${selectedPercent}${resolution.selected ? `, ${pixels(resolution.selected)} pixels per eye` : ''}`);
    lessResolution.disabled = resolution.selectedScale <= MIN_NATIVE_RENDER_SCALE;
    moreResolution.disabled = resolution.selectedScale >= resolution.maxScale;
    maximumResolution.disabled = !resolution.hasMaximum;
    recommendedResolution.classList.toggle('on', resolution.selectedScale === 1);
    maximumResolution.classList.toggle('on', resolution.hasMaximum && resolution.selectedScale === resolution.maxScale);
    setText(resolutionLimits, `75% · lower detail${resolution.hasMaximum ? ` — ${percent(resolution.maxScale)} · headset maximum` : ' — waiting for headset maximum…'}`);
    setText(resolutionPixels, resolution.selected ? `${previewScale === null ? 'Selected' : 'Preview'}: ${pixels(resolution.selected)} pixels per eye` : 'Waiting for native eye dimensions…');
    const resolutionDetails = [
      resolution.applied ? `Applied: ${pixels(resolution.applied)} per eye` : '',
      resolution.recommended ? `Recommended: ${pixels(resolution.recommended)}` : '',
      resolution.maximum ? `Runtime limit: ${pixels(resolution.maximum)}` : '',
      previewScale === null && current.renderScale > resolution.maxScale ? `Requested ${percent(current.renderScale)}; limited to ${selectedPercent} on this headset` : '',
    ];
    setText(resolutionApplied, resolutionDetails.filter(Boolean).join(' · '));
    const foveationText =
      m.foveationSupported === false
        ? 'Foveated rendering is unavailable on this headset. The world keeps full detail at the selected resolution.'
        : current.foveation === 'off'
          ? 'Off renders the whole eye at full detail at the selected world resolution. This uses more GPU time.'
          : 'On profiles keep a sharp area around your gaze and reduce peripheral detail. Without eye tracking, that area stays centered. A wider sharp area uses more GPU time.';
    setText(foveationNote, `${foveationText}${typeof m.foveationEnabled === 'boolean' ? ` Currently applied: ${m.foveationEnabled ? 'On' : 'Off'}.` : ''}`);
    const runtime = m.runtime && typeof m.runtime === 'object' ? (m.runtime as Record<string, { value?: number }>) : {};
    const appGpu = runtime['/perfmetrics_android/app/gpu_frametime']?.value;
    const cpu = typeof m.cpuP99Ms === 'number' && Number.isFinite(m.cpuP99Ms) ? `CPU p99 ${m.cpuP99Ms.toFixed(1)} ms` : '';
    const gpu = typeof appGpu === 'number' && Number.isFinite(appGpu) ? `GPU ${appGpu.toFixed(1)} ms` : '';
    const detailText = [nativeFpsCounter(metrics).text, cpu, gpu].filter(Boolean).join(' · ');
    if (details.textContent !== detailText) details.textContent = detailText;
  };
  modal = openModal(el, {
    onClose: () => {
      modal = null;
      repaint = null;
    },
  });
  repaint();
}
