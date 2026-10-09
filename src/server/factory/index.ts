import type { FactoryState } from '../../shared/factory.js';
import { isFactoryFeature } from '../../shared/factory.js';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.js';
import { CiFeature } from './ci.js';
import { mountCloud, type CloudOptions } from './cloud.js';
import { ComputersFeature } from './computers.js';
import { FactoryOffice } from './office.js';
import { FactoryRegistry } from './registry.js';
import { SessionsFeature, type OfficeSessionRef } from './sessions.js';
import { WikiFeature, type WikiOptions } from './wiki.js';

export { sendDownload } from './feature.js';

export type FactoryMsg = Extract<ClientMsg, { t: `factory.${string}` }>;

export interface MountOptions {
  dataDir: string;
  broadcast(state: FactoryState): void;
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
  fetchImpl?: typeof fetch;
  base?: string;
  /** The floors' cloud droids (cloud.ts), when the office has floors to seat them on. */
  cloud?: Omit<CloudOptions, 'computers'>;
  /** The office's own droids with a Droid session, on every floor, for their credits. */
  officeSessions?: () => OfficeSessionRef[];
  /** The floors and the Droid command AutoWiki's /wiki runs need (wiki.ts). */
  wiki?: Pick<WikiOptions, 'floors' | 'runner'>;
}

/**
 * The office's Factory connection and every Factory feature, as server.ts uses them: `state` for
 * `welcome`, `message` for the factory.* messages, `registry.http` for /api/factory/…, `drop` when a
 * connection closes. A new feature registers here.
 */
export function mountFactory(opts: MountOptions) {
  const office = new FactoryOffice(opts.dataDir, { fetchImpl: opts.fetchImpl, base: opts.base });
  const registry = new FactoryRegistry({ link: office, broadcast: opts.broadcast, toast: opts.toast });
  office.onChange = () => registry.connectionChanged();
  registry.register((host) => new ComputersFeature(host));
  registry.register((host) => new SessionsFeature(host, { dataDir: opts.dataDir, officeSessions: opts.officeSessions }));
  registry.register((host) => new CiFeature(host));
  const wiki = registry.register((host) => new WikiFeature(host, { ...opts.wiki, key: () => office.key(), fetchImpl: opts.fetchImpl, base: opts.base })) as WikiFeature;
  const cloud = opts.cloud && mountCloud(registry, opts.cloud);
  registry.start();
  // A saved key is checked again at every start: it may have been deleted, or its plan changed.
  void office.check();

  /** Handles a factory.* message from connection `client` (named `who`); `reply` answers only them. */
  const message = (client: string, who: string, msg: FactoryMsg, reply: (msg: ServerMsg) => void) => {
    switch (msg.t) {
      case 'factory.connect': {
        const was = office.connection().fingerprint;
        void office.connect(typeof msg.key === 'string' ? msg.key.slice(0, 600) : '', who).then((error) => {
          reply({ t: 'factory.setup', ok: !error, ...(error ? { error } : {}) });
          if (error) return;
          const conn = office.connection();
          if (was && was !== conn.fingerprint) registry.keyReplaced();
          console.log(`  ${who} connected the office to Factory (${conn.account?.email ?? conn.fingerprint})`);
          opts.toast(`🏭 ${who} connected the office to Factory`);
        });
        break;
      }
      case 'factory.disconnect':
        if (!office.connection().connected) break;
        office.disconnect();
        console.log(`  ${who} disconnected the office from Factory`);
        opts.toast(`${who} disconnected the office from Factory`);
        break;
      case 'factory.refresh':
        if (msg.feature === undefined) {
          void office.check();
          registry.refresh();
        } else if (isFactoryFeature(msg.feature)) registry.refresh(msg.feature);
        break;
      case 'factory.watch':
        if (isFactoryFeature(msg.feature)) registry.watch(client, msg.feature, msg.on === true);
        break;
    }
  };

  return {
    office,
    registry,
    cloud,
    state: () => registry.state(),
    message,
    drop: (client: string) => registry.drop(client),
    stop: () => {
      wiki.stop();
      registry.stop();
    },
  };
}
