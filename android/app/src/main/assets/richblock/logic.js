// DOM-free helpers for the rich block page (render.js), checked by tests/android-richblock.test.ts.

/** Elements a drawing never keeps: anything that runs code, embeds a document or holds HTML. */
export const BAD_ELEMENTS = 'script, foreignObject, iframe, object, embed';

const SCRIPT_URL = /^\s*(?:javascript|data|vbscript):/i;

/** An attribute a drawing never keeps: event handlers, and links or references to script or data URLs. */
export function isUnsafeAttr(name, value) {
  const n = String(name).toLowerCase();
  if (n.startsWith('on')) return true;
  if (n === 'href' || n === 'xlink:href' || n === 'src' || n === 'action' || n === 'formaction') return SCRIPT_URL.test(String(value ?? ''));
  return false;
}

/** The width a drawing's `viewBox` ("minX minY width height") asks for, or 0 when it has none. */
export function naturalWidth(viewBox) {
  const w = Number(
    String(viewBox ?? '')
      .trim()
      .split(/[\s,]+/)[2],
  );
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/** The answer to the app's draw request `id`. */
export function doneMessage(id, height, svg) {
  return { type: 'done', id, ok: true, height: Math.ceil(height), svg };
}

/** Why request `id` couldn't be drawn: the first line of the error, as the web Thread shows it. */
export function failedMessage(id, error) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return { type: 'done', id, ok: false, error: text.split('\n')[0] || 'unknown error' };
}
