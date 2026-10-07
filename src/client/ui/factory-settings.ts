import { FACTORY_GROUPS, FACTORY_KEYS_URL, type FactoryCapability } from '../../shared/factory';
import { onFactorySetup, refreshFactory } from '../factory';
import type { Net } from '../net';
import { store } from '../state';
import { h, timeAgo } from './dom';

const MARK: Record<FactoryCapability['status'], string> = { ok: '✓', denied: '✗', checking: '…', error: '!' };

/** One line of what the key reaches: ✓ with what it found, ✗ with why not, … while it's asked. */
function capabilityRow(c: FactoryCapability, label: string) {
  const why = c.status === 'checking' ? 'Checking…' : c.status === 'denied' ? (c.reason ?? 'No access') : c.status === 'error' ? `Couldn’t check: ${c.reason ?? 'no answer'}` : c.reason;
  return h(
    'li',
    { class: c.status, title: c.detail ?? '' },
    h('span.mark', { 'aria-label': c.status === 'ok' ? 'Yes' : c.status === 'denied' ? 'No' : c.status }, MARK[c.status]),
    h('span.what', {}, label),
    why ? h('span.why', {}, why) : null,
  );
}

/**
 * ⚙️ Settings → Factory → "Factory API key": the password field and Connect while there's no key,
 * then whose key it is, its fingerprint, what it reaches, and Check again / Replace key / Disconnect.
 */
export function factoryKeySettings(net: Net): { nodes: Node[]; dispose: () => void } {
  const keyInput = h('input', { type: 'password', placeholder: 'Factory API key (fk-…)', 'aria-label': 'Factory API key', spellcheck: 'false', autocomplete: 'new-password' }) as HTMLInputElement;
  const connect = h('button.btn.primary', { type: 'button' }, 'Connect') as HTMLButtonElement;
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const form = h('div.webhook', {}, keyInput, connect, cancel);
  const intro = h(
    'p.setting-note.factory-intro',
    {},
    'Connecting shows your Factory cloud computers, Droid sessions and credits, CI automations and AutoWiki in the office, and lets you act on them from here. Make a key at ',
    h('a', { href: FACTORY_KEYS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'app.factory.ai/settings/api-keys'),
    '. It stays on the office’s machine and is never shown again.',
  );
  const who = h('p.outside-now');
  const facts = h('p.setting-note');
  const rejected = h('p.setting-note.bad');
  const caps = h('ul.factory-caps', { 'aria-label': 'What the key can reach' });
  const check = h('button.btn', { type: 'button' }, 'Check again') as HTMLButtonElement;
  const replace = h('button.btn', { type: 'button' }, 'Replace key');
  const remove = h('button.btn.danger', { type: 'button' }, 'Disconnect');
  const actions = h('div.seg', { style: 'margin-top:10px' }, check, replace, remove);
  const error = h('p.setting-note.bad', { role: 'alert' });
  const connected = h('div.factory-connected', {}, who, facts, rejected, caps, actions);

  let busy = false;
  let replacing = false;
  let failure = '';
  const paint = () => {
    const c = store.factory.connection;
    const editing = !c.connected || replacing;
    connected.classList.toggle('hidden', !c.connected || replacing);
    form.classList.toggle('hidden', !editing);
    intro.classList.toggle('hidden', !editing);
    cancel.classList.toggle('hidden', !c.connected);
    connect.disabled = busy;
    connect.textContent = busy ? 'Checking…' : c.connected ? 'Use this key' : 'Connect';
    keyInput.disabled = busy;
    error.classList.toggle('hidden', !failure);
    error.textContent = failure ? `⚠️ ${failure}` : '';
    if (!c.connected) return;
    const a = c.account;
    who.textContent = a ? `🏭 ${a.name}${a.email && a.email !== a.name ? ` · ${a.email}` : ''}` : '🏭 Connected to Factory';
    const members = c.members !== undefined ? `${c.members}${c.membersMore ? '+' : ''} ${c.members === 1 && !c.membersMore ? 'member' : 'members'} in the organization` : '';
    facts.textContent = [`Key ${c.fingerprint ?? ''}`, c.by && c.at ? `connected by ${c.by} ${timeAgo(c.at)}` : '', members, c.checking ? 'checking now…' : c.checkedAt ? `checked ${timeAgo(c.checkedAt)}` : ''].filter(Boolean).join(' · ');
    rejected.classList.toggle('hidden', !c.rejected);
    rejected.textContent = c.rejected ? `⚠️ Key rejected: Factory turned it down (${c.rejected}). The office has stopped reading Factory. Check again, or replace the key.` : '';
    caps.replaceChildren(...FACTORY_GROUPS.map((g) => capabilityRow(c.capabilities.find((x) => x.group === g.id) ?? { group: g.id, status: 'checking' }, g.label)));
    check.disabled = !!c.checking;
    check.textContent = c.checking ? 'Checking…' : 'Check again';
  };

  const send = () => {
    const key = keyInput.value.trim();
    if (!key) return keyInput.focus();
    busy = true;
    failure = '';
    net.send({ t: 'factory.connect', key });
    paint();
  };
  connect.addEventListener('click', send);
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  cancel.addEventListener('click', () => {
    replacing = false;
    failure = '';
    keyInput.value = '';
    paint();
  });
  replace.addEventListener('click', () => {
    replacing = true;
    failure = '';
    paint();
    keyInput.focus();
  });
  check.addEventListener('click', () => refreshFactory());
  remove.addEventListener('click', () => {
    if (confirm('Disconnect the office from Factory? It forgets the key, and the Factory boards and windows go blank until someone connects it again.')) net.send({ t: 'factory.disconnect' });
  });

  const offSetup = onFactorySetup((msg) => {
    busy = false;
    failure = msg.error ?? '';
    if (msg.ok) {
      replacing = false;
      keyInput.value = '';
    }
    paint();
  });
  const offState = store.on('factory', paint);
  // The "5m ago"s age while Settings stays open.
  const timer = setInterval(paint, 30_000);
  paint();
  return {
    nodes: [intro, form, error, connected],
    dispose: () => {
      offSetup();
      offState();
      clearInterval(timer);
    },
  };
}
