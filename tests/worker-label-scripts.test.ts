import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { openRouterLabel } from '../bin/worker-label-openrouter.mjs';
import { LabelModelError, scriptLabel, WorkerLabelModel } from '../src/server/worker-label-model.js';
import { labelSettings, WorkerLabelPreferences } from '../src/server/worker-label-settings.js';
import { LABEL_TEXT_CHARS, WORKER_LABEL_DEFAULTS, type WorkerLabelSettings } from '../src/shared/worker-labels.js';

const label = { name: 'Custom Label Scripts', summary: 'Checking the custom script contract and OpenRouter adapter' };
const settings: WorkerLabelSettings = { ...WORKER_LABEL_DEFAULTS, implementation: 'custom', command: process.execPath, args: [], model: 'meta/muse-spark-1.3-contributor', effort: 'minimal' };

async function program(t: TestContext, code: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-label-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'script.cjs');
  const observed = path.join(root, 'observed.json');
  await writeFile(file, `const fs = require('node:fs'); const observed = ${JSON.stringify(observed)};\n${code}`);
  return { root, observed, settings: { ...settings, args: [file] } };
}

async function started(file: string) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text) return JSON.parse(text) as { cwd: string; pid: number };
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Script did not report startup.');
}

test('custom preferences validate, persist and do not share argument arrays', async (t) => {
  const { root } = await program(t, '');
  const prefs = new WorkerLabelPreferences(root);
  const next = { ...settings, args: ['a path with spaces', '$(not a shell)', '; literal'] };
  assert.equal(prefs.set(next), undefined);
  next.args.push('mutated');
  assert.equal(prefs.get().args?.length, 3);
  prefs.get().args?.push('also mutated');
  assert.equal(prefs.get().args?.length, 3);
  assert.deepEqual(new WorkerLabelPreferences(root).get(), prefs.get());
  assert.deepEqual(labelSettings(WORKER_LABEL_DEFAULTS), WORKER_LABEL_DEFAULTS, 'older preferences still use Droid');
  assert.deepEqual(labelSettings({ ...WORKER_LABEL_DEFAULTS, implementation: 'droid', command: '/discarded' }), WORKER_LABEL_DEFAULTS);
  for (const value of [
    { ...settings, implementation: 'other' },
    { ...settings, command: 'relative/executable' },
    { ...settings, command: '/nul\0' },
    { ...settings, args: 'not an array' },
    { ...settings, args: [false] },
    { ...settings, args: ['bad\nargument'] },
    { ...settings, args: ['x'.repeat(4097)] },
    { ...settings, args: Array(33).fill('x') },
  ])
    assert.equal(labelSettings(value), undefined);
});

test('custom scripts receive bounded contract v1 input, literal args and no Factory dependency', async (t) => {
  const p = await program(
    t,
    `
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => text += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(observed, JSON.stringify({request: JSON.parse(text), args: process.argv.slice(2), cwd: process.cwd(), office: Object.keys(process.env).filter(k => /^(NEBULA_|DROID_OFFICE_)/.test(k))}));
  process.stdout.write(${JSON.stringify(JSON.stringify(label))});
});`,
  );
  const model = new WorkerLabelModel({
    droid: () => {
      throw new Error('Must not need Droid');
    },
    key: () => {
      throw new Error('Must not need Factory');
    },
    system: () => 'Owner sign prompt',
  });
  p.settings.args.push('literal space;$(not expanded)');
  const output = await model.generate({ text: 'x'.repeat(LABEL_TEXT_CHARS + 100), previousSubject: 's'.repeat(100) }, p.settings, new AbortController().signal);
  assert.deepEqual(output, { ...label, generated: true });
  const observed = JSON.parse(await readFile(p.observed, 'utf8'));
  assert.deepEqual(observed.request, { version: 1, system: 'Owner sign prompt', conversation: 'x'.repeat(LABEL_TEXT_CHARS), previousSubject: 's'.repeat(60), model: settings.model, effort: 'minimal' });
  assert.deepEqual(observed.args, ['literal space;$(not expanded)']);
  assert.deepEqual(observed.office, []);
  assert.notEqual(observed.cwd, p.root);
  await assert.rejects(stat(observed.cwd), { code: 'ENOENT' });
});

for (const [name, code, message] of [
  ['nonzero exit', "process.stderr.write('PRIVATE_CREDENTIAL_AND_TEXT'); process.exit(1)", /exited unsuccessfully/],
  ['invalid JSON', "process.stdout.write('PRIVATE_CREDENTIAL_AND_TEXT')", /invalid JSON/],
  ['invalid fields', 'process.stdout.write(\'{"name":{},"summary":"x"}\')', /subject and summary/],
  ['stdout overflow', "process.stdout.write('x'.repeat(65 * 1024))", /64 KiB/],
  ['stderr overflow', "process.stderr.write('x'.repeat(65 * 1024))", /64 KiB/],
] as const) {
  test(`custom runner rejects ${name} without echoing private diagnostics`, async (t) => {
    const p = await program(t, code);
    await assert.rejects(scriptLabel({ text: 'text' }, p.settings, 'system', new AbortController().signal), (error: Error) => {
      assert.ok(error instanceof LabelModelError);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
  });
}

test('custom runner reports missing executables and refuses already cancelled work', async () => {
  await assert.rejects(scriptLabel({ text: 'text' }, { ...settings, command: path.join(os.tmpdir(), 'missing-office-label-executable') }, '', new AbortController().signal), /Could not start/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(scriptLabel({ text: 'text' }, settings, '', cancelled.signal), /cancelled/);
});

test('custom runner cancels a running script and removes its scratch directory', async (t) => {
  const p = await program(t, 'fs.writeFileSync(observed, JSON.stringify({cwd:process.cwd(),pid:process.pid})); process.stdin.resume(); setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const call = scriptLabel({ text: 'text' }, p.settings, '', controller.signal);
  const rejected = assert.rejects(call, /cancelled/);
  const child = await started(p.observed);
  controller.abort();
  await rejected;
  await assert.rejects(stat(child.cwd), { code: 'ENOENT' });
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('custom runner enforces the timeout', async (t) => {
  const p = await program(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(scriptLabel({ text: 'text' }, p.settings, '', new AbortController().signal, 100), /timed out/);
});

test('custom runner preserves UTF-8 characters split across stdout chunks', async (t) => {
  const p = await program(
    t,
    `
const output = Buffer.from(JSON.stringify({name:'Café Labels',summary:'Checking Unicode'}));
const split = output.indexOf(Buffer.from('é')) + 1;
process.stdout.write(output.subarray(0, split));
setImmediate(() => process.stdout.write(output.subarray(split)));
`,
  );
  assert.equal((await scriptLabel({ text: 'text' }, p.settings, '', new AbortController().signal)).name, 'Café Labels');
});

// Trimmed from an actual Muse Spark 1.3 Contributor/minimal response, 2026-10-29.
const completion = {
  choices: [
    { index: 0, finish_reason: 'stop', native_finish_reason: 'completed', message: { role: 'assistant', content: '{"name": "Custom Label Scripts", "summary": "Checking the custom script contract and OpenRouter adapter"}', refusal: null } },
  ],
};
const request = { version: 1, system: 'Sign prompt', conversation: 'assistant: Checking the contract', previousSubject: label.name, model: settings.model, effort: 'minimal' };

test('OpenRouter example sends the exact model and minimal effort with JSON output and no tools', async () => {
  let sent: Record<string, unknown> = {};
  const result = await openRouterLabel(request, {
    key: 'test-only',
    fetchImpl: async (url: string, options: RequestInit) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(options.method, 'POST');
      sent = JSON.parse(options.body as string);
      return Response.json(completion);
    },
  });
  assert.deepEqual(result, label);
  assert.equal(sent.model, settings.model);
  assert.deepEqual(sent.reasoning, { effort: 'minimal', exclude: true });
  assert.equal(sent.tools, undefined);
  assert.ok(sent.response_format);
  assert.deepEqual(sent.messages, [
    { role: 'system', content: request.system },
    { role: 'user', content: JSON.stringify({ conversation: request.conversation, previousSubject: request.previousSubject }) },
  ]);
});

test('OpenRouter example rejects missing keys, unsupported efforts and failed/incomplete responses', async () => {
  await assert.rejects(openRouterLabel(request, { key: '' }), /OPENROUTER_API_KEY/);
  for (const change of [{ version: 2 }, { effort: 'off' }, { conversation: null }, { previousSubject: {} }]) await assert.rejects(openRouterLabel({ ...request, ...change }, { key: 'test-only' }), /Invalid contract/);
  await assert.rejects(openRouterLabel(request, { key: 'test-only', fetchImpl: async () => new Response('PRIVATE_PROVIDER_ERROR', { status: 401 }) }), /^Error: OpenRouter returned HTTP 401\.$/);
  for (const choices of [
    [],
    [{ finish_reason: 'length', message: { content: '{}' } }],
    [{ finish_reason: 'stop', message: { content: '{}', tool_calls: [{}] } }],
    [{ finish_reason: 'stop', message: { content: '{"name":"","summary":"x"}' } }],
  ])
    await assert.rejects(openRouterLabel(request, { key: 'test-only', fetchImpl: async () => Response.json({ choices }) }));
});
