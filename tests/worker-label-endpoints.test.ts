import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { extractCompletionLabel, LabelModelError, openAiLabel, WorkerLabelModel } from '../src/server/worker-label-model.js';
import { labelSettings, resolveLabelSettings, WorkerLabelPreferences } from '../src/server/worker-label-settings.js';
import { LABEL_TEXT_CHARS, parseLabelEndpointUrl, sameEndpointOrigin, WORKER_LABEL_DEFAULTS, type WorkerLabelSettings } from '../src/shared/worker-labels.js';

const sampleLabel = { name: 'Fix Session Redirect', summary: 'Tracing auth middleware redirecting expired cookies' };

const endpointSettings: WorkerLabelSettings = {
  ...WORKER_LABEL_DEFAULTS,
  implementation: 'openai',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5:7b',
  effort: 'low',
};

async function tempDir(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-label-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('parseLabelEndpointUrl normalizes server roots, /v1 bases, full completions paths, and LAN/Tailscale hosts', () => {
  const cases: Array<[string, string, string]> = [
    ['http://localhost:11434', 'http://localhost:11434', 'http://localhost:11434/v1/chat/completions'],
    ['localhost:11434/', 'http://localhost:11434', 'http://localhost:11434/v1/chat/completions'],
    ['127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1/chat/completions'],
    ['[::1]:8080/v1', 'http://[::1]:8080/v1', 'http://[::1]:8080/v1/chat/completions'],
    ['win5090:8000/v1', 'http://win5090:8000/v1', 'http://win5090:8000/v1/chat/completions'],
    ['http://192.168.1.50:11434', 'http://192.168.1.50:11434', 'http://192.168.1.50:11434/v1/chat/completions'],
    ['http://100.88.12.34:8000/v1', 'http://100.88.12.34:8000/v1', 'http://100.88.12.34:8000/v1/chat/completions'],
    ['http://gpu.tailnet.ts.net:8000/v1', 'http://gpu.tailnet.ts.net:8000/v1', 'http://gpu.tailnet.ts.net:8000/v1/chat/completions'],
    ['api.openai.com/v1', 'https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
    ['https://api.groq.com/openai/v1/chat/completions', 'https://api.groq.com/openai/v1/chat/completions', 'https://api.groq.com/openai/v1/chat/completions'],
    [
      'https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
      'https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
      'https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
    ],
  ];
  for (const [input, expectedBase, expectedCompletions] of cases) {
    const parsed = parseLabelEndpointUrl(input);
    assert.equal('error' in parsed, false, `expected valid URL for ${input}`);
    if (!('error' in parsed)) {
      assert.equal(parsed.baseUrl, expectedBase, input);
      assert.equal(parsed.completionsUrl, expectedCompletions, input);
    }
  }

  for (const invalid of [
    '',
    '   ',
    'justaword',
    'relative/executable',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://0.0.0.0:11434/v1',
    'http://[::]:11434/v1',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://api.openai.com/v1',
    'https://user:secret@api.openai.com/v1',
    'https://api.openai.com/v1 with space',
    'https://api.openai.com/\u0000',
  ]) {
    const parsed = parseLabelEndpointUrl(invalid);
    assert.equal('error' in parsed, true, `expected rejection for ${invalid}`);
  }

  assert.equal(sameEndpointOrigin('https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'), true);
  assert.equal(sameEndpointOrigin('https://api.openai.com/v1', 'https://openrouter.ai/v1'), false);
  assert.equal(sameEndpointOrigin('http://localhost:11434', 'http://localhost:1234'), false);
});

test('preferences store API keys at 0600, redact keys from client state, and never reuse keys across origins', async (t) => {
  const root = await tempDir(t);
  const prefs = new WorkerLabelPreferences(root);

  // Save OpenAI endpoint with API key
  assert.equal(
    prefs.set({
      ...endpointSettings,
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: '  sk-secret-openai-key  ',
      model: '  gpt-4.1-nano  ',
      endpointEffort: 'low',
    }),
    undefined,
  );
  const clientView = prefs.get();
  assert.equal(clientView.baseUrl, 'https://api.openai.com/v1');
  assert.equal(clientView.model, 'gpt-4.1-nano');
  assert.equal(clientView.endpointEffort, 'low');
  assert.equal(clientView.hasApiKey, true);
  assert.equal('apiKey' in clientView, false, 'client state must never expose apiKey');
  assert.equal(prefs.apiKey(), 'sk-secret-openai-key');
  assert.equal((await stat(path.join(root, 'worker-labels.json'))).mode & 0o777, 0o600);

  // Reloading from disk preserves the key and keeps client state redacted
  const reloaded = new WorkerLabelPreferences(root);
  assert.equal(reloaded.get().hasApiKey, true);
  assert.equal('apiKey' in reloaded.get(), false);
  assert.equal(reloaded.apiKey(), 'sk-secret-openai-key');

  // Updating model or interval on the SAME origin without apiKey preserves the saved key
  assert.equal(
    reloaded.set({
      ...reloaded.get(),
      apiKey: undefined,
      model: 'gpt-4.1-mini',
      intervalSeconds: 45,
    }),
    undefined,
  );
  assert.equal(reloaded.get().model, 'gpt-4.1-mini');
  assert.equal(reloaded.get().hasApiKey, true);
  assert.equal(reloaded.apiKey(), 'sk-secret-openai-key');

  // Changing to a DIFFERENT origin without providing a new key drops the old origin's key
  const crossOriginPreview = reloaded.resolve({
    ...reloaded.get(),
    baseUrl: 'http://localhost:11434/v1',
    apiKey: undefined,
    model: 'llama3.2',
  });
  assert.equal('error' in crossOriginPreview, false);
  if (!('error' in crossOriginPreview)) {
    assert.equal(crossOriginPreview.apiKey, undefined, 'must never carry key across origins');
    assert.equal(crossOriginPreview.settings.hasApiKey, false);
  }
  assert.equal(
    reloaded.set({
      ...reloaded.get(),
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      model: 'llama3.2',
    }),
    undefined,
  );
  assert.equal(reloaded.apiKey(), undefined);
  assert.equal(reloaded.get().hasApiKey, false);

  // Explicit empty string clears an existing key on the same origin
  assert.equal(reloaded.set({ ...reloaded.get(), apiKey: 'local-token' }), undefined);
  assert.equal(reloaded.apiKey(), 'local-token');
  assert.equal(reloaded.set({ ...reloaded.get(), apiKey: '' }), undefined);
  assert.equal(reloaded.apiKey(), undefined);
  assert.equal(reloaded.get().hasApiKey, false);

  // Droid mode stays untouched and discards endpoint fields
  assert.deepEqual(labelSettings(WORKER_LABEL_DEFAULTS), WORKER_LABEL_DEFAULTS);
  assert.deepEqual(labelSettings({ ...WORKER_LABEL_DEFAULTS, implementation: 'droid', baseUrl: 'http://localhost:11434/v1' }), WORKER_LABEL_DEFAULTS);

  // Invalid settings are rejected
  for (const invalid of [
    { ...endpointSettings, implementation: 'custom' },
    { ...endpointSettings, baseUrl: '' },
    { ...endpointSettings, baseUrl: 'http://api.openai.com/v1' },
    { ...endpointSettings, model: '   ' },
    { ...endpointSettings, model: 'bad\nmodel' },
    { ...endpointSettings, apiKey: 'bad\r\nheader' },
    { ...endpointSettings, endpointEffort: 'bogus' },
  ]) {
    assert.equal('error' in resolveLabelSettings(invalid), true);
  }
});

test('legacy custom-script preferences load disabled rather than switching silently to paid Factory labels', async (t) => {
  const root = await tempDir(t);
  await writeFile(path.join(root, 'worker-labels.json'), JSON.stringify({ on: true, implementation: 'custom', command: '/usr/local/bin/node', args: ['/tmp/label.mjs'], model: 'my-model', effort: 'low', intervalSeconds: 60 }));
  const prefs = new WorkerLabelPreferences(root);
  assert.deepEqual(prefs.get(), { ...WORKER_LABEL_DEFAULTS, on: false });
});

test('openAiLabel posts bounded conversation, optional Bearer header and optional reasoning_effort without needing Droid or Factory', async () => {
  const observed: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown>; redirect?: RequestRedirect }> = [];
  const stubFetch: typeof globalThis.fetch = async (input, init) => {
    observed.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      redirect: init?.redirect,
    });
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(sampleLabel) } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const model = new WorkerLabelModel({
    droid: () => {
      throw new Error('Must not consult Droid binary');
    },
    key: () => {
      throw new Error('Must not consult Factory API key');
    },
    endpointApiKey: () => 'sk-test-123',
    fetch: stubFetch,
    system: () => 'Sign writer prompt',
  });

  // 1. Default effort omitted, key attached, conversation bounded
  const out = await model.generate({ text: 'x'.repeat(LABEL_TEXT_CHARS + 250), previousSubject: 's'.repeat(90) }, { ...endpointSettings, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-nano' }, new AbortController().signal);
  assert.deepEqual(out, { ...sampleLabel, generated: true });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(observed[0].redirect, 'error');
  assert.equal(observed[0].headers.Authorization, 'Bearer sk-test-123');
  assert.equal(observed[0].body.model, 'openai/gpt-4.1-nano');
  assert.equal('reasoning_effort' in observed[0].body, false, 'omits reasoning_effort by default');
  assert.equal('temperature' in observed[0].body, false, 'omits temperature for reasoning-model compatibility');
  const messages = observed[0].body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /^Sign writer prompt\n/);
  const userPayload = JSON.parse(messages[1].content) as { previousSubject: string; conversation: string };
  assert.equal(userPayload.previousSubject, 's'.repeat(60));
  assert.equal(userPayload.conversation.length, LABEL_TEXT_CHARS);

  // 2. Localhost without API key and with explicit reasoning_effort
  await openAiLabel({ text: 'user: hello' }, { ...endpointSettings, baseUrl: 'http://localhost:11434', endpointEffort: 'minimal' }, undefined, 'System', new AbortController().signal, 15_000, stubFetch);
  assert.equal(observed[1].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal('Authorization' in observed[1].headers, false);
  assert.equal(observed[1].body.reasoning_effort, 'minimal');
});

test('extractCompletionLabel and openAiLabel handle <think> blocks, array content parts, code fences, and split UTF-8 chunks', async () => {
  assert.deepEqual(extractCompletionLabel('<think>\nReasoning about the task subject...\n</think>\n```json\n{"name":"Café Labels","summary":"Handling local thinking models"}\n```'), {
    name: 'Café Labels',
    summary: 'Handling local thinking models',
    generated: true,
  });
  assert.deepEqual(extractCompletionLabel('Sure, here is the JSON:\n{"name":"Auth Middleware","summary":"Adding token expiry checks"}'), { name: 'Auth Middleware', summary: 'Adding token expiry checks', generated: true });

  // Split multi-byte UTF-8 across chunks + structured content array
  const fullJson = Buffer.from(
    JSON.stringify({
      choices: [
        {
          message: {
            content: [
              { type: 'thinking', text: 'internal reasoning' },
              { type: 'text', text: JSON.stringify({ name: 'Café Sign', summary: 'Checking split UTF-8 bytes' }) },
            ],
          },
        },
      ],
    }),
  );
  const splitAt = fullJson.indexOf(Buffer.from('é')) + 1;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(fullJson.subarray(0, splitAt));
      controller.enqueue(fullJson.subarray(splitAt));
      controller.close();
    },
  });
  const result = await openAiLabel({ text: 'assistant: done' }, endpointSettings, undefined, 'System', new AbortController().signal, 15_000, async () => new Response(stream, { status: 200 }));
  assert.equal(result.name, 'Café Sign');
});

test('openAiLabel enforces 256 KiB response limit, refuses redirects, supports cancellation, and never echoes provider secrets', async () => {
  // Oversized stream
  const hugeStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024).fill(0x78));
    },
  });
  await assert.rejects(
    openAiLabel({ text: 'hi' }, endpointSettings, undefined, 'System', new AbortController().signal, 15_000, async () => new Response(hugeStream, { status: 200 })),
    /256 KiB/,
  );

  // Redirect error
  await assert.rejects(
    openAiLabel({ text: 'hi' }, endpointSettings, undefined, 'System', new AbortController().signal, 15_000, async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }),
    /redirect/,
  );

  // HTTP status errors never echo private body text
  for (const [status, key, pattern] of [
    [401, undefined, /requires an API key \(HTTP 401\)/],
    [401, 'sk-private-secret', /rejected the API key \(HTTP 401\)/],
    [404, 'sk-private-secret', /HTTP 404/],
    [400, undefined, /HTTP 400/],
    [429, undefined, /HTTP 429/],
    [502, undefined, /HTTP 502/],
  ] as const) {
    await assert.rejects(
      openAiLabel({ text: 'hi' }, endpointSettings, key, 'System', new AbortController().signal, 15_000, async () => new Response('{"error":{"message":"Invalid key sk-private-secret"}}', { status })),
      (err: Error) => {
        assert.ok(err instanceof LabelModelError);
        assert.match(err.message, pattern);
        assert.doesNotMatch(err.message, /sk-private-secret/);
        return true;
      },
    );
  }

  // Cancellation aborts in-flight fetch
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    openAiLabel({ text: 'hi' }, endpointSettings, undefined, 'System', controller.signal, 15_000, async () => new Response('{}')),
    /cancelled or timed out/,
  );
});

const browser = browserStatus();

test('workerLabelSettings UI: presets, live URL resolution, Test endpoint, saved key lifecycle, and untouched Droid mode', { skip: browser.installed ? false : `Chromium is not installed in ${browser.path}` }, async (t) => {
  const chromium = await launchBrowser();
  t.after(closeBrowser);
  const harnessCode = buildSync({
    stdin: {
      contents: `
          import { store } from './src/client/state.ts';
          import { workerLabelSettings } from './src/client/ui/worker-labels.ts';

          window.__runUiTest = async () => {
            const requests: any[] = [];
            let completed = 0;
            const waitRequest = async (expected: number) => {
              while (completed < expected) await new Promise<void>((r) => setTimeout(r, 0));
            };
            const net = {
              request: async (msg: any) => {
                requests.push(msg);
                try {
                  if (msg.t === 'workerLabels.test') {
                    return { t: 'action.result', requestId: '1', ok: true, note: 'Connected (42 ms) · sample label: “Fix Login” — Checking redirect loop' };
                  }
                  if (msg.t === 'workerLabels.set') {
                    const { apiKey, ...rest } = msg.settings;
                    const hasApiKey = apiKey !== undefined ? Boolean(apiKey) : Boolean(store.workerLabels.settings.hasApiKey);
                    store.workerLabels = {
                      ...store.workerLabels,
                      settings: msg.settings.implementation === 'openai' ? { ...rest, hasApiKey } : rest,
                    };
                    store.emit('workerLabels');
                    return { t: 'action.result', requestId: '2', ok: true };
                  }
                  return { t: 'action.result', requestId: '3', ok: false };
                } finally {
                  setTimeout(() => completed++, 0);
                }
              },
            };

            const view = workerLabelSettings(net as any);
            document.getElementById('root')!.append(view.element);

            const impl = view.element.querySelector('select[aria-label="Worker label implementation"]') as HTMLSelectElement;
            const urlInput = view.element.querySelector('input[aria-label="Worker label endpoint URL"]') as HTMLInputElement;
            const modelInput = view.element.querySelector('input[aria-label="Worker label endpoint model slug"]') as HTMLInputElement;
            const keyInput = view.element.querySelector('input[aria-label="Worker label endpoint API key"]') as HTMLInputElement;
            const byText = (label: string) => [...view.element.querySelectorAll('button')].find((b) => b.textContent === label)!;

            const initialTestHidden = byText('Test endpoint').classList.contains('hidden');

            impl.value = 'openai';
            impl.dispatchEvent(new Event('change'));
            const openAiTestVisible = !byText('Test endpoint').classList.contains('hidden');

            byText('OpenRouter').click();
            const presetUrl = urlInput.value;
            const liveHint = [...view.element.querySelectorAll('.field-hint')].map((el) => el.textContent).join(' | ');

            modelInput.value = 'openai/gpt-4.1-nano';
            modelInput.dispatchEvent(new Event('input'));
            keyInput.value = 'sk-or-secret';
            keyInput.dispatchEvent(new Event('input'));
            byText('Test endpoint').click();
            await waitRequest(1);
            const testBanner = view.element.querySelector('.note.good')?.textContent ?? '';

            byText('Save').click();
            await waitRequest(2);
            const afterSaveKeyValue = keyInput.value;
            const clearKeyVisible = !byText('Clear key').classList.contains('hidden');

            // Clicking Clear key marks key for removal and hides Clear key button
            byText('Clear key').click();
            const clearKeyHiddenAfterClear = byText('Clear key').classList.contains('hidden');
            byText('Cancel').click();
            const clearKeyRestoredAfterCancel = !byText('Clear key').classList.contains('hidden');

            // Switching URL to localhost hides Clear key and does not carry saved key
            byText('Ollama').click();
            const clearKeyHiddenOnLocalhost = byText('Clear key').classList.contains('hidden');

            view.dispose();
            return {
              initialTestHidden,
              openAiTestVisible,
              presetUrl,
              liveHint,
              testBanner,
              afterSaveKeyValue,
              clearKeyVisible,
              clearKeyHiddenAfterClear,
              clearKeyRestoredAfterCancel,
              clearKeyHiddenOnLocalhost,
              requests,
            };
          };
        `,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');

  const context = await newIsolatedContext(chromium, { viewport: { width: 1024, height: 760 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/api/droid/models*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [{ id: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash', supportedReasoningEfforts: ['low', 'medium'], labelReasoningEfforts: ['off', 'low', 'medium'] }],
      }),
    }),
  );
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: harnessCode });

  const outcome = await page.evaluate(() => (window as unknown as { __runUiTest: () => Promise<any> }).__runUiTest());

  assert.equal(outcome.initialTestHidden, true);
  assert.equal(outcome.openAiTestVisible, true);
  assert.equal(outcome.presetUrl, 'https://openrouter.ai/api/v1');
  assert.match(outcome.liveHint, /Requests POST https:\/\/openrouter\.ai\/api\/v1\/chat\/completions/);
  assert.match(outcome.testBanner, /Connected \(42 ms\)/);
  assert.equal(outcome.afterSaveKeyValue, '', 'saved password clears from DOM input');
  assert.equal(outcome.clearKeyVisible, true);
  assert.equal(outcome.clearKeyHiddenAfterClear, true);
  assert.equal(outcome.clearKeyRestoredAfterCancel, true);
  assert.equal(outcome.clearKeyHiddenOnLocalhost, true);
  assert.equal(outcome.requests.length, 2);
  assert.equal(outcome.requests[0].t, 'workerLabels.test');
  assert.equal(outcome.requests[0].settings.apiKey, 'sk-or-secret');
  assert.equal(outcome.requests[1].t, 'workerLabels.set');
  assert.equal(outcome.requests[1].settings.model, 'openai/gpt-4.1-nano');
});
