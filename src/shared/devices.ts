// Phones paired with the office (Droid Office for Android), as the office's own page sees them in
// ⚙️ Settings → Phone. A phone pairs by scanning the pairing link's QR code and keeps a device token;
// the office keeps only that token's hash (see server/devices.ts).

/** A paired phone, without its token. Times are ISO strings. */
export interface PairedDevice {
  id: string;
  /** What the phone called itself when it paired, like "Pixel 10 Pro XL". */
  name: string;
  pairedAt: string;
  lastSeenAt: string;
}

/** How a pairing address reaches this machine: the local network, or a tailnet from anywhere. */
export type PairingAddressKind = 'wifi' | 'tailscale';

export interface PairingAddress {
  /** A base URL like `http://192.168.1.20:4600`. */
  url: string;
  kind: PairingAddressKind;
  /** For a Tailscale address: whether it's the MagicDNS name or the 100.x address. */
  dns?: boolean;
}

/** What `GET /api/mobile/pairing` answers the Phone window with. */
export interface PairingState {
  office: { name: string; version: string };
  /** The QR code's text (`droidoffice://pair?…`), or none when nothing off this machine can reach the office. */
  link?: string;
  /** The addresses the link carries, in its order: Wi-Fi first, then Tailscale. */
  addresses: PairingAddress[];
  /** Why there's no link (a loopback-only bind, or no network). */
  reason?: string;
  devices: PairedDevice[];
}

/** The longest name a phone can pair under. */
export const DEVICE_NAME_MAX = 64;
/** The most phones one office keeps paired at once. */
export const DEVICES_MAX = 32;
/** The pairing link's scheme and version (see pairingLink). */
export const PAIRING_SCHEME = 'droidoffice://pair';
export const PAIRING_VERSION = 1;

/**
 * The pairing QR code's text: `droidoffice://pair?v=1&name=…&t=<LAN token>&u=<base url>&u=…`, every
 * value URL-encoded and the base URLs in the order the phone should try them.
 */
export function pairingLink(name: string, token: string, urls: readonly string[]): string {
  // encodeURIComponent leaves !'()* alone; a Mac's name often has parentheses ("MacBook Pro (2)").
  const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const q = [`v=${PAIRING_VERSION}`, `name=${enc(name)}`, `t=${enc(token)}`, ...urls.map((u) => `u=${enc(u)}`)];
  return `${PAIRING_SCHEME}?${q.join('&')}`;
}
