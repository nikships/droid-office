import { encode } from 'uqr';
import type { PairedDevice, PairingAddress, PairingState } from '../../shared/devices';
import { withToken } from '../token';
import { h, openModal, timeAgo } from './dom';

// The 📱 Phone window: the QR code Droid Office for Android scans to pair, the addresses it carries,
// and the phones that are paired. Only the office's own page on its own machine can read it (see
// /api/mobile/pairing in server.ts), so it polls separately from the game connection while open.

const SVG = 'http://www.w3.org/2000/svg';
/** Quiet zone, in modules. Scanners want four; three still reads well on a white tile with padding. */
const QUIET = 3;
/** The badge in the middle, in modules; Q error correction covers far more than it hides. */
const BADGE = 9;

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/**
 * The QR code's dark modules as one SVG path of unit squares, minus the square in the middle the
 * badge sits on. `size` counts the quiet zone. The finder eyes stay square: rounded ones look
 * friendlier but some phone scanners (OpenCV's, for one) stop finding the code.
 */
export function qrShape(text: string): { size: number; path: string; badge: number } {
  const qr = encode(text, { ecc: 'Q', border: QUIET });
  const n = qr.size - 2 * QUIET;
  const badge = BADGE + ((n - BADGE) % 2);
  const lo = (qr.size - badge) / 2;
  const inBadge = (x: number, y: number) => x >= lo && x < lo + badge && y >= lo && y < lo + badge;
  let path = '';
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark && !inBadge(x, y)) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size: qr.size, path, badge };
}

/** The pairing link drawn as a QR code, with the office's badge in the middle. */
function qrCode(text: string): SVGSVGElement {
  const { size, path, badge } = qrShape(text);
  const root = svg('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'Pairing QR code for Droid Office for Android', 'shape-rendering': 'crispEdges' });
  root.append(svg('rect', { width: size, height: size, fill: '#ffffff' }), svg('path', { d: path, fill: '#0a0a0a' }));
  const at = (size - badge) / 2;
  root.append(
    svg('rect', { x: at + 0.5, y: at + 0.5, width: badge - 1, height: badge - 1, rx: 1.6, fill: '#ffffff', 'shape-rendering': 'geometricPrecision' }),
    svg('image', { href: '/favicon.svg', x: at + 1.25, y: at + 1.25, width: badge - 2.5, height: badge - 2.5 }),
  );
  return root;
}

const KIND: Record<PairingAddress['kind'], string> = { wifi: 'Wi-Fi', tailscale: 'Tailscale' };

/** Opens the Phone window. `onChange` hears the paired phones whenever they're read again. */
export function openPhone(onChange?: (devices: PairedDevice[]) => void) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const tile = h('div.phone-qr', { 'aria-busy': 'true' }, h('div.spinner'));
  const caption = h('p.phone-qr-caption', {}, 'Scan with ', h('b', {}, 'Droid Office for Android'));
  const addresses = h('ul.phone-addrs', { 'aria-label': 'Addresses in the code' });
  const addressNote = h('p.setting-note');
  const devicesList = h('ul.phone-devices', { 'aria-label': 'Paired phones' });
  const devicesCount = h('span.phone-count');
  const status = h('p.phone-status', { role: 'status', 'aria-live': 'polite' });
  const steps = h(
    'ol.phone-steps',
    {},
    h('li', {}, h('span', {}, h('b', {}, 'Open Droid Office for Android'), ' on your phone.')),
    h('li', {}, h('span', {}, 'Start pairing in the app and point the camera at this code.')),
    h('li', {}, h('span', {}, 'Your phone shows up under ', h('b', {}, 'Paired phones'), '. Hire workers, watch their terminals and prompt them from it.')),
  );
  const pairCard = h('section.phone-pair', {}, h('div.phone-qr-col', {}, tile, caption), h('div.phone-side', {}, steps, h('h4.phone-label', {}, 'In this code'), addresses, addressNote));
  const paired = h('section.phone-paired', {}, h('div.phone-paired-head', {}, h('h4.phone-label', {}, 'Paired phones'), devicesCount), devicesList);
  const footer = h('footer', {}, h('span.grow', {}, 'The code changes every time the office starts. A paired phone stays paired until you forget it.'));
  const el = h('div.modal.phone', { role: 'dialog', 'aria-label': 'Phone' }, h('header', {}, h('h2', {}, '📱 Phone'), close), h('div.body', {}, pairCard, status, paired), footer);

  let link = '';
  let known: Set<string> | undefined;
  const fresh = new Set<string>();
  let armed = '';
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let stopped = false;
  let last: PairingState | undefined;

  const paintQr = (state: PairingState) => {
    tile.removeAttribute('aria-busy');
    if (state.link && state.link === link) return;
    link = state.link ?? '';
    tile.classList.toggle('off', !state.link);
    if (state.link) tile.replaceChildren(qrCode(state.link), ...['tl', 'tr', 'bl', 'br'].map((c) => h('i.phone-corner', { class: c, 'aria-hidden': 'true' })));
    else tile.replaceChildren(h('div.phone-qr-off', {}, h('span', { 'aria-hidden': 'true' }, '🔌'), h('p', {}, state.reason ?? 'Nothing off this machine can reach the office.')));
    caption.classList.toggle('hidden', !state.link);
  };

  const paintAddresses = (state: PairingState) => {
    addresses.replaceChildren(
      ...state.addresses.map((a) =>
        h('li', { class: a.kind }, h('span.phone-kind', { class: a.kind }, KIND[a.kind]), h('code', {}, a.url.replace(/^https?:\/\//, '')), a.kind === 'tailscale' && h('span.phone-hint', {}, a.dns ? 'MagicDNS' : 'tailnet IP')),
      ),
    );
    addresses.classList.toggle('hidden', !state.addresses.length);
    const tailnet = state.addresses.some((a) => a.kind === 'tailscale');
    const wifi = state.addresses.some((a) => a.kind === 'wifi');
    addressNote.textContent = !state.addresses.length
      ? ''
      : tailnet
        ? `The phone tries them in this order.${wifi ? ' Wi-Fi works on the same network as this machine;' : ''} Tailscale works from anywhere, once the phone is signed in to the same tailnet.`
        : 'The phone needs to be on the same Wi-Fi as this machine. Sign in to Tailscale on both to reach the office from anywhere.';
  };

  const forgetButton = (d: PairedDevice) => {
    const b = h('button.btn', { type: 'button', title: `Unpair ${d.name}: its token stops working right away` }, armed === d.id ? 'Sure? Forget' : 'Forget') as HTMLButtonElement;
    if (armed === d.id) b.classList.add('danger');
    b.addEventListener('click', () => {
      if (armed !== d.id) {
        armed = d.id;
        clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          armed = '';
          if (last) paintDevices(last);
        }, 4000);
        if (last) paintDevices(last);
        return;
      }
      armed = '';
      b.disabled = true;
      void request('DELETE', `/api/mobile/devices/${encodeURIComponent(d.id)}`);
    });
    return b;
  };

  const paintDevices = (state: PairingState) => {
    const list = state.devices;
    devicesCount.textContent = list.length ? String(list.length) : '';
    if (!list.length) {
      devicesList.replaceChildren(h('li.phone-empty', {}, h('span', { 'aria-hidden': 'true' }, '📵'), h('div', {}, h('b', {}, 'No phones paired yet'), h('span', {}, 'Scan the code above with the app to pair one.'))));
      return;
    }
    devicesList.replaceChildren(
      ...list.map((d) =>
        h(
          'li',
          { class: fresh.has(d.id) ? 'fresh' : '' },
          h('span.phone-icon', { 'aria-hidden': 'true' }, '📱'),
          h(
            'div.phone-main',
            {},
            h('div.phone-name', {}, d.name, fresh.has(d.id) && h('span.phone-new', {}, 'Just paired')),
            h('div.phone-meta', { title: `Paired ${new Date(d.pairedAt).toLocaleString()} · last seen ${new Date(d.lastSeenAt).toLocaleString()}` }, `Paired ${timeAgo(d.pairedAt)} · seen ${timeAgo(d.lastSeenAt)}`),
          ),
          forgetButton(d),
        ),
      ),
    );
  };

  const paint = (state: PairingState) => {
    last = state;
    if (known) for (const d of state.devices) if (!known.has(d.id)) fresh.add(d.id);
    known = new Set(state.devices.map((d) => d.id));
    paintQr(state);
    paintAddresses(state);
    paintDevices(state);
    const newest = state.devices.find((d) => fresh.has(d.id));
    status.textContent = newest ? `✅ ${newest.name} is paired. You can close this window.` : '';
    status.classList.toggle('ok', !!newest);
    onChange?.(state.devices);
  };

  const fail = (text: string, final = false) => {
    stopped ||= final;
    status.textContent = text;
    status.classList.remove('ok');
    status.classList.add('bad');
    if (final) for (const part of [pairCard, paired, footer]) part.classList.add('hidden');
  };

  const request = async (method: 'GET' | 'DELETE', path: string) => {
    clearTimeout(timer);
    try {
      const res = await fetch(withToken(path), { method, credentials: 'same-origin', cache: 'no-store' });
      if (disposed) return;
      if (res.status === 403) return fail('Pair phones from the office on its own machine (this page is another device). Open the office there, or in the Mac app, and come back here.', true);
      if (res.status === 401) return fail('The office restarted: reopen it from the join link in its terminal.', true);
      const body = (await res.json()) as PairingState | { error?: string };
      if (!res.ok) throw new Error(('error' in body && body.error) || `Request failed (${res.status})`);
      status.classList.remove('bad');
      paint(body as PairingState);
    } catch (err) {
      if (!disposed) fail(err instanceof Error ? err.message : 'Could not reach the office. Retrying…');
    } finally {
      if (!disposed && !stopped) timer = setTimeout(() => void request('GET', '/api/mobile/pairing'), 3000);
    }
  };

  const modal = openModal(el, {
    doing: '📱 pairing a phone',
    onClose: () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(armTimer);
    },
  });
  close.addEventListener('click', () => modal.close());
  void request('GET', '/api/mobile/pairing');
}

/** The paired phones as Settings shows them, or why it can't. */
export async function pairedPhones(): Promise<PairedDevice[] | string> {
  try {
    const res = await fetch(withToken('/api/mobile/pairing'), { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 403) return 'Phones pair from the office on its own machine.';
    if (!res.ok) return 'Could not read the paired phones.';
    return ((await res.json()) as PairingState).devices;
  } catch {
    return 'Could not reach the office.';
  }
}
