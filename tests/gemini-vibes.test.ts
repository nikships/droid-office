import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as THREE from 'three';
import { Worker } from '../src/client/world/character.js';
import { Sky, withBaselineOfficeFill } from '../src/client/world/sky.js';
import { callGeminiDecisions, GeminiDecisionsStore, probeGeminiKey, redactGeminiSecrets } from '../src/server/gemini-decisions.js';
import { buildFloorDecisionsBatch, OfficeVibes, type VibesClientView, type VibesFloorView } from '../src/server/office-vibes.js';
import {
  emptyFloorVibes,
  emptyGeminiState,
  DESK_MOMENT_FX,
  FLOOR_EVENT_COOLDOWN_MS,
  FLOOR_EVENT_FX,
  FLOOR_EVENTS,
  FLOOR_MOOD_LIGHTING,
  fingerprintGeminiKey,
  isFloorEvent,
  isFloorMood,
  isMonitorSpillTone,
  isValidGeminiApiKey,
  isWorkerMicroReaction,
  isWorkerVibePosture,
  MICRO_REACTION_COOLDOWN_MS,
  MICRO_REACTION_FX,
  MONITOR_SPILL_HEX,
  MONITOR_SPILL_POWER,
  unitFromScore,
  WORKER_MICRO_REACTIONS,
} from '../src/shared/gemini-vibes.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { ROOF } from '../src/shared/rooftop.js';

const TEST_KEY = 'AIzaSyTestKeyForUnitVerification0123456789';

function makeWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id: 'w-alpha',
    kind: 'agent',
    deskId: 'desk-1',
    name: 'Byte',
    color: '#ee6018',
    status: 'working',
    acked: false,
    createdBy: 'Owner',
    createdAt: 1_700_000_000_000,
    cols: 136,
    rows: 39,
    open: false,
    action: 'edit',
    activity: 'Editing src/server/office-vibes.ts',
    task: { name: 'Living 3D Vibes', summary: 'Wiring Gemini Decision 1 pulse' },
    ...overrides,
  };
}

test('shared gemini-vibes validators, key fingerprinting and defaults', () => {
  assert.equal(isValidGeminiApiKey(TEST_KEY), true);
  assert.equal(isValidGeminiApiKey('short'), false);
  assert.equal(isValidGeminiApiKey('AIza key with spaces 1234567890'), false);
  assert.equal(isValidGeminiApiKey('AIza\u0000control12345678901234'), false);
  assert.equal(fingerprintGeminiKey(TEST_KEY), 'AIza…6789');
  assert.equal(fingerprintGeminiKey('shortkey'), '••••');

  assert.equal(isWorkerVibePosture('flow'), true);
  assert.equal(isWorkerVibePosture('investigating'), true);
  assert.equal(isWorkerVibePosture('struggling'), true);
  assert.equal(isWorkerVibePosture('deliberating'), true);
  assert.equal(isWorkerVibePosture('debugging'), false, 'postures are states of mind, not the tool in use');
  assert.equal(isWorkerVibePosture('steady'), true);
  assert.equal(isWorkerVibePosture('dancing'), false);

  for (const kind of ['eureka', 'breakthrough', 'setback', 'puzzled', 'frustrated', 'pivot', 'rabbit_hole', 'corner_cut', 'risky_move']) assert.equal(isWorkerMicroReaction(kind), true, kind);
  // Facts the office already knows play as desk moments without asking Gemini.
  for (const kind of ['shipped', 'team_sync', 'relief']) assert.equal(isWorkerMicroReaction(kind), false, kind);
  for (const kind of ['hired', 'finished', 'shipped', 'sent_home', 'shot'] as const) assert.ok(DESK_MOMENT_FX[kind].glyph && DESK_MOMENT_FX[kind].hex.startsWith('#'), kind);
  assert.equal(isWorkerMicroReaction('none'), false);
  for (const kind of WORKER_MICRO_REACTIONS) assert.ok(MICRO_REACTION_FX[kind].glyph && MICRO_REACTION_FX[kind].hex.startsWith('#'), kind);
  for (const kind of FLOOR_EVENTS) {
    assert.equal(isFloorEvent(kind), true, kind);
    assert.ok(FLOOR_EVENT_FX[kind].pulses >= 1, kind);
  }
  assert.equal(isFloorEvent('none'), false);
  assert.equal(isFloorEvent('ship_it'), false, 'a pull request opening is played from worker updates, not graded');
  assert.ok(FLOOR_EVENT_FX.ship_it.pulses >= 1);
  assert.equal(unitFromScore(3), 0.75);
  assert.equal(unitFromScore(9), 1);
  assert.equal(unitFromScore(-1), 0);
  assert.equal(unitFromScore(Number.NaN), undefined);
  assert.equal(FLOOR_MOOD_LIGHTING.calm_planning.pulse, 0, 'the baseline mood holds still');
  assert.equal(FLOOR_MOOD_LIGHTING.calm_planning.hex, '#383a46', 'the baseline mood is the clear-night fill Remastered bakes against');
  for (const mood of ['deep_crunch', 'debugging_tension', 'celebration_swell'] as const) assert.ok(FLOOR_MOOD_LIGHTING[mood].pulse > 0, mood);
  for (const tone of ['emerald', 'amber', 'crimson'] as const) assert.ok(MONITOR_SPILL_POWER[tone] >= 2, tone);

  assert.equal(isMonitorSpillTone('emerald'), true);
  assert.equal(isMonitorSpillTone('crimson'), true);
  assert.equal(isMonitorSpillTone('purple'), false);
  assert.equal(isFloorMood('deep_crunch'), true);
  assert.equal(isFloorMood('celebration_swell'), true);
  assert.equal(isFloorMood('party'), false);

  assert.equal(emptyGeminiState().watching3d, 0);
  assert.equal(emptyFloorVibes('f1', 123).mood, 'calm_planning');
  assert.ok(MONITOR_SPILL_HEX.emerald.startsWith('#'));
  assert.ok(FLOOR_MOOD_LIGHTING.deep_crunch.fillScale < 1);
});

test('GeminiDecisionsStore persists mode 0600 on disk and never leaks raw key in fingerprint', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemini-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = new GeminiDecisionsStore(dir);
  assert.equal(store.connected(), false);
  assert.equal(store.vibesOn(), true);
  assert.equal(store.saveKey('bad', 'Nik', 1000), 'Enter a valid Gemini API key.');

  const staleTemp = path.join(dir, 'gemini.json.tmp');
  writeFileSync(staleTemp, 'stale temporary file');
  chmodSync(staleTemp, 0o666);
  assert.equal(store.saveKey(`  ${TEST_KEY}  `, 'Nik', 1234), undefined);
  assert.equal(store.connected(), true);
  assert.equal(store.apiKey(), TEST_KEY);
  assert.equal(store.fingerprint(), 'AIza…6789');
  assert.equal(store.at(), 1234);

  const file = path.join(dir, 'gemini.json');
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  const rawDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(rawDisk.apiKey, TEST_KEY);

  assert.equal(store.setVibesOn(false), undefined);
  store.markChecked(2000, 'API key expired');

  const reloaded = new GeminiDecisionsStore(dir);
  assert.equal(reloaded.connected(), true);
  assert.equal(reloaded.vibesOn(), false);
  assert.equal(reloaded.checkedAt(), 2000);
  assert.equal(reloaded.rejected(), 'API key expired');

  assert.equal(reloaded.disconnect(), undefined);
  assert.equal(reloaded.connected(), false);
  assert.equal(reloaded.apiKey(), undefined);
});

test('redactGeminiSecrets scrubs raw, URL-encoded, bearer and provider tokens', () => {
  const secret = 'my-custom-secret-value-998877';
  const input = [
    `Key=${TEST_KEY}`,
    `Encoded=${encodeURIComponent(secret)}`,
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'x-goog-api-key: customKeyValue123',
    'Factory fk-1234567890abcdefghijklmno and GitHub ghp_1234567890abcdefghijklmnop',
  ].join('\n');
  const scrubbed = redactGeminiSecrets(input, [secret]);
  assert.doesNotMatch(scrubbed, new RegExp(TEST_KEY));
  assert.doesNotMatch(scrubbed, /my-custom-secret-value/);
  assert.doesNotMatch(scrubbed, /eyJhbGciOi/);
  assert.doesNotMatch(scrubbed, /customKeyValue123/);
  assert.doesNotMatch(scrubbed, /fk-1234567890/);
  assert.doesNotMatch(scrubbed, /ghp_1234567890/);

  // Keys ending with '-' or '_' (non-word boundary) are also scrubbed cleanly
  const dashEnd = redactGeminiSecrets('Token AIzaSyD0123456789abcdefghijk- and fk-1234567890abcdefghij- here');
  assert.doesNotMatch(dashEnd, /AIzaSyD/);
  assert.doesNotMatch(dashEnd, /fk-1234567890/);
});

test('callGeminiDecisions and probeGeminiKey parse real /v1beta/decisions shapes, blocks and errors', async () => {
  let seenHeaders: HeadersInit | undefined;
  let seenBody = '';
  const okFetch: typeof fetch = async (_url, init) => {
    seenHeaders = init?.headers;
    seenBody = String(init?.body ?? '');
    return new Response(
      JSON.stringify({
        answers: {
          ready: { type: 'noul', noul: 0.96, confidence: 0.92 },
          mood: {
            type: 'choice',
            choice: 'deep_crunch',
            probabilities: { calm_planning: 0.04, celebration_swell: 0.02, debugging_tension: 0.05, deep_crunch: 0.89 },
            confidence: 0.89,
          },
          rubric: {
            type: 'score',
            score: 2,
            legend: { '0': 'low', '1': 'mid', '2': 'high' },
            probabilities: { '0': 0.02, '1': 0.08, '2': 0.9 },
            confidence: 0.9,
          },
        },
        usage: {
          total_tokens: 148,
          total_input_tokens: 148,
          input_tokens_by_modality: [{ modality: 'text', tokens: 148 }],
          total_output_tokens: 0,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  let clock = 5000;
  const res = await callGeminiDecisions({
    apiKey: TEST_KEY,
    input: 'Floor check',
    questions: {
      ready: { type: 'noul', instructions: 'Is Byte working?' },
      mood: { type: 'choice', instructions: 'What is the floor mood?', criteria: { calm_planning: 'calm', deep_crunch: 'crunch' } },
      rubric: { type: 'score', instructions: 'Score urgency', criteria: ['low', 'mid', 'high'] },
    },
    fetchImpl: okFetch,
    now: () => (clock += 42),
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.inputTokens, 148);
    assert.equal(res.latencyMs, 42);
    assert.equal(res.answers.ready?.type, 'noul');
    assert.equal(res.answers.mood?.type, 'choice');
    assert.equal(res.answers.rubric?.type, 'score');
  }
  assert.equal((seenHeaders as Record<string, string>)['x-goog-api-key'], TEST_KEY);
  assert.match(seenBody, /"model":"gemini-decision-1"/);

  // Validation guards
  const emptyQ = await callGeminiDecisions({ apiKey: TEST_KEY, input: 'x', questions: {}, fetchImpl: okFetch });
  assert.equal(emptyQ.ok, false);
  const badKeyQ = await callGeminiDecisions({
    apiKey: TEST_KEY,
    input: 'x',
    questions: { 'bad key!': { type: 'noul', instructions: 'x' } },
    fetchImpl: okFetch,
  });
  assert.equal(badKeyQ.ok, false);

  // Key rejection + secret scrubbing in error message
  const rejectFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 400,
          message: `API key not valid: ${TEST_KEY}. Please pass a valid API key.`,
          status: 'INVALID_ARGUMENT',
        },
      }),
      { status: 400 },
    );
  const probeFail = await probeGeminiKey(TEST_KEY, { fetchImpl: rejectFetch });
  assert.equal(probeFail.ok, false);
  if (!probeFail.ok) {
    assert.equal(probeFail.keyRejected, true);
    assert.doesNotMatch(probeFail.error, new RegExp(TEST_KEY));
  }

  // Safety block handling
  const blockedFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        answers: {},
        prompt_feedback: { block_reason: 'SAFETY' },
        usage_metadata: { prompt_token_count: 32 },
      }),
      { status: 200 },
    );
  const probeBlocked = await probeGeminiKey(TEST_KEY, { fetchImpl: blockedFetch });
  assert.equal(probeBlocked.ok, false);
  if (!probeBlocked.ok) assert.match(probeBlocked.error, /SAFETY/);
});

test('OfficeVibes enforces strict view-aware cost gating, digest deduplication, and reaction cooldowns', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-vibes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = new GeminiDecisionsStore(dir);
  let now = 10_000;
  let airgapped = false;
  const clients = new Map<string, VibesClientView>();
  let tailText = 'PASS tests/auth.test.ts (14 passed)';
  const worker = makeWorker();

  const floor: VibesFloorView = {
    id: 'f1',
    name: 'droid-office',
    workers: [worker],
    pulls: [],
    tail: () => `${tailText}\nSecret=${TEST_KEY}`,
  };

  const geminiBroadcasts: ReturnType<OfficeVibes['geminiState']>[] = [];
  const floorBroadcasts: ReturnType<OfficeVibes['floorState']>[] = [];
  let apiCalls = 0;
  let lastPayload = '';
  let mockBreakthroughProb = 0.92;

  const stubFetch: typeof fetch = async (_url, init) => {
    apiCalls += 1;
    lastPayload = String(init?.body ?? '');
    if (lastPayload.includes('"ready"')) {
      return new Response(
        JSON.stringify({
          answers: { ready: { type: 'noul', noul: 0.95, confidence: 0.95 } },
          usage: { total_tokens: 25, total_input_tokens: 25, total_output_tokens: 0 },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        answers: {
          floor_mood: {
            type: 'choice',
            choice: 'deep_crunch',
            probabilities: { calm_planning: 0.05, celebration_swell: 0.08, debugging_tension: 0.03, deep_crunch: 0.84 },
            confidence: 0.84,
          },
          w0_posture: {
            type: 'choice',
            choice: 'flow',
            probabilities: { struggling: 0.03, flow: 0.88, investigating: 0.04, steady: 0.03, deliberating: 0.02 },
            confidence: 0.88,
          },
          w0_spill: {
            type: 'choice',
            choice: 'emerald',
            probabilities: { amber: 0.02, crimson: 0.01, emerald: 0.91, neutral: 0.06 },
            confidence: 0.91,
          },
          w0_react: {
            type: 'choice',
            choice: 'breakthrough',
            probabilities: {
              breakthrough: mockBreakthroughProb,
              setback: 0.01,
              none: Number((1 - mockBreakthroughProb - 0.03).toFixed(2)),
              puzzled: 0.01,
              pivot: 0.01,
            },
            confidence: mockBreakthroughProb,
          },
        },
        usage: { total_tokens: 210, total_input_tokens: 210, total_output_tokens: 0 },
      }),
      { status: 200 },
    );
  };

  const vibes = new OfficeVibes({
    store,
    airgapped: () => airgapped,
    clients: () => clients.values(),
    floors: () => [floor],
    floor: (id) => (id === 'f1' ? floor : undefined),
    broadcastGemini: (s) => geminiBroadcasts.push(s),
    emitFloorVibes: (_fid, s) => floorBroadcasts.push(s),
    fetchImpl: stubFetch,
    pulseMs: 60_000,
    quickPulseMs: 60_000,
    now: () => now,
  });
  t.after(() => vibes.stop());

  // Malformed key is rejected locally without touching the network
  let badReply: { ok: boolean; error?: string } | undefined;
  await vibes.connect('not-a-valid-key', 'Owner', (r) => (badReply = r));
  assert.equal(badReply?.ok, false);
  assert.equal(apiCalls, 0);

  // Connect key (1 probe call)
  let connectReply: { ok: boolean; error?: string } | undefined;
  await vibes.connect(TEST_KEY, 'Owner', (r) => (connectReply = r));
  assert.equal(connectReply?.ok, true);
  assert.equal(apiCalls, 1);

  // 1. Companion-only client (/dashboard): MUST make ZERO 3D Vibes calls!
  clients.set('comp-1', { id: 'comp-1', floor: 'f1', dashboard: true });
  vibes.setWatching('comp-1', true);
  await vibes.pulseNow();
  assert.equal(vibes.geminiState().watching3d, 0);
  assert.equal(apiCalls, 1, 'dashboard companion never triggers Gemini 3D pulses');

  // 2. 3D client standing on @roof: MUST make ZERO 3D Vibes calls!
  clients.set('3d-1', { id: '3d-1', floor: ROOF, dashboard: false });
  vibes.setWatching('3d-1', true);
  await vibes.pulseNow();
  assert.equal(vibes.geminiState().watching3d, 0);
  assert.equal(apiCalls, 1, 'rooftop has no workers and triggers zero pulses');

  // 3. 3D client arrives on indoor floor f1 and is visible: triggers 1 batched call!
  clients.set('3d-1', { id: '3d-1', floor: 'f1', dashboard: false });
  vibes.syncViewers(false);
  assert.equal(vibes.geminiState().watching3d, 1);
  await vibes.pulseNow();
  assert.equal(apiCalls, 2);
  assert.doesNotMatch(lastPayload, new RegExp(TEST_KEY), 'terminal secrets are scrubbed from Decisions input');
  const parsedReq = JSON.parse(lastPayload) as { questions: Record<string, { instructions: string }> };
  assert.match(parsedReq.questions.w0_posture?.instructions ?? '', /For worker \[w0\] \("Byte"\)/, 'each question names its worker explicitly');

  const latestFloor = floorBroadcasts.at(-1)!;
  assert.equal(latestFloor.mood, 'deep_crunch');
  assert.equal(latestFloor.workers['w-alpha']?.posture, 'flow');
  assert.equal(latestFloor.workers['w-alpha']?.spill, 'emerald');
  assert.equal(latestFloor.workers['w-alpha']?.reaction?.kind, 'breakthrough');
  assert.equal(latestFloor.workers['w-alpha']?.reaction?.seq, 1);

  // 4. Unchanged terminal snapshot digest: MUST skip API call ($0.00)!
  now += 4000;
  await vibes.pulseNow();
  assert.equal(apiCalls, 2, 'unchanged snapshot digest skips API call');

  // 5. Terminal changes within the cooldown: updates posture/spill, clears expired one-shot, and does NOT re-fire twitchy reaction!
  tailText = 'Running lint checks...';
  now += 2000; // 6s elapsed (> 4.5s grace window, < 9s cooldown)
  await vibes.pulseNow();
  assert.equal(apiCalls, 3);
  assert.equal(floorBroadcasts.at(-1)?.workers['w-alpha']?.reaction, undefined, 'cooldown prevents back-to-back micro-reactions and clears stale reaction');

  // 6. After the cooldown with enough confidence (>= 0.6): fires seq 2!
  tailText = 'All 42 suites passed!';
  now += MICRO_REACTION_COOLDOWN_MS + 1000;
  await vibes.pulseNow();
  assert.equal(apiCalls, 4);
  assert.equal(floorBroadcasts.at(-1)?.workers['w-alpha']?.reaction?.seq, 2);

  // 7. Low confidence (< 0.6): does NOT fire new reaction even past cooldown!
  mockBreakthroughProb = 0.45;
  tailText = 'Ambiguous log line';
  now += MICRO_REACTION_COOLDOWN_MS + 1000;
  await vibes.pulseNow();
  assert.equal(apiCalls, 5);
  assert.equal(floorBroadcasts.at(-1)?.workers['w-alpha']?.reaction, undefined, 'sub-0.6 probability does not fire one-shot reaction');

  // 8. 3D window hidden / closed to menu bar: watching3d drops to 0 and pulses stop immediately!
  vibes.setWatching('3d-1', false);
  tailText = 'New output while hidden';
  await vibes.pulseNow();
  assert.equal(vibes.geminiState().watching3d, 0);
  assert.equal(apiCalls, 5, 'hidden 3D window spends $0.00');

  // 9. Airgapped mode disables Gemini calls while preserving stored credentials
  vibes.setWatching('3d-1', true);
  airgapped = true;
  vibes.syncViewers(false);
  await vibes.pulseNow();
  assert.equal(vibes.geminiState().connected, false);
  assert.equal(apiCalls, 5);
  assert.equal(store.connected(), true, 'credentials remain intact on disk while airgapped');

  // Batch builder check for multi-worker floor
  const batch = buildFloorDecisionsBatch(floor, [worker, makeWorker({ id: 'w-beta', name: 'Pixel', deskId: 'desk-2' })], []);
  assert.equal(Object.keys(batch.questions).length, 3 + 2 * 5, 'floor mood, stakes and event, plus posture, spill, reaction, stakes and progress per worker');
  assert.equal(batch.questions.floor_stakes?.type, 'score');
  assert.equal(batch.questions.floor_event?.type, 'choice');
  assert.equal(batch.questions.w1_stakes?.type, 'score');
  assert.equal(batch.questions.w1_progress?.type, 'score');
  for (const key of ['floor_energy', 'w0_energy']) assert.equal(batch.questions[key], undefined, `${key}: output rate is a counter, not a judgment`);
  // Gemini is asked what output means for the task, never to spot keywords a regex could.
  for (const key of ['floor_mood', 'w0_spill', 'w0_react']) assert.match(batch.questions[key]?.instructions ?? '', /not keywords/, key);
  const allCriteria = JSON.stringify(Object.values(batch.questions).map((q) => ('criteria' in q ? q.criteria : null)));
  for (const counter of ['team_message', 'team_report', 'non-zero exit', 'pull request opened']) assert.ok(!allCriteria.includes(counter), `no criterion hinges on ${counter}`);
  const reactCriteria = batch.questions.w0_react?.type === 'choice' ? Object.keys(batch.questions.w0_react.criteria) : [];
  for (const kind of [...WORKER_MICRO_REACTIONS, 'none']) assert.ok(reactCriteria.includes(kind), `reaction question offers ${kind}`);
  const eventCriteria = batch.questions.floor_event?.type === 'choice' ? Object.keys(batch.questions.floor_event.criteria) : [];
  for (const kind of [...FLOOR_EVENTS, 'none']) assert.ok(eventCriteria.includes(kind), `floor event question offers ${kind}`);
});

test('already cancelled Decisions requests never start a fetch', async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const result = await callGeminiDecisions({
    apiKey: TEST_KEY,
    input: 'cancelled',
    questions: { ready: { type: 'noul', instructions: 'Ready?' } },
    signal: abort.signal,
    fetchImpl: async () => {
      calls++;
      return new Response('{}');
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
});

test('OfficeVibes backs off failed requests and safely reports snapshot exceptions', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibes-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new GeminiDecisionsStore(dir);
  store.saveKey(TEST_KEY, 'Owner', 0);
  let now = 0;
  let calls = 0;
  let healthy = false;
  let brokenTail = false;
  const floor: VibesFloorView = {
    id: 'f1',
    name: 'Office',
    workers: [makeWorker()],
    pulls: [],
    tail: () => {
      if (brokenTail) throw new Error(`Snapshot failed: ${TEST_KEY}`);
      return 'Working';
    },
  };
  const vibes = new OfficeVibes({
    store,
    airgapped: () => false,
    clients: () => [{ id: 'view', floor: 'f1', dashboard: false }],
    floors: () => [floor],
    floor: () => floor,
    broadcastGemini: () => {},
    emitFloorVibes: () => {},
    pulseMs: 1_000_000,
    quickPulseMs: 1_000_000,
    now: () => now,
    fetchImpl: async () => {
      calls++;
      return new Response('{}', { status: healthy ? 200 : 503 });
    },
  });
  t.after(() => vibes.stop());
  vibes.setWatching('view', true);
  await vibes.pulseNow();
  assert.equal(calls, 1);
  for (const delay of [10_000, 20_000, 40_000, 60_000, 60_000]) {
    const before = calls;
    now += delay - 1;
    await vibes.pulseNow();
    assert.equal(calls, before, 'failed requests do not retry before their deadline');
    now++;
    await vibes.pulseNow();
    assert.equal(calls, before + 1, 'retry starts only at the exponentially backed-off deadline');
  }
  healthy = true;
  now += 60_000;
  await vibes.pulseNow();
  const successCalls = calls;
  await vibes.pulseNow();
  assert.equal(calls, successCalls, 'successful snapshots retain digest deduplication');
  brokenTail = true;
  await assert.doesNotReject(vibes.pulseNow());
  assert.match(vibes.geminiState().lastError ?? '', /Snapshot failed/);
  assert.ok(!vibes.geminiState().lastError?.includes(TEST_KEY), 'unexpected errors redact saved keys');
  brokenTail = false;
  now += 10_000;
  floor.workers.push(makeWorker({ id: 'new' }));
  await vibes.pulseNow();
  assert.equal(calls, successCalls + 1, 'success resets the error backoff');

  const batch = buildFloorDecisionsBatch(
    floor,
    Array.from({ length: 18 }, (_, i) => makeWorker({ id: `w${i}` })),
  );
  assert.match(batch.input, /18 active\/recent desk workers \(16 shown, 2 omitted\)/);
  assert.equal(batch.workers.length, 16);
});

test('OfficeVibes cancels airgapped probes and ignores old-key pulses after replacement', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibes-races-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new GeminiDecisionsStore(dir);
  store.saveKey(TEST_KEY, 'Owner', 100);
  let airgapped = false;
  const requests: { signal: AbortSignal; finish: (response: Response) => void }[] = [];
  const vibes = new OfficeVibes({
    store,
    airgapped: () => airgapped,
    clients: () => [{ id: 'view', floor: 'f1', dashboard: false }],
    floors: () => [floor],
    floor: () => ({ ...floor, workers: [...floor.workers] }),
    broadcastGemini: () => {},
    emitFloorVibes: () => {},
    quickPulseMs: 60_000,
    pulseMs: 60_000,
    fetchImpl: async (_url, init) => new Promise<Response>((finish) => requests.push({ signal: init!.signal!, finish })),
  });
  const floor: VibesFloorView = { id: 'f1', name: 'Office', workers: [makeWorker()], pulls: [], tail: () => 'Working' };
  t.after(() => vibes.stop());
  const probeResponse = () => new Response(JSON.stringify({ answers: { ready: { type: 'noul', noul: 1, confidence: 1 } } }));
  let connected: boolean | undefined;
  const connect = vibes.connect(TEST_KEY, 'Owner', (r) => {
    connected = r.ok;
  });
  airgapped = true;
  vibes.syncViewers();
  assert.equal(requests[0].signal.aborted, true, 'airgapped mode aborts even explicit key probes');
  requests[0].finish(probeResponse());
  await connect;
  assert.equal(connected, false, 'late probe success cannot persist while airgapped');

  airgapped = false;
  vibes.setWatching('view', true);
  const pulse = vibes.pulseNow();
  const replacement = vibes.connect(`${TEST_KEY}new`, 'Owner', () => {});
  requests[2].finish(probeResponse());
  await replacement;
  assert.equal(requests[1].signal.aborted, true, 'replacing a key invalidates old-key pulses');
  requests[1].finish(new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }));
  await pulse;
  assert.equal(store.rejected(), undefined, 'old-key rejection cannot suspend verified replacement');

  store.markChecked(200, 'API key expired');
  const check = vibes.check(() => {});
  requests[3].finish(new Response('{}', { status: 503 }));
  await check;
  assert.equal(store.rejected(), 'API key expired', 'transient check failure must preserve rejection');

  store.markChecked(300);
  const departedPulse = vibes.pulseNow();
  floor.workers = [];
  requests[4].finish(
    new Response(
      JSON.stringify({
        answers: {
          w0_posture: { type: 'choice', choice: 'flow', confidence: 1 },
          w0_react: { type: 'choice', choice: 'breakthrough', confidence: 1 },
        },
      }),
    ),
  );
  await departedPulse;
  assert.deepEqual(vibes.floorState('f1')?.workers, {}, 'late responses cannot resurrect departed workers');
});

test('3D Worker continuous postures, micro-reaction envelopes and Sky baseline-safe mood crossfades', (t) => {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const ctx2d = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    arc: () => {},
    ellipse: () => {},
    closePath: () => {},
    fill: () => {},
    stroke: () => {},
    fillText: () => {},
    setTransform: () => {},
    scale: () => {},
    save: () => {},
    restore: () => {},
    roundRect: () => {},
    clip: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        width: 256,
        height: 128,
        getContext: () => ctx2d,
      }),
    },
  });
  t.after(() => {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete (globalThis as { document?: unknown }).document;
  });

  const actor = new Worker('Byte', '#ee6018');
  actor.setSeat('chair');
  actor.setStatus('working');

  for (const posture of ['flow', 'investigating', 'struggling', 'deliberating'] as const) {
    actor.applyVibe({ posture, spill: 'neutral' }, 1000);
    assert.equal(actor.activeVibePosture, posture);
    actor.update(0.12, 1.5);
    assert.ok(Number.isFinite(actor.lean), `${posture} produces finite torso lean`);
  }

  // Triggered micro-reactions play once per seq and expire cleanly after ~2.2s
  actor.applyVibe(
    {
      posture: 'flow',
      spill: 'emerald',
      reaction: { kind: 'breakthrough', seq: 1, at: 1000, confidence: 0.93 },
    },
    1200,
  );
  assert.equal(actor.activeReaction, 'breakthrough');
  actor.update(0.3, 2.0);
  assert.equal(actor.animating, true);
  actor.update(2.7, 4.7);
  assert.equal(actor.activeReaction, null, 'reaction completes cleanly and restores bulb');

  // Re-applying same seq=1 does not replay
  actor.applyVibe(
    {
      posture: 'flow',
      spill: 'emerald',
      reaction: { kind: 'breakthrough', seq: 1, at: 1000, confidence: 0.93 },
    },
    1500,
  );
  assert.equal(actor.activeReaction, null);

  // Exercise the remaining micro-reactions with stakes driving the posture clock and progress carried along
  for (const [i, kind] of (['setback', 'puzzled', 'eureka', 'frustrated', 'pivot', 'rabbit_hole', 'corner_cut', 'risky_move'] as const).entries()) {
    actor.applyVibe({ posture: 'struggling', spill: 'crimson', stakes: i / 7, progress: 1 - i / 7, reaction: { kind, seq: i + 2, at: 5000, confidence: 0.91 } }, 5100);
    assert.equal(actor.activeReaction, kind);
    assert.equal(actor.activeVibeStakes, i / 7);
    assert.equal(actor.activeVibeProgress, 1 - i / 7);
    actor.update(0.2, 5.2);
    actor.update(0.6, 5.8);
    assert.ok(Number.isFinite(actor.body.rotation.x) && Number.isFinite(actor.body.position.y), `${kind} keeps the body finite`);
    actor.update(2.5, 8.3);
    assert.equal(actor.activeReaction, null, `${kind} ends within its envelope`);
  }
  // Opening a pull request is acted out from the worker update, with a full chair spin.
  actor.triggerReaction('shipped');
  assert.equal(actor.activeReaction, 'shipped');
  actor.update(0.6, 9);
  assert.ok(Number.isFinite(actor.body.rotation.y) && actor.body.rotation.y !== 0, 'shipping spins the chair');
  actor.update(3, 12);
  assert.equal(actor.activeReaction, null);
  actor.applyVibe({ posture: 'flow', spill: 'neutral' }, 9000);
  assert.equal(actor.activeVibeStakes, 0.5, 'a missing stakes grade falls back to a steady pace');
  assert.equal(actor.activeVibeProgress, 0, 'no progress arc without a grade');
  for (const transition of ['die', 'leave', 'dance'] as const) {
    const interrupted = new Worker('Byte', '#ee6018');
    interrupted.setSeat('chair');
    interrupted.triggerReaction('puzzled');
    interrupted.update(0.3, 1);
    if (transition === 'dance') interrupted.dance({ pos: new THREE.Vector3(), yaw: 0 });
    else if (transition === 'leave') interrupted.leave('Bye');
    else interrupted.die();
    assert.equal(interrupted.activeReaction, null, `${transition} cancels the reaction before update's early return`);
    interrupted.dispose();
  }
  actor.triggerReaction('setback');
  actor.update(0.449, 8.449);
  const beforePhase = actor.body.rotation.x;
  actor.update(0.002, 8.451);
  assert.ok(Math.abs(actor.body.rotation.x - beforePhase) < 0.02, 'flinch and slump blend continuously across the old 0.45s snap');
  actor.dispose();

  // Sky mood crossfade & Remastered GI baseline guard
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight('#ffffff', 0.18);
  const hemi = new THREE.HemisphereLight('#ffffff', '#000000', 0.3);
  const ambient = new THREE.AmbientLight('#ffffff', 0.1);
  const cam = new THREE.PerspectiveCamera();
  const sky = new Sky(scene, { sun, hemi, ambient }, { lamps: [], bulbs: [], windows: [], halos: [], clouds: new THREE.MeshBasicMaterial(), street: -4 });

  sky.setMood('deep_crunch', false);
  assert.equal(sky.currentMood, 'deep_crunch');
  assert.equal(sky.moodTransitioning, true);
  sky.update(0.5, 1.0, cam);

  let ranBake = false;
  withBaselineOfficeFill(0.8, () => {
    ranBake = true;
  });
  assert.equal(ranBake, true);
  sky.setMood('celebration_swell', true);
  assert.equal(sky.moodTransitioning, false);
});

test('OfficeVibes grades floor stakes, worker stakes and progress, and room-wide floor events with confidence gating and a cooldown', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibes-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new GeminiDecisionsStore(dir);
  store.saveKey(TEST_KEY, 'Owner', 0);
  let now = 50_000;
  let tail = 'PASS tests/a.test.ts';
  let eventProb = 0.81;
  let eventChoice = 'convergence';
  const bodies: { questions: Record<string, { type: string; criteria?: unknown }> }[] = [];
  const floor: VibesFloorView = {
    id: 'f1',
    name: 'Office',
    workers: [makeWorker(), makeWorker({ id: 'w-beta', name: 'Pixel', deskId: 'desk-2' })],
    pulls: [],
    tail: () => tail,
  };
  const emitted: ReturnType<OfficeVibes['floorState']>[] = [];
  // Answer shapes trimmed from a live gemini-decision-1 response to the same question set.
  const answers = () => ({
    floor_mood: { type: 'choice', choice: 'celebration_swell', probabilities: { celebration_swell: 0.8, calm_planning: 0.1, deep_crunch: 0.05, debugging_tension: 0.05 }, confidence: 0.8 },
    floor_stakes: { type: 'score', score: 3.0022119931211178, legend: { '0': 'Relaxed', '4': 'Critical' }, probabilities: { '2': 0.21, '3': 0.49, '4': 0.27 }, confidence: 0.49 },
    floor_event: { type: 'choice', choice: eventChoice, probabilities: { [eventChoice]: eventProb, none: 1 - eventProb }, confidence: eventProb },
    w0_posture: { type: 'choice', choice: 'flow', probabilities: { flow: 0.9 }, confidence: 0.9 },
    w0_spill: { type: 'choice', choice: 'emerald', probabilities: { emerald: 0.9 }, confidence: 0.9 },
    w0_react: { type: 'choice', choice: 'eureka', probabilities: { eureka: 0.6283014285833879, breakthrough: 0.27, none: 0.03 }, confidence: 0.6283014285833879 },
    w0_stakes: { type: 'score', score: 2.9037745884954935, legend: {}, probabilities: { '3': 0.59 }, confidence: 0.59 },
    w0_progress: { type: 'score', score: 1.0, legend: {}, probabilities: { '1': 0.7 }, confidence: 0.7 },
    w1_posture: { type: 'choice', choice: 'struggling', probabilities: { struggling: 0.8 }, confidence: 0.8 },
    w1_spill: { type: 'choice', choice: 'crimson', probabilities: { crimson: 0.88 }, confidence: 0.88 },
    w1_react: { type: 'choice', choice: 'frustrated', probabilities: { frustrated: 0.9230681059752905, puzzled: 0.03, none: 0.01 }, confidence: 0.9230681059752905 },
    w1_stakes: { type: 'score', score: 4, legend: {}, probabilities: { '4': 0.6 }, confidence: 0.6 },
    w1_progress: { type: 'score', score: 3, legend: {}, probabilities: { '3': 0.6 }, confidence: 0.6 },
  });
  const vibes = new OfficeVibes({
    store,
    airgapped: () => false,
    clients: () => [{ id: 'view', floor: 'f1', dashboard: false }],
    floors: () => [floor],
    floor: () => floor,
    broadcastGemini: () => {},
    emitFloorVibes: (_id, s) => emitted.push(s),
    pulseMs: 1_000_000,
    quickPulseMs: 1_000_000,
    now: () => now,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ answers: answers(), usage: { total_input_tokens: 1031, total_output_tokens: 0 } }));
    },
  });
  t.after(() => vibes.stop());
  vibes.setWatching('view', true);

  await vibes.pulseNow();
  const q = bodies.at(-1)!.questions;
  assert.equal(q.floor_stakes?.type, 'score');
  assert.equal(q.w0_stakes?.type, 'score');
  assert.equal(q.w0_progress?.type, 'score');
  assert.equal(q.floor_event?.type, 'choice');
  let s = emitted.at(-1)!;
  assert.equal(s.mood, 'celebration_swell');
  assert.equal(s.stakes, 0.751, 'floor stakes are the expected score over the 0-4 rubric');
  assert.equal(s.workers['w-alpha']?.stakes, 0.726);
  assert.equal(s.workers['w-beta']?.stakes, 1);
  assert.equal(s.workers['w-alpha']?.progress, 0.25);
  assert.equal(s.workers['w-beta']?.progress, 0.75);
  assert.equal(s.workers['w-alpha']?.reaction?.kind, 'eureka', 'a 0.63 eureka clears the reaction gate');
  assert.equal(s.workers['w-beta']?.reaction?.kind, 'frustrated');
  assert.deepEqual(s.event && { kind: s.event.kind, seq: s.event.seq }, { kind: 'convergence', seq: 1 });

  // A new snapshot inside the grace window carries the same event, so a viewer arriving now still sees it.
  now += 3000;
  tail = 'PASS tests/b.test.ts';
  await vibes.pulseNow();
  s = emitted.at(-1)!;
  assert.equal(s.event?.seq, 1);

  // Past the grace window but inside the cooldown, a fresh confident event does not fire again.
  now += 4000;
  tail = 'PASS tests/c.test.ts';
  await vibes.pulseNow();
  assert.equal(emitted.at(-1)!.event, undefined, 'the cooldown keeps the room from flashing every pulse');

  // After the cooldown, too little confidence fires nothing either.
  now += FLOOR_EVENT_COOLDOWN_MS;
  eventProb = 0.4;
  tail = 'PASS tests/d.test.ts';
  await vibes.pulseNow();
  assert.equal(emitted.at(-1)!.event, undefined);

  // A confident different moment fires the next sequence number.
  eventProb = 0.77;
  eventChoice = 'collision';
  tail = 'FAIL tests/e.test.ts';
  await vibes.pulseNow();
  s = emitted.at(-1)!;
  assert.deepEqual(s.event && { kind: s.event.kind, seq: s.event.seq }, { kind: 'collision', seq: 2 });

  // An unknown choice or a missing score degrades cleanly.
  now += FLOOR_EVENT_COOLDOWN_MS;
  eventChoice = 'party';
  tail = 'other';
  await vibes.pulseNow();
  assert.equal(emitted.at(-1)!.event, undefined);

  // Turning Living 3D off and straight back on drops carried moments instead of replaying them.
  now += FLOOR_EVENT_COOLDOWN_MS;
  eventChoice = 'convergence';
  eventProb = 0.9;
  tail = 'PASS tests/f.test.ts';
  await vibes.pulseNow();
  s = emitted.at(-1)!;
  assert.equal(s.event?.seq, 3);
  assert.ok(s.workers['w-alpha']?.reaction, 'a reaction fired alongside the event');
  assert.equal(vibes.setVibesOn(false), undefined);
  assert.equal(emitted.at(-1)!.event, undefined, 'the neutral snapshot has no event');
  assert.equal(vibes.setVibesOn(true), undefined);
  now += 1000;
  await vibes.pulseNow();
  s = emitted.at(-1)!;
  assert.equal(s.event, undefined, 'the event from before the reset is not carried into the fresh snapshot');
  assert.equal(s.workers['w-alpha']?.reaction, undefined, 'nor is the reaction');
  assert.equal(s.workers['w-beta']?.reaction, undefined);
});
