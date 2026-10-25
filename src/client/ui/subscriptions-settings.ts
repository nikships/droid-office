import type { Net } from '../net';
import { store } from '../state';
import { compareVersions } from '../../shared/setup';
import { providerName, type ProxyState, type SubscriptionAccount, type SubscriptionProvider, type SubscriptionProviderKey } from '../../shared/subscriptions';
import { h } from './dom';
import { toggle } from './kit';
import { deviceCode, progressBar } from './welcome-signin';
import { FEATURED_PROVIDERS, percentLeft, providerConnected, usageTone, usageWords } from './welcome-steps';

/** A provider DroidProxy hasn't described yet (it isn't answering): enough to offer Connect, which starts it. */
export function placeholderProvider(key: SubscriptionProviderKey): SubscriptionProvider {
  return { key, name: providerName(key), enabled: true, connect: 'browser', accounts: [] };
}

/** The providers to show: DroidProxy's own list, or the featured two until it answers. */
export function shownProviders(): SubscriptionProvider[] {
  const listed = store.subscriptions.providers;
  return listed.length ? listed : FEATURED_PROVIDERS.map(placeholderProvider);
}

/** One bar per usage window of an account: how much is left, and when it resets. */
export function usageBars(a: SubscriptionAccount, now = Date.now()): HTMLElement | null {
  if (!a.windows.length) return a.usageError ? h('small.subs-usage-error', {}, `Usage unavailable: ${a.usageError}`) : null;
  return h(
    'ul.subs-usage',
    {},
    ...a.windows.map((w) => {
      const bar = h('span.subs-usage-bar', { class: usageTone(w), 'aria-hidden': 'true' }, h('span'));
      bar.style.setProperty('--left', `${percentLeft(w)}%`);
      return h('li', {}, h('span.subs-usage-name', {}, w.name), h('span.subs-usage-words', {}, usageWords(w, now)), bar);
    }),
  );
}

/** An account as a row: who it is, why it can't be used if it can't, its usage, and Remove when `onRemove` is given. */
export function accountRow(a: SubscriptionAccount, onRemove?: () => void): HTMLElement {
  const why = a.expired ? h('span.pill', {}, 'Sign-in expired') : a.disabled ? h('span.pill', {}, 'Off in DroidProxy') : null;
  return h(
    'li.subs-account',
    {},
    h('div.subs-account-head', {}, h('span.subs-account-label', { title: a.label }, a.label), why, onRemove ? h('button.btn.sm.ghost.subs-remove', { type: 'button', onclick: onRemove }, 'Remove') : null),
    usageBars(a),
  );
}

/** A provider's connect in flight (its device code, or a line to finish in the browser), or why the last one failed. */
export function connectingBlock(p: SubscriptionProvider, net: Net, actions = true): HTMLElement | null {
  const c = p.connecting;
  if (!c) return null;
  const name = providerName(p.key);
  if (c.error) return h('p.note.bad', { role: 'alert' }, `Couldn’t connect ${name}: ${c.error}`);
  const cancel = () => net.send({ t: 'subscriptions.connectCancel', provider: p.key });
  if (c.code || c.url) return deviceCode({ code: c.code ?? null, url: c.url ?? null, waiting: `Waiting for you to sign in to ${name}…`, onCancel: cancel, actions });
  return h('div.subs-connecting', {}, deviceCode({ code: null, url: null, waiting: `Finish signing in to ${name} in your browser…` }), actions ? h('button.btn.sm.ghost', { type: 'button', onclick: cancel }, 'Cancel') : null);
}

/** What Connect says for a provider: connect, add a second account, or go to DroidProxy for one it connects only there. */
export function connectLabel(p: SubscriptionProvider): string {
  if (p.connect === 'app') return 'Connect in DroidProxy';
  if (updatesFirst()) return 'Update DroidProxy and connect';
  return p.accounts.length ? 'Add another' : 'Connect';
}

/** DroidProxy is too old to drive, so a connect installs the new one first: that quits and restarts the app. */
export function updatesFirst(): boolean {
  return store.subscriptions.proxy.phase === 'outdated';
}

export const UPDATES_FIRST_NOTE = 'DroidProxy on this Mac is too old for the office. Connecting updates it first, which quits and restarts it.';

/** Sends the connect for `p`: through DroidProxy's own window when it connects only there. */
export function connect(net: Net, p: SubscriptionProvider) {
  if (p.connect === 'app') net.send({ t: 'subscriptions.proxy', action: 'open' });
  else net.send({ t: 'subscriptions.connect', provider: p.key });
}

/** DroidProxy's phase in a line for the owner. */
export function proxyWords(p: ProxyState): string {
  const v = p.version ? ` ${p.version}` : '';
  switch (p.phase) {
    case 'unsupported':
      return 'Needs a Mac with Apple silicon.';
    case 'missing':
      return 'Not installed yet. Connecting an account installs it, or install it now.';
    case 'installing':
      return 'Installing…';
    case 'stopped':
      return `DroidProxy${v} is installed and not running. The office starts it when a worker needs it.`;
    case 'starting':
      return 'Starting…';
    case 'outdated':
      return `DroidProxy${v} is too old for the office to drive. Updating quits it and starts the new version.`;
    case 'running':
      return `Running · version${v || ' unknown'}`;
  }
}

interface Parts {
  desc?: Node;
  control?: Node;
  below?: Node[];
}

/**
 * ⚙️ Settings → Subscriptions: "DroidProxy" (its phase, version and actions), "Accounts" (each
 * provider's switch, accounts and usage, Connect, Remove) and "Models in Droid". Off a Mac with
 * Apple silicon the pane says so in one line and `hideWhenUnsupported` hides the rest.
 */
export function subscriptionsSettings(net: Net): { proxy: Parts; accounts: Parts; models: Parts; unsupported: HTMLElement; hideWhenUnsupported: (...els: HTMLElement[]) => void; dispose: () => void } {
  const unsupported = h('p.note.info', {}, 'Subscriptions need DroidProxy, a menu-bar app for Macs with Apple silicon. This office runs on another kind of computer, so its workers use your Factory account’s models.');
  const hidden: HTMLElement[] = [];

  const proxyText = h('small');
  const proxyMeta = h('small.subs-meta');
  const proxyActions = h('div.row.wrap');
  const proxyProgress = h('div');
  const proxyError = h('p.note.bad', { role: 'alert' });
  const proxyButton = (label: string, action: 'install' | 'start' | 'open', primary = false, disabled = false) =>
    h('button.btn.sm', { type: 'button', class: primary ? 'primary' : '', disabled, onclick: () => net.send({ t: 'subscriptions.proxy', action }) }, label);

  const accountsList = h('div.subs-providers');
  const modelsText = h('small');
  const modelsActions = h('div.row');

  let accountsKey = '';
  const paint = () => {
    const s = store.subscriptions;
    const p = s.proxy;
    const off = p.phase === 'unsupported';
    unsupported.classList.toggle('hidden', !off);
    for (const el of hidden) el.classList.toggle('hidden', off);
    if (off) return;

    proxyText.textContent = 'A small menu-bar app on this Mac. It serves your Claude, ChatGPT and other plans to Droid, and keeps their sign-ins.';
    proxyMeta.textContent = proxyWords(p);
    const newer = !!p.version && !!p.latest && compareVersions(p.latest, p.version) > 0;
    const buttons: HTMLElement[] = [];
    if (p.phase === 'missing') buttons.push(proxyButton('Install', 'install', true));
    else if (p.phase === 'installing') buttons.push(proxyButton('Installing…', 'install', false, true));
    else if (p.phase === 'outdated') buttons.push(proxyButton(p.latest ? `Update to ${p.latest}` : 'Update', 'install', true));
    else {
      if (p.phase === 'stopped') buttons.push(proxyButton('Start', 'start', true));
      if (p.phase === 'starting') buttons.push(proxyButton('Starting…', 'start', false, true));
      if (newer) buttons.push(proxyButton(`Update to ${p.latest}`, 'install'));
      if (p.phase === 'running') buttons.push(proxyButton('Open DroidProxy', 'open'));
    }
    proxyActions.replaceChildren(...buttons);
    proxyProgress.replaceChildren(...(p.phase === 'installing' ? [progressBar('Installing DroidProxy', p.progress)] : []));
    proxyError.textContent = p.error ?? '';

    // Rebuilt only when it would look different (and once a minute for "resets in"), so a poll doesn't swap a button out from under a click.
    const next = JSON.stringify([s.providers, p.phase, Math.floor(Date.now() / 60_000)]);
    if (next !== accountsKey) {
      accountsKey = next;
      accountsList.replaceChildren(...(updatesFirst() ? [h('p.note.warn', {}, UPDATES_FIRST_NOTE)] : []), ...shownProviders().map((pr) => providerBlock(pr, s.providers.length > 0)));
    }

    const m = s.models;
    const update = h('button.btn.sm', { type: 'button', onclick: () => net.send({ t: 'subscriptions.models' }) });
    if (!m) {
      modelsText.textContent = 'Shows once DroidProxy is running.';
      modelsActions.replaceChildren();
    } else if (!m.installed) {
      modelsText.textContent = m.available ? `None of DroidProxy’s ${m.available} models are in Droid yet.` : 'DroidProxy has no models to give Droid until an account is connected.';
      update.textContent = 'Add models';
      update.classList.add('primary');
      modelsActions.replaceChildren(...(m.available ? [update] : []));
    } else if (m.stale) {
      modelsText.textContent = `${m.installed} DroidProxy models are in Droid’s model list, but DroidProxy now serves ${m.available}. Update them so Droid has the current list.`;
      update.textContent = 'Update models';
      update.classList.add('primary');
      modelsActions.replaceChildren(update);
    } else {
      modelsText.textContent = `All ${m.installed} of DroidProxy’s models are in Droid’s model list, so every picker offers them.`;
      modelsActions.replaceChildren();
    }
  };

  const providerBlock = (pr: SubscriptionProvider, known: boolean): HTMLElement => {
    const name = providerName(pr.key);
    const count = pr.accounts.length;
    const summary = !pr.enabled ? 'Switched off: its models don’t run' : count ? `${count} account${count === 1 ? '' : 's'}` : 'Not connected';
    const sw = known
      ? toggle({
          label: `${name} models`,
          bare: true,
          checked: pr.enabled,
          onChange: (on) => net.send({ t: 'subscriptions.provider', provider: pr.key, enabled: on }),
        })
      : null;
    if (sw) sw.title = pr.enabled ? `Switch ${name} off` : `Switch ${name} on`;
    const remove = (a: SubscriptionAccount) => () => {
      if (confirm(`Remove ${a.label} from ${name}? DroidProxy forgets its sign-in, and workers on ${name} models use your other ${name} accounts, if any.`)) {
        net.send({ t: 'subscriptions.disconnect', provider: pr.key, account: a.id });
      }
    };
    const busy = !!pr.connecting && !pr.connecting.error;
    return h(
      'section.subs-provider',
      { class: providerConnected(pr) ? 'connected' : '' },
      h('div.subs-provider-head', {}, h('div.group-label', {}, h('b', {}, name), h('small', {}, summary)), busy ? null : h('button.btn.sm', { type: 'button', onclick: () => connect(net, pr) }, connectLabel(pr)), sw),
      count ? h('ul.subs-accounts', {}, ...pr.accounts.map((a) => accountRow(a, remove(a)))) : null,
      connectingBlock(pr, net),
    );
  };

  paint();
  const off = store.on('subscriptions', paint);
  const timer = setInterval(paint, 30_000);
  return {
    proxy: { desc: h('span.stack.tight', {}, proxyText, proxyMeta), control: proxyActions, below: [proxyProgress, proxyError] },
    accounts: { desc: h('small', {}, 'Each plan’s accounts, and how much of every usage window is left. A plan switched off stops its models; nobody can hire on them.'), below: [accountsList] },
    models: { desc: modelsText, control: modelsActions },
    unsupported,
    hideWhenUnsupported: (...els) => {
      hidden.push(...els);
      paint();
    },
    dispose: () => {
      off();
      clearInterval(timer);
    },
  };
}
