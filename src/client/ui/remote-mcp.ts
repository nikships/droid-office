import { remoteMcpConfig, type RemoteMcpBot, type RemoteMcpKey, type RemoteMcpState } from '../../shared/remote-mcp';
import { withToken } from '../token';
import { copyButton } from './clipboard';
import { h, timeAgo, toast } from './dom';
import { disclosure, field, toggle } from './kit';
import { confirmDialog } from './prompt';

// Settings → Phone & web → Tailscale MCP: external bots on the owner's own Tailscale devices join the
// building as agents at Mission Control, with no desk (docs/mission-control.md). The office serves and
// unserves the endpoint itself; this row switches it and hands out each bot's connection.

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

function lastUsed(at: number | undefined, what?: string): string | undefined {
  return at ? `${what ? `${what} ` : ''}used ${timeAgo(at)}` : undefined;
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
  const openBots = new Set<string>();
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
    const where = ['Mission Control', b.grokBot ? 'Grok Bot webhook' : undefined, b.status ? `${b.status}${b.activity ? `: ${b.activity}` : ''}` : undefined, `added ${timeAgo(b.createdAt)}`, lastUsed(b.lastUsedAt, 'main key')]
      .filter(Boolean)
      .join(' · ');
    const rotate = h('button.btn.sm.ghost', { type: 'button', title: 'Give this bot a new key. The old one stops working at once.' }, 'New key');
    rotate.addEventListener('click', () =>
      confirmDialog(`New key for ${b.name}?`, 'Its old main key stops working at once; its named keys keep working. Give the bot the new connection afterwards.', 'New key', () => void act('POST', { action: 'rotate', id: b.id })),
    );
    const remove = h('button.btn.sm.danger', { type: 'button' }, 'Remove');
    remove.addEventListener('click', () => confirmDialog(`Remove ${b.name}?`, 'Its keys stop working. Any subagents it hired stay on their floors and work on their own.', 'Remove', () => void act('POST', { action: 'revoke', id: b.id })));
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
            keys(b),
            h('hr.divider'),
            grokSection(b),
          )
        : h('div.stack.tight', {}, h('p.note', {}, 'Its connection shows here once the office is on your tailnet.'), h('div.row.wrap', {}, rotate, remove), keys(b), h('hr.divider'), grokSection(b)),
    );
    details.open = openBots.has(b.id);
    details.addEventListener('toggle', () => {
      if (details.open) openBots.add(b.id);
      else openBots.delete(b.id);
    });
    details.meta.textContent = [b.grokBot ? 'Grok Bot' : undefined, b.status].filter(Boolean).join(' · ');
    return details;
  }

  /** Per-bot Grok Bot push webhook configuration: wakes this one bot when its subagents report, ask or block. */
  function grokSection(b: RemoteMcpBot): Node {
    const saved = b.grokBot;
    const urlInput = h('input.input', {
      type: 'url',
      value: saved?.webhookUrl ?? '',
      placeholder: 'https://api2.cursor.sh/automations/webhook/…',
      'aria-label': `Grok Bot webhook URL for ${b.name}`,
    });
    const tokenInput = h('input.input', {
      type: 'password',
      autocomplete: 'new-password',
      placeholder: saved?.hasToken ? 'Saved — leave blank to keep current token' : 'crsr_…',
      'aria-label': `Grok Bot bearer token for ${b.name}`,
    });
    const saveBtn = h('button.btn.sm', { type: 'button' }, saved ? 'Save webhook' : 'Enable Grok Bot');
    const testBtn = saved ? h('button.btn.sm.ghost', { type: 'button', title: 'POST one clearly marked test event to wake and verify this webhook.' }, 'Send test') : null;
    const form = h(
      'div.stack.tight',
      {},
      field('Webhook URL', urlInput, 'HTTPS JSON endpoint woken for this bot and its named keys.'),
      field('Bearer token', tokenInput, saved?.hasToken ? 'Stored only on this Mac. Leave blank to keep the saved token.' : 'Sent in Authorization: Bearer. Stored only on this Mac and never shown again.'),
      h('div.row.wrap', {}, saveBtn, testBtn),
    );
    form.hidden = !saved;

    const swGrok = toggle({
      label: 'Grok Bot',
      description: 'Push subagent reports, questions, blockers and messages directly to this bot’s webhook instead of waiting for polling.',
      checked: !!saved,
      onChange: (on) => {
        if (on) {
          form.hidden = false;
          if (!urlInput.value) urlInput.focus();
          return;
        }
        if (!saved) {
          form.hidden = true;
          return;
        }
        swGrok.input.checked = true;
        confirmDialog(`Turn off Grok Bot push for ${b.name}?`, 'Its saved webhook URL and bearer token will be removed, and it will go back to polling its inbox.', 'Turn off', () => {
          openBots.add(b.id);
          void act('POST', { action: 'set-grok-bot', id: b.id, grokBot: null }, () => toast(`${b.name} is back to inbox polling.`));
        });
      },
    });

    const save = () => {
      const webhookUrl = urlInput.value.trim();
      const webhookToken = tokenInput.value.trim();
      if (!webhookUrl) return urlInput.focus();
      if (!saved?.hasToken && !webhookToken) return tokenInput.focus();
      openBots.add(b.id);
      void act('POST', { action: 'set-grok-bot', id: b.id, grokBot: { webhookUrl, ...(webhookToken ? { webhookToken } : {}) } }, () => toast(`${b.name}’s Grok Bot webhook is saved.`));
    };
    saveBtn.addEventListener('click', save);
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    tokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    testBtn?.addEventListener('click', () => {
      openBots.add(b.id);
      void act('POST', { action: 'test-webhook', id: b.id }, () => toast(`Sent a test event to ${b.name}’s webhook.`));
    });

    const last = saved?.lastDelivery;
    const delivery = last
      ? h(
          'p.note',
          { class: last.ok ? 'good' : 'bad' },
          last.ok ? `Last push succeeded ${timeAgo(last.at)} (${last.event}${last.status ? `, HTTP ${last.status}` : ''}).` : `Last push failed ${timeAgo(last.at)} (${last.event}): ${last.error ?? 'delivery failed'}.`,
        )
      : null;

    return h('div.stack.tight', {}, swGrok, delivery, form);
  }

  /** Extra keys for one bot, one per client it runs on, so a lost laptop's key goes without the bot's other clients. */
  function keys(b: RemoteMcpBot): Node {
    // An office that hasn't restarted since a source hot reload sends bots without named keys.
    const rows = (b.keys ?? []).map((k) => keyRow(b, k));
    const name = h('input.input', { type: 'text', maxlength: 60, placeholder: 'Key name, like laptop or relay', 'aria-label': `New key name for ${b.name}` });
    const add = h('button.btn.sm', { type: 'button' }, 'Add key');
    const submit = () => {
      const n = name.value.trim();
      if (!n) return name.focus();
      openBots.add(b.id);
      void act('POST', { action: 'add-key', id: b.id, name: n }, (s) => {
        const key = s.bots.find((x) => x.id === b.id)?.keys?.find((k) => k.name === n);
        toast(key?.connection ? `${b.name} has a new key, ${n}. Copy its config below.` : `${b.name} has a new key, ${n}. Its config shows here once the office is on your tailnet.`);
      });
    };
    add.addEventListener('click', submit);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    return h(
      'div.stack.tight',
      {},
      h('small.setting-meta', {}, 'Named keys act as this bot. Give each client its own, and revoke one without touching the others.'),
      rows.length ? h('ul.list.boxed', { 'aria-label': `Named keys for ${b.name}` }, ...rows) : null,
      h('div.input-group', {}, name, add),
    );
  }

  function keyRow(b: RemoteMcpBot, k: RemoteMcpKey): Node {
    const revoke = h('button.btn.sm.danger', { type: 'button' }, 'Revoke');
    revoke.addEventListener('click', () =>
      confirmDialog(`Revoke ${k.name}?`, `The client using this key loses access at once. ${b.name}'s other keys keep working.`, 'Revoke', () => {
        openBots.add(b.id);
        void act('POST', { action: 'revoke-key', id: b.id, key: k.id });
      }),
    );
    const connection = k.connection;
    const meta = [`added ${timeAgo(k.createdAt)}`, lastUsed(k.lastUsedAt) ?? 'never used'].join(' · ');
    return h(
      'li.list-row',
      {},
      h('div.list-main', {}, h('div.list-title', { title: k.name }, k.name), h('div.list-meta', { title: k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleString()}` : 'Not used yet' }, meta)),
      h(
        'div.list-end',
        {},
        connection ? copyButton('Copy config', () => remoteMcpConfig(connection), 'sm ghost') : null,
        connection ? copyButton('Copy key', () => connection.headers.Authorization.replace(/^Bearer /, ''), 'sm ghost') : null,
        revoke,
      ),
    );
  }

  function addForm(s: RemoteMcpState): Node {
    const name = h('input.input', { type: 'text', maxlength: 60, placeholder: 'Bot name, like Grok', 'aria-label': 'Bot name' });
    const add = h('button.btn.primary', { type: 'button' }, 'Add bot');
    const urlInput = h('input.input', { type: 'url', placeholder: 'https://api2.cursor.sh/automations/webhook/…', 'aria-label': 'Grok Bot webhook URL' });
    const tokenInput = h('input.input', { type: 'password', autocomplete: 'new-password', placeholder: 'crsr_…', 'aria-label': 'Grok Bot bearer token' });
    const grokFields = h('div.stack.tight', {}, field('Webhook URL', urlInput, 'HTTPS JSON endpoint woken for this bot.'), field('Bearer token', tokenInput, 'Sent in Authorization: Bearer. Stored only on this Mac and never shown again.'));
    grokFields.hidden = true;
    const grokToggle = toggle({
      label: 'Grok Bot',
      description: 'Attach a push webhook now so subagents wake this bot directly instead of waiting for polling.',
      onChange: (on) => {
        grokFields.hidden = !on;
        if (on && name.value.trim()) urlInput.focus();
      },
    });
    const submit = () => {
      const n = name.value.trim();
      if (!n) return name.focus();
      let grokBot: { webhookUrl: string; webhookToken: string } | undefined;
      if (grokToggle.input.checked) {
        const webhookUrl = urlInput.value.trim();
        const webhookToken = tokenInput.value.trim();
        if (!webhookUrl) return urlInput.focus();
        if (!webhookToken) return tokenInput.focus();
        grokBot = { webhookUrl, webhookToken };
      }
      void act('POST', { action: 'add', name: n, ...(grokBot ? { grokBot } : {}) }, (next) => {
        const bot = next.bots.find((b) => b.name === n && !s.bots.some((old) => old.id === b.id));
        if (bot) openBots.add(bot.id);
        toast(bot?.connection ? `${n} joined Mission Control. Copy its config below into the bot’s MCP client.` : `${n} joined Mission Control. Its config shows here once the office is on your tailnet.`);
      });
    };
    add.addEventListener('click', submit);
    for (const el of [name, urlInput, tokenInput]) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
    }
    return h('div.stack.tight', {}, h('div.input-group', {}, name, add), grokToggle, grokFields);
  }

  void call('GET').then(paint);
  return { control: sw, meta, panel };
}
