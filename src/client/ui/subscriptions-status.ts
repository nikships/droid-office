import { providerName } from '../../shared/subscriptions';
import { store } from '../state';
import { h, openModal } from './dom';
import { windowHeader } from './kit';
import { providerLogo } from './model-logo';
import { accountRow, proxyWords } from './subscriptions-settings';

/** Companion clients read the office's plans; installation and sign-in happen on its Mac. */
export function openSubscriptionsStatus() {
  const body = h('div.body.stack');
  const paint = () => {
    const s = store.subscriptions;
    body.replaceChildren(
      h('p', {}, 'The plans your workers run on. Manage sign-ins, accounts and DroidProxy in Settings → Subscriptions on the office’s Mac.'),
      h('section.stack.tight', {}, h('h3', {}, 'DroidProxy'), h('p', {}, proxyWords(s.proxy)), s.proxy.error ? h('p.note.bad', {}, s.proxy.error) : null),
      ...(s.models ? [h('p.sub', {}, `${s.models.installed} models in Droid · ${s.models.available} available${s.models.stale ? ' · update the model list on the Mac' : ''}`)] : []),
      ...s.providers.map((p) =>
        h(
          'section.subs-provider',
          {},
          h(
            'div.subs-provider-head',
            {},
            h('span.subs-provider-logo', {}, providerLogo(p.key)),
            h(
              'div.group-label',
              {},
              h('b', {}, providerName(p.key)),
              h('small', {}, !p.enabled ? 'Switched off: its models don’t run' : p.accounts.length ? `${p.accounts.length} account${p.accounts.length === 1 ? '' : 's'}` : 'Not connected'),
            ),
          ),
          h('ul.subs-accounts', {}, ...p.accounts.map((a) => accountRow(a))),
        ),
      ),
      ...(!s.providers.length && s.proxy.phase !== 'unsupported' ? [h('p.note.info', {}, 'No accounts are listed yet. Connect a plan on the office’s Mac.')] : []),
    );
  };
  paint();
  const off = store.on('subscriptions', paint);
  const timer = setInterval(paint, 30_000);
  const modal = openModal(h('div.modal', {}, windowHeader('Subscriptions', 'Accounts and usage from your office'), body), {
    onClose: () => {
      off();
      clearInterval(timer);
    },
  });
  return modal;
}
