// The Tailscale MCP endpoint for external workers, as Settings shows it (GET, PUT and POST /api/remote-mcp,
// only from the office's own machine, because the state holds every bot's credential).

export type RemoteMcpStatus = 'off' | 'starting' | 'serving' | 'unavailable';

/** What a bot's MCP client needs: a Streamable HTTP URL and the headers it sends on every request. */
export interface RemoteMcpConnection {
  url: string;
  headers: Record<string, string>;
}

/** A named key a bot holds besides its main one, so each of its clients can be revoked on its own. */
export interface RemoteMcpKey {
  id: string;
  name: string;
  createdAt: number;
  /** To the minute; unset until the key is first used. */
  lastUsedAt?: number;
  /** Only while the endpoint is on the tailnet. */
  connection?: RemoteMcpConnection;
}

/** Last push attempt to a Grok Bot's webhook, kept in memory while the office runs. */
export interface RemoteMcpWebhookDelivery {
  at: number;
  ok: boolean;
  status?: number;
  event: string;
  error?: string;
}

/** Grok Bot push configuration as Settings shows it (the bearer token itself is never sent to the browser). */
export interface RemoteMcpGrokBot {
  webhookUrl: string;
  /** True when a bearer token is saved on disk. */
  hasToken: boolean;
  lastDelivery?: RemoteMcpWebhookDelivery;
}

export interface RemoteMcpBot {
  id: string;
  name: string;
  createdAt: number;
  status?: string;
  activity?: string;
  unread: number;
  /** When its main key last connected, to the minute. */
  lastUsedAt?: number;
  /** Only while the endpoint is on the tailnet. */
  connection?: RemoteMcpConnection;
  /** Named keys besides the main one; absent from an office older than named keys. */
  keys?: RemoteMcpKey[];
  /** Present when this bot's MCP connection is marked as a Grok Bot with a push webhook. */
  grokBot?: RemoteMcpGrokBot;
}

export interface RemoteMcpState {
  on: boolean;
  status: RemoteMcpStatus;
  url?: string;
  /** Why it isn't serving, or a warning while it is. */
  reason?: string;
  /** A Tailscale admin page that fixes `reason`, such as turning on HTTPS certificates for the tailnet. */
  fixUrl?: string;
  /** Set when this office was started with the endpoint turned off (DROID_OFFICE_REMOTE_MCP=off). */
  locked?: string;
  bots: RemoteMcpBot[];
}

/** The `mcpServers` entry most MCP clients take as JSON. */
export function remoteMcpConfig(connection: RemoteMcpConnection): string {
  return JSON.stringify({ mcpServers: { 'droid-office': { type: 'http', url: connection.url, headers: connection.headers } } }, null, 2);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Validates a Grok Bot webhook URL: HTTPS anywhere, or HTTP only on loopback for local relays and tests.
 * Credentials in the URL itself are refused so secrets live only in the bearer token field.
 */
export function validateGrokWebhookUrl(raw: unknown): { url: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'Enter the Grok Bot webhook URL' };
  const trimmed = raw.trim();
  if (trimmed.length > 2000) return { error: 'Webhook URL must be 2000 characters or fewer' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'Enter a valid webhook URL (https://…)' };
  }
  if (parsed.username || parsed.password) return { error: 'Keep credentials out of the webhook URL; enter the bearer token below instead' };
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(host))) {
    return { error: 'Webhook URL must use https:// (http:// is allowed only on localhost)' };
  }
  return { url: parsed.toString() };
}
