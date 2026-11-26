import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config.js';
import { bearerToken, isGuestRequest, isLocalRequest, lanAllowed } from '../lan.js';
import type { TailnetHttps } from '../tailnet-https.js';
import { machineName, pairingAddresses, type DevicesStore } from '../devices.js';
import type { TailscaleWatch } from '../tailscale.js';
import type { WebCompanion } from '../web-companion.js';
import { pairingLink, type PairedDevice, type PairingState } from '../../shared/devices.js';
import type { Client } from './client.js';
import { sameOrigin, send } from './http-utils.js';

interface AccessContext {
  cfg: Config;
  lanToken: string;
  devices: DevicesStore;
  tailscale: TailscaleWatch;
  companion: WebCompanion;
  tailnetHttps(): TailnetHttps;
  clients: Map<string, Client>;
  version: string;
  address(): AddressInfo | string | null;
}

/** Whether a connection is a guest's (external sharing), never one of the owner's. */
export const isGuestClient = (c: Client): boolean => !!(c as Client & { guest?: unknown }).guest;

/** The owner's own browsers and phones, for the Mac menu bar's counts. */
export const ownerDevices = (clients: Iterable<Client>) => [...clients].filter((c) => !isGuestClient(c)).map((c) => ({ device: c.device, phone: !!c.phoneSizes }));

/** Shared HTTP/WebSocket credentials and owner-only pairing settings. */
export function createAccess({ cfg, lanToken, devices, tailscale, companion, tailnetHttps, clients, version, address }: AccessContext) {
  /**
   * Who may reach the office: loopback, this start's LAN token (`?t=`), or a paired phone's device
   * token (`Authorization: Bearer`, or `?d=`). A device token that isn't paired (any more) is refused
   * outright, even on loopback, so a forgotten phone always hears that it was forgotten.
   */
  const access = (req: http.IncomingMessage, url: URL): { ok: boolean; device?: PairedDevice; header?: boolean; unpaired?: boolean } => {
    // The guest backend authenticates only share links (guest-http.ts); no office credential works there.
    if (isGuestRequest(req)) return { ok: false };
    const header = bearerToken(req);
    const token = header ?? url.searchParams.get('d');
    if (token) {
      const device = devices.verify(token);
      return device ? { ok: true, device, header: header !== undefined } : { ok: false, unpaired: true };
    }
    return { ok: lanAllowed(req, url, lanToken) };
  };
  /**
   * The office's own page on its own machine: loopback, and a same-origin request (the Origin header,
   * or for a GET, which carries none, the browser's Sec-Fetch-Site). What the Phone window reads and
   * changes (the pairing link, the paired phones) answers nothing else: no phone, no LAN browser.
   */
  const ownPage = (req: http.IncomingMessage) => isLocalRequest(req) && !bearerToken(req) && (sameOrigin(req, cfg) || (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin'));
  const officeCard = () => ({ name: machineName(), version });
  /** The Phone window's view: the pairing link with the addresses it carries, and the paired phones. */
  const pairingState = async (): Promise<PairingState> => {
    const port = (address() as AddressInfo | null)?.port ?? cfg.port;
    const scheme = cfg.tls ? 'https' : 'http';
    const tailnet = await tailscale.get();
    const https = cfg.tailnetHttps === false ? { on: false, status: 'off' as const, locked: 'Tailscale HTTPS is disabled by DROID_OFFICE_TAILNET_HTTPS=off.' } : tailnetHttps().state();
    const addresses = pairingAddresses(https.origin);
    const office = officeCard();
    const reachable = addresses.length > 0;
    const reason = reachable
      ? undefined
      : (https.locked ??
        https.reason ??
        (https.on ? 'Tailscale HTTPS is not ready. Start Tailscale on both devices and check HTTPS in the Web companion window.' : 'Tailscale HTTPS is off. Turn it on in the Web companion window to pair phones or browsers.'));
    const urls = addresses.map((a) => a.url);
    const link = urls.length ? pairingLink(office.name, lanToken, urls) : undefined;
    return {
      office,
      companion: companion.on,
      https,
      local: `${scheme}://localhost:${port}`,
      reachable,
      tailscale: !!tailnet,
      ...(link ? { link } : {}),
      addresses,
      ...(reason ? { reason } : {}),
      devices: devices.list(),
    };
  };
  /**
   * Turns the web companion on or off. Off closes every companion socket; paired browsers stay paired.
   * Guests on share links are governed only by external sharing's own toggle.
   */
  const setCompanion = (on: boolean) => {
    if (companion.on === on) return;
    companion.set(on, 'owner');
    console.log(`  🌐  The web companion is ${on ? 'on' : 'off'}`);
    if (!on) for (const c of clients.values()) if (c.dashboard && !isGuestClient(c)) c.ws.close(4403, 'The web companion was turned off');
  };
  /** Unpairs a phone: its token stops working, and its open connections are closed. */
  const forgetDevice = (id: string): boolean => {
    const name = devices.list().find((d) => d.id === id)?.name;
    if (!devices.forget(id)) return false;
    for (const c of clients.values()) if (c.device === id) c.ws.close(4401, 'This device was unpaired');
    console.log(`  📱 ${name} is no longer paired with the office`);
    return true;
  };

  /** Off the machine without this start's token: APIs get JSON, pages get a pointer to the join link. */
  const refuseHttp = (res: http.ServerResponse, api: boolean, unpaired = false) => {
    if (unpaired) return send(res, 401, { error: 'This device is not paired with the office any more. Pair it again from ⚙️ Settings → Phone & web.' });
    const hint = 'Open the join link from the office’s terminal (it prints a QR code on startup).';
    if (api) return send(res, 401, { error: `This office needs its join link (?t=). ${hint}` });
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join link needed · Droid Office</title></head><body style="font:16px/1.5 system-ui,sans-serif;color:#2b2d42;background:#bfe3ff;display:grid;place-items:center;min-height:100vh;margin:0"><main style="background:#fffaf3;border:3px solid #2b2d42;border-radius:18px;padding:28px 32px;max-width:440px;margin:16px"><h1 style="margin:0 0 8px;font-size:22px">🔒 Join link needed</h1><p style="margin:0">This office only opens with its join link. ${hint}</p></main></body></html>`,
    );
  };

  return { access, ownPage, officeCard, pairingState, setCompanion, forgetDevice, refuseHttp };
}
