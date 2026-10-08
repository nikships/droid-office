import type { ServiceInfo, ServicesState } from '../../shared/protocol';
import { store } from '../state';
import { h, openModal, timeAgo } from './dom';
import { emptyState } from './kit';
import { copy, copyButton, guessOs, openCommand, OS_LABEL, type Os } from './clipboard';

export function serviceUrl(port: number): string {
  // The tunnel lands on the office's own port, so it speaks whatever the office speaks.
  return `${location.protocol}//localhost:${port}`;
}

/**
 * One command that tunnels localhost:<port> to the office, which relays it to the worker's
 * server, and opens it once the tunnel is up, over the owner's SSH access to its machine.
 */
export function serviceTunnel(s: ServicesState, port: number, os: Os): string {
  const open = openCommand(serviceUrl(port), os);
  return `ssh -N -o ExitOnForwardFailure=yes -o PermitLocalCommand=yes -o LocalCommand="${open}" -L ${port}:localhost:${s.port} ${s.ssh ?? 'you@your-server'}`;
}

function describe(svc: ServiceInfo): { who: string; color: string; branch?: string } {
  const w = store.workers.get(svc.workerId);
  return { who: w?.name ?? 'A worker', color: w?.color ?? 'var(--muted)', branch: w?.worktree?.branch };
}

export function openServices() {
  let os = guessOs();
  let picked: number | null = null;
  let copied: number | null = null;
  const body = h('div.body.stack');
  const close = h('button.btn.icon.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const tabs = h('div.seg.os-tabs', { role: 'radiogroup', 'aria-label': 'Your computer' });
  const footer = h('footer', {}, h('span.grow', {}, 'Tunnels go through the office: your SSH access to its machine guards every page. Keep the terminal open while you look.'));
  const el = h(
    'div.modal.lg.services',
    { role: 'dialog', 'aria-label': 'Services' },
    h('header', {}, h('div.titles', {}, h('h2', {}, 'Services'), h('p.sub', {}, 'Web servers the workers are running')), h('div.actions', {}, tabs), close),
    body,
    footer,
  );

  const pick = async (svc: ServiceInfo) => {
    picked = svc.port;
    copied = (await copy(serviceTunnel(store.services, svc.port, os))) ? svc.port : null;
    render();
  };

  const render = () => {
    const s = store.services;
    tabs.replaceChildren(
      ...(Object.keys(OS_LABEL) as Os[]).map((o) => h('button.btn.sm', { type: 'button', role: 'radio', 'aria-checked': String(o === os), class: o === os ? 'on' : '', onclick: () => ((os = o), (copied = null), render()) }, OS_LABEL[o])),
    );
    body.replaceChildren(h('p.svc-hint', {}, 'Click one to copy a command that opens it on your computer. Run it in a terminal and the page opens by itself.'));
    if (!s.items.length) {
      body.append(
        emptyState(
          '🌐',
          'Nothing running yet',
          h(
            'span',
            {},
            'When a worker starts a web server (',
            h('code', {}, 'npm run dev'),
            ', a preview build, ',
            h('code', {}, 'python -m http.server'),
            ') it shows up here within a few seconds. Try prompting: “start the dev server in the background so we can review it”.',
          ),
        ),
      );
      return;
    }
    const list = h('ul.list.boxed.svc-rows');
    for (const svc of s.items) {
      const { who, color, branch } = describe(svc);
      const dot = h('span.dot');
      dot.style.setProperty('--dot', color);
      const on = picked === svc.port;
      const open = h('a.btn.sm', { href: serviceUrl(svc.port), target: '_blank', rel: 'noopener', title: `Open ${serviceUrl(svc.port)} (needs the tunnel, unless the office runs on this computer)` }, 'Open ↗');
      open.addEventListener('click', (e) => e.stopPropagation());
      const li = h(
        'li.list-row',
        { class: on ? 'on' : '', 'aria-selected': String(on), tabindex: 0, role: 'button', title: 'Copy the tunnel command' },
        h('span.list-icon', {}, dot),
        h('div.list-main', {}, h('div.list-title', {}, svc.title || svc.command), h('div.list-meta', {}, [who, branch ? `🌿 ${branch}` : '', svc.title ? svc.command : '', `started ${timeAgo(svc.since)}`].filter(Boolean).join(' · '))),
        h('div.list-end', {}, h('span.svc-port', {}, `:${svc.port}`), open),
      );
      li.addEventListener('click', () => void pick(svc));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void pick(svc);
        }
      });
      list.append(li);
    }
    body.append(list);

    const svc = s.items.find((i) => i.port === picked);
    if (svc) {
      const cmd = serviceTunnel(s, svc.port, os);
      body.append(
        copied === svc.port
          ? h('p.note.good', {}, `Copied. Paste it in a terminal: it opens ${serviceUrl(svc.port)} once the tunnel is up.`)
          : h('p.note.info', {}, `The command for :${svc.port} — run it in a terminal, and it opens ${serviceUrl(svc.port)}.`),
        h(
          'div.cmd',
          {},
          h('pre', {}, cmd),
          copyButton('Copy', () => cmd),
        ),
      );
    } else if (picked !== null) {
      body.append(h('p.note.bad', {}, `The server on :${picked} stopped.`));
    }
    body.append(
      s.ssh
        ? h('p.svc-hint', {}, 'It tunnels as ', h('code', {}, s.ssh), ', your SSH access to the office’s machine. Or run ', h('code', {}, 'deploy/aws.sh service <port>'), ' instead.')
        : h('p.svc-hint', {}, 'Replace ', h('code', {}, 'you@your-server'), " with how you SSH to the office's machine. If the office runs on this computer, just click Open."),
    );
  };

  const unsubs = [store.on('services', render), store.on('workers', render)];
  // Keeps "up 5m" fresh.
  const tick = setInterval(render, 30_000);
  const modal = openModal(el, {
    doing: '🌐 at the services board',
    onClose: () => {
      unsubs.forEach((u) => u());
      clearInterval(tick);
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
}
