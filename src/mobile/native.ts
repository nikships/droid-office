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
  /** Deletes only on the office the picture was uploaded to; `office`, when given, must be that one. */
  forgetImage(floor: string, id: string, office: string | null): void;
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

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const PHASES: readonly string[] = ['idle', 'connecting', 'connected', 'offline', 'unauthorized'];

function isLink(v: unknown): v is HostLink {
  return isObject(v) && typeof v.phase === 'string' && PHASES.includes(v.phase) && isSeq(v.epoch) && isSeq(v.seq) && (v.office === undefined || typeof v.office === 'string') && (v.reason === undefined || typeof v.reason === 'string');
}

function isOffices(v: unknown): v is HostOffices {
  return (
    isObject(v) &&
    Array.isArray(v.offices) &&
    v.offices.every((o) => isObject(o) && isText(o.id) && typeof o.name === 'string' && (o.where === undefined || typeof o.where === 'string')) &&
    (v.active === undefined || typeof v.active === 'string') &&
    (v.seq === undefined || isSeq(v.seq))
  );
}

function isIncoming(v: unknown): v is HostIncoming {
  if (!isObject(v) || !isText(v.office)) return false;
  if (v.kind === 'worker') return isText(v.worker) && (v.floor === undefined || isText(v.floor));
  return v.kind === 'floor' && isText(v.floor);
}

/** A ManagementEvent the page may ask for, or undefined. */
export function parseManagementEvent(text: string | null | undefined): ManagementEvent | undefined {
  const e = parse<unknown>(text);
  if (!isObject(e)) return undefined;
  switch (e.kind) {
    case 'open-worker':
      return isText(e.workerId) && (e.view === 'thread' || e.view === 'tty') ? { kind: 'open-worker', workerId: e.workerId, view: e.view } : undefined;
    case 'switch-floor':
      return isText(e.floor) ? { kind: 'switch-floor', floor: e.floor } : undefined;
    case 'close':
      return { kind: 'close' };
    default:
      return undefined;
  }
}

/** A bootstrap with every field the app relies on, or undefined. */
function parseBootstrap(text: string | null | undefined): HostBootstrap | undefined {
  const b = parse<unknown>(text);
  if (!isOffices(b)) return undefined;
  const { link, seq, replay, incoming } = b as unknown as Record<string, unknown>;
  if (!isLink(link) || !isSeq(seq) || !Array.isArray(replay)) return undefined;
  return {
    offices: b.offices,
    ...(b.active !== undefined ? { active: b.active } : {}),
    link,
    seq,
    replay: replay.filter((m): m is ServerMsg => isObject(m) && typeof m.t === 'string'),
    ...(isIncoming(incoming) ? { incoming } : {}),
  };
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
      const e = parse<Record<string, unknown>>(payload);
      if (!isObject(e)) return;
      // Each handler on its own: one that throws must not keep the rest from hearing the event.
      const each = <A extends unknown[]>(set: Set<(...args: A) => void>, ...args: A) => {
        for (const h of [...set]) {
          try {
            h(...args);
          } catch (err) {
            console.error(err);
          }
        }
      };
      switch (e.k) {
        case 'message': {
          const msg = e.msg;
          if (isSeq(e.seq) && isSeq(e.epoch) && isObject(msg) && typeof msg.t === 'string') each(handlers.message, msg as unknown as ServerMsg, { seq: e.seq, epoch: e.epoch });
          return;
        }
        case 'link':
          if (isLink(e.link)) each(handlers.link, e.link);
          return;
        case 'offices':
          if (isOffices(e.offices)) each(handlers.offices, e.offices);
          return;
        case 'incoming':
          if (isIncoming(e.incoming)) each(handlers.incoming, e.incoming);
          return;
        case 'screen':
          if (isText(e.workerId)) each(handlers.screen, e.workerId);
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
        const event = parseManagementEvent(e?.nativeEvent?.data);
        if (event) props.onEvent?.(event);
      },
    });

  return {
    async bootstrap() {
      listening();
      const b = parseBootstrap(await module.bootstrap());
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
    forgetImage: (floor, id, office) => module.forgetImage(floor, id, office ?? null),
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
