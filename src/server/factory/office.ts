import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FACTORY_GROUPS, FACTORY_KEYS_URL, type FactoryAccount, type FactoryCapability, type FactoryConnection, type FactoryGroup } from '../../shared/factory.js';
import { redact } from '../jira.js';
import { FACTORY_API, FactoryApi, FactoryError, fingerprint } from './api.js';

type Fetch = typeof fetch;

interface Saved {
  key: string;
  by: string;
  at: number;
  account?: FactoryAccount;
  members?: number;
  membersMore?: boolean;
  capabilities: FactoryCapability[];
  checkedAt?: number;
  rejected?: string;
}

/** What one group's probe found besides "ok", and the users and computers that say whose key it is. */
interface Found {
  reason?: string;
  users?: unknown[];
  usersMore?: boolean;
}

/** One cheap GET per group. `sessions` is the slow one (see SLOW_TIMEOUT_MS). */
const PROBES: Record<FactoryGroup, (api: FactoryApi) => Promise<Found>> = {
  computers: async (api) => {
    const r = await api.providers();
    const providers = (r?.providers ?? []).filter((p): p is string => typeof p === 'string');
    return { reason: providers.length ? `Can make ${providers.join(', ')} computers` : undefined };
  },
  sessions: async (api) => {
    await api.sessions(1);
    return {};
  },
  ci: async (api) => {
    const r = await api.ciOwners();
    const connected = r?.integration?.connected;
    return { reason: connected === false ? 'GitHub isn’t connected to Factory yet' : connected ? 'GitHub connected' : undefined };
  },
  wiki: async (api) => {
    await api.wikiRuns();
    return {};
  },
  organization: async (api) => {
    const r = await api.users();
    const users = Array.isArray(r?.users) ? r.users : [];
    return { reason: `${users.length}${r?.pagination?.hasMore ? '+' : ''} ${users.length === 1 ? 'member' : 'members'}`, users, usersMore: !!r?.pagination?.hasMore };
  },
  serviceAccounts: async (api) => {
    await api.serviceAccounts();
    return {};
  },
};

/** A group's capability from the error its probe threw. */
export function capabilityFromError(group: FactoryGroup, err: unknown, at: number): FactoryCapability {
  const e = err instanceof FactoryError ? err : new FactoryError((err as Error)?.message ?? 'Something went wrong', 0);
  const base = { group, httpStatus: e.status, checkedAt: at, ...(e.detail ? { detail: e.detail } : {}) };
  if (e.status === 402) return { ...base, status: 'denied', reason: /team/i.test(e.detail) ? 'Needs a Teams plan' : 'Needs another Factory plan' };
  if (e.status === 403) return { ...base, status: 'denied', reason: 'The key’s account isn’t allowed to' };
  if (e.status === 401) return { ...base, status: 'denied', reason: 'Key rejected' };
  if (e.status === 404) return { ...base, status: 'denied', reason: 'Not available to this account' };
  return { ...base, status: 'error', reason: e.message };
}

const userName = (u: Record<string, unknown>) => {
  const name = [u.firstName, u.lastName].filter((s) => typeof s === 'string' && s.trim()).join(' ');
  return name || (typeof u.email === 'string' ? u.email : '') || 'Unknown';
};

/**
 * Whose key it is: the person who owns the account's computers (`ownerId` of a human owner), among
 * the organization's users; else the only user there is.
 */
export function accountOf(users: unknown[], computers: unknown[]): FactoryAccount | undefined {
  const list = users.filter((u): u is Record<string, unknown> => !!u && typeof u === 'object' && typeof (u as { id?: unknown }).id === 'string');
  const account = (u: Record<string, unknown>): FactoryAccount => ({ id: String(u.id), name: userName(u), ...(typeof u.email === 'string' ? { email: u.email } : {}) });
  for (const c of computers) {
    if (!c || typeof c !== 'object') continue;
    const { ownerId, ownerPrincipalKind } = c as { ownerId?: unknown; ownerPrincipalKind?: unknown };
    if (ownerPrincipalKind !== undefined && ownerPrincipalKind !== 'human') continue;
    const u = list.find((x) => x.id === ownerId);
    if (u) return account(u);
  }
  return list.length === 1 ? account(list[0]) : undefined;
}

/** Writes JSON readable only by the office's user, whole: a temp file renamed into place. */
function writePrivate(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const checking = (group: FactoryGroup): FactoryCapability => ({ group, status: 'checking' });

export interface FactoryOfficeOptions {
  fetchImpl?: Fetch;
  base?: string;
  /** The connection changed: who it is, what it can reach, rejected, gone. */
  onChange?: () => void;
  now?: () => number;
}

/**
 * The office's one Factory connection, an API key, kept in the office's .droid-office/factory.json
 * (0600). The key never leaves this class: connection() is what browsers get, and API errors carry
 * no key.
 */
export class FactoryOffice {
  readonly file: string;
  private saved?: Saved;
  private api?: FactoryApi;
  private checkRun?: Promise<void>;
  /** Which connect or check is the latest, so an older one's late answers don't land. */
  private generation = 0;
  private now: () => number;

  constructor(
    dataDir: string,
    private opts: FactoryOfficeOptions = {},
  ) {
    this.file = path.join(dataDir, 'factory.json');
    this.now = opts.now ?? Date.now;
    this.restore();
  }

  set onChange(fn: (() => void) | undefined) {
    this.opts.onChange = fn;
  }

  /** What browsers get. Never the key. */
  connection(): FactoryConnection {
    const s = this.saved;
    if (!s) return { connected: false, capabilities: [] };
    return {
      connected: true,
      fingerprint: fingerprint(s.key),
      ...(s.account ? { account: s.account } : {}),
      ...(s.members !== undefined ? { members: s.members } : {}),
      ...(s.membersMore ? { membersMore: true } : {}),
      by: s.by,
      at: s.at,
      capabilities: FACTORY_GROUPS.map((g) => s.capabilities.find((c) => c.group === g.id) ?? checking(g.id)),
      ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}),
      ...(this.checkRun ? { checking: true } : {}),
      ...(s.rejected ? { rejected: s.rejected } : {}),
    };
  }

  /** The API as the key, while connected and not rejected. */
  client(): FactoryApi | undefined {
    return this.saved && !this.saved.rejected ? this.api : undefined;
  }

  private makeApi(key: string) {
    return new FactoryApi(key, this.opts.fetchImpl ?? fetch, this.opts.base ?? FACTORY_API);
  }

  /**
   * Checks the key with Factory, then saves it, replacing any key before it. Resolves to why not, if
   * not. It answers once the quick probes are back; the slow sessions probe carries on and lands later.
   */
  async connect(raw: string, by: string): Promise<string | undefined> {
    const key = raw.trim();
    if (key.length < 8 || key.length > 500 || /\s/.test(key)) return `That doesn’t look like a Factory API key. Make one at ${FACTORY_KEYS_URL}`;
    const api = this.makeApi(key);
    const gen = ++this.generation;
    const { fast, sessions } = this.probe(api);
    const found = await fast;
    if (gen !== this.generation) return 'Another key was connected meanwhile.';
    const caps = found.capabilities;
    const answered = caps.filter((c) => (c.httpStatus ?? 200) !== 0);
    if (!answered.length) return redact(`Couldn’t reach Factory: ${caps[0]?.reason ?? 'no answer'}`, [key]);
    if (answered.every((c) => c.httpStatus === 401)) {
      const detail = answered.find((c) => c.detail)?.detail;
      return `Factory didn’t accept that key (401)${detail ? `: ${detail}` : ''}. Check that it’s whole and hasn’t been deleted, or make a new one at ${FACTORY_KEYS_URL}`;
    }
    this.saved = { key, by, at: this.now(), ...found.who, capabilities: [...caps, checking('sessions')], checkedAt: this.now() };
    this.api = api;
    this.persist();
    this.changed();
    void this.landSessions(gen, sessions);
    return undefined;
  }

  /** Probes the saved key again ("Check again", and every start): what it reaches, whose it is, and whether it still works. */
  check(): Promise<void> {
    if (!this.saved || !this.api) return Promise.resolve();
    if (this.checkRun) return this.checkRun;
    const gen = ++this.generation;
    const api = this.api;
    const run = (async () => {
      const { fast, sessions } = this.probe(api);
      const found = await fast;
      if (gen !== this.generation || !this.saved) return;
      const caps = found.capabilities;
      const answered = caps.filter((c) => (c.httpStatus ?? 200) !== 0);
      const rejected = answered.length > 0 && answered.every((c) => c.httpStatus === 401);
      const was = this.saved.capabilities.find((c) => c.group === 'sessions');
      this.saved = {
        ...this.saved,
        ...found.who,
        capabilities: [...caps, was ? { ...was, status: 'checking' } : checking('sessions')],
        checkedAt: this.now(),
        rejected: rejected ? (answered.find((c) => c.detail)?.detail ?? 'it answered 401') : undefined,
      };
      this.persist();
      this.checkRun = undefined;
      this.changed();
      await this.landSessions(gen, sessions);
    })().finally(() => {
      if (this.checkRun === run) this.checkRun = undefined;
    });
    this.checkRun = run;
    this.changed();
    return run;
  }

  /** Factory answered 401 for the saved key on some later call: it reads as rejected until checked again or replaced. */
  rejected(err: FactoryError) {
    if (!this.saved || this.saved.rejected) return;
    this.saved = { ...this.saved, rejected: err.detail || err.title || 'it answered 401' };
    console.error('droid-office: Factory rejected the office’s API key; Factory features stop until it’s checked again or replaced in Settings');
    this.persist();
    this.changed();
  }

  disconnect() {
    this.generation++;
    this.saved = undefined;
    this.api = undefined;
    this.checkRun = undefined;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // already gone
    }
    this.changed();
  }

  /** Runs every probe in parallel: `fast` is everything but sessions (plus whose key it is), `sessions` lands on its own. */
  private probe(api: FactoryApi): { fast: Promise<{ capabilities: FactoryCapability[]; who: Partial<Saved> }>; sessions: Promise<FactoryCapability> } {
    const one = async (group: FactoryGroup): Promise<{ cap: FactoryCapability; found?: Found }> => {
      try {
        const found = await PROBES[group](api);
        return { cap: { group, status: 'ok', httpStatus: 200, checkedAt: this.now(), ...(found.reason ? { reason: found.reason } : {}) }, found };
      } catch (err) {
        return { cap: capabilityFromError(group, err, this.now()) };
      }
    };
    const computers = api.computers().catch(() => undefined);
    const quick = FACTORY_GROUPS.filter((g) => g.id !== 'sessions').map((g) => one(g.id));
    const fast = Promise.all([Promise.all(quick), computers]).then(([results, list]) => {
      const org = results.find((r) => r.cap.group === 'organization')?.found;
      const who: Partial<Saved> = {};
      if (org?.users) {
        const account = accountOf(org.users, Array.isArray(list?.computers) ? list.computers : []);
        if (account) who.account = account;
        who.members = org.users.length;
        who.membersMore = org.usersMore || undefined;
      }
      return { capabilities: results.map((r) => r.cap), who };
    });
    return { fast, sessions: one('sessions').then((r) => r.cap) };
  }

  private async landSessions(gen: number, sessions: Promise<FactoryCapability>) {
    const cap = await sessions;
    if (gen !== this.generation || !this.saved) return;
    this.saved = { ...this.saved, capabilities: [...this.saved.capabilities.filter((c) => c.group !== 'sessions'), cap] };
    this.persist();
    this.changed();
  }

  private changed() {
    this.opts.onChange?.();
  }

  private persist() {
    if (!this.saved) return;
    try {
      writePrivate(this.file, this.saved);
    } catch (err) {
      console.error(`droid-office: couldn't save the Factory connection: ${(err as Error).message}`);
    }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      if (typeof s.key !== 'string' || !s.key.trim()) return;
      const groups = new Set<string>(FACTORY_GROUPS.map((g) => g.id));
      this.saved = {
        key: s.key.trim(),
        by: typeof s.by === 'string' ? s.by : '?',
        at: typeof s.at === 'number' ? s.at : this.now(),
        ...(s.account && typeof s.account.name === 'string' ? { account: s.account } : {}),
        ...(typeof s.members === 'number' ? { members: s.members } : {}),
        ...(s.membersMore ? { membersMore: true } : {}),
        capabilities: Array.isArray(s.capabilities) ? s.capabilities.filter((c) => c && groups.has(c.group)) : [],
        ...(typeof s.checkedAt === 'number' ? { checkedAt: s.checkedAt } : {}),
        ...(typeof s.rejected === 'string' ? { rejected: s.rejected } : {}),
      };
      this.api = this.makeApi(this.saved.key);
    } catch {
      // a broken file just means no connection
    }
  }
}
