import { factoryLimitsActive } from '../../shared/factory-limits';
import { factoryFetch, refreshFactory, watchFactory } from '../factory';
import { store } from '../state';
import { h, openModal } from './dom';
import { factoryLimitsView } from './factory-limits-view';
import { field, windowHeader } from './kit';

/** Live, disposable limits panel. Only an explicit selector change plus confirmation writes billing preferences. */
export function factoryLimitsPanel(): { element: HTMLElement; dispose(): void } {
  const body = h('div.stack');
  const preference = h('select.select', { 'aria-label': 'Overage preference' }, h('option', { value: '', disabled: true }, 'Not set'), h('option', { value: 'droidCore' }, 'Droid Core'), h('option', { value: 'extraUsage' }, 'Extra Usage'));
  const error = h('p.note.bad', { role: 'alert' });
  const control = field('Overage preference', preference, 'Used when Standard runs out. Extra Usage spends your prepaid balance; Droid Core uses its separate quota.');
  const refresh = h('button.btn.sm', { type: 'button', onclick: () => refreshFactory('limits') }, 'Refresh limits');
  const element = h('section.stack.factory-limits', { 'aria-label': 'Factory limits and overage' }, body, control, error, h('div.row', {}, refresh));
  let busy = false;
  let failure = '';
  let drawn = '';
  const paint = () => {
    const factory = store.factory;
    const s = factory.limits;
    const next = JSON.stringify([factory.connection, s, store.setup.airgapped, Math.floor(Date.now() / 60_000)]);
    if (next !== drawn) {
      drawn = next;
      body.replaceChildren(...factoryLimitsView(factory, Date.now(), !!store.setup.airgapped));
    }
    const writable = factory.connection.connected && !factory.connection.rejected && factoryLimitsActive(s) && !store.setup.airgapped && s.canManageOverage;
    control.classList.toggle('hidden', !writable);
    preference.disabled = busy || !writable;
    preference.value = s.overagePreference ?? '';
    refresh.disabled = busy || !factory.connection.connected || !!factory.connection.rejected || !!store.setup.airgapped;
    error.textContent = failure;
    error.classList.toggle('hidden', !failure);
  };
  preference.addEventListener('change', () => {
    if (preference.disabled) return paint();
    const value = preference.value;
    if (value !== 'droidCore' && value !== 'extraUsage') return paint();
    if (value === store.factory.limits.overagePreference) return;
    const warning =
      value === 'extraUsage'
        ? 'Use Extra Usage when Factory Standard runs out? This can spend your prepaid Extra Usage balance.'
        : 'Use Droid Core when Factory Standard runs out? Standard models will stop at their limit instead of spending Extra Usage.';
    if (!confirm(warning)) return paint();
    busy = true;
    failure = '';
    paint();
    void factoryFetch('limits', '/overage', { method: 'POST', body: { overagePreference: value } })
      .then(() => refreshFactory('limits'))
      .catch((err: unknown) => {
        failure = err instanceof Error ? err.message : 'Couldn’t change the overage preference.';
      })
      .finally(() => {
        busy = false;
        paint();
      });
  });
  const off = store.on('factory', paint);
  const offSetup = store.on('setup', paint);
  const unwatch = watchFactory('limits');
  const timer = setInterval(paint, 30_000);
  paint();
  return {
    element,
    dispose() {
      off();
      offSetup();
      unwatch();
      clearInterval(timer);
    },
  };
}

export function openFactoryLimits() {
  const panel = factoryLimitsPanel();
  const content = h('div.modal.factory-limits-modal', {}, windowHeader('Factory Limits & Overage', 'Standard and Droid Core · 5-hour, weekly and monthly quotas'), h('div.body', {}, panel.element));
  return openModal(content, { size: 'lg', onClose: panel.dispose });
}
