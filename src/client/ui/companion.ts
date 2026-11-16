import type { PairedDevice, PairingState } from '../../shared/devices';
import { companionLink } from '../../shared/devices';
import { withToken } from '../token';
import { copy } from './clipboard';
import { h, openModal, timeAgo, toast } from './dom';
import { icon, type IconName } from './icons';
import { emptyState, toggle, windowHeader } from './kit';
import { confirmDialog } from './prompt';

// The 🌐 Web companion window: whether desktop browsers may use the office at /dashboard, the link for
// each way to reach this computer (localhost or Tailscale HTTPS), how pairing works,
// and the browsers that are paired. Like the Phone window, only the office's own page on its own
// machine can read or change it (/api/mobile/pairing and /api/mobile/companion in server.ts).

/** The LAN token the pairing link carries: what opens a companion link the first time. */
function lanTokenOf(state: PairingState): string {
  try {
    return state.link ? (new URL(state.link).searchParams.get('t') ?? '') : '';
  } catch {
    return '';
  }
}

interface Way {
  icon: IconName;
  kind: 'local' | 'tailscale';
  title: string;
  reach: string;
  tags: string[];
  /** What Copy and Open use. */
  link: string;
}

function ways(state: PairingState): Way[] {
  const token = lanTokenOf(state);
  const local: Way = {
    icon: 'monitor',
    kind: 'local',
    title: 'This computer',
    reach: 'In any browser on the computer running the office.',
    tags: ['No pairing'],
    link: companionLink(state.local),
  };
  return [
    local,
    ...state.addresses.map(
      (a): Way => ({
        icon: 'globe',
        kind: 'tailscale',
        title: 'Tailscale · HTTPS',
        reach: 'Private to your tailnet. Pair here, then install with Chrome’s address-bar button.',
        tags: ['Chrome app', 'Best to bookmark'],
        link: companionLink(a.url, token),
      }),
    ),
  ];
}

/**
 * Opens the Web companion window. `onChange` hears the state whenever it's read again. `companion`
 * is the window opened from the companion itself, which turning it off disconnects too.
 */
export function openCompanion(onChange?: (state: PairingState) => void, { companion = false } = {}) {
  const toggleEl = toggle({
    label: 'Web companion',
    bare: true,
    onChange: (on) => {
      if (on || !companion) return void setOn(on);
      toggleEl.input.checked = true;
      confirmDialog(
        'Turn off the web companion?',
        'This window disconnects too, and every paired browser with it. To turn it back on, switch to the 3D office from the menu bar icon or the Office menu, then open Settings → Phone & web.',
        'Turn off',
        () => void setOn(false),
      );
    },
  });
  const statePill = h('span.pill');
  const heroText = h('small');
  const hero = h('section.wc-hero', {}, h('span.wc-hero-icon', {}, icon('monitor', 26)), h('div.wc-hero-text', {}, h('div.wc-hero-title', {}, h('b', {}, 'Your office in any desktop browser'), statePill), heroText), toggleEl);
  const addrs = h('div.wc-ways', { 'aria-label': 'Ways to connect' });
  const reachNote = h('div.wc-notes');
  const httpsToggle = toggle({
    label: 'Tailscale HTTPS',
    disabled: true,
    description: 'The only remote access path for browsers and Android. Both devices need Tailscale. Localhost keeps working.',
    onChange: (on) => {
      httpsToggle.input.disabled = true;
      const update = () => {
        httpsBusy = true;
        httpsToggle.input.disabled = true;
        void request('PUT', '/api/mobile/https', { on }).finally(() => {
          httpsBusy = false;
          if (!disposed && last) paint(last);
        });
      };
      if (on) update();
      else {
        httpsToggle.input.checked = true;
        httpsToggle.input.disabled = false;
        confirmDialog('Turn off remote access?', 'Every remote browser and Android connection disconnects. The office stays available on this computer.', 'Turn off', update);
      }
    },
  });
  const httpsNote = h('p.note', { role: 'status' });
  const httpsSection = h('div.stack.tight', { hidden: true }, httpsToggle, httpsNote);
  const steps = h(
    'ol.wc-steps',
    {},
    h('li', {}, h('span', {}, 'Sign both computers in to Tailscale. Click ', h('b', {}, 'Copy pairing link'), ' above and paste it into the other computer’s browser.')),
    h('li', {}, h('span', {}, 'Choose ', h('b', {}, 'Pair this browser'), ' there before refreshing. There is no approval pop-up on this computer: the link grants access.')),
    h('li', {}, h('span', {}, h('b', {}, 'Bookmark the page.'), ' Each address pairs on its own, so bookmark the one you’ll use. Tailscale’s name works at home and away.')),
  );
  const count = h('span.wc-count');
  const list = h('ul.list.boxed.wc-browsers', { 'aria-label': 'Paired browsers' });
  const status = h('p.note', { role: 'status', 'aria-live': 'polite' });
  const body = h(
    'div.body',
    {},
    h(
      'div.stack.loose',
      {},
      hero,
      status,
      h('section.section', {}, h('div.eyebrow', {}, h('span.no', {}, '01'), 'Choose how to connect'), httpsSection, addrs, reachNote),
      h('section.section', {}, h('div.eyebrow', {}, h('span.no', {}, '02'), 'Pair a browser on another computer'), steps),
      h('p.note.info', {}, 'Pairing links include a private access key. Use the copy button, not a manually typed address. Keep the link private; it works until the office restarts.'),
      h('section.section', {}, h('div.eyebrow', {}, h('span.no', {}, '03'), 'Paired browsers', count), list),
    ),
  );
  const footer = h('footer', {}, h('span.grow', {}, 'Keep this computer awake with the office running. Closing the office stops the companion too.'));
  const el = h('div.modal.lg.wc', { role: 'dialog', 'aria-label': 'Web companion' }, windowHeader('🌐 Web companion', 'Workers, live terminals and the Whiteboard, without the 3D'), body, footer);

  let last: PairingState | undefined;
  let httpsBusy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let stopped = false;
  let armed = '';
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let waysKey = '';

  const copyBtn = (w: Way, disabled: boolean) => {
    const label = h('span', {}, 'Copy pairing link');
    const b = h('button.btn.sm', { type: 'button', disabled, 'aria-label': `Copy pairing link for ${w.title}`, title: 'Includes the private access key needed to connect this browser' }, icon('copy', 13), label);
    b.addEventListener('click', async () => {
      const ok = await copy(w.link);
      label.textContent = ok ? 'Copied' : 'Copy failed';
      b.classList.toggle('done', ok);
      if (ok) toast('Pairing link copied. Paste it into the other computer’s browser, then choose Pair this browser.', 'info');
      setTimeout(() => {
        label.textContent = 'Copy pairing link';
        b.classList.remove('done');
      }, 1600);
    });
    return b;
  };

  const paintWays = (state: PairingState) => {
    const key = JSON.stringify([state.companion, state.https, state.local, state.addresses, lanTokenOf(state), state.reachable, state.reason]);
    if (key === waysKey) return;
    waysKey = key;
    const off = !state.companion;
    const way = (w: Way) =>
      h(
        'div.wc-way',
        { class: w.kind },
        h('span.wc-way-icon', {}, icon(w.icon, 18)),
        h('div.wc-way-main', {}, h('div.wc-way-title', {}, h('b', {}, w.title), ...w.tags.map((t) => h('span.wc-tag', { class: t === 'Best to bookmark' ? 'best' : '' }, t))), h('small', {}, w.reach)),
        h(
          'div.wc-way-actions',
          {},
          w.kind === 'local'
            ? h(
                'a.btn.sm.primary',
                { href: w.link, target: '_blank', rel: 'noopener noreferrer', class: off ? 'disabled' : '', 'aria-disabled': off ? 'true' : undefined, tabindex: off ? '-1' : undefined },
                icon('external', 13),
                'Open here',
              )
            : copyBtn(w, off),
        ),
      );
    const available = ways(state);
    addrs.replaceChildren(...available.map(way));
    const notes: HTMLElement[] = [];
    if (!state.reachable)
      notes.push(
        h(
          'div.wc-way.missing',
          {},
          h('span.wc-way-icon', {}, icon('lock', 18)),
          h('div.wc-way-main', {}, h('b', {}, 'Only this computer'), h('small', {}, state.reason ?? 'Start Tailscale on both devices and enable HTTPS above. LAN-only and plain HTTP remote connections are not supported.')),
        ),
      );
    reachNote.replaceChildren(...notes);
    addrs.classList.toggle('off', off);
    reachNote.classList.toggle('off', off);
  };

  const unpairButton = (d: PairedDevice) => {
    const b = h('button.btn.sm', { type: 'button', class: armed === d.id ? 'danger' : '', title: `Unpair ${d.name}: its access stops right away and its tabs disconnect` }, armed === d.id ? 'Sure? Unpair' : 'Unpair');
    b.addEventListener('click', () => {
      if (armed !== d.id) {
        armed = d.id;
        clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          armed = '';
          if (last) paintBrowsers(last);
        }, 4000);
        if (last) paintBrowsers(last);
        return;
      }
      armed = '';
      b.disabled = true;
      void request('DELETE', `/api/mobile/devices/${encodeURIComponent(d.id)}`);
    });
    return b;
  };

  const paintBrowsers = (state: PairingState) => {
    const browsers = state.devices.filter((d) => d.kind === 'browser');
    count.textContent = browsers.length ? String(browsers.length) : '';
    if (!browsers.length) {
      list.replaceChildren(h('li.wc-empty', {}, emptyState('', 'No browsers paired yet', 'Pair one from a companion link above. Phones are under 📱 Phone.')));
      return;
    }
    list.replaceChildren(
      ...browsers.map((d) =>
        h(
          'li.list-row',
          {},
          h('span.list-icon.wc-browser-icon', {}, icon('monitor', 16)),
          h(
            'div.list-main',
            {},
            h('div.list-title', { title: d.name }, d.name),
            h('div.list-meta', { title: `Paired ${new Date(d.pairedAt).toLocaleString()} · last seen ${new Date(d.lastSeenAt).toLocaleString()}` }, `Paired ${timeAgo(d.pairedAt)} · seen ${timeAgo(d.lastSeenAt)}`),
          ),
          h('div.list-end', {}, unpairButton(d)),
        ),
      ),
    );
  };

  const paint = (state: PairingState) => {
    last = state;
    const https = state.https;
    httpsSection.hidden = !https;
    httpsToggle.input.checked = https?.on ?? false;
    httpsToggle.input.disabled = httpsBusy || !!https?.locked;
    let httpsMessage = https?.locked ?? https?.reason;
    if (!httpsMessage) {
      if (https?.status === 'starting') httpsMessage = 'Setting up Tailscale Serve…';
      else if (https?.status === 'serving') httpsMessage = 'HTTPS is ready. Copy its pairing link below. Pair again if you previously used HTTP.';
      else httpsMessage = 'Remote access is off. Turn on to create a tailnet-only HTTPS address. Nothing is opened to the public internet.';
    }
    httpsNote.replaceChildren(httpsMessage, ...(https?.fixUrl ? [' ', h('a', { href: https.fixUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Enable HTTPS in Tailscale')] : []));
    toggleEl.input.checked = state.companion;
    toggleEl.input.disabled = false;
    statePill.className = `pill ${state.companion ? 'done' : 'offline'}`;
    statePill.textContent = state.companion ? 'On' : 'Off';
    heroText.textContent = state.companion
      ? 'Open it on this computer, or copy a pairing link for another computer. Your workers, live terminals, prompts and Whiteboard are all there.'
      : 'Off: browsers can’t pair or connect, and any open companion tab was disconnected. Paired browsers stay paired and come back when you turn it on.';
    hero.classList.toggle('off', !state.companion);
    paintWays(state);
    paintBrowsers(state);
    onChange?.(state);
  };

  const fail = (text: string, final = false) => {
    stopped ||= final;
    status.textContent = text;
    status.className = 'note bad';
  };

  const request = async (method: 'GET' | 'DELETE' | 'PUT', path: string, body?: unknown) => {
    clearTimeout(timer);
    try {
      const res = await fetch(withToken(path), { method, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      if (disposed) return;
      if (res.status === 403) return fail('Manage the web companion from the office on its own computer (this page is another device).', true);
      if (res.status === 401) return fail('The office restarted: reopen it from the join link in its terminal.', true);
      const data = (await res.json()) as PairingState | { error?: string };
      if (!res.ok) throw new Error(('error' in data && data.error) || `Request failed (${res.status})`);
      status.textContent = '';
      status.className = 'note';
      paint(data as PairingState);
      return true;
    } catch (err) {
      if (!disposed) fail(err instanceof Error ? err.message : 'Could not reach the office. Retrying…');
    } finally {
      if (!disposed && !stopped) timer = setTimeout(() => void request('GET', '/api/mobile/pairing'), 3000);
    }
  };

  const setOn = async (on: boolean) => {
    toggleEl.input.disabled = true;
    if (await request('PUT', '/api/mobile/companion', { on })) toast(on ? '🌐 Web companion on' : '🌐 Web companion off: companion tabs were disconnected', 'info');
    else if (last) toggleEl.input.checked = last.companion;
    toggleEl.input.disabled = false;
  };

  openModal(el, {
    doing: '🌐 setting up the web companion',
    onClose: () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(armTimer);
    },
  });
  toggleEl.input.disabled = true;
  void request('GET', '/api/mobile/pairing');
}

/** The web companion as Settings shows it: on or off and how many browsers are paired, or why it can't say. */
export async function companionState(): Promise<PairingState | string> {
  try {
    const res = await fetch(withToken('/api/mobile/pairing'), { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 403) return 'The web companion is managed from the office on its own computer.';
    if (!res.ok) return 'Could not read the web companion’s state.';
    return (await res.json()) as PairingState;
  } catch {
    return 'Could not reach the office.';
  }
}
