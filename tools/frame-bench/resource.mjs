// What a scenario cost the machine: CPU time and memory of the app's processes, and the GPU's utilization. Used by bench.mjs
// with --resources, so two builds can be compared on what they use as well as on how they pace.
//
// CPU is the processes' cumulative CPU time (`ps -o cputime`, 10 ms resolution) over the window, as a share of one core, so
// it is an exact average and not `ps`'s decaying %CPU. Memory is the processes' resident size, sampled every second. GPU is
// the system-wide Apple GPU utilization from IOKit (`ioreg`, no privileges needed): it cannot say which process used it,
// so a quiet machine matters. Per-process GPU needs powermetrics, which needs sudo.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out));
  });

/** `1:02:03.45`, `2:03.45` or `3.45` as seconds. */
export function cpuSeconds(text) {
  const parts = text.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/** What kind of Electron process a command line is. */
export function roleOf(command) {
  if (command.includes('(Renderer)')) return 'renderer';
  if (command.includes('(GPU)')) return 'gpu';
  if (command.includes('Helper')) return 'helper';
  return 'main';
}

/** The processes of one app from `ps -Ao pid,cputime,rss,command` output: those whose command is inside the app bundle (under any of its paths: /tmp is /private/tmp for helpers). */
export function parsePs(text, appPaths) {
  const paths = [appPaths].flat();
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || !paths.some((p) => m[4].includes(p))) continue;
    out.push({ pid: Number(m[1]), cpuSec: cpuSeconds(m[2]), rssKb: Number(m[3]), role: roleOf(m[4]) });
  }
  return out;
}

/** The AGX accelerator's utilization numbers from `ioreg -r -d 1 -w0 -c AGXAccelerator`. */
export function parseGpu(text) {
  const num = (name) => {
    const m = new RegExp(`"${name}"=(\\d+)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  return { device: num('Device Utilization %'), renderer: num('Renderer Utilization %'), tiler: num('Tiler Utilization %'), memoryMb: num('In use system memory') == null ? null : num('In use system memory') / 1048576 };
}

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const max = (xs) => {
  const s = xs.filter((x) => x != null);
  return s.length ? Math.max(...s) : null;
};

/** The summary of a window from the first and last process lists and every sample taken in between. Pure. */
export function summarize({ first, last, seconds, samples }) {
  const before = new Map(first.map((p) => [p.pid, p]));
  const cpu = { total: 0 };
  for (const p of last) {
    const was = before.get(p.pid);
    if (!was) continue;
    const pct = (Math.max(0, p.cpuSec - was.cpuSec) / seconds) * 100;
    cpu.total += pct;
    cpu[p.role] = (cpu[p.role] ?? 0) + pct;
  }
  const rss = samples.map((s) => s.procs.reduce((total, p) => total + p.rssKb, 0) / 1024);
  const rssByRole = {};
  for (const role of new Set(samples.flatMap((s) => s.procs.map((p) => p.role)))) rssByRole[role] = median(samples.map((s) => s.procs.filter((p) => p.role === role).reduce((total, p) => total + p.rssKb, 0) / 1024));
  return {
    seconds,
    cpuPct: cpu,
    rssMb: { median: median(rss), max: max(rss), byRoleMedian: rssByRole },
    processes: Math.max(0, ...samples.map((s) => s.procs.length)),
    gpu: {
      device: { median: median(samples.map((s) => s.gpu.device)), max: max(samples.map((s) => s.gpu.device)) },
      renderer: { median: median(samples.map((s) => s.gpu.renderer)), max: max(samples.map((s) => s.gpu.renderer)) },
      tiler: { median: median(samples.map((s) => s.gpu.tiler)), max: max(samples.map((s) => s.gpu.tiler)) },
      memoryMb: { median: median(samples.map((s) => s.gpu.memoryMb)), max: max(samples.map((s) => s.gpu.memoryMb)) },
    },
  };
}

/** Starts sampling the app's processes and the GPU every `every` ms. `stop()` returns the summary of the window. */
export async function startResourceSampler(app, every = 1000) {
  const appPaths = [...new Set([path.resolve(app), realpathSync(app)])];
  const ps = async () => parsePs(await run('ps', ['-Ao', 'pid,cputime,rss,command']), appPaths);
  const gpu = async () => parseGpu(await run('ioreg', ['-r', '-d', '1', '-w0', '-c', 'AGXAccelerator']));
  const t0 = Date.now();
  const first = await ps();
  const samples = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const [procs, g] = await Promise.all([ps(), gpu()]);
      samples.push({ procs, gpu: g });
      await new Promise((r) => setTimeout(r, every));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      const last = await ps();
      return summarize({ first, last, seconds: (Date.now() - t0) / 1000, samples: samples.length ? samples : [{ procs: last, gpu: await gpu() }] });
    },
  };
}
