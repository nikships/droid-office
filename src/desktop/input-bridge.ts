/**
 * The one channel from the office page to the main process: the CDP binding `__droidOfficeHost` (`Runtime.addBinding`), called
 * by the injected page script (`page/shim.ts`). The page is not trusted, so main takes nothing from it but this fixed list of
 * small messages, checks each one's shape and size, and only reads them from the office's own main frame.
 */
export const BINDING_NAME = '__droidOfficeHost';
/** Longer than any message below; anything bigger is dropped unread. */
export const MAX_PAYLOAD = 512;

export type HostMessage =
  /** The page asked for pointer lock. `activation` is `navigator.userActivation.isActive` at that moment. */
  | { t: 'lock'; id: number; raw: boolean; activation: boolean }
  /** The page called `document.exitPointerLock()`. */
  | { t: 'exit' }
  /** An Esc key up reached the end of the page's handlers; `prevented` is whether one of them took it. */
  | { t: 'escUp'; prevented: boolean }
  /** An editable element took or lost focus. The rectangle is where the caret is, in CSS pixels. */
  | { t: 'editable'; on: boolean; x: number; y: number; w: number; h: number }
  /** Settings → Terminal key report started (`on`) or ended: keep this process's key steps, then hand them to the page. */
  | { t: 'keyTrace'; on: boolean };

function num(v: unknown, limit = 1e5): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit ? v : null;
}

export function parseHostMessage(payload: unknown): HostMessage | null {
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) return null;
  let m: unknown;
  try {
    m = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'lock': {
      const id = num(o.id, 2 ** 31);
      if (id === null || typeof o.raw !== 'boolean' || typeof o.activation !== 'boolean') return null;
      return { t: 'lock', id, raw: o.raw, activation: o.activation };
    }
    case 'exit':
      return { t: 'exit' };
    case 'escUp':
      return typeof o.prevented === 'boolean' ? { t: 'escUp', prevented: o.prevented } : null;
    case 'editable': {
      if (typeof o.on !== 'boolean') return null;
      const [x, y, w, h] = [num(o.x), num(o.y), num(o.w), num(o.h)];
      if (x === null || y === null || w === null || h === null) return null;
      return { t: 'editable', on: o.on, x, y, w, h };
    }
    case 'keyTrace':
      return typeof o.on === 'boolean' ? { t: 'keyTrace', on: o.on } : null;
    default:
      return null;
  }
}

/** A JavaScript execution context, as `Runtime.executionContextCreated` describes it. */
export interface ExecutionContext {
  id: number;
  origin: string;
  auxData?: { frameId?: string; isDefault?: boolean };
}

/** Whether a binding call came from the page's own scripts, in the main frame, at the office's origin. A frame, an isolated world or another origin never does. */
export function trustedContext(ctx: ExecutionContext | undefined, mainFrameId: string | undefined, officeOrigin: string | undefined): boolean {
  if (!ctx || !mainFrameId || !officeOrigin) return false;
  return ctx.auxData?.isDefault === true && ctx.auxData.frameId === mainFrameId && ctx.origin === officeOrigin;
}
