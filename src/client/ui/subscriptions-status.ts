import { store } from '../state';
import { claimEscape, h, openModal } from './dom';
import { windowHeader } from './kit';
import { proxyLine, RingTips, subscriptionsView } from './subscriptions-rings';

/** Companion clients read the office's plans; installation and sign-in happen on its Mac. */
export function openSubscriptionsStatus() {
  const proxy = h('span.subs-proxy');
  const body = h('div.body.stack');
  const footer = h('footer', {}, h('span.grow', {}, 'Manage accounts in Settings → Connections on the office’s Mac'));
  const content = h('div.modal.subs-status', {}, windowHeader('Subscriptions', proxy), body, footer);
  const tips = new RingTips();
  let shown = '';
  const paint = () => {
    const s = store.subscriptions;
    const now = Date.now();
    proxy.textContent = proxyLine(s);
    proxy.dataset.phase = s.proxy.phase;
    footer.classList.toggle('hidden', s.proxy.phase === 'unsupported');
    // Rebuilt only when it would look different (and once a minute for "resets in"), so a poll doesn't close an open tooltip.
    const next = JSON.stringify([s.proxy, s.models, s.providers, Math.floor(now / 60_000)]);
    if (next === shown) return;
    shown = next;
    const keep = tips.current;
    const focused = body.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.account : undefined;
    const view = subscriptionsView(s, now);
    body.replaceChildren(...view.nodes);
    tips.attach(view.rings, keep, focused);
  };
  paint();
  const off = store.on('subscriptions', paint);
  const timer = setInterval(paint, 30_000);
  const unclaim = claimEscape(content, () => tips.dismiss());
  content.addEventListener('pointerdown', (e) => {
    if (!(e.target as Element | null)?.closest?.('.subs-tile')) tips.dismiss();
  });
  const modal = openModal(content, {
    onClose: () => {
      off();
      clearInterval(timer);
      unclaim();
    },
  });
  return modal;
}
