import { store } from '../state';
import { claimEscape, h, openModal } from './dom';
import { windowHeader } from './kit';
import { proxyLine, RingTips, subscriptionsView } from './subscriptions-rings';
import { openFactoryLimits } from './factory-limits';
import { factoryLimitsActive } from '../../shared/factory-limits';
import { watchFactory } from '../factory';

/** Companion clients read the office's plans; installation and sign-in happen on its Mac. */
export function openSubscriptionsStatus() {
  const proxy = h('span.subs-proxy');
  const body = h('div.body.stack');
  const limits = h('button.btn.sm', { type: 'button', onclick: () => openFactoryLimits() }, 'Factory Limits & Overage');
  const footer = h('footer', {}, h('span.grow', {}, 'Manage accounts in Settings → Connections'), limits);
  const content = h('div.modal.subs-status', {}, windowHeader('Subscriptions', proxy), body, footer);
  const tips = new RingTips();
  let shown = '';
  const paint = () => {
    const s = store.subscriptions;
    const now = Date.now();
    const factory = store.factory;
    const active = !store.setup.airgapped && factory.connection.connected && !factory.connection.rejected && factoryLimitsActive(factory.limits);
    proxy.textContent = active ? `Factory quotas · ${proxyLine(s)}` : proxyLine(s);
    proxy.dataset.phase = s.proxy.phase;
    limits.classList.toggle('hidden', !factory.connection.connected);
    // Rebuilt only when it would look different (and once a minute for "resets in"), so a poll doesn't close an open tooltip.
    const next = JSON.stringify([s.proxy, s.models, s.providers, active ? factory.limits : null, factory.connection.connected, Math.floor(now / 60_000)]);
    if (next === shown) return;
    shown = next;
    const keep = tips.current;
    const focused = body.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.account : undefined;
    const view = subscriptionsView(s, now, undefined, active ? factory.limits : undefined);
    body.replaceChildren(...view.nodes);
    tips.attach(view.rings, keep, focused);
  };
  paint();
  const off = store.on('subscriptions', paint);
  const offFactory = store.on('factory', paint);
  const offSetup = store.on('setup', paint);
  const unwatch = watchFactory('limits');
  const timer = setInterval(paint, 30_000);
  const unclaim = claimEscape(content, () => tips.dismiss());
  content.addEventListener('pointerdown', (e) => {
    if (!(e.target as Element | null)?.closest?.('.subs-tile')) tips.dismiss();
  });
  const modal = openModal(content, {
    onClose: () => {
      off();
      offFactory();
      offSetup();
      unwatch();
      clearInterval(timer);
      unclaim();
    },
  });
  return modal;
}
