export interface NativePerformanceLabel {
  text: string;
  warning: boolean;
}

export function nativeFpsCounter(metrics: unknown): NativePerformanceLabel {
  const m = metrics && typeof metrics === 'object' ? (metrics as Record<string, unknown>) : {};
  const fps = typeof m.fps === 'number' && Number.isFinite(m.fps) && m.fps >= 0 ? `${m.fps.toFixed(1)} fps` : 'Measuring FPS…';
  const refresh = typeof m.refresh === 'number' && Number.isFinite(m.refresh) && m.refresh > 0 ? ` · ${Math.round(m.refresh)} Hz` : '';
  const status = nativePerformanceLabel(metrics);
  if (m.focused === false) return { text: 'Session paused', warning: true };
  if (typeof m.controlAgeMs === 'number' && m.controlAgeMs > 1000) return { text: `${fps}${refresh} · Office delayed`, warning: true };
  return { text: `${fps}${refresh}`, warning: status?.warning ?? false };
}

/** A measured display mode is useful; it is never a promise that an empty or stale world is smooth. */
export function nativePerformanceLabel(metrics: unknown): NativePerformanceLabel | null {
  if (!metrics || typeof metrics !== 'object') return null;
  const m = metrics as Record<string, unknown>;
  const refresh = typeof m.refresh === 'number' && Number.isFinite(m.refresh) ? m.refresh : 0;
  if (refresh <= 0) return null;
  const hz = `${Math.round(refresh)} Hz display`;
  if (m.focused === false) return { text: 'Headset session paused', warning: true };
  if (typeof m.controlAgeMs !== 'number' || !Number.isFinite(m.controlAgeMs) || m.controlAgeMs > 1000) return { text: `${hz} · Office updates delayed`, warning: true };
  if (refresh < 89) return { text: `${hz} · 90 Hz required`, warning: true };
  const scene = m.scene && typeof m.scene === 'object' ? (m.scene as Record<string, unknown>) : null;
  if (!scene || !(Number(scene.objects) > 0) || !(Number(scene.drawCalls) > 0) || !(Number(scene.stateSerial) > 0)) return { text: `${hz} · Loading the office…`, warning: true };
  if (typeof m.fps !== 'number' || !Number.isFinite(m.fps)) return { text: `${hz} · Measuring frame rate…`, warning: false };
  if (m.fps < 89 || Number(m.missedPeriods) > 0) return { text: `${hz} · Frame rate below 90 fps`, warning: true };
  return { text: hz, warning: false };
}

/** The closed-workspace status panel's two lines, under the packet names installed apps read. */
export interface NativeStatusText {
  /** The FPS counter, or ''. Named `aim` for the installed apps, which once showed aim hints here. */
  aim: string;
  /** The latest transient toast, or ''. */
  message: string;
}

/**
 * What the status panel in front of you shows while the workspace is closed: the FPS counter when
 * its setting is on, and the latest toast while it lasts. Nothing else persists there, and no
 * control is named (native/mode.ts controlHintsShown).
 */
export function nativeStatus(metrics: unknown, counter: boolean, toast: string): NativeStatusText {
  return { aim: counter ? nativeFpsCounter(metrics).text : '', message: toast };
}
