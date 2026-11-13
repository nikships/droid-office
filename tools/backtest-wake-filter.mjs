#!/usr/bin/env node
// Backtests the inter-agent noise gate (src/server/wake-filter.ts) live against gemini-decision-1 on
// real Factory Droid session history. Reads ~/.factory/sessions and a floor's .droid-office/team.json,
// rebuilds each message's team context at the moment it was sent, and routes it through the shipped
// WakeFilter. Writes the audit trail outside the repository; never commit its output.
//
//   node --import tsx tools/backtest-wake-filter.mjs [--key-file <gemini.json>] [--team <team.json>] [--out <dir>] [--limit <n>] [--dry]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { redactGeminiSecrets } from '../src/server/gemini-decisions.ts';
import { CHATTER_WINDOW_MS, WakeFilter, wakeGuard } from '../src/server/wake-filter.ts';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SESSIONS = arg('--sessions', path.join(os.homedir(), '.factory/sessions'));
const KEY_FILE = arg('--key-file', path.join(os.homedir(), 'office-info/.droid-office/gemini.json'));
const TEAM_FILE = arg('--team', path.join(os.homedir(), 'repos/droid-office/.droid-office/team.json'));
const OUT = arg('--out', path.join(os.tmpdir(), 'wake-filter-backtest'));
const LIMIT = Number(arg('--limit', '200'));
const DRY = process.argv.includes('--dry');
const CAPS = { team_report: 0.42, progress: 0.2, team_note: 0.26, done: 0.1, lead_notify: 0.02 };
const TOOLS = ['team_report', 'lead_notify', 'team_note', 'visit_message'];
const PR_RE = /https:\/\/(?:github\.com|gitlab\.com)\/[^\s)<>]+\/(?:pull|merge_requests)\/\d+/;

const rg = (pattern) => {
  try {
    return execFileSync('rg', ['-l', '--glob', '*.jsonl', pattern, SESSIONS], { encoding: 'utf8', maxBuffer: 1 << 27 })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

/** `droid_office.<tool>({...})` calls inside a Script, with its `// @input:` blocks resolved. */
function scriptCalls(script) {
  const inputs = {};
  const re = /\/\/ @input: (\w+) <<'([^']+)'\n([\s\S]*?)\n\2(?:\n|$)/g;
  for (let m = re.exec(script); m; m = re.exec(script)) inputs[m[1]] = m[3];
  const out = [];
  const call = /droid_office\.(team_report|lead_notify|team_note|visit_message)\(\s*\{/g;
  for (let m = call.exec(script); m; m = call.exec(script)) {
    let depth = 0;
    let end = -1;
    let quote = '';
    const start = m.index + m[0].length - 1;
    for (let i = start; i < script.length; i++) {
      const ch = script[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    try {
      // Agent-authored literals only: a frozen context with nothing but the resolved input blocks.
      const value = vm.runInNewContext(`(${script.slice(start, end + 1)})`, { inputs: Object.freeze({ ...inputs }) }, { timeout: 50 });
      if (value && typeof value === 'object' && typeof value.text === 'string') out.push({ tool: m[1], input: JSON.parse(JSON.stringify(value)) });
    } catch {}
  }
  return out;
}

const textOf = (content) =>
  Array.isArray(content)
    ? content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
    : typeof content === 'string'
      ? content
      : '';

function readSession(file) {
  const s = { file, dir: path.basename(path.dirname(file)), times: [], calls: [], todos: [], said: [] };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === 'session_start') s.cwd = d.cwd;
    const at = Date.parse(d.timestamp ?? '');
    const msg = d.message;
    if (!msg || !Number.isFinite(at)) continue;
    s.times.push(at);
    const body = textOf(msg.content);
    if (msg.role === 'user' && !s.role) {
      const role = /Droid Office role: ([^,(\n]+?)(?:, subagent of ([^(\n]+?))? \(/.exec(body);
      if (role) {
        s.role = role[1].trim();
        if (role[2]) s.lead = role[2].trim();
      }
    }
    if (msg.role === 'user' && !s.task) {
      const task = /## Task from [^\n]+\n```text\n([\s\S]*?)\n```/.exec(body);
      if (task) s.task = task[1];
    }
    if (msg.role === 'assistant') {
      if (body.trim()) s.said.push({ at, text: body.trim() });
      for (const c of msg.content ?? []) {
        if (c.type !== 'tool_use') continue;
        const name = String(c.name ?? '');
        if (name === 'TodoWrite') s.todos.push({ at, todos: c.input?.todos });
        const direct = name.replace(/^droid-office___/, '');
        if (name.startsWith('droid-office___') && TOOLS.includes(direct)) s.calls.push({ at, tool: direct, input: c.input ?? {} });
        if (name === 'Script' && typeof c.input?.script === 'string') {
          if (/TodoWrite\(\{\s*todos:\s*`/.test(c.input.script)) s.todos.push({ at, todos: /TodoWrite\(\{\s*todos:\s*`([\s\S]*?)`/.exec(c.input.script)?.[1] });
          for (const sc of scriptCalls(c.input.script)) s.calls.push({ at, ...sc });
        }
      }
    }
  }
  s.first = s.times.length ? Math.min(...s.times) : 0;
  s.last = s.times.length ? Math.max(...s.times) : 0;
  return s;
}

const steps = (todos) => {
  if (Array.isArray(todos)) return todos.map((t) => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') }));
  if (typeof todos !== 'string') return [];
  return todos
    .split('\n')
    .map((l) => /^\s*\d+\.\s*\[(\w+)\]\s*(.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ status: m[1], content: m[2] }));
};
const near = (s, t, ms) => s.times.some((x) => Math.abs(x - t) <= ms);
const before = (list, t) => list.filter((x) => x.at <= t).at(-1);

function statusAt(s, t) {
  if (s.first > t + 5000) return undefined;
  if (s.last < t - 5000) return 'done';
  return near(s, t, 120_000) ? 'working' : 'done';
}

function teammateAt(s, t) {
  const status = statusAt(s, t);
  if (!status) return undefined;
  const notes = s.calls.filter((c) => c.tool === 'team_note' && c.at <= t);
  const lastNote = notes.at(-1);
  const areas = [...notes].reverse().find((c) => Array.isArray(c.input.areas))?.input.areas;
  const rep = [...s.calls].reverse().find((c) => c.tool === 'team_report' && c.at <= t);
  return {
    id: s.file,
    name: s.role ?? 'Worker',
    status,
    ...(s.task ? { task: s.task.slice(0, 300) } : {}),
    ...(areas?.length ? { areas } : {}),
    ...(lastNote ? { note: lastNote.input.text } : {}),
    ...(rep
      ? {
          report: {
            kind: rep.input.question ? 'question' : rep.input.progress ? 'progress' : 'report',
            summary: String(rep.input.result?.summary ?? rep.input.text).slice(0, 300),
            ...(rep.input.result?.status ? { status: rep.input.result.status } : {}),
          },
        }
      : {}),
  };
}

function leadAt(name, sessions, t) {
  const own = sessions.filter((s) => (name === 'Orchestrator' ? /orchestrator/i.test(s.dir) || s.role === 'Orchestrator' : s.role === name) && s.first <= t + 5000 && s.last >= t - 3_600_000);
  const s = own.sort((a, b) => Math.abs(a.last - t) - Math.abs(b.last - t))[0];
  if (!s) return { id: name, name, ...(name === 'Orchestrator' ? { building: true } : {}), status: 'done' };
  const plan = before(s.todos, t);
  const said = s.said
    .filter((x) => x.at <= t)
    .slice(-3)
    .map((x) => x.text)
    .join('\n')
    .slice(-1200);
  return {
    id: s.file,
    name,
    ...(name === 'Orchestrator' ? { building: true } : {}),
    status: near(s, t, 30_000) && s.last > t + 10_000 ? 'working' : 'done',
    ...(s.task ? { task: s.task.slice(0, 600) } : {}),
    ...(plan ? { steps: steps(plan.todos) } : {}),
    ...(said ? { tail: said } : {}),
  };
}

function chatterAt(s, t) {
  const recent = s.calls.filter((c) => c.at < t && t - c.at <= CHATTER_WINDOW_MS);
  const routine = recent.filter((c) => !c.input.question && !c.input.prUrl && !c.input.pushedSha && c.input.kind !== 'blocker' && c.input.kind !== 'question').length;
  const last = s.calls.filter((c) => c.at < t).at(-1);
  return { routine, total: recent.length, ...(last ? { sinceLastMs: t - last.at } : {}) };
}

function packetFor(ev, sessions) {
  const { s, call } = ev;
  const t = call.at;
  const i = call.input;
  // One entry per teammate name: the session of that name nearest the moment, never the sender itself.
  const nearest = new Map();
  for (const o of sessions) {
    if (o === s || o.role === s.role || o.lead !== s.lead || o.first > t + 5000 || o.last < t - 6 * 3_600_000) continue;
    const had = nearest.get(o.role);
    const gap = (x) => (x.first <= t && x.last >= t ? 0 : Math.min(Math.abs(x.first - t), Math.abs(x.last - t)));
    if (!had || gap(o) < gap(had)) nearest.set(o.role, o);
  }
  const team = [...nearest.values()];
  const teammates = team.map((o) => teammateAt(o, t)).filter(Boolean);
  const notes = s.calls.filter((c) => c.tool === 'team_note' && c.at < t);
  const prevAreas = [...notes].reverse().find((c) => Array.isArray(c.input.areas))?.input.areas ?? [];
  const sender = { id: s.file, name: s.role, ...(s.task ? { task: s.task.slice(0, 300) } : {}), ...(prevAreas.length ? { areas: prevAreas } : {}) };
  const lead = leadAt(s.lead, sessions, t);
  if (call.tool === 'team_note') {
    const areas = Array.isArray(i.areas) ? i.areas : prevAreas;
    const areasChanged = Array.isArray(i.areas) && i.areas.join('\n') !== prevAreas.join('\n');
    // Working siblings that have not reported in their current turn (approximated as the last ten minutes).
    const reportedRecently = new Set(team.filter((o) => o.calls.some((c) => c.tool === 'team_report' && c.at <= t && c.at > t - 600_000)).map((o) => o.file));
    const siblings = teammates.filter((m) => m.status === 'working' && !reportedRecently.has(m.id));
    return { channel: 'team_note', lead, sender, teammates, siblings, message: { text: i.text, areas, areasChanged } };
  }
  if (call.tool === 'lead_notify')
    return { channel: 'lead_notify', lead: { ...lead, building: true }, sender, teammates, message: { text: i.text, kind: i.kind ?? 'update', ...(i.pushedSha ? { pushedSha: i.pushedSha } : {}), ...(i.prUrl ? { prUrl: i.prUrl } : {}) } };
  const result = i.result ?? {};
  const prUrl = i.prUrl ?? result.artifacts?.prUrl ?? PR_RE.exec(i.text)?.[0];
  return {
    channel: 'team_report',
    lead,
    sender,
    teammates,
    message: {
      text: i.text,
      ...(i.progress ? { progress: true } : {}),
      ...(i.question ? { question: true } : {}),
      resultStatus: result.status ?? (i.question ? 'blocked' : i.progress ? 'partial' : 'ok'),
      ...(result.conflicts?.length ? { conflicts: result.conflicts.length } : {}),
      ...(i.pushedSha ? { pushedSha: i.pushedSha } : {}),
      ...(prUrl ? { prUrl } : {}),
      ...(result.artifacts?.commits?.length ? { commits: result.artifacts.commits.length } : {}),
      ...(result.artifacts?.files?.length ? { files: result.artifacts.files.slice(0, 20) } : {}),
      ...(i.images?.length ? { images: i.images.length } : {}),
    },
  };
}

function teamJsonDone() {
  if (!existsSync(TEAM_FILE)) return [];
  const j = JSON.parse(readFileSync(TEAM_FILE, 'utf8'));
  const events = j.events ?? [];
  return events
    .filter((e) => e.kind === 'done')
    .map((e) => {
      const others = events.filter((x) => x.lead === e.lead && x.worker !== e.worker && Math.abs(x.at - e.at) < 3_600_000);
      const byWorker = new Map();
      for (const x of others) if (!byWorker.has(x.worker) || byWorker.get(x.worker).at < x.at) byWorker.set(x.worker, x);
      const teammates = [...byWorker.values()].map((x) => ({ id: x.worker, name: x.name, status: x.at > e.at ? 'working' : 'done', ...(x.text ? { report: { kind: x.kind, summary: String(x.text).slice(0, 200) } } : {}) }));
      return {
        source: 'team.json',
        at: e.at,
        packet: {
          channel: 'done',
          lead: { id: e.lead, name: e.lead === 'orchestrator' ? 'Orchestrator' : e.lead, status: 'done' },
          sender: { id: e.worker, name: e.name },
          teammates,
          message: { text: e.text ?? 'Finished its turn without sending a report.' },
        },
      };
    });
}

/** Clearly labeled synthetic chatter, separate from the real corpus: proves the block path fires at all. */
const SYNTHETIC = [
  ['lead_notify', 'Still going! Making great progress, will keep you posted.'],
  ['lead_notify', 'Working on it now, everything is going smoothly so far.'],
  ['lead_notify', 'Just checking in again, still on it!'],
  ['team_note', 'Hi team! Excited to be working with everyone on this.'],
  ['team_note', 'Still chugging along, nothing to share yet.'],
  ['visit_tell', 'Hey! Just saying hi, hope your day is going well.'],
  ['lead_notify', 'Phase 1 done, starting phase 2 now.'],
  ['lead_notify', 'Lint is green, now waiting on CI.'],
  ['team_note', 'Heads up: I renamed WakeVerdict.notify to notifyIds in src/server/wake-filter.ts; update your imports.'],
  ['lead_notify', 'Blocked: npm ci fails with EACCES on node_modules/.bin, need a decision on reinstalling.'],
];

function syntheticPackets(sessions) {
  const lead = { id: 'L', name: 'Orchestrator', building: true, status: 'done', task: 'Coordinate subagents on the settings pane rebuild.' };
  const teammates = [
    { id: 'a', name: 'Byte', status: 'working', task: 'Client settings UI', areas: ['src/client/ui/gemini-settings.ts'] },
    { id: 'b', name: 'Nova', status: 'working', task: 'Server wake filter', areas: ['src/server/wake-filter.ts'] },
  ];
  void sessions;
  return SYNTHETIC.map(([channel, text], n) => ({
    source: 'synthetic',
    at: Date.now(),
    packet: {
      channel,
      lead: channel === 'visit_tell' ? { id: 'h', name: 'Cosmo', status: 'working', task: 'Fixing flaky e2e test' } : lead,
      sender: { id: `syn-${n}`, name: 'Pixel', task: 'Docs pass' },
      teammates: channel === 'visit_tell' ? [] : teammates,
      ...(channel === 'team_note' ? { siblings: teammates } : {}),
      message: { text, ...(channel === 'lead_notify' ? { kind: 'update' } : channel === 'visit_tell' ? { kind: 'tell' } : {}) },
    },
    chatter: { routine: 3, total: 3, sinceLastMs: 45_000 },
  }));
}

function seeded(seed) {
  let x = seed >>> 0;
  return () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const files = [...new Set([...rg('"name":"droid-office___(team_report|lead_notify|team_note)"'), ...rg('droid_office\\.(team_report|lead_notify|team_note)\\('), ...rg('Droid Office role:')])];
const sessions = files.map(readSession).filter((s) => s.role);
const real = [];
const seen = new Set();
for (const s of sessions) {
  if (!s.lead) continue;
  for (const call of s.calls) {
    if (call.tool === 'visit_message') continue;
    const sig = `${s.role}|${String(call.input.text).slice(0, 120)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    real.push({ source: 'session', s, call, at: call.at, group: `${s.lead}|${new Date(call.at).toISOString().slice(0, 13)}` });
  }
}
const stratum = (e) => (e.call.tool === 'team_report' ? (e.call.input.progress ? 'progress' : 'team_report') : e.call.tool);
const groups = new Map();
for (const e of real) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
const rand = seeded(20261113);
const order = [...groups.keys()]
  .sort()
  .map((k) => [rand(), k])
  .sort((a, b) => a[0] - b[0])
  .map(([, k]) => k);
const picked = [];
const taken = {};
const want = (k) => Math.ceil(LIMIT * (CAPS[k] ?? 0));
const dones = teamJsonDone();
for (const g of order) {
  for (const e of groups.get(g).sort((a, b) => a.at - b.at)) {
    const k = stratum(e);
    if ((taken[k] ?? 0) >= want(k)) continue;
    taken[k] = (taken[k] ?? 0) + 1;
    picked.push(e);
  }
}
const doneSample = dones.sort(() => rand() - 0.5).slice(0, want('done'));
const corpus = [
  ...picked.map((e) => ({ source: 'session', at: e.at, group: e.group, packet: packetFor(e, sessions), chatter: chatterAt(e.s, e.at) })),
  ...doneSample.map((d) => ({ ...d, group: `${d.packet.lead.id}|${new Date(d.at).toISOString().slice(0, 13)}` })),
  ...syntheticPackets(sessions),
];
const key = JSON.parse(readFileSync(KEY_FILE, 'utf8')).apiKey;
const scrub = (v) => redactGeminiSecrets(v, [key]);
for (const c of corpus) {
  c.packet.message.text = scrub(String(c.packet.message.text));
}
console.log(`sessions ${sessions.length}, real events ${real.length}, corpus ${corpus.length} (${JSON.stringify({ ...taken, done: doneSample.length, synthetic: SYNTHETIC.length })})`);
if (DRY) process.exit(0);

class BacktestFilter extends WakeFilter {
  constructor(chatter) {
    super({ store: { apiKey: () => key, connected: () => true, wakeFilterOn: () => true, rejected: () => undefined }, airgapped: () => false });
    this.fixed = chatter;
  }
  chatterOf() {
    return this.fixed ?? { routine: 0, total: 0 };
  }
}

const results = await pool(corpus, 6, async (c) => {
  const filter = new BacktestFilter(c.chatter);
  const started = Date.now();
  const verdict = await filter.decide(c.packet);
  return { ...c, verdict, wallMs: Date.now() - started, guard: wakeGuard(c.packet) };
});

const realResults = results.filter((r) => r.source !== 'synthetic');
const by = (list, f) => list.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
const lat = realResults
  .map((r) => r.verdict.latencyMs)
  .filter((x) => typeof x === 'number')
  .sort((a, b) => a - b);
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
const leadChannels = new Set(['team_report', 'done', 'lead_notify']);
const leadEvents = realResults.filter((r) => leadChannels.has(r.packet.channel)).sort((a, b) => a.at - b.at);
let wakeups = 0;
const pendingHold = new Map();
for (const r of leadEvents) {
  const g = r.group;
  if (r.verdict.traffic === 'wake_immediately') {
    wakeups++;
    pendingHold.delete(g);
  } else if (r.verdict.traffic === 'hold_for_batch') pendingHold.set(g, true);
}
wakeups += pendingHold.size;
const notes = realResults.filter((r) => r.packet.channel === 'team_note');
const siblingCandidates = notes.reduce((n, r) => n + (r.packet.siblings?.length ?? 0), 0);
const siblingNotified = notes.reduce((n, r) => n + (r.verdict.notify ? r.verdict.notify.length : (r.packet.siblings?.length ?? 0)), 0);
const summary = {
  model: 'gemini-decision-1',
  realEvaluated: realResults.length,
  synthetic: results.length - realResults.length,
  byChannel: by(realResults, (r) => `${r.packet.channel}${r.packet.message.progress ? ':progress' : ''}`),
  byTraffic: by(realResults, (r) => r.verdict.traffic),
  bySource: by(realResults, (r) => r.verdict.source),
  realBlocked: realResults.filter((r) => r.verdict.traffic === 'block_and_coach').length,
  syntheticByTraffic: by(
    results.filter((r) => r.source === 'synthetic'),
    (r) => r.verdict.traffic,
  ),
  leadWakeupsBaseline: leadEvents.length,
  leadWakeupsGated: wakeups,
  wakeupsSavedPct: leadEvents.length ? Math.round((1 - wakeups / leadEvents.length) * 1000) / 10 : 0,
  siblingCandidates,
  siblingNotified,
  latencyMs: { median: pct(0.5), p95: pct(0.95), max: lat.at(-1) ?? null },
  inputTokens: realResults.reduce((n, r) => n + (r.verdict.inputTokens ?? 0), 0),
  outputTokens: 0,
};
mkdirSync(OUT, { recursive: true });
const audit = results.map((r) => ({
  source: r.source,
  at: new Date(r.at).toISOString(),
  channel: r.packet.channel,
  progress: r.packet.message.progress ?? false,
  lead: r.packet.lead.name,
  sender: r.packet.sender.name,
  teammates: r.packet.teammates.map((t) => `${t.name}:${t.status}`),
  siblings: r.packet.siblings?.map((t) => t.name),
  notified: r.verdict.notify?.map((id) => r.packet.siblings?.find((t) => t.id === id)?.name),
  traffic: r.verdict.traffic,
  vsource: r.verdict.source,
  reason: r.verdict.reason,
  probabilities: r.verdict.probabilities,
  pureChatter: r.verdict.pureChatter,
  noBlock: r.guard.noBlock,
  latencyMs: r.verdict.latencyMs,
  text: r.packet.message.text.slice(0, 600),
}));
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`audit: ${path.join(OUT, 'audit.json')}`);
