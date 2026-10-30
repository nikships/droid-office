import type { Net } from '../net';
import { store } from '../state';
import { forkRefusal } from '../../shared/worker-fork';
import { h, openModal, toast } from './dom';
import { field, windowHeader } from './kit';

/** The source keeps running; only the optional new direction is sent to the twin. */
export function openForkWorker(net: Net, workerId: string) {
  const source = store.workers.get(workerId);
  if (!source) return;
  const plain = store.currentFloor()?.plain;
  const prompt = h('textarea.input', { rows: 4, maxlength: 20000, placeholder: 'Try a different approach…', 'aria-label': 'New direction (optional)' });
  const error = h('p.field-error.hidden', { role: 'status' });
  const cancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const submit = h('button.btn.accent', { type: 'button' }, 'Fork worker');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': `Fork ${source.name}` },
    windowHeader(`Fork ${source.name}`, plain ? 'Same conversation. Shared folder.' : 'Same conversation. A separate worktree.'),
    h(
      'div.body.stack',
      {},
      h(
        'p',
        {},
        plain
          ? 'The twin gets a separate copy of this worker’s conversation in the same folder. No worktree is created. Both workers share files, so their edits affect each other.'
          : 'The twin gets this worker’s current commit, staged and unstaged edits, and untracked files. The original stays untouched.',
      ),
      h('p.note.info', {}, `The twin counts toward your worker limit and takes the nearest free desk.${plain ? '' : ' Ignored local files follow this floor’s normal worktree setup.'}`),
      field('New direction (optional)', prompt, 'Leave blank to open the fork without starting a turn.'),
      error,
    ),
    h('footer', {}, h('span.grow'), cancel, submit),
  );
  let pending = false;
  const paint = () => {
    const w = store.workers.get(workerId);
    const why = !net.up ? 'Disconnected. Nothing can be sent.' : w ? forkRefusal(w) : 'The source worker has left';
    submit.disabled = pending || !!why;
    submit.title = why ?? 'Create an independent twin';
    if (!pending) {
      error.textContent = why ?? '';
      error.classList.toggle('hidden', !why);
    }
  };
  const offWorkers = store.on('workers', paint);
  const offStatus = net.onStatus(paint);
  const modal = openModal(el, {
    onClose: () => {
      offWorkers();
      offStatus();
    },
  });
  cancel.onclick = () => modal.close();
  submit.onclick = async () => {
    if (pending || submit.disabled) return;
    pending = true;
    submit.textContent = 'Forking…';
    paint();
    const result = await net.request({ t: 'worker.fork', workerId, prompt: prompt.value.trim() || undefined });
    pending = false;
    submit.textContent = 'Fork worker';
    if (result.ok) {
      modal.close();
      toast('Fork created at the nearest free seat', 'info');
    } else {
      paint();
      error.textContent = result.error ?? 'The fork could not be confirmed. Check the floor before trying again.';
      error.classList.remove('hidden');
    }
  };
  paint();
  prompt.focus();
}
