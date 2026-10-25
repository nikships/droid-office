import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySetupState, type DroidCliState, type SetupState } from '../src/shared/setup.js';
import { emptySubscriptionsState, type SubscriptionProvider, type SubscriptionsState } from '../src/shared/subscriptions.js';
import {
  currentStep,
  defaultWorkerChange,
  droidPhase,
  factoryPhase,
  justConnected,
  percentLeft,
  readyModel,
  shouldAutoOpen,
  stepDone,
  stepMeta,
  stepPlan,
  subscriptionsPhase,
  usageTone,
  usageWords,
  welcomeSteps,
} from '../src/client/ui/welcome-steps.js';

// A fresh Mac: no Droid on it, the office has looked, and nobody has been through the welcome.
function setup(droid: Partial<DroidCliState> = {}, onboarded = false): SetupState {
  const base = emptySetupState();
  return { droid: { ...base.droid, busy: null, canInstall: true, ...droid }, onboarded };
}

const installed = { path: '/Users/me/.local/bin/droid', version: '0.249.0', latest: '0.249.0' };

function claude(over: Partial<SubscriptionProvider> = {}): SubscriptionProvider {
  return { key: 'claude', name: 'Claude', enabled: true, connect: 'browser', accounts: [], ...over };
}

function codex(over: Partial<SubscriptionProvider> = {}): SubscriptionProvider {
  return { key: 'codex', name: 'Codex', enabled: true, connect: 'browser', accounts: [], ...over };
}

function subs(over: Partial<SubscriptionsState> = {}, phase: SubscriptionsState['proxy']['phase'] = 'running'): SubscriptionsState {
  const base = emptySubscriptionsState();
  return { ...base, proxy: { ...base.proxy, phase, version: phase === 'running' ? '1.8.180' : null }, ...over };
}

const account = (label: string, over = {}) => ({ id: `${label}.json`, label, expired: false, disabled: false, windows: [], ...over });

test('the steps: Subscriptions only where DroidProxy can run', () => {
  assert.deepEqual(welcomeSteps(subs({}, 'unsupported')), ['droid', 'factory', 'ready']);
  assert.deepEqual(welcomeSteps(subs({}, 'missing')), ['droid', 'factory', 'subscriptions', 'ready']);
});

test('a fresh Mac starts on Droid, with Install as its one action', () => {
  const s = setup();
  const p = subs({}, 'missing');
  assert.equal(currentStep(s, p), 'droid');
  assert.equal(droidPhase(s.droid), 'missing');
  assert.deepEqual(stepPlan('droid', s, p), { primary: { kind: 'install', label: 'Install Droid' }, secondary: null });
  assert.equal(stepMeta('droid', s, p), 'The coding agent your workers are');
  assert.equal(stepDone('droid', s, p), false);
});

test('Droid: checking, installing, a failed install, and where the office cannot install it', () => {
  const p = subs();
  assert.deepEqual(stepPlan('droid', setup({ busy: 'checking' }), p).primary, { kind: 'busy', label: 'Checking…' });
  const busy = setup({ busy: 'installing', progress: 0.4 });
  assert.equal(droidPhase(busy.droid), 'installing');
  assert.deepEqual(stepPlan('droid', busy, p).primary, { kind: 'busy', label: 'Installing…' });
  assert.equal(stepMeta('droid', busy, p), 'Installing…');
  assert.deepEqual(stepPlan('droid', setup({ error: 'The download’s SHA-256 did not match' }), p).primary, { kind: 'install', label: 'Try again' });
  const manual = setup({ canInstall: false });
  assert.equal(droidPhase(manual.droid), 'manual');
  assert.deepEqual(stepPlan('droid', manual, p).primary, { kind: 'check', label: 'Check again' });
  // An update over an installed Droid is still installing, not missing.
  assert.equal(droidPhase({ ...setup(installed).droid, busy: 'installing' }), 'installing');
});

test('installed Droid moves on to the Factory account, and shows its version', () => {
  const s = setup({ ...installed, signedIn: false });
  const p = subs();
  assert.equal(stepDone('droid', s, p), true);
  assert.equal(stepMeta('droid', s, p), 'Droid 0.249.0');
  assert.equal(currentStep(s, p), 'factory');
  assert.deepEqual(stepPlan('factory', s, p), { primary: { kind: 'signIn', label: 'Sign in' }, secondary: null });
});

test('the Factory account waits for Droid, and for a doctor that could not tell', () => {
  const p = subs();
  assert.equal(factoryPhase(setup()), 'needs-droid');
  assert.deepEqual(stepPlan('factory', setup(), p).primary, { kind: 'blocked', label: 'Sign in', why: 'Install Droid first' });
  assert.equal(factoryPhase(setup({ ...installed, busy: 'checking' })), 'checking');
  assert.equal(factoryPhase(setup({ ...installed, signedIn: null })), 'unknown');
  assert.deepEqual(stepPlan('factory', setup({ ...installed, signedIn: null }), p).primary, { kind: 'check', label: 'Check again' });
});

test('signing in: starting, then the code with Open sign-in page, and Cancel throughout', () => {
  const p = subs();
  const starting = setup({ ...installed, signedIn: false, busy: 'signing-in', signIn: { code: null, url: null, since: 1 } });
  assert.equal(factoryPhase(starting), 'starting');
  assert.deepEqual(stepPlan('factory', starting, p), { primary: { kind: 'busy', label: 'Starting…' }, secondary: { kind: 'cancelSignIn', label: 'Cancel' } });
  const url = 'https://auth.factory.ai/device?user_code=WXYZ-1234';
  const code = setup({ ...installed, signedIn: false, busy: 'signing-in', signIn: { code: 'WXYZ-1234', url, since: 1 } });
  assert.equal(factoryPhase(code), 'code');
  assert.deepEqual(stepPlan('factory', code, p), { primary: { kind: 'openSignIn', label: 'Open sign-in page', url }, secondary: { kind: 'cancelSignIn', label: 'Cancel' } });
  assert.equal(stepMeta('factory', code, p), 'Signing in…');
  const noUrl = setup({ ...installed, signedIn: false, busy: 'signing-in', signIn: { code: 'WXYZ-1234', url: null, since: 1 } });
  assert.deepEqual(stepPlan('factory', noUrl, p).primary, { kind: 'busy', label: 'Waiting…' });
  const failed = setup({ ...installed, signedIn: false, error: 'The sign-in timed out' });
  assert.deepEqual(stepPlan('factory', failed, p).primary, { kind: 'signIn', label: 'Try again' });
});

test('signed in: the account down the side, and on to Subscriptions on a Mac', () => {
  const s = setup({ ...installed, signedIn: true, account: 'owner@example.com' });
  assert.equal(stepMeta('factory', s, subs()), 'owner@example.com');
  assert.equal(currentStep(s, subs()), 'subscriptions');
  assert.equal(currentStep(s, subs({}, 'unsupported')), 'ready');
});

test('Subscriptions: the cards are the actions, Skip always there until one connects', () => {
  const s = setup({ ...installed, signedIn: true });
  const idle = subs({ providers: [claude(), codex()] });
  assert.equal(subscriptionsPhase(idle), 'idle');
  assert.deepEqual(stepPlan('subscriptions', s, idle), { primary: null, secondary: { kind: 'skip', label: 'Skip' } });
  assert.equal(subscriptionsPhase(subs({}, 'installing')), 'setting-up');
  assert.equal(subscriptionsPhase(subs({}, 'starting')), 'setting-up');
  const connecting = subs({ providers: [claude({ connecting: { since: 1 } }), codex()] });
  assert.equal(subscriptionsPhase(connecting), 'connecting');
  assert.equal(stepMeta('subscriptions', s, connecting), 'Connecting…');
  // A failed connect is not still connecting: its error shows and Connect is offered again.
  assert.equal(subscriptionsPhase(subs({ providers: [claude({ connecting: { since: 1, error: 'The sign-in was cancelled' } })] })), 'idle');
  const connected = subs({ providers: [claude(), codex({ accounts: [account('owner@example.com')] })] });
  assert.equal(subscriptionsPhase(connected), 'connected');
  assert.equal(stepDone('subscriptions', s, connected), true);
  assert.equal(stepMeta('subscriptions', s, connected), 'ChatGPT');
  assert.deepEqual(stepPlan('subscriptions', s, connected).primary, { kind: 'next', label: 'Continue' });
  // An expired or switched-off account doesn't count.
  const stale = subs({ providers: [claude({ accounts: [account('a@example.com', { expired: true }), account('b@example.com', { disabled: true })] })] });
  assert.equal(subscriptionsPhase(stale), 'idle');
});

test('Skip moves to Ready and says so down the side', () => {
  const s = setup({ ...installed, signedIn: true });
  const p = subs({ providers: [claude(), codex()] });
  const skipped = new Set(['subscriptions'] as const);
  assert.equal(currentStep(s, p, skipped), 'ready');
  assert.equal(stepMeta('subscriptions', s, p, skipped), 'Skipped');
  assert.deepEqual(stepPlan('ready', s, p).primary, { kind: 'start', label: 'Start' });
  assert.deepEqual(stepPlan('ready', setup(), p).primary, { kind: 'blocked', label: 'Start', why: 'Droid needs to be installed and signed in first' });
  assert.equal(stepDone('ready', s, p), false);
  assert.equal(stepDone('ready', setup(installed, true), p), true);
});

test('it opens by itself only while the office needs it, once per tab', () => {
  assert.equal(shouldAutoOpen(setup(), false, false), true);
  assert.equal(shouldAutoOpen(setup(), true, false), false);
  assert.equal(shouldAutoOpen(setup(), false, true), false);
  assert.equal(shouldAutoOpen(setup({}, true), false, false), false);
  assert.equal(shouldAutoOpen(emptySetupState(), false, false), false);
  assert.equal(shouldAutoOpen(setup({ ...installed, signedIn: false }), false, false), true);
  assert.equal(shouldAutoOpen(setup({ ...installed, signedIn: true }), false, false), false);
});

test('Ready starts on a just-connected plan’s first model that can run, else the office default', () => {
  const ids = ['claude-opus-5-5', 'custom:droidproxy:gpt-6-astra', 'custom:droidproxy:gpt-6.1-sol', 'custom:droidproxy:ag-c55o-high'];
  const p = subs({
    providers: [codex({ accounts: [account('owner@example.com')] })],
    availability: {
      'custom:droidproxy:gpt-6-astra': { state: 'exhausted', until: null, window: '5-hour' },
      'custom:droidproxy:gpt-6.1-sol': { state: 'ok' },
      'custom:droidproxy:ag-c55o-high': { state: 'ok' },
    },
    modelProviders: { 'custom:droidproxy:gpt-6-astra': 'codex', 'custom:droidproxy:gpt-6.1-sol': 'codex', 'custom:droidproxy:ag-c55o-high': 'antigravity' },
  });
  assert.equal(justConnected(p, ['claude', 'codex']), 'codex');
  assert.equal(justConnected(p, ['claude']), undefined);
  assert.equal(readyModel(p, ids, 'claude-opus-5-5', 'codex'), 'custom:droidproxy:gpt-6.1-sol');
  assert.equal(readyModel(p, ids, 'claude-opus-5-5', 'antigravity'), 'custom:droidproxy:ag-c55o-high');
  assert.equal(readyModel(p, ids, 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(readyModel(p, ids, undefined), '');
  // Without the provider of each model, any subscription model that runs.
  assert.equal(readyModel({ ...p, modelProviders: undefined }, ids, undefined, 'codex'), 'custom:droidproxy:gpt-6.1-sol');
  // An office default that can't run gives way to one that can.
  assert.equal(readyModel(p, ids, 'custom:droidproxy:gpt-6-astra'), 'custom:droidproxy:gpt-6.1-sol');
});

test('Start saves the default worker only when the pick changed it', () => {
  assert.equal(defaultWorkerChange('', {}), undefined);
  assert.equal(defaultWorkerChange('claude-opus-5-5', { model: 'claude-opus-5-5', effort: 'high' }), undefined);
  assert.deepEqual(defaultWorkerChange('custom:droidproxy:gpt-6.1-sol', { model: 'claude-opus-5-5', effort: 'high' }), { model: 'custom:droidproxy:gpt-6.1-sol' });
  assert.equal(defaultWorkerChange('', { model: 'claude-opus-5-5' }), null);
});

test('usage windows: what is left, its tone and when it resets', () => {
  const now = Date.parse('2026-10-25T21:33:29Z');
  // From DroidProxy's /droidproxy/usage: a ChatGPT Plus account out of its 5-hour window.
  const fiveHour = { name: '5-hour', usedPercent: 100, resetsAt: Date.parse('2026-10-25T22:12:45Z') };
  const weekly = { name: 'Weekly', usedPercent: 16, resetsAt: Date.parse('2026-11-01T08:15:40Z') };
  assert.equal(percentLeft(fiveHour), 0);
  assert.equal(usageTone(fiveHour), 'bad');
  assert.equal(usageWords(fiveHour, now), '0% left · resets in 40 min');
  assert.equal(percentLeft(weekly), 84);
  assert.equal(usageTone(weekly), 'good');
  assert.equal(usageWords(weekly, now), '84% left · resets in 6 d 10 h');
  assert.equal(usageTone({ name: 'Weekly', usedPercent: 99, resetsAt: null }), 'warn');
  assert.equal(usageWords({ name: 'Weekly', usedPercent: 99, resetsAt: null }, now), '1% left');
});
