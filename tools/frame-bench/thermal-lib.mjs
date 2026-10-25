// Pure validation and statistics for thermal.mjs. A cap is not proof of an actual load.
export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
export const stats = (values) => {
  const valid = values.filter((value) => finite(value) !== null);
  return valid.length ? { n: valid.length, mean: mean(valid), min: Math.min(...valid), max: Math.max(...valid) } : null;
};
export const temperatures = (rows) => ({ cpu: mean(rows.map((r) => r.cpuC)), gpu: mean(rows.map((r) => r.gpuC)) });

/** macmon 0.10 NDJSON. Missing fan/power counters are unknown, never zero. */
export function sensorSample(value, at, phase) {
  const cpuC = finite(value.temp?.cpu_temp_avg),
    gpuC = finite(value.temp?.gpu_temp_avg);
  if (!(cpuC > 0 && cpuC < 150 && gpuC > 0 && gpuC < 150)) throw new Error('macmon did not report valid CPU/GPU sensor averages');
  return {
    at,
    timestamp: value.timestamp,
    phase,
    cpuC,
    gpuC,
    fans: (value.fans ?? []).map((fan) => ({ name: fan.name, rpm: finite(fan.rpm) })),
    cpuActive: finite(value.cpu_active_ratio),
    gpuActive: finite(value.gpu_active_ratio),
    gpuMHz: finite(value.gpu_freq_mhz),
    cpuW: finite(value.cpu_power),
    gpuW: finite(value.gpu_power),
    systemW: finite(value.sys_power),
  };
}

export function coolingStatus(samples, { cpuMax, gpuMax, stability, window = 30 }, now) {
  const recent = samples.filter((row) => row.phase === 'cooldown').slice(-window);
  if (recent.length !== window || now - recent.at(-1).at > 2500 || recent.at(-1).at - recent[0].at < (window - 3) * 1000) return { ready: false };
  if (recent.some((row, i) => i > 0 && row.at - recent[i - 1].at > 2500)) return { ready: false };
  const middle = Math.floor(window / 2);
  const current = temperatures(recent),
    first = temperatures(recent.slice(0, middle)),
    last = temperatures(recent.slice(middle));
  const stable = Math.abs(last.cpu - first.cpu) < stability && Math.abs(last.gpu - first.gpu) < stability;
  return { ...current, stable, ready: stable && current.cpu <= cpuMax && current.gpu <= gpuMax };
}

export function validatePacing(report, fps, seconds) {
  if (!Number.isFinite(report?.fps) || report.fpsCap !== fps || Math.abs(report.fps - fps) > fps * 0.025) throw new Error(`actual drawn rate ${report?.fps} FPS does not match requested ${fps} FPS`);
  if (!(report.frames >= fps * seconds * 0.95 && report.spanMs >= seconds * 950)) throw new Error(`frame report covers only ${report.frames} frames / ${report.spanMs} ms, expected ${seconds} seconds`);
}

/** FrameStats retains only 7,200 samples. Read/reset short chunks rather than losing half a 120 FPS trial. */
export function combinePacing(chunks, fps, seconds) {
  if (!chunks.length) throw new Error('no frame chunks');
  const sum = (key) => chunks.reduce((total, chunk) => total + chunk.report[key], 0);
  for (const chunk of chunks) validatePacing(chunk.report, fps, chunk.seconds);
  const frames = sum('frames'),
    spanMs = sum('spanMs');
  const report = { fpsCap: fps, frames, spanMs, fps: (frames * 1000) / spanMs, missed: sum('missed'), repeated: sum('repeated'), chunks };
  validatePacing(report, fps, seconds);
  return report;
}

export function validatePresenter(report, fps, backend) {
  if (backend !== 'native') return;
  if (!Number.isFinite(report?.fps) || Math.abs(report.fps - fps) > fps * 0.05) throw new Error(`native presented rate ${report?.fps} FPS does not match requested ${fps} FPS`);
}

export function summarizeTrials(trials) {
  const first = trials[0];
  if (!first) throw new Error('no valid trials');
  for (const row of trials) {
    if (
      row.fps !== first.fps ||
      row.backend !== first.backend ||
      row.configuration.renderer !== first.configuration.renderer ||
      JSON.stringify(row.configuration.output) !== JSON.stringify(first.configuration.output) ||
      row.warmupSeconds !== first.warmupSeconds ||
      row.measurementSeconds !== first.measurementSeconds ||
      JSON.stringify(row.coolCriteria) !== JSON.stringify(first.coolCriteria) ||
      row.configuration.floor !== first.configuration.floor ||
      row.configuration.weather !== first.configuration.weather
    )
      throw new Error('cannot compare different frame rates, backends, quality settings or protocols');
    validatePacing(row.pacing, row.fps, row.measurementSeconds);
    validatePresenter(row.presenter, row.fps, row.backend);
  }
  const summary = {};
  for (const variant of ['before', 'after']) {
    const rows = trials.filter((row) => row.variant === variant);
    if (rows.length < 2) throw new Error(`need at least two independent ${variant} trials`);
    const aggregate = (read) => stats(rows.map(read));
    summary[variant] = {
      trials: rows.length,
      cpuC: aggregate((r) => r.cpuC.mean),
      gpuC: aggregate((r) => r.gpuC.mean),
      startCpuC: aggregate((r) => r.startTemperatures.cpu),
      startGpuC: aggregate((r) => r.startTemperatures.gpu),
      warmingCpuC: aggregate((r) => r.last30.cpu - r.first30.cpu),
      warmingGpuC: aggregate((r) => r.last30.gpu - r.first30.gpu),
      gpuActive: aggregate((r) => r.gpuActive?.mean),
      estimatedGpuW: aggregate((r) => r.estimatedGpuW?.mean),
    };
  }
  return {
    fps: first.fps,
    backend: first.backend,
    configuration: first.configuration,
    ...summary,
    afterMinusBefore: { cpuC: summary.after.cpuC.mean - summary.before.cpuC.mean, gpuC: summary.after.gpuC.mean - summary.before.gpuC.mean },
    limits: [
      'Sensor averages, not hottest-core, chassis or ambient temperatures.',
      'Trial means are the independent replicates, not one-second samples.',
      'Inspect warming drift and repeat variation before claiming a thermal benefit.',
      'GPU counters are system-wide estimates, not app-specific or wall power.',
      'No panel scan-out or battery-life measurement.',
    ],
  };
}
