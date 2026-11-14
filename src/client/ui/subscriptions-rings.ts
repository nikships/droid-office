import { durationWords, providerName, type SubscriptionAccount, type SubscriptionProvider, type SubscriptionsState, type UsageWindow } from '../../shared/subscriptions';
import { h } from './dom';
import { providerLogo } from './model-logo';
import { subscriptionsOrder } from './subscriptions-order';
import { percentLeft, usageTone } from './welcome-steps';
import { factoryLimitsActive, factoryWindows, type FactoryLimitsState } from '../../shared/factory-limits';
import { FACTORY_TIERS, factoryLimitsSummary, factoryReset } from './factory-limits-view';

/** At most this many windows are drawn as nested arcs in one ring; the tooltip lists every one. */
const RING_LAYERS = 3;

const RESET_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Formats a reset time ("Nov 4, 2026, 4:31 AM"); tests pass one with a fixed locale and zone. */
export type DateWords = (ms: number) => string;

/** The plans in use (switched on, with accounts), switched off, and switched on with nobody signed in. */
export function ringGroups(providers: readonly SubscriptionProvider[]): { active: SubscriptionProvider[]; off: SubscriptionProvider[]; unconnected: SubscriptionProvider[] } {
  const ordered = subscriptionsOrder(providers);
  return {
    active: ordered.filter((p) => p.enabled && p.accounts.length > 0),
    off: ordered.filter((p) => !p.enabled),
    unconnected: ordered.filter((p) => p.enabled && p.accounts.length === 0),
  };
}

/** DroidProxy in one line: its version and Droid's models while it runs, else what it's doing. */
export function proxyLine(s: SubscriptionsState): string {
  const p = s.proxy;
  const v = p.version ? ` ${p.version}` : '';
  switch (p.phase) {
    case 'unsupported':
      return 'Needs a Mac with Apple silicon';
    case 'missing':
      return 'DroidProxy isn’t installed';
    case 'installing':
      return 'Installing DroidProxy…';
    case 'stopped':
      return `DroidProxy${v} is stopped · starts when a worker needs it`;
    case 'starting':
      return 'Starting DroidProxy…';
    case 'outdated':
      return `DroidProxy${v} needs an update`;
    case 'running': {
      const m = s.models;
      if (!m) return `DroidProxy${v}`;
      const count = m.installed === m.available ? `${m.installed}` : `${m.installed} of ${m.available}`;
      return `DroidProxy${v} · ${count} models in Droid${m.stale ? ' · update them on the Mac' : ''}`;
    }
  }
}

/** "Weekly: 29% left". */
export function windowLine(w: UsageWindow): string {
  return `${w.name}: ${percentLeft(w)}% left`;
}

/** "Resets in 5 h (Nov 4, 2026, 4:31 AM)"; null when the provider doesn't say or the time has passed. */
export function resetLine(w: UsageWindow, now: number, date: DateWords = (ms) => RESET_DATE.format(ms)): string | null {
  return w.resetsAt !== null && w.resetsAt > now ? `Resets in ${durationWords(w.resetsAt - now)} (${date(w.resetsAt)})` : null;
}

/** Why an account isn't used, if it isn't. */
export function accountState(a: SubscriptionAccount): string | null {
  if (a.expired) return 'Sign-in expired';
  return a.disabled ? 'Off in DroidProxy' : null;
}

/** What stands in for an account's windows when there are none. */
function usageMissing(a: SubscriptionAccount): string | null {
  if (a.windows.length) return null;
  return a.usageError ? `Usage unavailable: ${a.usageError}` : 'No usage reported';
}

/** A ring's accessible name: "Claude, owner@example.com: 5-hour 90% left, Weekly 29% left". */
export function ringLabel(p: SubscriptionProvider, a: SubscriptionAccount): string {
  const parts = a.windows.map((w) => `${w.name} ${percentLeft(w)}% left`);
  const state = accountState(a);
  if (state) parts.unshift(state);
  if (!a.windows.length) parts.push(a.usageError ? 'usage unavailable' : 'no usage reported');
  return `${providerName(p.key)}, ${a.label}: ${parts.join(', ')}`;
}

export interface QuotaRing {
  /** `provider/account`, to find the same account's ring again after a repaint. */
  key: string;
  ring: HTMLButtonElement;
  tip: HTMLElement;
}

let tipIds = 0;

/** An account's ring (one arc per usage window, the provider's logo inside) and its tooltip. */
export function quotaRing(p: SubscriptionProvider, a: SubscriptionAccount, now: number, date?: DateWords): QuotaRing & { tile: HTMLElement } {
  const key = `${p.key}/${a.id}`;
  return accountRing(key, ringLabel(p, a), a, providerLogo(p.key), now, date);
}

function accountRing(key: string, label: string, a: SubscriptionAccount, logo: HTMLElement | null, now: number, date?: DateWords, detail?: string): QuotaRing & { tile: HTMLElement } {
  const id = `subs-tip-${++tipIds}`;
  const arcs = a.windows.slice(0, RING_LAYERS).map((w, i) => {
    const arc = h('span.subs-arc', { class: `layer-${i} ${usageTone(w)}`, 'aria-hidden': 'true' });
    arc.style.setProperty('--left', String(percentLeft(w)));
    return arc;
  });
  const ring = h(
    'button.subs-ring',
    { type: 'button', class: accountState(a) || !a.windows.length ? 'muted' : '', 'aria-label': label, 'aria-describedby': id, 'data-account': key },
    ...(arcs.length ? arcs : [h('span.subs-arc.empty', { 'aria-hidden': 'true' })]),
    logo,
  );
  const state = accountState(a);
  const missing = usageMissing(a);
  const tip = h(
    'div.subs-tip',
    { id, role: 'tooltip', popover: 'manual' },
    h('b', {}, a.label),
    state ? h('span.subs-tip-state', {}, state) : null,
    ...a.windows.map((w) => {
      const reset = resetLine(w, now, date);
      const resetText = reset ?? (detail ? factoryReset(w, now) : null);
      return h('span.subs-tip-window', {}, h('span', {}, windowLine(w)), resetText ? h('small', {}, resetText) : null);
    }),
    missing ? h('small', {}, missing) : null,
    detail ? h('small', {}, detail) : null,
  );
  const tile = h('li.subs-tile', {}, ring, h('span.subs-tile-label', { title: a.label }, a.label), tip);
  return { key, ring, tip, tile };
}

export function factoryQuotaRings(s: FactoryLimitsState, now: number, date?: DateWords): (QuotaRing & { tile: HTMLElement })[] {
  if (!factoryLimitsActive(s)) return [];
  return FACTORY_TIERS.filter(({ key }) => !!s.limits[key]).map(({ key, label }) => {
    const windows = factoryWindows(s, key);
    const detail = factoryLimitsSummary(s);
    return accountRing(
      `factory/${key}`,
      `Factory ${label}: ${windows.map(windowLine).join(', ')}. ${detail}`,
      { id: key, label, expired: false, disabled: false, windows },
      h('img.ai-logo', { src: '/factory-glyph.svg', alt: '', 'aria-hidden': 'true' }),
      now,
      date,
      detail,
    );
  });
}

/** Small non-interactive rings inside the dashboard's Subscriptions button. */
export function factoryHeaderRings(s: FactoryLimitsState, now: number): HTMLElement | null {
  if (!factoryLimitsActive(s)) return null;
  return h(
    'span.factory-header-rings',
    {},
    ...FACTORY_TIERS.filter(({ key }) => !!s.limits[key]).map(({ key, label }) => {
      const windows = factoryWindows(s, key);
      const title = `Factory ${label}: ${windows.map((w) => `${windowLine(w)}, ${factoryReset(w, now)}`).join('; ')}. ${factoryLimitsSummary(s)}`;
      return h(
        'span.factory-header-quota',
        { title, role: 'img', 'aria-label': title },
        h(
          'span.factory-mini-ring',
          {},
          ...windows.map((w, i) => {
            const arc = h('span.subs-arc', { class: `layer-${i} ${usageTone(w)}`, 'aria-hidden': 'true' });
            arc.style.setProperty('--left', String(percentLeft(w)));
            return arc;
          }),
        ),
        h('span', { 'aria-hidden': 'true' }, key === 'core' ? 'Core' : label),
      );
    }),
  );
}

/** A muted line of providers ("Off" or "Not connected") with their logos; null when there are none. */
function providerLine(label: string, providers: SubscriptionProvider[]): HTMLElement | null {
  if (!providers.length) return null;
  return h('p.subs-off', {}, h('span.subs-off-label', {}, label), ...providers.map((p) => h('span.subs-off-chip', {}, providerLogo(p.key), providerName(p.key))));
}

/** The Subscriptions window's body: a ring per account grouped by provider, then the plans that are off. */
export function subscriptionsView(s: SubscriptionsState, now: number, date?: DateWords, factory?: FactoryLimitsState): { nodes: HTMLElement[]; rings: QuotaRing[] } {
  const { active, off, unconnected } = ringGroups(s.providers);
  const rings: QuotaRing[] = [];
  const groups = active.map((p) => {
    const tiles = p.accounts.map((a) => {
      const r = quotaRing(p, a, now, date);
      rings.push(r);
      return r.tile;
    });
    return h('li.subs-group', {}, h('span.subs-group-name', {}, providerName(p.key)), h('ul.subs-tiles', { 'aria-label': `${providerName(p.key)} accounts` }, ...tiles));
  });
  const factoryRings = factory ? factoryQuotaRings(factory, now, date) : [];
  if (factory && factoryRings.length) {
    rings.unshift(...factoryRings);
    groups.unshift(h('li.subs-group', {}, h('span.subs-group-name', {}, 'Factory'), h('ul.subs-tiles', { 'aria-label': 'Factory quotas' }, ...factoryRings.map((r) => r.tile)), h('small', {}, factoryLimitsSummary(factory))));
  }
  const nodes: (HTMLElement | null)[] = [
    s.proxy.error ? h('p.note.bad', {}, s.proxy.error) : null,
    groups.length ? h('ul.subs-groups', {}, ...groups) : null,
    !groups.length && s.proxy.phase !== 'unsupported' ? h('p.subs-empty', {}, 'No plans in use. Connect one on the office’s Mac.') : null,
    providerLine('Off', off),
    providerLine('Not connected', unconnected),
  ];
  return { nodes: nodes.filter((n): n is HTMLElement => n !== null), rings };
}

/** Puts a tooltip under its ring, or above it when there's no room below, inside the window's edges. */
function place(ring: HTMLElement, tip: HTMLElement) {
  const gap = 8;
  const r = ring.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const top = r.bottom + gap + t.height <= innerHeight - gap ? r.bottom + gap : Math.max(gap, r.top - gap - t.height);
  const left = Math.min(Math.max(gap, r.left + r.width / 2 - t.width / 2), Math.max(gap, innerWidth - gap - t.width));
  tip.style.setProperty('--tip-x', `${Math.round(left)}px`);
  tip.style.setProperty('--tip-y', `${Math.round(top)}px`);
}

/**
 * The rings' tooltips, one open at a time: hovering with a mouse or focusing a ring shows its
 * tooltip, and clicking or tapping pins it until the next click, a click outside, blur or Esc.
 */
export class RingTips {
  private open: QuotaRing | null = null;
  private pinned = false;

  /**
   * Wires a fresh set of rings. After a repaint, `keep` (what was open before it) opens again and
   * `focused` (the account whose ring had focus) gets focus back, so a keyboard user stays put.
   */
  attach(rings: QuotaRing[], keep = this.current, focused?: string) {
    this.hide(true);
    this.open = null;
    this.pinned = false;
    for (const r of rings) {
      r.ring.addEventListener('pointerenter', (e) => {
        if ((e as PointerEvent).pointerType === 'mouse') this.show(r);
      });
      r.ring.addEventListener('pointerleave', (e) => {
        if ((e as PointerEvent).pointerType === 'mouse') this.hide();
      });
      r.ring.addEventListener('focus', () => this.show(r));
      r.ring.addEventListener('blur', () => this.hide(true));
      r.ring.addEventListener('click', () => {
        if (this.open === r && this.pinned) this.hide(true);
        else this.show(r, true);
      });
    }
    const again = keep ? rings.find((r) => r.key === keep.key) : undefined;
    if (again) this.show(again, keep?.pinned);
    if (focused) rings.find((r) => r.key === focused)?.ring.focus({ preventScroll: true });
  }

  show(r: QuotaRing, pin = false) {
    if (this.open && this.open !== r) this.hide(true);
    if (this.open !== r) {
      r.tip.showPopover();
      place(r.ring, r.tip);
      r.ring.classList.add('on');
      this.open = r;
    }
    this.pinned = this.pinned || pin;
  }

  /** Hides the open tooltip; a pinned one only when `force`. */
  hide(force = false) {
    const r = this.open;
    if (!r || (this.pinned && !force)) return;
    r.tip.hidePopover();
    r.ring.classList.remove('on');
    this.open = null;
    this.pinned = false;
  }

  /** For Esc and clicks outside: hides an open tooltip, and says whether there was one. */
  dismiss(): boolean {
    if (!this.open) return false;
    this.hide(true);
    return true;
  }

  get current(): { key: string; pinned: boolean } | null {
    return this.open ? { key: this.open.key, pinned: this.pinned } : null;
  }
}
