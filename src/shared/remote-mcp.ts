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

export interface RemoteMcpBot {
  id: string;
  name: string;
  floor: string;
  floorName?: string;
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
  floors: { id: string; name: string }[];
}

/** The `mcpServers` entry most MCP clients take as JSON. */
export function remoteMcpConfig(connection: RemoteMcpConnection): string {
  return JSON.stringify({ mcpServers: { 'droid-office': { type: 'http', url: connection.url, headers: connection.headers } } }, null, 2);
}
