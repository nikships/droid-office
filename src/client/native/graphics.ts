import { h, openModal, type Modal } from '../ui/dom';
import { DEFAULT_NATIVE_GRAPHICS, readNativeGraphics, type NativeGraphicsSettings } from './graphics-settings';
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
  const choices = <K extends 'foveation' | 'renderScale' | 'peripheralDensity'>(key: K, label: string, values: readonly (readonly [NativeGraphicsSettings[K], string])[]) => {
    const row = h('div.seg.ng-choices', { role: 'radiogroup', 'aria-label': label });
    const buttons = values.map(([value, title]) => {
      const button = h('button.btn', { type: 'button', role: 'radio', onclick: () => save({ ...getNativeGraphicsSettings(), [key]: value }) }, title);
      row.append(button);
      return { button, value };
    });
    controls.push(() => {
      for (const { button, value } of buttons) {
        const selected = getNativeGraphicsSettings()[key] === value;
        button.classList.toggle('on', selected);
        button.setAttribute('aria-checked', String(selected));
      }
    });
    return row;
  };
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
    h('h3', {}, 'Foveated rendering'),
    choices('foveation', 'Foveated rendering', [
      ['performance', 'More headroom'],
      ['balanced', 'Balanced'],
      ['clarity', 'Wider sharp area'],
    ]),
    h('p.setting-note', {}, 'Your gaze stays at full resolution. A wider sharp area uses more GPU time. Without eye tracking, a wider central area stays sharp.'),
    h('h3', {}, 'World resolution'),
    choices('renderScale', 'World resolution', [
      [0.8, '80%'],
      [0.9, '90%'],
      [1, '100% · sharpest'],
    ]),
    h('p.setting-note', {}, '100% uses the headset’s recommended eye resolution. Lower values reduce world detail. Workspace text keeps its full resolution.'),
    h('label.choice.ng-fps', {}, sharpScreens, h('span', {}, 'Sharper laptop screens')),
    h('p.setting-note', {}, 'Keeps nearby terminal screens at full resolution independently of world detail. Turning this off saves GPU time and uses the normal world rendering.'),
    h('h3', {}, 'Peripheral detail'),
    choices('peripheralDensity', 'Peripheral detail', [
      [0.25, 'Low'],
      [0.4, 'Medium'],
      [0.55, 'High'],
    ]),
    h('p.setting-note', {}, 'Higher detail outside your gaze uses more GPU time. Balanced, 100% resolution and Low detail are the tested defaults.'),
    h('label.choice.ng-fps', {}, fps, h('span', {}, 'Always show the FPS counter')),
    h('p.setting-note', {}, 'The counter uses the native application’s measured frame rate. Display refresh and delayed office updates are reported separately. The app always requests 90 Hz.'),
  );
  const el = h(
    'section.modal.native-graphics',
    { role: 'dialog', 'aria-label': 'Graphics & performance' },
    h('header', {}, h('h2', {}, 'Graphics & performance')),
    body,
    h('footer', {}, h('button.btn', { type: 'button', onclick: () => save({ ...DEFAULT_NATIVE_GRAPHICS }) }, 'Restore defaults'), h('span.grow', {}, 'Changes apply immediately on this headset.')),
  );
  let paintedSettings: NativeGraphicsSettings | null = null;
  repaint = () => {
    if (paintedSettings !== getNativeGraphicsSettings()) {
      controls.forEach((fn) => {
        fn();
      });
      paintedSettings = getNativeGraphicsSettings();
    }
    const reading = nativePerformanceLabel(metrics);
    const text = reading?.text ?? 'Waiting for native display measurements…';
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle('warning', reading?.warning ?? false);
    const m = metrics && typeof metrics === 'object' ? (metrics as Record<string, unknown>) : {};
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
