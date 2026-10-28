import type { ComponentType, ReactElement } from 'react';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import type { HostActionResult, HostBootstrap, HostHttpRequest, HostHttpResponse, HostImage, HostIncoming, HostLink, HostMessageMeta, HostOffices, ManagementEvent, ManagementParams, MobileHost } from './host';

/**
 * The Android side of {@link MobileHost}: `DroidOfficeHost` in android/app/src/main/java/ai/factory/droidoffice/rn/.
 * Everything crosses as JSON text, so this file and the Kotlin module agree on strings only, and a value
 * that does not parse is dropped rather than half-applied. The module owns the socket, TokenVault,
 * CleartextGuard and route racing; nothing it returns carries a token, an office address or a file path.
 */
export interface NativeOfficeHost {
  /** JSON {@link HostBootstrap}, read on the native main thread so `seq` matches the replay exactly. */
  bootstrap(): Promise<string>;
  /** Synchronous: true when the frame went out on the open, welcomed socket. */
  send(json: string): boolean;
  /** JSON {@link HostActionResult}. Native adds `requestId`; nothing is ever resent. */
  request(json: string): Promise<string>;
  /** Synchronous: a hold token for `release`, 0 when the id is refused. */
  hold(workerId: string): number;
  release(token: number): void;
  /** JSON {@link HostHttpResponse}; rejects with the policy's reason when the route is not allowed. */
  http(json: string): Promise<string>;
  /** JSON {@link HostImage}[]. */
  pickImages(floor: string, max: number): Promise<string>;
  forgetImage(floor: string, id: string): void;
  layoutLoad(office: string): Promise<string | null>;
  layoutSave(office: string, json: string): void;
  openPairing(): void;
  openOffices(): void;
  openSettings(): void;
  selectOffice(officeId: string): void;
  haptic(kind: string): void;
  /** Synchronous: JSON string[] of the worker's screen rows, or null. */
  screen(workerId: string): string | null;
}

/** The one event the module emits (`DroidOfficeHost`), its payload a JSON {@link NativeEvent}. */
export const NATIVE_EVENT = 'DroidOfficeHost';

export type NativeEvent = { k: 'message'; seq: number; epoch: number; msg: ServerMsg } | { k: 'link'; link: HostLink } | { k: 'offices'; offices: HostOffices } | { k: 'incoming'; incoming: HostIncoming } | { k: 'screen'; workerId: string };

export interface NativeEvents {
  addListener(name: string, listener: (payload: string) => void): { remove(): void };
}

/** The props the native views take: `params` as JSON text, `onEvent` as a direct event carrying JSON text. */
export interface NativeTerminalProps {
  workerId: string;
  active: boolean;
  fit?: string;
  style?: unknown;
}

export interface NativeManagementProps {
  tool: string;
  floor: string;
  params?: string;
  onToolEvent?: (e: { nativeEvent: { data: string } }) => void;
  style?: unknown;
}

export interface NativeDeps {
  module: NativeOfficeHost;
  events: NativeEvents;
  /** The codegen host components (src/mobile/specs/), injected so this file loads in Node tests. */
  views: { Terminal: ComponentType<any>; Management: ComponentType<any> };
  /** `React.createElement`. */
  createElement(type: ComponentType<any>, props: Record<string, unknown>): ReactElement;
}

function parse<T>(text: string | null | undefined): T | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Builds the {@link MobileHost} the RN app gets, over the native module. */
export function createHost(deps: NativeDeps): MobileHost {
  const { module } = deps;
  type Handlers = { message: Set<(m: ServerMsg, meta: HostMessageMeta) => void>; link: Set<(l: HostLink) => void>; offices: Set<(o: HostOffices) => void>; incoming: Set<(i: HostIncoming) => void>; screen: Set<(id: string) => void> };
  const handlers: Handlers = { message: new Set(), link: new Set(), offices: new Set(), incoming: new Set(), screen: new Set() };
  let subscribed = false;
  const listening = () => {
    // One native listener for the life of the app, added before the first bootstrap can be asked for.
    if (subscribed) return;
    subscribed = true;
    deps.events.addListener(NATIVE_EVENT, (payload) => {
      const e = parse<NativeEvent>(payload);
      if (!e || typeof e !== 'object') return;
      switch (e.k) {
        case 'message':
          if (e.msg && typeof e.msg === 'object') for (const h of [...handlers.message]) h(e.msg, { seq: e.seq, epoch: e.epoch });
          return;
        case 'link':
          for (const h of [...handlers.link]) h(e.link);
          return;
        case 'offices':
          for (const h of [...handlers.offices]) h(e.offices);
          return;
        case 'incoming':
          for (const h of [...handlers.incoming]) h(e.incoming);
          return;
        case 'screen':
          for (const h of [...handlers.screen]) h(e.workerId);
          return;
      }
    });
  };
  const on = <K extends keyof Handlers>(kind: K, handler: Handlers[K] extends Set<infer H> ? H : never) => {
    listening();
    (handlers[kind] as Set<typeof handler>).add(handler);
    return () => void (handlers[kind] as Set<typeof handler>).delete(handler);
  };

  const { Terminal: NativeTerminal, Management: NativeManagement } = deps.views;
  const Terminal = (props: { workerId: string; active: boolean; fit?: 'phone' | 'desktop'; style?: unknown }) =>
    deps.createElement(NativeTerminal, { workerId: props.workerId, active: props.active, fit: props.fit ?? 'phone', style: props.style });
  const Management = (props: { tool: string; floor: string; params?: ManagementParams; onEvent?: (event: ManagementEvent) => void; style?: unknown }) =>
    deps.createElement(NativeManagement, {
      tool: props.tool,
      floor: props.floor,
      params: JSON.stringify(props.params ?? {}),
      style: props.style,
      onToolEvent: (e: { nativeEvent: { data: string } }) => {
        const event = parse<ManagementEvent>(e?.nativeEvent?.data);
        if (event && typeof event === 'object' && typeof event.kind === 'string') props.onEvent?.(event);
      },
    });

  return {
    async bootstrap() {
      listening();
      const b = parse<HostBootstrap>(await module.bootstrap());
      if (!b) throw new Error('The app could not read the office state.');
      return b;
    },
    onMessage: (h) => on('message', h),
    onLink: (h) => on('link', h),
    onOffices: (h) => on('offices', h),
    onIncoming: (h) => on('incoming', h),
    onScreen: (h) => on('screen', h),
    send(msg: ClientMsg) {
      return module.send(JSON.stringify(msg)) === true;
    },
    async request(msg: ClientMsg): Promise<HostActionResult> {
      try {
        return parse<HostActionResult>(await module.request(JSON.stringify(msg))) ?? { ok: false, error: 'The app could not read the office’s answer. Check its current state before trying again; it was not replayed.' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    holdWorker(workerId: string) {
      const token = module.hold(workerId);
      let held = token > 0;
      return () => {
        if (!held) return;
        held = false;
        module.release(token);
      };
    },
    async http(request: HostHttpRequest): Promise<HostHttpResponse> {
      const r = parse<HostHttpResponse>(await module.http(JSON.stringify(request)));
      if (!r) throw new Error('The app could not read the office’s answer.');
      return r;
    },
    async pickImages(floor: string, max: number): Promise<HostImage[]> {
      return parse<HostImage[]>(await module.pickImages(floor, max)) ?? [];
    },
    forgetImage: (floor, id) => module.forgetImage(floor, id),
    layout: {
      async load(office: string) {
        return parse<unknown>(await module.layoutLoad(office));
      },
      save(office: string, value: unknown) {
        module.layoutSave(office, JSON.stringify(value ?? null));
      },
    },
    openPairing: () => module.openPairing(),
    openOffices: () => module.openOffices(),
    openSettings: () => module.openSettings(),
    selectOffice: (id) => module.selectOffice(id),
    haptic: (kind) => module.haptic(kind),
    screen(workerId: string) {
      const rows = parse<string[]>(module.screen(workerId));
      return Array.isArray(rows) ? rows : undefined;
    },
    views: { Terminal, Management },
  };
}
