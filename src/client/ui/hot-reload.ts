import type { HotReloadState } from '../../shared/hot-reload';
import { withToken } from '../token';
import { h } from './dom';

/** Polls separately from the game connection, only while Settings is open. */
export function hotReloadSettings(): { element: HTMLElement; dispose: () => void } {
  const note = h('small.setting-desc', {}, 'For the local office started with npm run build && npm run start (normally :4600). Source changes rebuild the browser client and refresh your page; server changes still need a restart.');
  const status = h('p.note.info', { role: 'status', 'aria-live': 'polite' }, 'Checking source reload…');
  const error = h('pre.setting-error', { hidden: true });
  const toggle = h('button.btn.sm', { type: 'button', disabled: true }, 'Enable');
  const rebuild = h('button.btn.sm', { type: 'button', disabled: true }, 'Build & reload');
  const controls = h('div.row', {}, toggle, rebuild);
  const element = h('div.stack.tight', {}, note, controls, status, error);
  if (!document.querySelector<HTMLMetaElement>('meta[name="office-revision"]')?.content.trim()) {
    status.textContent = 'This is Vite development (normally :5173), which already reloads source changes. Use the built local office on :4600 for these settings.';
    controls.hidden = true;
    return { element, dispose: () => {} };
  }

  let state: HotReloadState | undefined;
  let busy = false;
  let disposed = false;
  let stopped = false;
  let failure = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const paint = () => {
    toggle.textContent = state?.enabled ? 'Disable' : 'Enable';
    toggle.disabled = busy || stopped || !state || (!state.available && !state.enabled);
    rebuild.textContent = state?.phase === 'error' ? 'Build & reload (retry)' : 'Build & reload';
    rebuild.disabled = busy || stopped || !state || !state.available || !state.enabled || state.phase === 'building';
    const messages: string[] = [];
    if (state) {
      messages.push(state.enabled ? 'Source hot reload is on.' : 'Source hot reload is off.');
      if (!state.available) messages.push(state.reason || 'Source reload is unavailable in this office.');
      if (state.phase === 'building') messages.push('Building the browser client… The page reloads after a successful build.');
      else if (state.phase === 'error') messages.push('Build failed. The last successful client stays published. Fix the source and retry.');
      else if (state.lastBuiltAt) messages.push(`Last built ${new Date(state.lastBuiltAt).toLocaleTimeString()}.`);
      if (state.restartRequired) messages.push('Server source changed. Restart the local office to apply it; client reload does not restart the server.');
    }
    if (failure) messages.push(failure);
    status.textContent = messages.join(' ') || 'Checking source reload…';
    error.textContent = state?.error || '';
    error.hidden = !state?.error;
  };
  const request = async (body?: { enabled: boolean } | { rebuild: true }) => {
    if (disposed || stopped || busy) return;
    clearTimeout(timer);
    busy = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 8000);
    paint();
    try {
      const response = await fetch(withToken('/api/hot-reload'), {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401) {
        stopped = true;
        throw new Error('The office restarted: reopen it from the join link in its terminal.');
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
      if (disposed) return;
      state = result as HotReloadState;
      failure = '';
    } catch (err) {
      if (!disposed) failure = err instanceof Error && err.name !== 'AbortError' ? err.message : 'Could not reach the local office. Retrying…';
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      busy = false;
      if (!disposed) {
        paint();
        if (!stopped) timer = setTimeout(() => void request(), 2000);
      }
    }
  };
  toggle.addEventListener('click', () => {
    if (!toggle.disabled && state) void request({ enabled: !state.enabled });
  });
  rebuild.addEventListener('click', () => {
    if (!rebuild.disabled) void request({ rebuild: true });
  });
  void request();
  return {
    element,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
