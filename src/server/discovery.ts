import { isIP, type AddressInfo } from 'node:net';
import os from 'node:os';
import { Bonjour, type Service, type ServiceConfig } from 'bonjour-service';
import type { Config } from './config.js';

type AdvertisedService = Pick<Service, 'records' | 'on' | 'stop'>;
interface DiscoveryTransport {
  publish(options: ServiceConfig): AdvertisedService;
  destroy(): void;
}
interface DiscoveryDependencies {
  create?: (onError: (error: unknown) => void) => DiscoveryTransport;
  hostname?: () => string;
  interfaces?: () => Record<string, readonly { address: string; internal: boolean }[] | undefined>;
  warn?: (message: string) => void;
}

const VIRTUAL_INTERFACE = /^(?:utun|tun|tap|wg|tailscale|docker|br-|veth|vmnet|vboxnet|virbr|bridge|vEthernet|VMware|VirtualBox|ZeroTier|WireGuard|Teredo|isatap|lo\d*$)|\bvpn\b/i;

/** Canonicalize IPv6 (including mapped loopback addresses) before comparing interface addresses. */
function normalizeAddress(address: string): string {
  const host = address.split('%')[0];
  if (isIP(host) !== 6) return host;
  const canonical = new URL(`http://[${host}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const hi = Number.parseInt(mapped[1], 16);
  const lo = Number.parseInt(mapped[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** CLI-owned, best-effort DNS-SD advertisement; ordinary startServer() callers open no multicast socket. */
export function startDiscovery(cfg: Pick<Config, 'discovery' | 'tls'>, address: AddressInfo | string | null, deps: DiscoveryDependencies = {}): { stop(): void } {
  if (!cfg.discovery || !address || typeof address === 'string') return { stop() {} };
  const bound = normalizeAddress(address.address);
  if (bound === '::1' || (isIP(bound) === 4 && bound.startsWith('127.'))) return { stop() {} };

  let transport: DiscoveryTransport | undefined;
  let service: AdvertisedService | undefined;
  let stopping = false;
  let destroyed = false;
  let deadline: NodeJS.Timeout | undefined;
  const destroy = () => {
    if (!transport || destroyed) return;
    destroyed = true;
    clearTimeout(deadline);
    try {
      transport.destroy();
    } catch {
      // A failed multicast socket must never prevent the office from starting or stopping.
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (!service) return destroy();
    // Give the library time to send its goodbye, with a bound before the CLI's 300ms exit deadline.
    deadline = setTimeout(destroy, 150);
    deadline.unref();
    try {
      service.stop(destroy);
    } catch {
      destroy();
    }
  };
  const onError = (error: unknown) => {
    if (stopping) return;
    (deps.warn ?? console.warn)(`droid-office: nearby discovery unavailable (${error instanceof Error ? error.message : String(error)}); connect with the office URL`);
    stop();
  };

  try {
    const wildcard = bound === '0.0.0.0' || bound === '::';
    // A headset on Wi-Fi cannot reach a laptop's VPN/container addresses. Explicit binds still
    // advertise just their requested address; wildcard binds use the laptop's LAN adapters.
    const lan = new Set(
      Object.entries((deps.interfaces ?? os.networkInterfaces)()).flatMap(([name, addresses]) => (VIRTUAL_INTERFACE.test(name) ? [] : (addresses ?? []).filter((item) => !item.internal).map((item) => normalizeAddress(item.address)))),
    );
    if (wildcard && !lan.size) return { stop };
    transport = (deps.create ?? ((error) => new Bonjour({}, error)))(onError);
    if (stopping) destroy();
    else {
      // Keep the DNS instance label below 63 bytes, and advertise no project names or filesystem paths.
      const laptop =
        (deps.hostname ?? os.hostname)()
          .split('.')[0]
          .replace(/[^a-z\d-]/gi, '-')
          .slice(0, 39)
          .replace(/^-+|-+$/g, '') || 'laptop';
      service = transport.publish({
        name: `Droid Office on ${laptop} (${address.port})`,
        type: 'droidoffice',
        protocol: 'tcp',
        port: address.port,
        host: `${laptop.toLowerCase()}-office-${address.port}.local`,
        txt: { v: '1', scheme: cfg.tls ? 'https' : 'http' },
        disableIPv6: isIP(bound) === 4,
      });
      // Bonjour generates addresses for every interface. Probing defers its first announcement,
      // letting us restrict those library-generated records to addresses this server actually serves.
      const records = service.records.bind(service);
      service.records = () =>
        records()
          .filter((record) => {
            if (record.type !== 'A' && record.type !== 'AAAA') return true;
            if (record.type === 'AAAA' && isIP(bound) === 4) return false;
            const ip = normalizeAddress(record.data);
            return wildcard ? lan.has(ip) : ip === bound;
          })
          .sort((a, b) => Number(a.type === 'AAAA') - Number(b.type === 'AAAA'));
      service.on('error', onError);
    }
  } catch (error) {
    onError(error);
  }
  return { stop };
}
