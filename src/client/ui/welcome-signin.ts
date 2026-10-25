import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';

/** "Waiting for you in the browser…", with a spinner: something is under way, nothing is wrong. */
export function waitLine(text: string): HTMLElement {
  return h('p.welcome-wait', {}, h('span.spinner', { 'aria-hidden': 'true' }), text);
}

/** A progress bar: `part` 0..1, or a moving one when nobody knows how far along it is. */
export function progressBar(label: string, part: number | undefined): HTMLElement {
  const known = typeof part === 'number' && Number.isFinite(part);
  const pct = known ? Math.round(Math.max(0, Math.min(1, part)) * 100) : 0;
  const bar = h('div.welcome-bar', { role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': known ? pct : undefined, class: known ? '' : 'indeterminate' }, h('span', { 'aria-hidden': 'true' }));
  bar.style.setProperty('--p', `${pct}%`);
  return bar;
}

/**
 * A device code shown large, for a sign-in that happens on a web page: Factory's for Droid, or a
 * provider's in DroidProxy. `actions` puts Open sign-in page (and Cancel) under it; the welcome has
 * them in its footer instead.
 */
export function deviceCode(opts: { code: string | null; url: string | null; waiting: string; onCancel?: () => void; actions?: boolean }): HTMLElement {
  const open = opts.url && opts.actions ? h('a.btn.sm.accent', { href: opts.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open sign-in page') : null;
  const cancel = opts.onCancel && opts.actions ? h('button.btn.sm.ghost', { type: 'button', onclick: opts.onCancel }, 'Cancel') : null;
  return h(
    'div.device-code',
    {},
    opts.code ? h('span.eyebrow', {}, 'Your code') : null,
    opts.code ? h('output.device-code-value', { 'aria-label': 'Sign-in code' }, opts.code) : null,
    open || cancel ? h('div.row', {}, open, cancel) : null,
    waitLine(opts.waiting),
  );
}

/**
 * Droid's sign-in to Factory while it runs: the code and the page to enter it on, from
 * store.setup.droid.signIn. `paint` redraws it; it is empty while Droid isn't signing in.
 */
export function signInPanel(net: Net, opts: { actions?: boolean } = {}): { element: HTMLElement; paint: () => void } {
  const element = h('div.welcome-signin');
  let key = '';
  const paint = () => {
    const d = store.setup.droid;
    const s = d.busy === 'signing-in' ? d.signIn : undefined;
    const next = JSON.stringify([d.busy, s?.code, s?.url]);
    if (next === key) return;
    key = next;
    if (d.busy !== 'signing-in') return element.replaceChildren();
    if (!s?.code && !s?.url) return element.replaceChildren(waitLine('Starting Droid’s sign-in…'));
    element.replaceChildren(
      deviceCode({
        code: s.code,
        url: s.url,
        waiting: 'Waiting for you to sign in, or create an account, on that page…',
        onCancel: () => net.send({ t: 'setup.droid.signInCancel' }),
        actions: opts.actions,
      }),
    );
  };
  paint();
  return { element, paint };
}
