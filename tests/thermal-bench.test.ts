import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combinePacing, coolingStatus, sensorSample, stats, summarizeTrials, validatePacing, validatePresenter } from '../tools/frame-bench/thermal-lib.mjs';
import { thermalOptions } from '../tools/frame-bench/thermal.mjs';
import { thermalHtml, traceSvg } from '../tools/frame-bench/thermal-report.mjs';

// Relevant fields from macmon 0.10.0 on the owner's M5 Pro, 2026-10-24.
const sensor = {
  timestamp: '2026-10-24T23:22:28.164911+00:00',
  temp: { cpu_temp_avg: 39.71788024902344, gpu_temp_avg: 39.02641296386719 },
  fans: [
    { name: 'fan0', rpm: 1350 },
    { name: 'fan1', rpm: 1460 },
  ],
  cpu_active_ratio: 0.03324418142437935,
  gpu_active_ratio: 0.031076347455382347,
  gpu_freq_mhz: 338,
  cpu_power: 0.5028603076934814,
  gpu_power: 0.013754715211689472,
  sys_power: 5.090418338775635,
};
const cooling = { cpuMax: 34, gpuMax: 33, stability: 0.3 };
const rows = () => Array.from({ length: 30 }, (_, i) => ({ at: i * 1000, phase: 'cooldown', cpuC: 32, gpuC: 31 }));
const pacing = (fps = 120) => ({ fps, fpsCap: fps, frames: fps * 120 - 1, spanMs: 119990 });

test('sensor normalization retains real fan speeds and distinguishes unknown counters from zero', () => {
  const row = sensorSample(sensor, 1000, 'measurement');
  assert.equal(row.cpuC, 39.71788024902344);
  assert.equal(row.gpuW, 0.013754715211689472);
  assert.equal(row.fans[0].rpm, 1350);
  const missing = sensorSample({ temp: sensor.temp }, 2000, 'cooldown');
  assert.deepEqual(missing.fans, []);
  assert.equal(missing.gpuW, null);
  assert.equal(stats([null, undefined, Number.NaN, Number.POSITIVE_INFINITY]), null);
  assert.deepEqual(stats([0, null, 10]), { n: 2, mean: 5, min: 0, max: 10 });
  assert.throws(() => sensorSample({}, 1000, 'setup'), /valid CPU\/GPU/);
  assert.throws(() => sensorSample({ temp: { cpu_temp_avg: Number.NaN, gpu_temp_avg: 30 } }, 1000, 'setup'), /valid CPU\/GPU/);
});

test('cooldown needs a fresh, complete, stable window under both temperature limits', () => {
  assert.equal(coolingStatus(rows(), cooling, 30000).ready, true);
  assert.equal(coolingStatus(rows().slice(1), cooling, 30000).ready, false);
  assert.equal(coolingStatus(rows(), cooling, 33000).ready, false);
  assert.equal(
    coolingStatus(
      rows().map((r) => ({ ...r, gpuC: 34 })),
      cooling,
      30000,
    ).ready,
    false,
  );
  assert.equal(
    coolingStatus(
      rows().map((r, i) => ({ ...r, cpuC: 32 + i * 0.03 })),
      cooling,
      30000,
    ).ready,
    false,
  );
  assert.equal(
    coolingStatus(
      rows().map((r) => ({ ...r, phase: 'setup' })),
      cooling,
      30000,
    ).ready,
    false,
  );
  assert.equal(
    coolingStatus(
      rows().map((r) => ({ ...r, at: r.at / 2 })),
      cooling,
      15000,
    ).ready,
    false,
  );
  const gap = rows();
  gap[10].at -= 2000;
  assert.equal(coolingStatus(gap, cooling, 30000).ready, false);
});

test('the requested cap does not validate a 60 FPS workload as 120 FPS', () => {
  assert.doesNotThrow(() => validatePacing(pacing(), 120, 120));
  assert.throws(() => validatePacing({ ...pacing(), fps: 60 }, 120, 120), /actual drawn rate/);
  assert.throws(() => validatePacing({ ...pacing(), fps: Number.NaN }, 120, 120), /actual drawn rate/);
  assert.throws(() => validatePacing({ ...pacing(), fpsCap: 60 }, 120, 120), /actual drawn rate/);
  assert.throws(() => validatePacing({ ...pacing(), frames: 1200, spanMs: 10000 }, 120, 120), /frame report covers only/);
  assert.throws(() => validatePacing({ ...pacing(), spanMs: 0 }, 120, 120), /frame report covers only/);
});

test('120-second pacing is validated in chunks, never from a truncated 7,200-frame ring', () => {
  const report = { ...pacing(), frames: 1199, spanMs: 9992, missed: 0, repeated: 0 };
  const chunks = Array.from({ length: 12 }, () => ({ seconds: 10, report }));
  const combined = combinePacing(chunks, 120, 120);
  assert.equal(combined.frames, 14388);
  assert.ok(combined.spanMs > 119000);
  assert.equal(combined.chunks.length, 12);
  assert.throws(() => combinePacing(chunks.slice(0, 6), 120, 120), /frame report covers only/);
  assert.throws(() => combinePacing([{ seconds: 10, report: { ...report, fps: 60 } }], 120, 10), /actual drawn rate/);
  assert.throws(() => combinePacing([], 120, 120), /no frame chunks/);
});
test('native comparisons also require the actual native presentation rate', () => {
  assert.doesNotThrow(() => validatePresenter({ fps: 119.9 }, 120, 'native'));
  assert.throws(() => validatePresenter({ fps: 60 }, 120, 'native'), /native presented rate/);
  assert.throws(() => validatePresenter(null, 120, 'native'), /native presented rate/);
  assert.doesNotThrow(() => validatePresenter(null, 60, 'headless'));
});

const trials = () =>
  [38, 37, 39, 40].map((temperature, i) => ({
    label: ['A1', 'B1', 'B2', 'A2'][i],
    variant: i === 0 || i === 3 ? 'before' : 'after',
    backend: 'native',
    fps: 120,
    measurementSeconds: 120,
    configuration: { renderer: 'Remastered · 2× MSAA · SDR · GI', output: { width: 3456, height: 2168 } },
    cpuC: { mean: temperature },
    gpuC: { mean: temperature - 1 },
    startTemperatures: { cpu: 33, gpu: 32 },
    first30: { cpu: temperature - 0.2, gpu: temperature - 1.2 },
    last30: { cpu: temperature + 0.2, gpu: temperature - 0.8 },
    pacing: pacing(),
    presenter: { fps: 120 },
  }));

test('comparison weights independent trial means equally, records ranges and does not invent power readings', () => {
  const input = trials();
  const summary = summarizeTrials(input);
  assert.equal(summary.before.trials, 2);
  assert.equal(summary.after.trials, 2);
  assert.equal(summary.before.cpuC.mean, 39);
  assert.equal(summary.after.cpuC.mean, 38);
  assert.equal(summary.afterMinusBefore.cpuC, -1);
  assert.equal(summary.before.cpuC.max - summary.before.cpuC.min, 2);
  assert.equal(summary.before.estimatedGpuW, null);
  assert.ok(Math.abs(summary.after.warmingCpuC.mean - 0.4) < 1e-9);
});

test('comparison rejects missing repeats, different quality, backend and FPS', () => {
  assert.throws(() => summarizeTrials([]), /no valid trials/);
  assert.throws(() => summarizeTrials(trials().slice(0, 3)), /independent before/);
  for (const change of [
    { fps: 60 },
    { backend: 'headless' },
    { configuration: { renderer: 'Classic', output: { width: 3456, height: 2168 } } },
    { configuration: { renderer: 'Remastered · 2× MSAA · SDR · GI', output: { width: 1728, height: 1084 } } },
  ]) {
    const input = trials();
    assert.throws(() => summarizeTrials([input[0], { ...input[1], ...change }, ...input.slice(2)]), /cannot compare different/);
  }
});

const args = ['--clone', '/tmp/real-clone', '--before', '/tmp/before', '--after', '/tmp/after', '--macmon', '/tmp/macmon', '--out', '/tmp/results'];
test('thermal CLI defaults to native 120 FPS and validates experiment arguments', () => {
  const options = thermalOptions(args);
  assert.equal(options.fps, 120);
  assert.equal(options.backend, 'native');
  assert.equal(options.warmup, 180);
  assert.equal(options.seconds, 120);
  assert.throws(() => thermalOptions([...args, '--backend', 'headless']), /120 FPS requires/);
  assert.throws(() => thermalOptions([...args, '--fps', '80']), /40, 60 or 120/);
  assert.throws(() => thermalOptions([...args, '--seconds', 'NaN']), /invalid --seconds/);
  assert.throws(() => thermalOptions([...args, '--outt', '/tmp/oops']), /Unknown option/);
  assert.equal(thermalOptions([...args, '--backend', 'headless', '--fps', '60']).backend, 'headless');
  assert.equal(thermalOptions(['--help']).help, true);
  assert.equal(thermalOptions(['--compare', '/tmp/results']).compare, '/tmp/results');
});

test('static thermal report includes all trials, measured rates, ranges and explicit limits', () => {
  const input = trials();
  const html = thermalHtml(summarizeTrials(input), input);
  for (const label of ['A1', 'B1', 'B2', 'A2']) assert.ok(html.includes(`${label} ·`));
  assert.ok(html.includes('Presented FPS'));
  assert.ok(html.includes('38.00°C'));
  assert.ok(html.includes('correlated'));
  assert.ok(html.includes('not hottest-core'));
  assert.ok(html.includes('temperature-traces.svg'));
  const unsafe = trials();
  unsafe[0].label = '<script>not markup</script>';
  assert.ok(thermalHtml(summarizeTrials(unsafe), unsafe).includes('&lt;script&gt;'));
});

test('trace chart plots every run, shades measurement, and rejects missing or invalid sensor data', () => {
  const input = trials().map((row) => ({ ...row, loadAt: 0, finishAt: 300000, warmupSeconds: 180 }));
  const samples = input.map((trial) => Array.from({ length: 60 }, (_, i) => ({ at: i * 5000, cpuC: trial.cpuC.mean, gpuC: trial.gpuC.mean })));
  const svg = traceSvg(input, samples);
  assert.equal((svg.match(/<polyline /g) ?? []).length, 8);
  assert.ok(svg.includes('measurement'));
  assert.ok(svg.includes('stroke-dasharray'));
  assert.throws(() => traceSvg(input, [[], ...samples.slice(1)]), /incomplete trace/);
  samples[0][0].gpuC = Number.NaN;
  assert.throws(() => traceSvg(input, samples), /incomplete trace/);
});
