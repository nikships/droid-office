import assert from 'node:assert/strict';
import test from 'node:test';
import { highlightRanges, pushRecent, scopesOf, scoreModel, sectionsFor, splitFamily, squash } from '../src/client/ui/model-search.js';

// Entries as droid lists them for the owner: BYOK models from their settings, Factory's from its catalogue.
const catalogue = [
  { id: 'custom:zen:space-bunny-free', displayName: 'Space Alpha Bunny', custom: true, provider: 'generic-chat-completion-api' },
  { id: 'custom:droidproxy:gpt-6.1-sol', displayName: 'DroidProxy: GPT 6.1 Sol', custom: true, provider: 'openai' },
  { id: 'custom:droidproxy:ag-c55o-high', displayName: 'DroidProxy: Antigravity: Claude Opus 5.5 (High)', custom: true, provider: 'openai' },
  { id: 'custom:openrouter:kimi-k3.1-pro', displayName: 'OpenRouter: Kimi K3.1 Pro', custom: true, provider: 'anthropic' },
  { id: 'claude-opus-5-5', displayName: 'Opus 5.5', provider: 'anthropic', tokenMultiplier: 1.6, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', provider: 'openai', tokenMultiplier: 0.8, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'glm-5.3', displayName: 'GLM-5.3', provider: 'factory', tokenMultiplier: 0.56, noImages: true, supportedReasoningEfforts: ['low', 'high', 'max'] },
  { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro [Deprecated]', provider: 'factory', legacy: true, tokenMultiplier: 0.528, noImages: true, supportedReasoningEfforts: ['low', 'high', 'max'] },
];

async function listed() {
  const { pickerModel } = await import('../src/client/ui/models.js');
  return catalogue.map((m) => pickerModel(m as Parameters<typeof pickerModel>[0]));
}

test('the picker lists your gateways by name and Factory models by provider', async () => {
  const models = await listed();
  const byId = (id: string) => models.find((m) => m.id === id);
  assert.deepEqual([byId('custom:droidproxy:gpt-6.1-sol')?.group, byId('custom:openrouter:kimi-k3.1-pro')?.group, byId('custom:zen:space-bunny-free')?.group], ['DroidProxy', 'OpenRouter', 'Zen']);
  assert.equal(byId('custom:droidproxy:gpt-6.1-sol')?.name, 'GPT 6.1 Sol');
  assert.equal(byId('custom:droidproxy:gpt-6.1-sol')?.glyph, true);
  assert.equal(byId('custom:openrouter:kimi-k3.1-pro')?.name, 'Kimi K3.1 Pro');
  assert.equal(byId('claude-opus-5-5')?.group, 'Anthropic');
  assert.equal(byId('claude-opus-5-5')?.cost, 1.6);
  assert.equal(byId('custom:droidproxy:gpt-6.1-sol')?.cost, undefined, 'your own key spends no Factory credits');
  assert.equal(byId('glm-5.3')?.group, 'Other');
  assert.deepEqual(byId('glm-5.3')?.tags, ['no images']);
  assert.equal(byId('deepseek-v4-pro')?.scope, 'Legacy');
  assert.equal(byId('deepseek-v4-pro')?.name, 'DeepSeek V4 Pro', 'Legacy already says deprecated');
  assert.match(byId('claude-opus-5-5')?.detail ?? '', /Anthropic · effort Low to Max/);
});

test('chips put yours first and other and legacy last', async () => {
  const keys = scopesOf(await listed()).map((s) => s.key);
  assert.deepEqual(keys, ['Yours', 'Anthropic', 'OpenAI', 'Other', 'Legacy']);
  assert.equal(scopesOf(await listed())[0].count, 4);
});

test('without a query: recents on top, then your biggest gateway, then the rest', async () => {
  const models = await listed();
  const sections = sectionsFor(models, { query: '', scope: '', recents: ['gpt-6.1-sol', 'gone-model', 'claude-opus-5-5'] });
  assert.deepEqual(
    sections.map((s) => s.label),
    ['Recent', 'DroidProxy', 'Zen', 'OpenRouter', 'Anthropic', 'OpenAI', 'Other', 'Legacy'],
  );
  assert.deepEqual(
    sections[0].models.map((m) => m.id),
    ['gpt-6.1-sol', 'claude-opus-5-5'],
    'a recent pick droid no longer lists is skipped',
  );
  const filtered = sectionsFor(models, { query: '', scope: 'Anthropic', recents: ['gpt-6.1-sol'] });
  assert.deepEqual(
    filtered.map((s) => s.label),
    ['Anthropic'],
    'a chip shows only its own group, with no recents',
  );
});

test('a query gives one ranked list, name matches first', async () => {
  const models = await listed();
  const [only] = sectionsFor(models, { query: 'opus', scope: '', recents: [] });
  assert.equal(only.flat, true);
  assert.equal(only.label, '2 matches');
  assert.deepEqual(
    only.models.map((m) => m.id),
    ['claude-opus-5-5', 'custom:droidproxy:ag-c55o-high'],
    'a name that starts with the word beats one that has it later',
  );
});

test('search ignores punctuation and finds by provider, gateway and id', async () => {
  const models = await listed();
  const ids = (query: string) => sectionsFor(models, { query, scope: '', recents: [] }).flatMap((s) => s.models.map((m) => m.id));
  assert.deepEqual(ids('gpt61').sort(), ['custom:droidproxy:gpt-6.1-sol', 'gpt-6.1-sol']);
  assert.deepEqual(ids('openrouter'), ['custom:openrouter:kimi-k3.1-pro']);
  assert.deepEqual(ids('sol openai').sort(), ['custom:droidproxy:gpt-6.1-sol', 'gpt-6.1-sol']);
  assert.deepEqual(ids('nothing like this'), []);
  assert.deepEqual(ids('glm-5.3'), ['glm-5.3']);
});

test('scoreModel needs every word to hit', async () => {
  const [sol] = (await listed()).filter((m) => m.id === 'gpt-6.1-sol');
  assert.ok(scoreModel(sol, 'gpt sol') > 0);
  assert.equal(scoreModel(sol, 'gpt opus'), 0);
  assert.ok(scoreModel(sol, '') > 0);
  assert.ok(scoreModel(sol, 'gpt-6.1 sol') > scoreModel(sol, 'sol'));
});

test('helpers: squash, highlight, family split and recents', () => {
  assert.equal(squash('GPT-6.1 Sol'), 'gpt61sol');
  assert.deepEqual(highlightRanges('Claude Opus 5.5 (High)', 'opus claude'), [
    [0, 6],
    [7, 11],
  ]);
  assert.deepEqual(highlightRanges('Opus', 'op us'), [[0, 4]], 'words that touch are drawn as one highlight');
  assert.deepEqual(splitFamily('Antigravity: Gemini 3.1 Pro (High)'), { family: 'Antigravity', rest: 'Gemini 3.1 Pro (High)' });
  assert.deepEqual(splitFamily('Opus 5.5'), { rest: 'Opus 5.5' });
  assert.deepEqual(pushRecent(['a', 'b', 'c', 'd'], 'c'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(pushRecent(['a', 'b', 'c', 'd'], 'e'), ['e', 'a', 'b', 'c']);
});
