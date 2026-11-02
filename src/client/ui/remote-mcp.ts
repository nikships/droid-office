import { remoteMcpConfig, type RemoteMcpBot, type RemoteMcpState } from '../../shared/remote-mcp';
import { withToken } from '../token';
import { copyButton } from './clipboard';
import { h, timeAgo, toast } from './dom';
import { disclosure, toggle } from './kit';
import { confirmDialog } from './prompt';

// Settings → Phone & web → Tailscale MCP: external bots on the owner's own Tailscale devices join as
// workers. The office serves and unserves the endpoint itself; this row switches it and hands out each
// bot's connection.

type Answer = RemoteMcpState | string;

async function call(method: 'GET' | 'PUT' | 'POST', body?: unknown): Promise<Answer> {
  try {
    const res = await fetch(withToken('/api/remote-mcp'), {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (!res.ok) return typeof data.error === 'string' ? data.error : 'The office couldn’t do that.';
    return data as RemoteMcpState;
  } catch {
    return 'Could not reach the office.';
  }
}

const STATUS: Record<RemoteMcpState['status'], string> = { off: 'Off', starting: 'Starting…', serving: 'On your tailnet', unavailable: 'Waiting for Tailscale' };

/** One line for the row's description: whether it's on, where, and how many bots. */
export function remoteMcpSummary(s: RemoteMcpState): string {
  if (s.locked) return s.locked;
  if (!s.on) return 'Off. No bot can connect.';
  const bots = s.bots.length ? `${s.bots.length} bot${s.bots.length === 1 ? '' : 's'}` : 'no bots yet';
  return `${STATUS[s.status]} · ${bots}`;
}

export function remoteMcpSettings(): { control: HTMLElement; meta: HTMLElement; panel: HTMLElement } {
  const sw = toggle({ label: 'Tailscale MCP', bare: true, disabled: true, onChange: (on) => void act('PUT', { on }) });
  const meta = h('span.setting-meta', {}, 'Checking Tailscale…');
  const panel = h('div.stack.tight.rmcp');
  let busy = false;

  const paint = (s: Answer) => {
    busy = false;
    if (typeof s === 'string') {
      meta.textContent = s;
      sw.input.disabled = true;
      return;
    }
    sw.input.checked = s.on;
    sw.input.disabled = !!s.locked;
    meta.textContent = remoteMcpSummary(s);
    panel.replaceChildren(...(s.on && !s.locked ? view(s) : []));
  };

  async function act(method: 'PUT' | 'POST', body: unknown, done?: (s: RemoteMcpState) => void) {
    if (busy) return;
    busy = true;
    sw.input.disabled = true;
    const s = await call(method, body);
    if (typeof s === 'string') toast(s, 'error');
    else done?.(s);
    paint(typeof s === 'string' ? await call('GET') : s);
  }

  function view(s: RemoteMcpState): Node[] {
    const out: Node[] = [];
    if (s.reason) {
      out.push(h('p.note', { class: s.status === 'serving' ? 'warn' : 'info' }, s.reason, s.fixUrl ? h('span', {}, ' ', h('a', { href: s.fixUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open Tailscale')) : null));
    }
    if (s.url) {
      const url = s.url;
      const input = h('input.input', { type: 'text', readonly: true, value: url, 'aria-label': 'MCP server URL', title: url });
      out.push(
        h(
          'div.input-group',
          {},
          input,
          copyButton('Copy URL', () => url),
        ),
      );
      out.push(h('p.note.info', {}, 'Only your own Tailscale devices reach this address, never the internet. Each bot also sends its own key, so you can remove one without touching the others.'));
    }
    out.push(...s.bots.map((b) => botRow(b)));
    out.push(addForm(s));
    return out;
  }

  function botRow(b: RemoteMcpBot): Node {
    const where = [b.floorName ?? b.floor, b.status ? `${b.status}${b.activity ? `: ${b.activity}` : ''}` : undefined, `added ${timeAgo(b.createdAt)}`].filter(Boolean).join(' · ');
    const rotate = h('button.btn.sm.ghost', { type: 'button', title: 'Give this bot a new key. The old one stops working at once.' }, 'New key');
    rotate.addEventListener('click', () => confirmDialog(`New key for ${b.name}?`, 'Its old key stops working at once. Give the bot the new connection afterwards.', 'New key', () => void act('POST', { action: 'rotate', id: b.id })));
    const remove = h('button.btn.sm.danger', { type: 'button' }, 'Remove');
    remove.addEventListener('click', () =>
      confirmDialog(`Remove ${b.name}?`, 'Its key stops working and its desk is freed. Any subagents it hired stay and work on their own.', 'Remove', () => void act('POST', { action: 'revoke', id: b.id })),
    );
    const connection = b.connection;
    const details = disclosure(
      b.name,
      h('small.setting-meta', {}, where),
      connection
        ? h(
            'div.stack.tight',
            {},
            h('pre.rmcp-config', { 'aria-label': `MCP connection for ${b.name}` }, remoteMcpConfig(connection)),
            h(
              'div.row.wrap',
              {},
              copyButton('Copy config', () => remoteMcpConfig(connection), 'sm'),
              copyButton('Copy key', () => connection.headers.Authorization.replace(/^Bearer /, ''), 'sm ghost'),
              rotate,
              remove,
            ),
          )
        : h('div.stack.tight', {}, h('p.note', {}, 'Its connection shows here once the office is on your tailnet.'), h('div.row.wrap', {}, rotate, remove)),
    );
    details.meta.textContent = b.status ?? '';
    return details;
  }

  function addForm(s: RemoteMcpState): Node {
    const name = h('input.input', { type: 'text', maxlength: 60, placeholder: 'Bot name, like Grok', 'aria-label': 'Bot name' });
    const floor = h('select.select', { 'aria-label': 'Floor its desk is on' }, ...s.floors.map((f) => h('option', { value: f.id }, f.name)));
    const add = h('button.btn.primary', { type: 'button', disabled: !s.floors.length }, 'Add bot');
    const submit = () => {
      const n = name.value.trim();
      if (!n) return name.focus();
      void act('POST', { action: 'add', name: n, floor: floor.value }, () => toast(`${n} has a desk. Open it below and copy its config into the bot’s MCP client.`));
    };
    add.addEventListener('click', submit);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    return h('div.input-group', {}, name, floor, add);
  }

  void call('GET').then(paint);
  return { control: sw, meta, panel };
}
