// Markdown tables for bench.mjs results (one JSON object per scenario run).
const ms = (n) => (n == null ? '-' : `${n.toFixed(1)}`);
/** A header row and its separator row, from the column names. */
const header = (...cols) => [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** `median` alone for one run, `median [min–max]` over repeats. */
const spreadOf = (xs, digits = 1) => {
  const m = median(xs).toFixed(digits);
  return xs.length > 1 ? `${m} [${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)}]` : m;
};

/** One table row per (config, cap, scenario): the median over repeats, with the range of the tail numbers in brackets. */
export function tables(rows) {
  const paced = rows.filter((r) => r.report);
  const key = (r) => `${r.config}|${r.cap}|${r.scenario}`;
  const groups = new Map();
  for (const r of paced) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  const lines = [...header('Config', 'Renderer', 'Cap', 'Scenario', 'Runs', 'Frames', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'Missed', 'Repeated', 'CPU p50 ms', 'GPU scene+hands ms')];
  for (const g of groups.values()) {
    const r = g[0];
    const f = (pick) => g.map((x) => pick(x.report));
    const gpu = g.every((x) => x.report.gpu.scene != null && x.report.gpu.hands != null) ? `${median(f((x) => x.gpu.scene)).toFixed(1)} + ${median(f((x) => x.gpu.hands)).toFixed(1)}` : '-';
    lines.push(
      `| ${r.config} | ${r.renderer} | ${r.cap} | ${r.scenario} | ${g.length} | ${Math.round(median(f((x) => x.frames)))} | ${spreadOf(f((x) => x.frameTime.p50))} | ${spreadOf(f((x) => x.frameTime.p95))} | ${spreadOf(f((x) => x.frameTime.p99))} | ${spreadOf(f((x) => x.frameTime.max))} | ${spreadOf(
        f((x) => x.missed),
        0,
      )} | ${spreadOf(
        f((x) => x.repeated),
        0,
      )} | ${spreadOf(f((x) => x.cpu.total.p50))} | ${gpu} |`,
    );
  }
  const shown = paced.filter((r) => r.display && r.scenario !== 'idle');
  if (shown.length) {
    const dgroups = new Map();
    for (const r of shown) dgroups.set(key(r), [...(dgroups.get(key(r)) ?? []), r]);
    lines.push('', ...header('Config', 'Cap', 'Scenario', 'Runs', 'Display fps', 'gap p50 ms', 'gap p95 ms', 'gap p99 ms', 'gap max ms', 'Late', 'Extra refreshes'));
    for (const g of dgroups.values()) {
      const r = g[0];
      const d = (pick) => g.map((x) => pick(x.display));
      lines.push(
        `| ${r.config} | ${r.cap} | ${r.scenario} | ${g.length} | ${spreadOf(d((x) => x.fps))} | ${spreadOf(d((x) => x.gap.p50))} | ${spreadOf(d((x) => x.gap.p95))} | ${spreadOf(d((x) => x.gap.p99))} | ${spreadOf(d((x) => x.gap.max))} | ${spreadOf(
          d((x) => x.missed),
          0,
        )} | ${spreadOf(
          d((x) => x.repeated),
          0,
        )} |`,
      );
    }
  }
  const loads = rows.filter((r) => r.scenario?.startsWith('load-'));
  if (loads.length) {
    lines.push('', ...header('Config', 'Renderer', 'Cap', 'Load', 'Page shown s', 'Warm-up done s', 'RAF p50 ms', 'RAF p99 ms', 'RAF longest ms', 'Slow frames'));
    for (const r of loads)
      lines.push(
        `| ${r.config} | ${r.renderer} | ${r.cap} | ${r.scenario.slice(5)} | ${(r.load.shownMs / 1000).toFixed(1)} | ${(r.load.warmMs / 1000).toFixed(1)} | ${ms(r.raf.gap.p50)} | ${ms(r.raf.gap.p99)} | ${ms(r.raf.longest)} | ${r.raf.over} of ${r.raf.frames} |`,
      );
  }
  return lines.join('\n');
}
