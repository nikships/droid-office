#!/usr/bin/env node
// Local static artifacts for a completed ABBA series. No network, profile or account data.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, summarizeTrials } from './thermal-lib.mjs';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = (value, digits = 2) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'unknown');

export function traceSvg(trials, samples) {
  const traces = trials.map((trial, i) => {
    const rows = samples[i].filter((r) => r.at >= trial.loadAt && r.at <= trial.finishAt);
    if (rows.length < 10 || rows.some((r) => !Number.isFinite(r.cpuC) || !Number.isFinite(r.gpuC))) throw new Error(`incomplete trace for ${trial.label}`);
    const groups = new Map();
    for (const row of rows) {
      const bin = Math.floor((row.at - trial.loadAt) / 5000);
      const group = groups.get(bin) ?? [];
      group.push(row);
      groups.set(bin, group);
    }
    return {
      label: trial.label,
      variant: trial.variant,
      values: [...groups.entries()].map(([bin, values]) => ({ second: bin * 5 + 2.5, cpu: mean(values.map((r) => r.cpuC)), gpu: mean(values.map((r) => r.gpuC)) })),
    };
  });
  const all = traces.flatMap((t) => t.values.flatMap((v) => [v.cpu, v.gpu]));
  const minimum = Math.floor(Math.min(...all)) - 1,
    maximum = Math.ceil(Math.max(...all)) + 1;
  const seconds = trials[0].warmupSeconds + trials[0].measurementSeconds;
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 420" role="img" aria-labelledby="title">',
    '<title id="title">CPU and GPU sensor averages, four counterbalanced trials</title>',
    '<rect width="1120" height="420" fill="#171715"/>',
    '<g font-family="system-ui,sans-serif" fill="#d8d6cf">',
  ];
  for (const [index, key] of ['cpu', 'gpu'].entries()) {
    const left = index * 550 + 65,
      top = 65,
      width = 450,
      height = 260;
    const x = (second) => left + (second / seconds) * width;
    const y = (value) => top + height - ((value - minimum) / (maximum - minimum)) * height;
    parts.push(`<text x="${left}" y="31" font-size="18">${key.toUpperCase()} sensor average (°C)</text>`);
    parts.push(`<rect x="${x(trials[0].warmupSeconds)}" y="${top}" width="${(width * trials[0].measurementSeconds) / seconds}" height="${height}" fill="#252521"/>`);
    for (let i = 0; i <= 5; i++) {
      const value = minimum + ((maximum - minimum) * i) / 5;
      parts.push(`<path d="M${left},${y(value)}H${left + width}" stroke="#41413a"/>`, `<text x="${left - 12}" y="${y(value) + 4}" text-anchor="end" font-size="12">${value.toFixed(1)}</text>`);
      parts.push(`<text x="${x((seconds * i) / 5)}" y="348" text-anchor="middle" font-size="12">${Math.round((seconds * i) / 5)}</text>`);
    }
    parts.push(`<text x="${left + width / 2}" y="374" text-anchor="middle" font-size="12">Seconds of rendering · shaded = measurement</text>`);
    for (const trace of traces) {
      const points = trace.values.map((v) => `${x(v.second).toFixed(1)},${y(v[key]).toFixed(1)}`).join(' ');
      parts.push(`<polyline points="${points}" fill="none" stroke="${trace.variant === 'before' ? '#efad71' : '#79bee9'}" stroke-width="2"${trace.label.endsWith('2') ? ' stroke-dasharray="7 4"' : ''}/>`);
    }
  }
  parts.push('<text x="65" y="404" fill="#efad71" font-size="12">A1 original, solid · A2 original, dashed</text>', '<text x="615" y="404" fill="#79bee9" font-size="12">B1 optimized, solid · B2 optimized, dashed</text>', '</g></svg>');
  return parts.join('\n');
}

export function thermalHtml(summary, trials) {
  const table = trials
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.label)} · ${escapeHtml(r.variant)}</td><td>${escapeHtml(r.commit?.slice(0, 7))}</td><td>${number(r.startTemperatures.cpu)} / ${number(r.startTemperatures.gpu)}</td><td>${number(r.cpuC.mean)} / ${number(r.gpuC.mean)}</td><td>${number(r.pacing.fps)}</td><td>${number(r.presenter?.fps)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Office thermal comparison</title><style>
*{box-sizing:border-box}body{margin:0;background:#111110;color:#e9e7e2;font:17px/1.5 system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:48px}h1{font-size:42px;line-height:1.1}h2{font-size:25px}p,small{color:#aaa9a3}section{border:1px solid #373631;padding:24px;margin:24px 0}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:12px;border-bottom:1px solid #34332e;text-align:left}th{font-size:13px;color:#aaa9a3}img{width:100%}small{display:block;margin-top:20px}
</style><main>
<header data-wb-id="thermal-summary"><p>BEFORE / AFTER · ${summary.fps} FPS · ${escapeHtml(summary.backend)}</p><h1>Measured temperatures.<br>Report the uncertainty.</h1>
<p>${escapeHtml(summary.configuration.renderer)} · ${summary.configuration.output.width} × ${summary.configuration.output.height}. Two independent trials per version, ABBA order. These are late-run means, not automatically thermal equilibrium.</p></header>
<section data-wb-id="thermal-means"><h2>Sensor averages</h2><table><tr><th></th><th>Before</th><th>After</th><th>After − before</th></tr>
<tr><td>CPU</td><td>${number(summary.before.cpuC.mean)}°C</td><td>${number(summary.after.cpuC.mean)}°C</td><td>${number(summary.afterMinusBefore.cpuC)}°C</td></tr>
<tr><td>GPU</td><td>${number(summary.before.gpuC.mean)}°C</td><td>${number(summary.after.gpuC.mean)}°C</td><td>${number(summary.afterMinusBefore.gpuC)}°C</td></tr></table>
<p>Before-trial range: CPU ${number(summary.before.cpuC.max - summary.before.cpuC.min)}°C, GPU ${number(summary.before.gpuC.max - summary.before.gpuC.min)}°C. After-trial range: CPU ${number(summary.after.cpuC.max - summary.after.cpuC.min)}°C, GPU ${number(summary.after.gpuC.max - summary.after.gpuC.min)}°C.</p>
<p>Compare the average difference with repeat variation, starting temperatures and continued warming. The one-second samples are correlated, not extra independent trials.</p></section>
<section data-wb-id="thermal-traces"><h2>Full load traces</h2><img src="temperature-traces.svg" alt="All four CPU and GPU load traces; five-second averages, with measurement windows shaded"></section>
<section data-wb-id="thermal-trials"><h2>Every valid trial</h2><table><tr><th>Trial</th><th>Commit</th><th>Start CPU/GPU °C</th><th>Late CPU/GPU °C</th><th>Drawn FPS</th><th>Presented FPS</th></tr>${table}</table></section>
<section data-wb-id="thermal-limits"><h2>Limits</h2><ul>${summary.limits.map((limit) => `<li>${escapeHtml(limit)}</li>`).join('')}</ul><p>Warmup ${trials[0].warmupSeconds}s; measurement ${trials[0].measurementSeconds}s. No room-temperature control. Inspect machine.json, protocol.json and raw sensors.jsonl before attributing a difference to the code.</p></section>
<small>Raw measurements stay local. Report generated without network access.</small></main></html>`;
}

export function writeThermalReport(out) {
  const trials = ['A1', 'B1', 'B2', 'A2'].map((label) => JSON.parse(readFileSync(path.join(out, label, 'result.json'), 'utf8')));
  const summary = summarizeTrials(trials);
  const samples = trials.map((r) =>
    readFileSync(path.join(out, r.label, 'sensors.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  );
  writeFileSync(path.join(out, 'temperature-traces.svg'), traceSvg(trials, samples));
  writeFileSync(path.join(out, 'report.html'), thermalHtml(summary, trials));
  return { out, ...summary.afterMinusBefore };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node tools/frame-bench/thermal-report.mjs RESULTS_DIR');
    console.log(writeThermalReport(path.resolve(process.argv[2])));
  } catch (error) {
    console.error(`thermal-report: ${error.message}`);
    process.exitCode = 1;
  }
}
