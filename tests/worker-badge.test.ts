import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectInfo } from '../src/shared/protocol.js';
import { claudeDefaults, droidDefaults, engineBadge, fetchDroidModels, workerBadge } from '../src/client/ui/provider.js';

const project = (over: Partial<ProjectInfo> = {}): ProjectInfo => ({
  name: 'p',
  dir: '/tmp/p',
  forge: 'github',
  agentCmd: 'droid',
  defaultProvider: 'droid',
  agentProviders: ['droid', 'claude', 'opencode', 'codex'],
  ...over,
});

// These run before the catalogue test below loads it (node runs a file's tests in order).
test('an explicit model and effort win over every default', () => {
  assert.equal(workerBadge('claude', 'opus', 'high', project()), 'Opus · High');
  assert.equal(engineBadge('claude', 'opus', 'high', project()), 'Opus · High');
  assert.equal(engineBadge('droid', 'custom:droidproxy:opus-5-5', 'high', project()), 'DroidProxy: Opus 5.5 · High');
});

test('before the catalogue loads, a Droid worker without an override shows its provider', () => {
  assert.deepEqual(droidDefaults(), {});
  assert.equal(workerBadge('droid', undefined, undefined, project()), undefined);
  assert.equal(engineBadge('droid', undefined, undefined, project()), 'Droid');
});

test('a worker that predates providers resolves to the office default', () => {
  assert.equal(engineBadge(undefined, undefined, undefined, project()), 'Droid');
});

test("Claude's office default comes from --agent-args, and only when Claude is the default agent", () => {
  const claude = project({ agentCmd: 'claude --model opus --effort high', defaultProvider: 'claude' });
  assert.deepEqual(claudeDefaults(claude), { model: 'opus', effort: 'high' });
  assert.equal(workerBadge('claude', undefined, undefined, claude), 'Opus · High');
  assert.equal(engineBadge('claude', undefined, undefined, claude), 'Opus · High');
  // --agent-args never apply to a worker hired onto another provider.
  assert.deepEqual(claudeDefaults(project({ agentCmd: 'droid --model opus' })), {});
  assert.equal(engineBadge('claude', undefined, undefined, project()), 'Claude Code');
});

test('claudeDefaults reads --model=, -m and --effort=, ignores unknown values, last wins', () => {
  assert.deepEqual(claudeDefaults(project({ agentCmd: 'claude --model=sonnet', defaultProvider: 'claude' })), { model: 'sonnet' });
  assert.deepEqual(claudeDefaults(project({ agentCmd: 'claude -m haiku', defaultProvider: 'claude' })), { model: 'haiku' });
  assert.deepEqual(claudeDefaults(project({ agentCmd: 'claude --effort=xhigh --model fable', defaultProvider: 'claude' })), {
    model: 'fable',
    effort: 'xhigh',
  });
  assert.deepEqual(claudeDefaults(project({ agentCmd: 'claude --model gpt-9 --effort warp', defaultProvider: 'claude' })), {});
  assert.deepEqual(claudeDefaults(project({ agentCmd: 'claude --model opus --model sonnet', defaultProvider: 'claude' })), { model: 'sonnet' });
  assert.deepEqual(claudeDefaults(project({ agentCmd: 'claude', defaultProvider: 'claude' })), {});
  assert.deepEqual(claudeDefaults(null), {});
});

test('OpenCode shows the raw model id, Codex and Custom show their provider', () => {
  assert.equal(engineBadge('opencode', 'anthropic/claude-sonnet-4', undefined, project()), 'anthropic/claude-sonnet-4');
  assert.equal(engineBadge('opencode', undefined, undefined, project()), 'OpenCode');
  assert.equal(engineBadge('codex', undefined, undefined, project()), 'Codex');
  assert.equal(engineBadge('custom', undefined, undefined, project()), 'Custom');
});

test('Droid workers without an override show the catalogue default once it loads', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      models: [{ id: 'custom:droidproxy:opus-5-5', displayName: 'DroidProxy: Opus 5.5' }],
      defaultModel: 'custom:droidproxy:opus-5-5',
      defaultReasoningEffort: 'high',
    }),
  })) as unknown as typeof fetch;
  await fetchDroidModels();
  assert.deepEqual(droidDefaults(), { model: 'custom:droidproxy:opus-5-5', effort: 'high' });
  assert.equal(workerBadge('droid', undefined, undefined, project()), 'DroidProxy: Opus 5.5 · High');
  assert.equal(engineBadge('droid', undefined, undefined, project()), 'DroidProxy: Opus 5.5 · High');
  // Model and effort fall back independently: each side keeps its own override.
  assert.equal(workerBadge('droid', 'glm-5.3-flash', undefined, project()), 'Glm 5.3 Flash · High');
  assert.equal(workerBadge('droid', undefined, 'low', project()), 'DroidProxy: Opus 5.5 · Low');
  assert.equal(workerBadge('droid', 'glm-5.3-flash', 'low', project()), 'Glm 5.3 Flash · Low');
});
