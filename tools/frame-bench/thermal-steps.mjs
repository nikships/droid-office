// office-run.mjs owns the browser/native app. This file owns the read-only sensor process.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { combinePacing, coolingStatus, sensorSample, stats, temperatures, validatePacing, validatePresenter } from './thermal-lib.mjs';

export default async ({ js, reload, waitFor, sleep, out, log }) => {
  const options = JSON.parse(process.env.OFFICE_THERMAL_OPTIONS);
  const samples = [];
  let phase = 'setup',
    pending = '',
    sensorError;
  const decoder = new StringDecoder('utf8');
  const sensor = spawn(options.macmon, ['pipe', '--interval', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => sensor.once('close', resolve));
  sensor.on('error', (error) => {
    sensorError = error.message;
  });
  sensor.stderr.on('data', (data) => {
    sensorError = `${sensorError ?? ''}${data}`.slice(-4096);
  });
  sensor.stdout.on('data', (data) => {
    try {
      pending += decoder.write(data);
      if (pending.length > 1024 * 1024) throw new Error('macmon line exceeds 1 MiB');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines.filter((text) => text.trim())) {
        const sample = sensorSample(JSON.parse(line), Date.now(), phase);
        samples.push(sample);
        appendFileSync(`${out}/sensors.jsonl`, `${JSON.stringify(sample)}\n`);
      }
    } catch (error) {
      sensorError = error.message;
      sensor.kill('SIGTERM');
    }
  });
  const checkSensor = () => {
    if (sensorError || sensor.exitCode !== null || sensor.signalCode !== null) throw new Error(`sensor failed: ${sensorError ?? sensor.exitCode ?? sensor.signalCode}`);
    if (samples.length && Date.now() - samples.at(-1).at > 4000) throw new Error('sensor stopped producing fresh readings');
  };
  try {
    await js((settings) => {
      for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value);
    }, options.storage);
    await reload();
    await waitFor(() => !document.querySelector('#warmup.on'), null, 360000);
    await js((target) => window.office.goTo(target), options.target);
    const configuration = await js(() => {
      const o = window.__office;
      o.renderLoop.host.pace = () => 'paused';
      o.renderLoop.wake();
      window.office.frameStats({ reset: true });
      const report = window.office.frameStats(),
        lights = [];
      o.scene.traverse((object) => {
        if (object.isPointLight) lights.push({ visible: object.visible, intensity: object.intensity });
      });
      return { floor: window.office.state().floor.id, renderer: report.renderer, output: report.output, lights, mode: o.renderLoop.mode, weather: o.store.sky?.weather };
    });
    if (configuration.mode !== 'paused') throw new Error('rendering did not pause for cooldown');
    log(`CONFIGURATION ${JSON.stringify(configuration)}`);
    phase = 'cooldown';
    const coolAt = Date.now();
    let startTemperatures;
    for (;;) {
      await sleep(10000);
      checkSensor();
      const status = coolingStatus(samples, options, Date.now());
      const seconds = (Date.now() - coolAt) / 1000;
      log(`COOLDOWN ${JSON.stringify({ seconds, ...status })}`);
      if (seconds >= options.minCool && status.ready) {
        startTemperatures = { cpu: status.cpu, gpu: status.gpu };
        break;
      }
      if (seconds >= options.maxCool) throw new Error(`cooldown limit reached: ${JSON.stringify(status)}`);
    }
    phase = 'load-warmup';
    const loadAt = Date.now();
    await js(() => {
      const o = window.__office;
      if (o.renderLoop.mode !== 'paused' || window.office.frameStats().cpu.total.max !== 0) throw new Error('the cooldown contained drawn frames');
      o.renderLoop.host.pace = () => 'full';
      o.renderLoop.wake();
    });
    await sleep(3000);
    const started = await js(() => window.office.frameStats());
    log(`RESUMED ${JSON.stringify(started)}`);
    validatePacing(started, options.fps, 0.5);
    await sleep(Math.max(0, options.warmup * 1000 - 3000));
    checkSensor();
    let previousAt = await js(async () => {
      if (window.office.presenterStats) await window.office.presenterStats({ reset: true });
      window.office.frameStats({ reset: true });
      return performance.now();
    });
    const measureAt = Date.now();
    phase = 'measurement';
    const chunks = [];
    // Capture inside the rolling frame-history limit. Raw chunk quantiles stay separate;
    // a mean or maximum of p95s would not be a valid whole-window p95.
    const deadline = measureAt + options.seconds * 1000;
    while (Date.now() < deadline - 10) {
      await sleep(Math.min(10000, deadline - Date.now()));
      checkSensor();
      const chunk = await js(() => {
        const at = performance.now(),
          report = window.office.frameStats();
        window.office.frameStats({ reset: true });
        return { at, report };
      });
      chunks.push({ seconds: (chunk.at - previousAt) / 1000, report: chunk.report });
      previousAt = chunk.at;
      validatePacing(chunk.report, options.fps, chunks.at(-1).seconds);
    }
    const finishAt = Date.now();
    const pacing = combinePacing(chunks, options.fps, options.seconds);
    const presenter = await js(async () => (window.office.presenterStats ? await window.office.presenterStats() : null));
    await js(() => {
      window.__office.renderLoop.host.pace = () => 'paused';
      window.__office.renderLoop.wake();
    });
    checkSensor();
    validatePacing(pacing, options.fps, options.seconds);
    validatePresenter(presenter, options.fps, options.backend);
    const measured = samples.filter((sample) => sample.phase === 'measurement' && sample.at >= measureAt + 1000 && sample.at <= finishAt);
    if (measured.length < options.seconds * 0.9) throw new Error(`too few sensor samples: ${measured.length}`);
    if (measured.some((sample, i) => i > 0 && sample.at - measured[i - 1].at > 2500)) throw new Error('sensor gaps during measurement');
    const result = {
      schema: 1,
      label: options.label,
      variant: options.variant,
      commit: options.commit,
      backend: options.backend,
      fps: options.fps,
      configuration,
      startTemperatures,
      loadAt,
      measureAt,
      finishAt,
      cooldownSeconds: (loadAt - coolAt) / 1000,
      warmupSeconds: options.warmup,
      measurementSeconds: options.seconds,
      coolCriteria: { cpuMaxC: options.cpuMax, gpuMaxC: options.gpuMax, stabilityC: options.stability, minSeconds: options.minCool, windowSamples: 30 },
      cpuC: stats(measured.map((s) => s.cpuC)),
      gpuC: stats(measured.map((s) => s.gpuC)),
      fan0Rpm: stats(measured.map((s) => s.fans.find((f) => f.name === 'fan0')?.rpm)),
      fan1Rpm: stats(measured.map((s) => s.fans.find((f) => f.name === 'fan1')?.rpm)),
      cpuActive: stats(measured.map((s) => s.cpuActive)),
      gpuActive: stats(measured.map((s) => s.gpuActive)),
      estimatedCpuW: stats(measured.map((s) => s.cpuW)),
      estimatedGpuW: stats(measured.map((s) => s.gpuW)),
      first30: temperatures(measured.slice(0, 30)),
      last30: temperatures(measured.slice(-30)),
      pacing,
      presenter,
    };
    writeFileSync(`${out}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
    log(`THERMAL_RESULT ${JSON.stringify(result)}`);
  } finally {
    sensor.kill('SIGTERM');
    await closed;
  }
};
