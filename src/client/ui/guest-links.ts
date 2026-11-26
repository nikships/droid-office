import {
  GUEST_AUDIT_PAGE_MAX,
  GUEST_EXPIRY_CHOICES,
  GUEST_LABEL_MAX,
  GUEST_PRESETS,
  GUEST_PRESET_INFO,
  guestScope,
  type GuestAuditEntry,
  type GuestAuditPage,
  type GuestExpiry,
  type GuestLinkCreated,
  type GuestLinkItem,
  type GuestPreset,
} from '../../shared/guest-links';
import type { ServerMsg } from '../../shared/protocol';
import { withToken } from '../token';
import { copy } from './clipboard';
import { h, openModal, timeAgo, toast } from './dom';
import { icon } from './icons';
import { choices, emptyState, field, toggle, windowHeader } from './kit';
import { confirmDialog } from './prompt';
import {
  LIMITED_TEXT,
  limitedPage,
  switchEnabled,
  appendAudit,
  auditActionText,
  auditTargetText,
  checkDraft,
  createBlocked,
  expiryView,
  guestCountText,
  linkEnded,
  refreshAudit,
  scopeText,
  tickDelay,
  transportView,
  type ShareDraft,
  type ShareState,
} from './guest-links-model';

// The 🔗 Share window: the external-sharing switch, new share links, the links with their live guests,
// and what guests changed. Any owner page may read it; `GuestLinksState.manage` says how much it may
// change. `full` (the office's own page on its own machine) does everything; `limited` (the owner's
// other pages) may revoke links and turn sharing off, but not create links or turn sharing on, so the
// window hides those there. The secret link lives in this window's DOM only while it shows it: never
// in storage or logs.

const AUDIT_PAGE = 25;

/** What the window hears from the office: `guestLinks.changed` pushes, and a fresh welcome after a reconnect. */
export interface ShareFeed {
  onMessage(fn: (msg: ServerMsg) => void): () => void;
}

/** One line about sharing for Settings, or why it can't say. */
export function shareSummary(state: ShareState | string): string {
  if (typeof state === 'string') return state;
  const active = state.links.filter((l) => !linkEnded(l)).length;
  const transport = transportView(state.on, state.transport);
  return `${state.on ? transport.pill : 'Off'} · ${active ? `${active} active link${active === 1 ? '' : 's'}` : 'no active links'} · ${guestCountText(state.guests).toLowerCase()}`;
}

/** The sharing state for Settings' row. */
export async function shareState(): Promise<ShareState | string> {
  try {
    const res = await fetch(withToken('/api/guest-links'), { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error || 'Could not read the share links.';
    return (await res.json()) as ShareState;
  } catch {
    return 'Could not reach the office.';
  }
}

type Fail = { ok: false; status: number; error: string };
type Reply<T> = { ok: true; data: T } | Fail;

async function call<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Reply<T>> {
  try {
    const res = await fetch(withToken(path), {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: data?.error || `Request failed (${res.status})` };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the office.' };
  }
}

/** Opens the Share window. `onChange` hears the state whenever it's read again. */
export function openShare(feed: ShareFeed, onChange?: (state: ShareState | string) => void) {
  // ---- The switch ------------------------------------------------------------------------------
  const sw = toggle({
    label: 'External sharing',
    bare: true,
    disabled: true,
    onChange: (on) => {
      if (on) return void setOn(true);
      sw.input.checked = true;
      const guests = last?.guests ?? 0;
      confirmDialog(
        'Turn off external sharing?',
        `${guests ? `${guestCountText(guests)} now. Every one` : 'Every connected guest'} is disconnected at once, and no share link opens until you turn sharing back on. Links that haven’t expired or been revoked work again then.`,
        'Turn off',
        () => void setOn(false),
      );
    },
  });
  const pill = h('span.pill');
  const heroText = h('small');
  const heroExtra = h('div.share-origin');
  const hero = h('section.share-hero', {}, h('span.share-hero-icon', {}, icon('globe', 24)), h('div.share-hero-text', {}, h('div.share-hero-title', {}, h('b', {}, 'External sharing'), pill), heroText, heroExtra), sw);
  const status = h('p.note.hidden', { role: 'status', 'aria-live': 'polite' });

  // ---- Create ----------------------------------------------------------------------------------
  const labelInput = h('input.input', { type: 'text', maxlength: GUEST_LABEL_MAX, placeholder: 'Alex - PR review', autocomplete: 'off', spellcheck: 'false' });
  const labelError = h('p.field-error.hidden', { role: 'alert' });
  const labelField = field('Label', labelInput, 'Who it’s for or why. It names the link here and in guest activity.');
  labelField.append(labelError);
  const presetPicker = choices(
    'share-preset',
    GUEST_PRESETS.map((p) => ({ value: p, title: GUEST_PRESET_INFO[p].label, description: GUEST_PRESET_INFO[p].description, icon: GUEST_PRESET_INFO[p].write ? '✏️' : '👁' })),
    'view-office',
    () => paintTargets(),
    { rows: true },
  );
  const presetField = h('div.field', {}, h('div.share-field-label', { id: 'share-preset-label' }, 'Permission'), presetPicker);
  presetPicker.setAttribute('aria-labelledby', 'share-preset-label');
  const floorSelect = h('select.select', { 'aria-label': 'Floor' }) as HTMLSelectElement;
  const workerSelect = h('select.select', { 'aria-label': 'Worker' }) as HTMLSelectElement;
  const floorError = h('p.field-error.hidden', { role: 'alert' });
  const floorField = field('Floor', floorSelect);
  floorField.append(floorError);
  const workerError = h('p.field-error.hidden', { role: 'alert' });
  const workerField = field('Worker', workerSelect);
  workerField.append(workerError);
  const targetRow = h('div.share-targets', {}, floorField, workerField);
  const expirySelect = h('select.select', {}, ...GUEST_EXPIRY_CHOICES.map((c) => h('option', { value: c.id }, c.label))) as HTMLSelectElement;
  const expiryField = field('Expires', expirySelect);
  const blocked = h('p.note.warn.hidden', { role: 'status' });
  const createError = h('p.note.bad.hidden', { role: 'alert' });
  const createBtn = h('button.btn.accent', { type: 'submit' }, icon('link', 14), 'Create share link') as HTMLButtonElement;
  const form = h('form.share-form.stack', { 'aria-label': 'Create a share link', novalidate: true }, blocked, labelField, presetField, targetRow, expiryField, createError, h('div.row.share-form-actions', {}, createBtn));

  // ---- The secret link, shown once -------------------------------------------------------------
  const created = h('section.share-created.hidden', { 'aria-label': 'New share link', tabindex: '-1' });
  const limitedNote = h('p.note.info.hidden', {}, LIMITED_TEXT);

  // ---- Links -----------------------------------------------------------------------------------
  const linksCount = h('span.share-count');
  const linksList = h('ul.list.boxed.share-links', { 'aria-label': 'Share links' });

  // ---- Audit -----------------------------------------------------------------------------------
  const auditList = h('ol.list.boxed.share-audit', { 'aria-label': 'Guest activity, newest first' });
  const auditMore = h('button.btn.sm.hidden', { type: 'button' }, 'Show older') as HTMLButtonElement;
  const auditNote = h('p.note.bad.hidden', { role: 'status' });

  const sections = h(
    'div.stack.loose.share-sections',
    {},
    h('section.section', {}, h('div.eyebrow', {}, h('span.no', {}, '01'), 'Create a share link'), limitedNote, created, form),
    h('section.section', {}, h('div.eyebrow', {}, h('span.no', {}, '02'), 'Share links', linksCount), linksList),
    h('section.section', {}, h('div.eyebrow', {}, h('span.no', {}, '03'), 'Guest activity'), auditNote, auditList, h('div.row.share-more', {}, auditMore)),
  );
  const body = h('div.body', {}, h('div.stack.loose', {}, hero, status, sections));
  const footer = h('footer', {}, h('span.grow', {}, 'Guests never reach Settings, pairing or sharing. Revoking a link or turning sharing off disconnects its guests at once.'));
  const el = h('div.modal.lg.share', { role: 'dialog', 'aria-label': 'Share' }, windowHeader('🔗 Share', 'Secret links that open the web companion for people outside your tailnet'), body, footer);

  let last: ShareState | undefined;
  let floorPicked = false;
  let disposed = false;
  let stopped = false;
  let busy = false;
  let tick: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let audit: GuestAuditEntry[] = [];
  let auditNext: string | undefined;
  let auditLoaded = false;
  const expiryCells = new Map<string, { cell: HTMLElement; link: GuestLinkItem }>();

  const fail = (text: string, final = false) => {
    stopped ||= final;
    status.textContent = text;
    status.className = 'note bad';
    if (final) {
      sections.classList.add('hidden');
      hero.classList.add('hidden');
      clearTimeout(tick);
      clearTimeout(poll);
    }
  };
  /** Only a lost session ends the window; anything else (a 403 included) shows the office's own words. */
  const finalFail = (r: Fail): boolean => {
    if (r.status === 401) {
      fail('The office restarted: reopen it from the join link in its terminal.', true);
      return true;
    }
    return false;
  };

  const preset = () => (presetPicker.value() || 'view-office') as GuestPreset;

  const paintTargets = () => {
    const targets = last?.targets ?? [];
    const scope = guestScope(preset());
    const keepFloor = floorSelect.value;
    floorSelect.replaceChildren(...(targets.length ? targets.map((f) => h('option', { value: f.id, title: f.name }, f.name)) : [h('option', { value: '' }, 'No open floors')]));
    if (targets.some((f) => f.id === keepFloor)) floorSelect.value = keepFloor;
    // One worker needs a floor that has some: until the owner picks a floor, start on the first that does.
    if (scope === 'worker' && !floorPicked && !targets.find((f) => f.id === floorSelect.value)?.workers.length) {
      const staffed = targets.find((f) => f.workers.length);
      if (staffed) floorSelect.value = staffed.id;
    }
    floorSelect.disabled = !targets.length;
    const floor = targets.find((f) => f.id === floorSelect.value);
    const keepWorker = workerSelect.value;
    const workers = floor?.workers ?? [];
    workerSelect.replaceChildren(...(workers.length ? workers.map((w) => h('option', { value: w.id, title: w.name }, w.name)) : [h('option', { value: '' }, floor ? `No workers on ${floor.name}` : 'No workers')]));
    if (workers.some((w) => w.id === keepWorker)) workerSelect.value = keepWorker;
    workerSelect.disabled = !workers.length;
    // Kit layouts set display, which beats the hidden attribute, so hide with the class.
    floorField.classList.toggle('hidden', scope === 'office');
    workerField.classList.toggle('hidden', scope !== 'worker');
    targetRow.classList.toggle('hidden', scope === 'office');
  };
  floorSelect.addEventListener('change', () => {
    floorPicked = true;
    paintTargets();
  });

  const clearErrors = () => {
    for (const e of [labelError, floorError, workerError, createError]) {
      e.textContent = '';
      e.classList.add('hidden');
    }
    labelInput.removeAttribute('aria-invalid');
  };
  const showError = (e: HTMLElement, text: string) => {
    e.textContent = text;
    e.classList.remove('hidden');
  };

  const paintCreate = (state: ShareState) => {
    // A limited page gets one plain line instead of a form it could never submit.
    const limited = limitedPage(state);
    limitedNote.classList.toggle('hidden', !limited);
    if (limited) hideCreated();
    form.classList.toggle('hidden', limited || !created.classList.contains('hidden'));
    const why = createBlocked(state);
    blocked.textContent = why ?? '';
    blocked.classList.toggle('hidden', !why);
    createBtn.disabled = busy || !!why;
    form.classList.toggle('off', !!why);
    paintTargets();
  };

  const paintHero = (state: ShareState) => {
    const view = transportView(state.on, state.transport);
    sw.input.checked = state.on;
    sw.input.disabled = busy || !switchEnabled(state);
    sw.title = switchEnabled(state) ? '' : (state.transport.locked ?? (limitedPage(state) ? LIMITED_TEXT : ''));
    pill.className = `pill share-pill ${view.tone}`;
    pill.textContent = view.pill;
    heroText.textContent = view.text;
    const extra: Node[] = [];
    if (view.origin) extra.push(h('code', { title: view.origin }, view.origin));
    if (view.fixUrl) extra.push(h('a', { href: view.fixUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Fix this in Tailscale', icon('external', 12)));
    heroExtra.replaceChildren(...extra);
    heroExtra.classList.toggle('hidden', !extra.length);
    hero.classList.toggle('off', !state.on);
  };

  const revoke = async (link: GuestLinkItem, b: HTMLButtonElement) => {
    b.disabled = true;
    const r = await call<ShareState>('DELETE', `/api/guest-links/${encodeURIComponent(link.id)}`);
    if (disposed) return;
    if (!r.ok) {
      b.disabled = false;
      if (!finalFail(r)) toast(r.status === 404 ? 'That link is already gone.' : `Could not revoke: ${r.error}`, 'error');
      if (r.status === 404) void load();
      return;
    }
    toast(`🔗 Revoked “${link.label}”${link.guests ? '. Its guests were disconnected.' : ''}`, 'info');
    paint(r.data);
  };

  const paintLinks = (state: ShareState) => {
    const now = Date.now();
    const active = state.links.filter((l) => !linkEnded(l, now)).length;
    linksCount.textContent = state.links.length ? `${active} active · ${guestCountText(state.guests).toLowerCase()}` : '';
    expiryCells.clear();
    if (!state.links.length) {
      linksList.replaceChildren(
        h(
          'li.share-empty',
          {},
          emptyState('🔗', 'No share links yet', limitedPage(state) ? 'Links created on the office’s own computer show up here.' : 'Create one above. Each link opens the web companion with only the access you choose.'),
        ),
      );
      return;
    }
    // Active links first, newest first; ended ones under them.
    const sorted = [...state.links].sort((a, b) => Number(linkEnded(a, now)) - Number(linkEnded(b, now)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    linksList.replaceChildren(
      ...sorted.map((l) => {
        const exp = expiryView(l, now);
        const cell = h('span.share-expiry', { class: exp.tone }, exp.text);
        expiryCells.set(l.id, { cell, link: l });
        const scope = scopeText(l);
        const guests = h('span.share-guests', { class: l.guests ? 'live' : '' }, guestCountText(exp.ended ? 0 : l.guests));
        const b = exp.ended ? null : (h('button.btn.sm.danger', { type: 'button', 'aria-label': `Revoke ${l.label}`, title: 'Turn this link off for good. Its guests disconnect at once.' }, 'Revoke') as HTMLButtonElement);
        b?.addEventListener('click', () => void revoke(l, b));
        return h(
          'li.list-row.share-link',
          { class: exp.ended ? 'ended' : '' },
          h('span.list-icon.share-link-icon', { 'aria-hidden': 'true' }, GUEST_PRESET_INFO[l.preset].write ? '✏️' : '👁'),
          h(
            'div.list-main',
            {},
            h('div.list-title', { title: l.label }, l.label),
            h('div.list-meta.share-scope', { title: scope }, scope),
            h(
              'div.list-meta.share-state',
              { title: `Created ${new Date(l.createdAt).toLocaleString()}${l.expiresAt ? ` · expires ${new Date(l.expiresAt).toLocaleString()}` : ''}` },
              cell,
              h('span', { 'aria-hidden': 'true' }, ' · '),
              guests,
            ),
          ),
          h('div.list-end', {}, b),
        );
      }),
    );
  };

  const scheduleTick = () => {
    clearTimeout(tick);
    if (disposed || stopped || !last) return;
    const delay = tickDelay(last.links);
    if (delay === undefined) return;
    tick = setTimeout(() => {
      const now = Date.now();
      let ended = false;
      for (const { cell, link } of expiryCells.values()) {
        const exp = expiryView(link, now);
        cell.textContent = exp.text;
        cell.className = `share-expiry ${exp.tone}`;
        ended ||= exp.ended && link.status === 'active';
      }
      // A link just ran out on this clock: drop its Revoke and let the cap and counts follow.
      if (ended && last) paint(last);
      else scheduleTick();
    }, delay);
  };

  const paint = (state: ShareState) => {
    last = state;
    paintHero(state);
    paintCreate(state);
    paintLinks(state);
    scheduleTick();
    clearTimeout(poll);
    // The transport says when it's done publishing, but poll too in case that push is missed.
    if (state.on && state.transport.status === 'starting') poll = setTimeout(() => void load(), 2000);
    onChange?.(state);
  };

  const load = async () => {
    if (disposed || stopped) return;
    const r = await call<ShareState>('GET', '/api/guest-links');
    if (disposed) return;
    if (!r.ok) {
      if (!finalFail(r)) {
        fail(r.error);
        clearTimeout(poll);
        poll = setTimeout(() => void load(), 3000);
      }
      return;
    }
    status.className = 'note hidden';
    status.textContent = '';
    paint(r.data);
  };

  const setOn = async (on: boolean) => {
    busy = true;
    sw.input.disabled = true;
    const r = await call<ShareState>('PUT', '/api/guest-links', { on });
    busy = false;
    if (disposed) return;
    if (!r.ok) {
      if (!finalFail(r)) fail(r.error);
      if (last) paint(last);
      // A refusal can mean this page's rights changed: read them again.
      void load();
      return;
    }
    toast(on ? '🔗 External sharing on' : '🔗 External sharing off: every guest was disconnected', 'info');
    paint(r.data);
  };

  // ---- Audit -----------------------------------------------------------------------------------
  const paintAudit = () => {
    auditMore.classList.toggle('hidden', !auditNext);
    if (!audit.length) {
      auditList.replaceChildren(h('li.share-empty', {}, emptyState('🗒', auditLoaded ? 'No guest activity yet' : 'Loading guest activity…', auditLoaded ? 'Every change a guest makes shows up here, with the link it came from.' : undefined)));
      return;
    }
    auditList.replaceChildren(
      ...audit.map((e) => {
        const when = new Date(e.at);
        const until = e.until ? ` to ${new Date(e.until).toLocaleTimeString()}` : '';
        return h(
          'li.list-row.share-entry',
          {},
          h(
            'div.list-main',
            {},
            h('div.list-title.share-entry-title', {}, h('b', {}, auditActionText(e)), h('span.share-entry-target', {}, auditTargetText(e.target))),
            e.detail ? h('div.list-meta.share-entry-detail', { title: e.detail }, e.detail) : null,
            h('div.list-meta', {}, h('span.share-entry-link', { title: e.linkLabel }, e.linkLabel), ' · ', h('time', { datetime: e.at, title: `${when.toLocaleString()}${until}` }, `${timeAgo(e.at)} · ${when.toLocaleString()}`)),
          ),
        );
      }),
    );
  };

  const loadAudit = async (mode: 'refresh' | 'older') => {
    if (disposed || stopped) return;
    if (mode === 'older' && !auditNext) return;
    auditMore.disabled = true;
    const q = new URLSearchParams({ limit: String(Math.min(AUDIT_PAGE, GUEST_AUDIT_PAGE_MAX)) });
    if (mode === 'older' && auditNext) q.set('before', auditNext);
    const r = await call<GuestAuditPage>('GET', `/api/guest-links/audit?${q}`);
    auditMore.disabled = false;
    if (disposed) return;
    if (!r.ok) {
      if (!finalFail(r)) {
        auditNote.textContent = `Could not read guest activity: ${r.error}`;
        auditNote.classList.remove('hidden');
      }
      return;
    }
    auditNote.classList.add('hidden');
    auditLoaded = true;
    if (mode === 'older') {
      audit = appendAudit(audit, r.data.entries);
      auditNext = r.data.next;
    } else {
      const { entries, reset } = refreshAudit(audit, r.data.entries);
      audit = entries;
      if (reset) auditNext = r.data.next;
    }
    paintAudit();
  };
  auditMore.addEventListener('click', () => void loadAudit('older'));

  // ---- Create ----------------------------------------------------------------------------------
  const hideCreated = () => {
    created.replaceChildren();
    created.classList.add('hidden');
    form.classList.remove('hidden');
  };

  const showCreated = (res: GuestLinkCreated) => {
    const url = h('input.input.share-url', { type: 'text', readonly: true, 'aria-label': 'Share link', spellcheck: 'false' }) as HTMLInputElement;
    url.value = res.url;
    url.addEventListener('focus', () => url.select());
    const copyLabel = h('span', {}, 'Copy link');
    const copyBtn = h('button.btn.primary', { type: 'button' }, icon('copy', 14), copyLabel);
    copyBtn.addEventListener('click', async () => {
      const ok = await copy(url.value);
      copyLabel.textContent = ok ? 'Copied' : 'Copy failed';
      copyBtn.classList.toggle('done', ok);
      if (!ok) url.select();
      setTimeout(() => {
        copyLabel.textContent = 'Copy link';
        copyBtn.classList.remove('done');
      }, 1600);
    });
    const done = h('button.btn.ghost', { type: 'button' }, 'Done');
    done.addEventListener('click', () => {
      hideCreated();
      labelInput.focus();
    });
    const exp = expiryView(res.link);
    created.replaceChildren(
      h('div.share-created-title', {}, h('span.share-created-icon', { 'aria-hidden': 'true' }, icon('check', 16)), h('b', { title: res.link.label }, `“${res.link.label}” is ready`)),
      h('div.input-group.share-url-row', {}, url, copyBtn),
      h(
        'p.note.warn',
        {},
        h('b', {}, 'Copy it now: this link won’t be shown again.'),
        ` Anyone who has it gets ${scopeText(res.link)} (${exp.text.toLowerCase()}), with no sign-in. Send it only to the person it’s for, and revoke it below when they’re done.`,
      ),
      h('div.row.share-created-actions', {}, done),
    );
    created.classList.remove('hidden');
    form.classList.add('hidden');
    copyBtn.focus();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!last || busy) return;
    clearErrors();
    const why = createBlocked(last);
    if (why) return showError(createError, why);
    const draft: ShareDraft = { label: labelInput.value, preset: preset(), floorId: floorSelect.value, workerId: workerSelect.value, expiry: expirySelect.value as GuestExpiry };
    const check = checkDraft(draft, last.targets);
    if (!check.ok) {
      if (check.field === 'label') {
        showError(labelError, check.error);
        labelInput.setAttribute('aria-invalid', 'true');
        labelInput.focus();
      } else if (check.field === 'floor') {
        showError(floorError, check.error);
        floorSelect.focus();
      } else if (check.field === 'worker') {
        showError(workerError, check.error);
        workerSelect.focus();
      } else showError(createError, check.error);
      return;
    }
    busy = true;
    createBtn.disabled = true;
    const r = await call<GuestLinkCreated>('POST', '/api/guest-links', check.body);
    busy = false;
    if (disposed) return;
    if (!r.ok) {
      if (!finalFail(r)) {
        showError(createError, r.error);
        void load();
      }
      createBtn.disabled = false;
      return;
    }
    labelInput.value = '';
    paint(r.data.state);
    showCreated(r.data);
  });

  const off = feed.onMessage((msg) => {
    if (msg.t === 'guestLinks.changed') {
      void load();
      if (msg.audit) void loadAudit('refresh');
    } else if (msg.t === 'welcome') {
      // Back after a reconnect (or an office restart): whatever changed meanwhile was not pushed here.
      void load();
      void loadAudit('refresh');
    }
  });

  openModal(el, {
    doing: '🔗 managing share links',
    onClose: () => {
      disposed = true;
      off();
      clearTimeout(tick);
      clearTimeout(poll);
      // Drop the one-time link with the window.
      created.replaceChildren();
    },
  });
  paintTargets();
  paintAudit();
  void load();
  void loadAudit('refresh');
  setTimeout(() => labelInput.focus(), 30);
}
