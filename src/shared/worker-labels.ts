/** Separate from worker effort pins: the sign writer can use a model's non-thinking modes. */
export const LABEL_EFFORTS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type LabelEffort = (typeof LABEL_EFFORTS)[number];

/** Optional reasoning_effort for OpenAI-compatible endpoints (omitted by default so standard chat models never fail). */
export const OPENAI_LABEL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type OpenAiLabelEffort = (typeof OPENAI_LABEL_EFFORTS)[number];

export interface WorkerLabelEndpointPreset {
  id: string;
  label: string;
  baseUrl: string;
  modelPlaceholder: string;
  needsKey?: boolean;
}

export const WORKER_LABEL_ENDPOINT_PRESETS: readonly WorkerLabelEndpointPreset[] = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', modelPlaceholder: 'llama3.2, qwen2.5:7b, gemma3:4b…' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', modelPlaceholder: 'qwen2.5-coder-7b-instruct…' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelPlaceholder: 'gpt-4.1-nano, gpt-4.1-mini, gpt-4o-mini…', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelPlaceholder: 'openai/gpt-4.1-nano, google/gemini-2.5-flash-lite…', needsKey: true },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', modelPlaceholder: 'llama-3.1-8b-instant, openai/gpt-oss-20b…', needsKey: true },
  { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', modelPlaceholder: 'grok-3-mini…', needsKey: true },
];

export interface WorkerLabelSettings {
  on: boolean;
  /** Omitted in older preferences: the isolated Droid implementation. */
  implementation?: 'droid' | 'openai';
  /** Base URL or full /chat/completions URL for an OpenAI-compatible endpoint. */
  baseUrl?: string;
  /**
   * Client -> server write-only API key:
   * - non-empty string sets or replaces the saved key
   * - empty string '' clears the saved key
   * - undefined keeps an existing saved key on the same URL origin
   * Never sent back to clients.
   */
  apiKey?: string;
  /** Server -> client indicator that an API key is stored for `baseUrl`. */
  hasApiKey?: boolean;
  /** Optional reasoning_effort sent to OpenAI-compatible endpoints; omitted when undefined. */
  endpointEffort?: OpenAiLabelEffort;
  model: string;
  effort: LabelEffort;
  intervalSeconds: number;
}

export interface WorkerLabelState {
  settings: WorkerLabelSettings;
  running: number;
  queued: number;
  error?: string;
  updatedAt?: number;
}

export interface ParsedLabelEndpoint {
  baseUrl: string;
  completionsUrl: string;
  origin: string;
  host: string;
}

export const WORKER_LABEL_DEFAULTS: WorkerLabelSettings = { on: true, model: 'glm-5.3-flash', effort: 'low', intervalSeconds: 60 };
export const LABEL_TEXT_CHARS = 24_000;
export const isLabelEffort = (value: unknown): value is LabelEffort => LABEL_EFFORTS.includes(value as LabelEffort);
export const isOpenAiLabelEffort = (value: unknown): value is OpenAiLabelEffort => OPENAI_LABEL_EFFORTS.includes(value as OpenAiLabelEffort);

function isLinkLocalOrMetadata(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '169.254.169.254' || host === 'fd00:ec2::254' || host === 'metadata.google.internal') return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  return false;
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === '0.0.0.0' || host === '::' || isLinkLocalOrMetadata(host)) return false;
  if (host === 'localhost' || host === '::1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return false;
    const [a, b] = octets;
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // Tailscale CGNAT 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(':')) return /^f[cd][0-9a-f]{0,2}:/i.test(host);
  if (!host.includes('.')) return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
  return /\.(?:local|lan|internal|home\.arpa|ts\.net)$/.test(host);
}

/**
 * Validates and normalizes an OpenAI-compatible endpoint URL.
 * Accepts a server root (`http://localhost:11434`), a `/v1` base (`https://api.openai.com/v1`),
 * or a full `/chat/completions` URL, and resolves the exact POST URL.
 */
export function parseLabelEndpointUrl(raw: unknown): ParsedLabelEndpoint | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'Enter an endpoint URL (for example http://localhost:11434/v1 or https://api.openai.com/v1).' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(trimmed)) {
    return { error: 'Enter a valid endpoint URL without spaces or control characters.' };
  }
  let candidate = trimmed;
  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(trimmed);
  if (!hasExplicitScheme) {
    const authority = trimmed.split(/[/?#]/, 1)[0] ?? '';
    let hostPart = '';
    let hasPort = false;
    if (authority.startsWith('[')) {
      const bracket = /^\[[^\]]+\](?::(\d+))?$/.exec(authority);
      if (!bracket) return { error: 'Enter a valid endpoint URL (for example http://localhost:11434/v1 or https://api.openai.com/v1).' };
      hostPart = authority.slice(0, authority.indexOf(']') + 1);
      hasPort = !!bracket[1];
    } else {
      const colon = authority.indexOf(':');
      hostPart = colon === -1 ? authority : authority.slice(0, colon);
      hasPort = colon !== -1;
    }
    if (!hostPart || (hostPart.toLowerCase() !== 'localhost' && !hostPart.startsWith('[') && !hostPart.includes('.') && !hasPort)) {
      return { error: 'Enter an endpoint URL (for example http://localhost:11434/v1 or https://api.openai.com/v1).' };
    }
    candidate = `${isPrivateOrLocalHost(hostPart) ? 'http://' : 'https://'}${trimmed}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: 'Enter a valid endpoint URL (for example http://localhost:11434/v1 or https://api.openai.com/v1).' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http:// and https:// endpoints are supported.' };
  }
  if (parsed.username || parsed.password) {
    return { error: 'Put credentials in the API key field, not in the URL.' };
  }
  const hostLower = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostLower || hostLower === '0.0.0.0' || hostLower === '::') {
    return { error: 'Use localhost or 127.0.0.1 instead of 0.0.0.0.' };
  }
  if (isLinkLocalOrMetadata(hostLower)) {
    return { error: 'Cloud metadata and link-local addresses cannot be used as label endpoints.' };
  }
  if (parsed.protocol === 'http:' && !isPrivateOrLocalHost(parsed.hostname)) {
    return { error: 'Use https:// for remote endpoints (http:// is allowed on localhost, LAN and Tailscale hosts).' };
  }
  parsed.hash = '';
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = cleanPath || '/';
  const baseUrl = cleanPath ? parsed.toString() : `${parsed.origin}${parsed.search}`;
  const target = new URL(parsed.toString());
  target.pathname = !cleanPath ? '/v1/chat/completions' : cleanPath.endsWith('/chat/completions') ? cleanPath : `${cleanPath}/chat/completions`;
  return { baseUrl, completionsUrl: target.toString(), origin: parsed.origin, host: parsed.host };
}

export function sameEndpointOrigin(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const pa = parseLabelEndpointUrl(a);
  const pb = parseLabelEndpointUrl(b);
  return !('error' in pa) && !('error' in pb) && pa.origin === pb.origin;
}
