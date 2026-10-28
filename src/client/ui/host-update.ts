import type { HostUpdateCommand, HostUpdateState } from '../../shared/host-update';
import { isHostUpdateState } from '../../shared/host-update-state';
import { officeFetch } from '../office-http';
import { h, openModal } from './dom';
import { windowHeader } from './kit';
import { confirmDialog } from './prompt';

/** Closing this view never cancels an update on the host. Mutations are never retried. */
export function openHostUpdate() {
  let closed = false;
  let pending = false;
  let state: HostUpdateState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const status = h('div.stack.tight', { role: 'status', 'aria-live': 'polite' }, h('p', {}, 'Reading host update status…'));
  const check = h('button.btn', { type: 'button', disabled: true, onclick: () => void request({ action: 'check' }) }, 'Check for updates');
  const install = h('button.btn.accent.hidden', { type: 'button' }, 'Install and restart');
  const el = h('div.modal', {}, windowHeader('Host desktop app', 'Update the Mac app that runs this office, not this browser.'), h('div.body.stack', {}, status), h('footer', {}, check, install));
  openModal(el, {
    onClose: () => {
      closed = true;
      clearTimeout(timer);
      abort.abort();
    },
  });

  function controls() {
    check.disabled = pending || state?.supported === false || state?.busy === true;
    install.classList.toggle('hidden', !state?.canInstall);
    install.disabled = pending || !state?.supported || state.busy;
  }

  install.onclick = () => {
    const version = state?.version;
    if (!version || !state?.canInstall || pending) return;
    confirmDialog('Update host desktop app?', `Install Droid Office ${version} on the host Mac and restart it? Workers keep running. This client disconnects briefly and reconnects when the office returns.`, 'Install and restart', () => {
      if (!closed) void request({ action: 'install', version });
    });
  };

  async function request(command: HostUpdateCommand = { action: 'status' }) {
    if (closed || pending) return;
    // Keep the confirmed action from racing a poll while its confirmation dialog is open.
    if (command.action === 'status' && document.querySelector('.modal.confirm')) {
      schedule();
      return;
    }
    clearTimeout(timer);
    pending = true;
    controls();
    try {
      const res = await officeFetch('/api/host/update', {
        method: command.action === 'status' ? 'GET' : 'POST',
        ...(command.action === 'status' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }),
        cache: 'no-store',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
      });
      if (res.status === 404) throw new Error('This office is too old for remote host updates. Update it on the Mac first.');
      const result: unknown = await res.json().catch(() => undefined);
      if (!res.ok) throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `The office answered ${res.status}`);
      if (!isHostUpdateState(result)) throw new Error('The host sent an unreadable update status. Try again.');
      if (closed) return;
      state = result;
      const s = state;
      status.replaceChildren(h('b', {}, s.title), ...(s.currentVersion ? [h('p', {}, `Host version ${s.currentVersion}`)] : []), ...(s.detail ? [h('p', {}, s.detail)] : []));
      if (s.busy) status.append(typeof s.progress === 'number' ? h('progress', { max: 1, value: s.progress, 'aria-label': 'Host update progress' }) : h('span.spinner', { 'aria-label': 'Host update in progress' }));
    } catch (err) {
      if (closed) return;
      const restarting = state?.phase === 'restarting' || state?.phase === 'preparing';
      state = undefined;
      status.replaceChildren(h('p.note.warn', {}, restarting ? 'Waiting for the host to restart. This view reconnects automatically.' : String((err as Error).message || 'Could not reach the host. Reconnecting…')));
    } finally {
      pending = false;
      if (!closed) {
        controls();
        schedule();
      }
    }
  }
  function schedule() {
    timer = setTimeout(() => {
      if (document.hidden) schedule();
      else void request();
    }, 2000);
  }
  void request();
}
