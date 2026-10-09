import type { FactoryCiState } from './factory-ci.js';
import { emptyCi } from './factory-ci.js';
import type { FactoryCloudState } from './factory-cloud.js';
import { emptyCloud } from './factory-cloud.js';
import type { FactoryComputersState } from './factory-computers.js';
import { emptyComputers } from './factory-computers.js';
import type { FactorySessionsState } from './factory-sessions.js';
import { emptySessions } from './factory-sessions.js';
import type { FactoryWikiState } from './factory-wiki.js';
import { emptyWiki } from './factory-wiki.js';

// The office's connection to Factory (factory.ai) with an API key, and the read state of each
// Factory feature the office shows. See docs/factory.md for the contract a feature follows.

/** Where someone makes a Factory API key. */
export const FACTORY_KEYS_URL = 'https://app.factory.ai/settings/api-keys';

/** The Factory features the office polls, each with its own slice of FactoryState. */
export type FactoryFeatureId = 'computers' | 'sessions' | 'ci' | 'wiki' | 'cloud';
export const FACTORY_FEATURES: readonly FactoryFeatureId[] = ['computers', 'sessions', 'ci', 'wiki', 'cloud'];

export function isFactoryFeature(v: unknown): v is FactoryFeatureId {
  return typeof v === 'string' && (FACTORY_FEATURES as readonly string[]).includes(v);
}

/** What the connection probes: the four API groups the features read, plus the organization and service accounts. Cloud droids are sessions. */
export type FactoryGroup = 'computers' | 'sessions' | 'ci' | 'wiki' | 'organization' | 'serviceAccounts';

export const FACTORY_GROUPS: readonly { id: FactoryGroup; label: string }[] = [
  { id: 'computers', label: 'Droid Computers' },
  { id: 'sessions', label: 'Droid sessions' },
  { id: 'ci', label: 'CI automations' },
  { id: 'wiki', label: 'AutoWiki' },
  { id: 'organization', label: 'Organization' },
  { id: 'serviceAccounts', label: 'Service accounts' },
];

/**
 * What the key can do with one group: `ok`, `denied` (the API said no: a plan, a role, the key),
 * `checking` (asked, no answer yet) or `error` (no answer we can use: a timeout, a 5xx).
 */
export type FactoryCapabilityStatus = 'ok' | 'denied' | 'checking' | 'error';

export interface FactoryCapability {
  group: FactoryGroup;
  status: FactoryCapabilityStatus;
  /** Why not, in a few words ("Needs a Teams plan"), or what it found ("GitHub connected"). */
  reason?: string;
  /** What the API said, when it said something. */
  detail?: string;
  /** The HTTP status of the answer, 0 for none. */
  httpStatus?: number;
  checkedAt?: number;
}

/** Whose key it is, from the organization's users. */
export interface FactoryAccount {
  id?: string;
  name: string;
  email?: string;
}

/** What browsers get about the connection. Never the key. */
export interface FactoryConnection {
  connected: boolean;
  /** The key's first letters and last four, like `fk-…a1b2`. */
  fingerprint?: string;
  account?: FactoryAccount;
  /** How many people are in the organization (`membersMore`: at least that many). */
  members?: number;
  membersMore?: boolean;
  /** Who connected it, and when (ms). */
  by?: string;
  at?: number;
  capabilities: FactoryCapability[];
  /** When the probe last finished (ms). */
  checkedAt?: number;
  /** A probe is running now. */
  checking?: boolean;
  /** Factory turned the saved key down since (a 401): every feature stops polling until it's checked again or replaced. */
  rejected?: string;
}

/** Every Factory feature's read state, one slice each, as `{ t: 'factory' }` and `welcome` carry it. */
export interface FactoryState {
  connection: FactoryConnection;
  computers: FactoryComputersState;
  sessions: FactorySessionsState;
  ci: FactoryCiState;
  wiki: FactoryWikiState;
  cloud: FactoryCloudState;
}

/** The slices before anything is read: what a disconnected office shows. */
export function emptyFactoryState(): FactoryState {
  return { connection: { connected: false, capabilities: [] }, computers: emptyComputers(), sessions: emptySessions(), ci: emptyCi(), wiki: emptyWiki(), cloud: emptyCloud() };
}

/** One group's capability, if the probe has said. */
export function capabilityOf(conn: FactoryConnection, group: FactoryGroup): FactoryCapability | undefined {
  return conn.capabilities.find((c) => c.group === group);
}

/** Whether the office can read a feature now: connected, the key not rejected, and the group not denied. */
export function factoryCan(conn: FactoryConnection, group: FactoryGroup): boolean {
  if (!conn.connected || conn.rejected) return false;
  return capabilityOf(conn, group)?.status !== 'denied';
}
