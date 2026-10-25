/**
 * Setup: what a fresh office needs before its first worker can run, Droid installed and signed in
 * to Factory, and whether the owner has been through the welcome (docs/subscriptions.md).
 */

/** What the office is doing about Droid right now. */
export type DroidBusy = 'checking' | 'installing' | 'signing-in';

/** The Droid CLI the office's workers run. */
export interface DroidCliState {
  /** The droid binary the office runs, by absolute path; null when it found none. */
  path: string | null;
  /** Its version (`droid --version`), when it has one. */
  version: string | null;
  /** The newest Droid release, once the office has looked; null before, or when it couldn't. */
  latest: string | null;
  /** Signed in to Factory: true, false, or null before the office has asked (or when it couldn't tell). */
  signedIn: boolean | null;
  /** Who Droid is signed in as, as `droid doctor` says it. */
  account: string | null;
  busy: DroidBusy | null;
  /** 0..1 while downloading. */
  progress?: number;
  /**
   * While signing in: the code Factory's page asks for and the page to open (with the code filled
   * in), as Droid's own sign-in printed them. Null until Droid has printed them.
   */
  signIn?: { code: string | null; url: string | null; since: number };
  /** Why the last install, sign-in or check failed, in words for the owner. */
  error: string | null;
  /** The office can install Droid here by itself (macOS or Linux, arm64 or x64). */
  canInstall: boolean;
}

export interface SetupState {
  droid: DroidCliState;
  /**
   * The owner finished the welcome, or the office found Droid ready the first time it looked (an
   * office that already worked never shows it). The welcome only opens by itself while this is false.
   */
  onboarded: boolean;
}

export function emptySetupState(): SetupState {
  return {
    droid: { path: null, version: null, latest: null, signedIn: null, account: null, busy: 'checking', error: null, canInstall: false },
    onboarded: true,
  };
}

/** Droid is installed and signed in: workers can start. */
export function droidReady(s: SetupState): boolean {
  return !!s.droid.path && s.droid.signedIn === true;
}

/**
 * The welcome should open by itself: the owner hasn't finished it, and the office knows where Droid
 * stands (missing, or its sign-in known). It keeps opening once Droid is ready, so a reload doesn't
 * lose its last two steps.
 */
export function needsWelcome(s: SetupState): boolean {
  return !s.onboarded && s.droid.busy !== 'checking' && (!s.droid.path || s.droid.signedIn !== null);
}

/** A newer Droid than the one installed is out. Versions are dotted numbers (0.249.0). */
export function droidUpdateAvailable(d: DroidCliState): boolean {
  return !!d.version && !!d.latest && compareVersions(d.latest, d.version) > 0;
}

/** Compares dotted version numbers ("1.8.179" vs "1.8.18"): negative, zero or positive. Anything after a '-' or '+' is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
