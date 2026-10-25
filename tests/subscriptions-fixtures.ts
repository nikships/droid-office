import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RawModels, RawStatus, RawUsage } from '../src/server/subscriptions/control.js';
import type { RunResult } from '../src/server/subscriptions/proxy-install.js';

/**
 * What DroidProxy and its release answer, for the subscriptions tests.
 *
 * USAGE is GET http://127.0.0.1:8317/droidproxy/usage from the owner's DroidProxy 1.8.177, trimmed,
 * with the account emails replaced: the Codex account is out of its 5-hour window. The control API
 * (STATUS, MODELS, CONTROL_FILE) isn't in any released DroidProxy yet, so those answers follow the
 * contract in docs/subscriptions.md ("DroidProxy's control API (version 1)") rather than a real reply.
 * CODESIGN_DV and SPCTL are the real stderr of `codesign -dv` and `spctl -a -t exec -vv` on the
 * owner's /Applications/DroidProxy.app.
 */

/** When USAGE was read. */
export const NOW = Date.parse('2026-10-25T21:31:54Z');

export const USAGE: RawUsage = {
  accounts: [
    {
      account: 'codex-user@example.com',
      as_of: '2026-10-25T21:31:55Z',
      error: null,
      id: 'codex-83bf45ca-codex-user@example.com-plus.json',
      provider: 'codex',
      windows: [
        { name: '5-hour', remaining_percent: 0, resets_at: '2026-10-25T22:12:45Z', resets_in_seconds: 2450, used_percent: 100 },
        { name: 'Weekly', remaining_percent: 84, resets_at: '2026-11-01T08:15:41Z', resets_in_seconds: 557026, used_percent: 16 },
      ],
    },
    {
      account: 'Grok-User@example.com',
      as_of: '2026-10-25T21:31:55Z',
      error: null,
      id: 'grok-cli.json',
      provider: 'grok',
      windows: [{ name: 'Weekly', remaining_percent: 34, resets_at: '2026-10-27T17:25:34Z', resets_in_seconds: 158019, used_percent: 66 }],
    },
    {
      account: 'Meta account 423f1867',
      as_of: '2026-10-25T21:31:56Z',
      error: null,
      id: '423f18679aabd648de17ceeb8d596cdc0705f26f63e5cdf988838a8375078f15',
      provider: 'meta',
      windows: [
        { name: '5-hour', remaining_percent: 100, resets_at: '2026-10-25T22:56:29Z', resets_in_seconds: 5074, used_percent: 0 },
        { name: 'Weekly', remaining_percent: 1, resets_at: '2026-10-26T00:00:00Z', resets_in_seconds: 8885, used_percent: 99 },
      ],
    },
  ],
  generated_at: '2026-10-25T21:31:54Z',
};

export const TOKEN = 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
export const CONTROL_FILE = { api: 1, port: 8317, token: TOKEN, version: '1.8.180', pid: 1234 };

export function status(over: Partial<RawStatus> = {}): RawStatus {
  return {
    api: 1,
    version: '1.8.180',
    backend: { running: true },
    providers: [
      { key: 'claude', name: 'Claude', enabled: true, connect: 'browser', accounts: [], connecting: null },
      {
        key: 'codex',
        name: 'Codex',
        enabled: true,
        connect: 'browser',
        accounts: [{ id: 'codex-83bf45ca-codex-user@example.com-plus.json', label: 'codex-user@example.com', expired: false, disabled: false }],
        connecting: null,
      },
      { key: 'grok', name: 'Grok', enabled: false, connect: 'device', accounts: [{ id: 'grok-cli.json', label: 'grok-user@example.com', expired: false, disabled: false }], connecting: null },
      { key: 'kimi', name: 'Kimi', enabled: true, connect: 'app', accounts: [], connecting: null },
    ],
    factory: { installed: 14, available: 14, stale: false },
    ...over,
  };
}

export const MODELS: RawModels = {
  generated_at: '2026-10-25T21:31:54Z',
  models: [
    { id: 'custom:droidproxy:gpt-6.1-sol', name: 'GPT 6.1 Sol', provider: 'codex', availability: { state: 'exhausted', until: '2026-10-25T22:12:45Z', window: '5-hour', account: 'codex-user@example.com' } },
    { id: 'custom:droidproxy:claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'claude', availability: { state: 'signed-out' } },
    { id: 'custom:droidproxy:grok-5', name: 'Grok 5', provider: 'grok', availability: { state: 'disabled' } },
    { id: 'custom:droidproxy:kimi-k3', name: 'Kimi K3', provider: 'kimi', availability: { state: 'unknown' } },
    { id: 'custom:droidproxy:gpt-6-luna', name: 'GPT 6 Luna', provider: 'codex', availability: { state: 'ok' } },
  ],
};

export const CODESIGN_DV = `Executable=/Applications/DroidProxy.app/Contents/MacOS/CLIProxyMenuBar
Identifier=com.droidproxy.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=7198 flags=0x10000(runtime) hashes=218+3 location=embedded
Signature size=8975
Timestamp=Oct 21, 2026 at 6:01:45 PM
Info.plist entries=18
TeamIdentifier=NW6B3R27LQ
Runtime Version=26.5.0
Sealed Resources version=2 rules=13 files=15
Internal requirements count=1 size=180
`;

export const SPCTL = `/Applications/DroidProxy.app: accepted
source=Notarized Developer ID
origin=Developer ID Application: Nikhil Anand (NW6B3R27LQ)
`;

export const ok = (stdout = '', stderr = ''): RunResult => ({ code: 0, stdout, stderr });

/** A folder under the OS temp dir, removed after the test. */
export function tempDir(t: { after(fn: () => void): void }, name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `droid-office-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A DroidProxy.app with only an Info.plist, kept as JSON so a fake plutil can hand it back. */
export function fakeApp(dir: string, version = '1.8.180', id = 'com.droidproxy.app'): string {
  const app = path.join(dir, 'DroidProxy.app');
  mkdirSync(path.join(app, 'Contents'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), JSON.stringify({ CFBundleIdentifier: id, CFBundleShortVersionString: version }));
  return app;
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
