import type { AgentChoice } from '../../shared/protocol';
import { droidReady, needsWelcome, type DroidCliState, type SetupState } from '../../shared/setup';
import { cannotRun, durationWords, isSubscriptionModel, providerName, type SubscriptionAccount, type SubscriptionProvider, type SubscriptionProviderKey, type SubscriptionsState, type UsageWindow } from '../../shared/subscriptions';

// The welcome's steps as pure functions of store.setup and store.subscriptions (docs/subscriptions.md
// "The welcome"), so the window only draws what these say. No DOM here: tests/welcome.test.ts loads it.

export type WelcomeStepId = 'droid' | 'factory' | 'subscriptions' | 'ready';

/** The two plans the welcome puts up front; every other provider waits under More. */
export const FEATURED_PROVIDERS: readonly SubscriptionProviderKey[] = ['claude', 'codex'];

/** The plan each featured provider stands for, under its name. */
export const PROVIDER_PLAN: Partial<Record<SubscriptionProviderKey, string>> = { claude: 'Claude Pro or Max', codex: 'ChatGPT Plus or Pro' };

export type DroidPhase = 'checking' | 'installing' | 'missing' | 'manual' | 'installed';

export type FactoryPhase = 'needs-droid' | 'checking' | 'starting' | 'code' | 'signed-out' | 'unknown' | 'signed-in';

export type SubscriptionsPhase = 'idle' | 'setting-up' | 'connecting' | 'connected';

export type WelcomeAction =
  | { kind: 'install'; label: string }
  | { kind: 'check'; label: string }
  | { kind: 'signIn'; label: string }
  | { kind: 'openSignIn'; label: string; url: string }
  | { kind: 'busy'; label: string }
  | { kind: 'blocked'; label: string; why: string }
  | { kind: 'next'; label: string }
  | { kind: 'start'; label: string };

export interface WelcomeSecondary {
  kind: 'cancelSignIn' | 'skip';
  label: string;
}

export interface StepPlan {
  /** The step's one primary action, rightmost in the footer; null when the step's own cards are the actions. */
  primary: WelcomeAction | null;
  secondary: WelcomeSecondary | null;
}

/** An account requests can use: signed in and switched on. */
export function usableAccount(a: SubscriptionAccount): boolean {
  return !a.expired && !a.disabled;
}

export function providerConnected(p: SubscriptionProvider): boolean {
  return p.accounts.some(usableAccount);
}

/** A provider's connect in flight that hasn't failed. */
export function connectingNow(p: SubscriptionProvider): boolean {
  return !!p.connecting && !p.connecting.error;
}

/** The steps the welcome has here: Subscriptions only where DroidProxy can run. */
export function welcomeSteps(subs: SubscriptionsState): WelcomeStepId[] {
  return subs.proxy.phase === 'unsupported' ? ['droid', 'factory', 'ready'] : ['droid', 'factory', 'subscriptions', 'ready'];
}

export function droidPhase(d: DroidCliState): DroidPhase {
  if (d.busy === 'installing') return 'installing';
  if (d.path) return 'installed';
  if (d.busy === 'checking') return 'checking';
  return d.canInstall ? 'missing' : 'manual';
}

export function factoryPhase(s: SetupState): FactoryPhase {
  const d = s.droid;
  if (d.signedIn === true) return 'signed-in';
  if (!d.path) return 'needs-droid';
  if (d.busy === 'signing-in') return d.signIn?.code || d.signIn?.url ? 'code' : 'starting';
  if (d.busy === 'checking') return 'checking';
  return d.signedIn === false ? 'signed-out' : 'unknown';
}

export function subscriptionsPhase(subs: SubscriptionsState): SubscriptionsPhase {
  if (subs.providers.some(providerConnected)) return 'connected';
  if (subs.providers.some(connectingNow)) return 'connecting';
  if (subs.proxy.phase === 'installing' || subs.proxy.phase === 'starting') return 'setting-up';
  return 'idle';
}

/** A step is done (a ✓ down the side). Ready is done once the owner finished the welcome. */
export function stepDone(id: WelcomeStepId, setup: SetupState, subs: SubscriptionsState): boolean {
  switch (id) {
    case 'droid':
      return !!setup.droid.path;
    case 'factory':
      return setup.droid.signedIn === true;
    case 'subscriptions':
      return subscriptionsPhase(subs) === 'connected';
    case 'ready':
      return setup.onboarded;
  }
}

/** The step the window shows by itself: the first one not done and not skipped in this window, else Ready. */
export function currentStep(setup: SetupState, subs: SubscriptionsState, skipped: ReadonlySet<WelcomeStepId> = new Set()): WelcomeStepId {
  return welcomeSteps(subs).find((id) => id !== 'ready' && !skipped.has(id) && !stepDone(id, setup, subs)) ?? 'ready';
}

export function stepTitle(id: WelcomeStepId): string {
  return { droid: 'Droid', factory: 'Factory account', subscriptions: 'Subscriptions', ready: 'Ready' }[id];
}

/** The line under a step's name down the side: what it is, or what it found. */
export function stepMeta(id: WelcomeStepId, setup: SetupState, subs: SubscriptionsState, skipped: ReadonlySet<WelcomeStepId> = new Set()): string {
  const d = setup.droid;
  switch (id) {
    case 'droid': {
      const phase = droidPhase(d);
      if (phase === 'installing') return 'Installing…';
      if (phase === 'installed') return d.version ? `Droid ${d.version}` : 'Installed';
      return 'The coding agent your workers are';
    }
    case 'factory': {
      const phase = factoryPhase(setup);
      if (phase === 'signed-in') return d.account ?? 'Signed in';
      if (phase === 'code' || phase === 'starting') return 'Signing in…';
      return 'The account Droid runs on';
    }
    case 'subscriptions': {
      const names = subs.providers.filter(providerConnected).map((p) => providerName(p.key));
      if (names.length) return names.join(' · ');
      if (subscriptionsPhase(subs) === 'connecting') return 'Connecting…';
      return skipped.has('subscriptions') ? 'Skipped' : 'Use the plan you already pay for';
    }
    case 'ready':
      return 'The model workers start on';
  }
}

/** What a step's footer offers. */
export function stepPlan(id: WelcomeStepId, setup: SetupState, subs: SubscriptionsState): StepPlan {
  const d = setup.droid;
  switch (id) {
    case 'droid': {
      const phase = droidPhase(d);
      if (phase === 'installed') return { primary: { kind: 'next', label: 'Continue' }, secondary: null };
      if (phase === 'installing') return { primary: { kind: 'busy', label: 'Installing…' }, secondary: null };
      if (phase === 'checking') return { primary: { kind: 'busy', label: 'Checking…' }, secondary: null };
      if (phase === 'manual') return { primary: { kind: 'check', label: 'Check again' }, secondary: null };
      return { primary: { kind: 'install', label: d.error ? 'Try again' : 'Install Droid' }, secondary: null };
    }
    case 'factory': {
      const phase = factoryPhase(setup);
      if (phase === 'signed-in') return { primary: { kind: 'next', label: 'Continue' }, secondary: null };
      if (phase === 'needs-droid') return { primary: { kind: 'blocked', label: 'Sign in', why: 'Install Droid first' }, secondary: null };
      if (phase === 'checking') return { primary: { kind: 'busy', label: 'Checking…' }, secondary: null };
      if (phase === 'unknown') return { primary: { kind: 'check', label: 'Check again' }, secondary: null };
      const cancel: WelcomeSecondary = { kind: 'cancelSignIn', label: 'Cancel' };
      if (phase === 'starting') return { primary: { kind: 'busy', label: 'Starting…' }, secondary: cancel };
      if (phase === 'code') {
        const url = d.signIn?.url;
        return { primary: url ? { kind: 'openSignIn', label: 'Open sign-in page', url } : { kind: 'busy', label: 'Waiting…' }, secondary: cancel };
      }
      return { primary: { kind: 'signIn', label: d.error ? 'Try again' : 'Sign in' }, secondary: null };
    }
    case 'subscriptions':
      return subscriptionsPhase(subs) === 'connected' ? { primary: { kind: 'next', label: 'Continue' }, secondary: null } : { primary: null, secondary: { kind: 'skip', label: 'Skip' } };
    case 'ready':
      return droidReady(setup) ? { primary: { kind: 'start', label: 'Start' }, secondary: null } : { primary: { kind: 'blocked', label: 'Start', why: 'Droid needs to be installed and signed in first' }, secondary: null };
  }
}

/** The welcome opens by itself: the office says it should, this tab hasn't closed it, and it isn't open already. */
export function shouldAutoOpen(setup: SetupState, closedHere: boolean, open: boolean): boolean {
  return !open && !closedHere && needsWelcome(setup);
}

/** The provider the owner connected in this window: the last Connect they pressed that now has an account. */
export function justConnected(subs: SubscriptionsState, pressed: readonly SubscriptionProviderKey[]): SubscriptionProviderKey | undefined {
  for (let i = pressed.length - 1; i >= 0; i--) {
    const p = subs.providers.find((x) => x.key === pressed[i]);
    if (p && providerConnected(p)) return p.key;
  }
  return undefined;
}

/**
 * The model the Ready step starts on: the first model (in Droid's order) of a just-connected
 * subscription that can run now, else the office's default worker unless it can't run, then any
 * subscription model that can. '' is Droid's own default. `models` is Droid's model list, by id.
 */
export function readyModel(subs: SubscriptionsState, models: readonly string[], officeDefault: string | undefined, connected?: SubscriptionProviderKey): string {
  const fresh = models.filter((id) => isSubscriptionModel(id) && subs.availability[id]?.state === 'ok');
  if (connected) {
    const own = subs.modelProviders ? fresh.find((id) => subs.modelProviders?.[id] === connected) : fresh[0];
    if (own) return own;
  }
  if (!officeDefault) return '';
  return cannotRun(subs.availability[officeDefault]) ? (fresh[0] ?? '') : officeDefault;
}

/** What Start saves as the office's default worker: undefined leaves it as it is, null goes back to the agent the office started with. */
export function defaultWorkerChange(picked: string, current: AgentChoice): AgentChoice | null | undefined {
  if (picked === (current.model ?? '')) return undefined;
  return picked ? { model: picked } : null;
}

/** How much of a usage window is left, 0..100. */
export function percentLeft(w: UsageWindow): number {
  return Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
}

/** A usage window's tone: out, low or fine. */
export function usageTone(w: UsageWindow): 'bad' | 'warn' | 'good' {
  const left = percentLeft(w);
  if (left <= 0) return 'bad';
  return left < 20 ? 'warn' : 'good';
}

/** "62% left · resets in 3 h 10 min", with `now` in ms since the epoch. */
export function usageWords(w: UsageWindow, now: number): string {
  const resets = w.resetsAt !== null && w.resetsAt > now ? ` · resets in ${durationWords(w.resetsAt - now)}` : '';
  return `${percentLeft(w)}% left${resets}`;
}
