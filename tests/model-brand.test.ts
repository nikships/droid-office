import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SUBSCRIPTION_PROVIDERS } from '../src/shared/subscriptions.js';
import { MODEL_BRANDS, modelBrand, providerBrand } from '../src/client/ui/model-brand.js';

test('model families beat API transports and subscription gateways', () => {
  // Names and ids from the owner's Droid catalogue (also used in model-search.test.ts).
  assert.equal(modelBrand({ id: 'custom:droidproxy:gpt-6.1-sol', name: 'DroidProxy: GPT 6.1 Sol', provider: 'openai' }), 'openai');
  assert.equal(modelBrand({ id: 'custom:droidproxy:ag-c55o-high', name: 'DroidProxy: Antigravity: Claude Opus 5.5 (High)', provider: 'openai' }), 'claude');
  assert.equal(modelBrand({ id: 'custom:openrouter:kimi-k3.1-pro', name: 'OpenRouter: Kimi K3.1 Pro', provider: 'anthropic' }), 'kimi');
  assert.equal(modelBrand({ id: 'glm-5.3', provider: 'factory' }), 'glm');
  assert.equal(modelBrand({ id: 'deepseek-v4-pro', provider: 'factory' }), 'deepseek');
  assert.equal(modelBrand({ id: 'custom:zen:space-bunny-free', name: 'Space Alpha Bunny', provider: 'generic-chat-completion-api' }), undefined);
});

test('canonical model IDs win, with display names as the fallback for opaque ids', () => {
  assert.equal(modelBrand({ id: 'gpt-6.1-sol', name: 'Claude gateway' }), 'openai');
  assert.equal(modelBrand({ id: 'custom:anthropic:gpt-6.1-sol' }), 'openai');
  assert.equal(modelBrand({ id: 'custom:openai:opaque', name: 'Sonnet 5.5' }), 'claude');
  assert.equal(modelBrand({ id: 'opaque', name: 'Gemini 3 Pro', provider: 'google' }), 'gemini');
  assert.equal(modelBrand({ id: 'custom:droidproxy:opaque', provider: 'generic-chat-completion-api' }), undefined);
});

test('family aliases, case and separators keep their own mark', () => {
  const aliases = {
    claude: ['claude-opus-5-5', 'OPUS 5.5', 'sonnet', 'haiku'],
    codex: ['gpt-5-codex', 'Codex'],
    gemini: ['gemini-3-pro', 'Antigravity: Gemini'],
    gemma: ['gemma-3'],
    deepseek: ['DeepSeek V4 Pro', 'deep-seek'],
    qwen: ['Qwen3-Coder'],
    grok: ['grok-4'],
    kimi: ['Kimi K3.1'],
    glm: ['GLM-5.3', 'chatglm'],
    minimax: ['MiniMax-M2'],
    mistral: ['Mistral', 'Mixtral', 'Codestral', 'Devstral', 'Magistral'],
    meta: ['Llama4'],
    muse: ['Muse'],
    cohere: ['command-r-plus', 'Aya'],
    nvidia: ['Nemotron'],
    perplexity: ['Sonar Pro'],
    openai: ['gpt_6', 'ChatGPT', 'o3', 'o4-mini'],
  } as const;
  for (const [brand, names] of Object.entries(aliases)) {
    for (const name of names) assert.equal(modelBrand({ name }), brand, name);
  }
});

test('provider-only displays prefer the model brand and cover every subscription', () => {
  assert.equal(providerBrand('Anthropic'), 'claude');
  assert.equal(providerBrand('Google'), 'gemini');
  assert.equal(providerBrand('xAI'), 'grok');
  assert.equal(providerBrand('Z.ai'), 'glm');
  for (const key of SUBSCRIPTION_PROVIDERS) assert.ok(providerBrand(key), key);
  assert.equal(providerBrand('DroidProxy'), undefined, 'a gateway must not stand in for an unknown model');
  assert.equal(providerBrand('Other'), undefined);
  assert.equal(providerBrand('constructor'), undefined);
  assert.equal(providerBrand(), undefined);
  assert.equal(modelBrand({}), undefined);
  assert.equal(modelBrand({ provider: 'Anthropic' }), 'claude');
  assert.equal(modelBrand({ id: 'megptastic', name: 'unrelated' }), undefined);
});

test('every mapped mark is bundled locally as a standalone SVG, with attribution', () => {
  const root = new URL('../src/client/public/icons/models/', import.meta.url);
  for (const { file } of Object.values(MODEL_BRANDS)) {
    const svg = readFileSync(new URL(file, root), 'utf8');
    assert.match(svg, /<svg\b/);
    assert.match(svg, /viewBox=/);
    assert.doesNotMatch(svg, /<script\b|<image\b|<foreignObject\b|(?:href|src)=["']https?:/i);
  }
  assert.match(readFileSync(new URL('LICENSE.txt', root), 'utf8'), /Copyright \(c\) 2023 LobeHub/);
});

test('Android bundles every brand as trusted 24×24 path-only SVGs its vector reader supports', () => {
  const root = new URL('../android/app/src/main/assets/model-icons/', import.meta.url);
  for (const brand of Object.keys(MODEL_BRANDS)) {
    const svg = readFileSync(new URL(`${brand}.svg`, root), 'utf8');
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /<path\b/);
    assert.doesNotMatch(svg, /<(?!\/?(?:svg|path|title)\b)[a-z]|transform=|(?:href|src)=|<(?:linearGradient|radialGradient)\b/i, brand);
  }
  assert.match(readFileSync(new URL('LICENSE.txt', root), 'utf8'), /LobeHub/);
});
