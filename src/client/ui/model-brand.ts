/** Locally bundled LobeHub marks. Model families take precedence over whoever serves them. */
export const MODEL_BRANDS = {
  claude: { file: 'claude-color.svg' },
  openai: { file: 'openai.svg', mono: true },
  codex: { file: 'codex-color.svg' },
  gemini: { file: 'gemini-color.svg' },
  gemma: { file: 'gemma-color.svg' },
  deepseek: { file: 'deepseek-color.svg' },
  qwen: { file: 'qwen-color.svg' },
  grok: { file: 'grok.svg', mono: true },
  kimi: { file: 'kimi-color.svg', tile: true },
  glm: { file: 'chatglm-color.svg' },
  minimax: { file: 'minimax-color.svg' },
  mistral: { file: 'mistral-color.svg' },
  meta: { file: 'meta-color.svg' },
  muse: { file: 'muse-color.svg' },
  junie: { file: 'junie-color.svg' },
  copilot: { file: 'githubcopilot.svg', mono: true },
  antigravity: { file: 'antigravity-color.svg' },
  openrouter: { file: 'openrouter-color.svg' },
  nvidia: { file: 'nvidia-color.svg' },
  cohere: { file: 'cohere-color.svg' },
  perplexity: { file: 'perplexity-color.svg' },
} satisfies Record<string, { file: string; mono?: boolean; tile?: boolean }>;

export type ModelBrand = keyof typeof MODEL_BRANDS;

const FAMILIES: readonly [ModelBrand, RegExp][] = [
  ['claude', /\b(?:claude|opus|sonnet|haiku)\b/i],
  ['codex', /\bcodex\b/i],
  ['gemini', /\bgemini\b/i],
  ['gemma', /\bgemma\b/i],
  ['deepseek', /\bdeep[\s-]?seek\b/i],
  ['qwen', /\bqwen(?:\d|\b)/i],
  ['grok', /\bgrok\b/i],
  ['kimi', /\bkimi\b/i],
  ['glm', /\b(?:chat)?glm(?:\d|\b)/i],
  ['minimax', /\bminimax\b/i],
  ['mistral', /\b(?:mistral|mixtral|codestral|devstral|magistral)\b/i],
  ['muse', /\bmuse\b/i],
  ['meta', /\bllama(?:\d|\b)/i],
  ['cohere', /\b(?:command(?:[ -][ar])?|aya)\b/i],
  ['nvidia', /\bnemotron\b/i],
  ['perplexity', /\bsonar\b/i],
  ['openai', /\b(?:gpt(?:\d|\b)|chatgpt|o[1-9](?:\b|[ -]))/i],
];

const PROVIDERS: Record<string, ModelBrand> = {
  anthropic: 'claude',
  claude: 'claude',
  openai: 'openai',
  chatgpt: 'openai',
  codex: 'codex',
  google: 'gemini',
  gemini: 'gemini',
  antigravity: 'antigravity',
  deepseek: 'deepseek',
  qwen: 'qwen',
  alibaba: 'qwen',
  xai: 'grok',
  grok: 'grok',
  moonshot: 'kimi',
  moonshotai: 'kimi',
  kimi: 'kimi',
  zai: 'glm',
  zhipu: 'glm',
  glm: 'glm',
  minimax: 'minimax',
  mistral: 'mistral',
  meta: 'meta',
  muse: 'muse',
  junie: 'junie',
  copilot: 'copilot',
  githubcopilot: 'copilot',
  openrouter: 'openrouter',
  nvidia: 'nvidia',
  cohere: 'cohere',
  perplexity: 'perplexity',
};

/** Provider-only surfaces still prefer their model brand: Claude, not Anthropic; Gemini, not Google. */
export function providerBrand(provider?: string): ModelBrand | undefined {
  const key = provider?.toLowerCase().replace(/[^a-z0-9]/g, '');
  return key && Object.hasOwn(PROVIDERS, key) ? PROVIDERS[key] : undefined;
}

export interface ModelIdentity {
  id?: string;
  name?: string;
  provider?: string;
}

/** Ignore BYOK gateway prefixes: an OpenRouter/Anthropic endpoint can serve somebody else's model. */
function modelPart(text: string): string {
  return text
    .replace(/^custom:(?:[^:]+:)?/i, '')
    .replace(/^[^:]+:\s*/, '')
    .replace(/_/g, '-');
}

export function modelBrand({ id, name, provider }: ModelIdentity): ModelBrand | undefined {
  // IDs are canonical; a display name may mention a different family in a gateway or description.
  for (const text of [id, name]) {
    if (!text) continue;
    const bare = modelPart(text);
    const match = FAMILIES.find(([, pattern]) => pattern.test(bare));
    if (match) return match[0];
  }
  return providerBrand(provider);
}
