import { DRINKS, type Drink } from '../../shared/rooftop';
import { h, openModal } from './dom';

export interface BarOptions {
  /** Had enough: nothing stronger than water or a mocktail. */
  cutOff: boolean;
  order(d: Drink): void;
}

/** How hard a drink hits, for the menu: a word, and how many of its three swirls are lit. */
function kick(d: Drink): { text: string; level: number } {
  if (d.strength < 0) return { text: 'Sobers you up', level: 0 };
  if (d.strength === 0) return { text: 'No alcohol', level: 0 };
  return d.strength >= 0.55 ? { text: 'Strong', level: 3 } : d.strength >= 0.4 ? { text: 'Goes to your head', level: 2 } : { text: 'Light', level: 1 };
}

/** The rooftop bar's menu: pick a drink and the bartender pours it. */
export function openBar(opts: BarOptions) {
  const close = h('button.btn.icon.close', { 'aria-label': 'Close' }, '✕');
  const list = h(
    'ul.list.boxed.bar-menu',
    {},
    ...DRINKS.map((d) => {
      const refused = opts.cutOff && d.strength > 0;
      const k = kick(d);
      const li = h(
        'li.list-row',
        {
          tabindex: refused ? -1 : 0,
          role: 'button',
          'aria-disabled': String(refused),
          title: refused ? "The bartender won't pour you another" : `Order a ${d.name.toLowerCase()}`,
        },
        h('span.list-icon.bar-emoji', {}, d.emoji),
        h('div.list-main', {}, h('div.list-title', {}, d.name), h('div.list-meta', {}, d.blurb)),
        h('span.list-end.bar-kick', { class: d.strength < 0 ? 'sober' : '' }, k.text, h('span.bar-meter', { 'aria-hidden': 'true' }, ...[1, 2, 3].map((n) => h('i', { class: n <= k.level ? 'lit' : '' })))),
      );
      const pick = () => {
        if (refused) return;
        modal.close();
        opts.order(d);
      };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });
      return li;
    }),
  );
  const el = h(
    'div.modal.bar',
    { role: 'dialog', 'aria-label': 'Bar' },
    h('header', {}, h('div.titles', {}, h('h2', {}, 'Sky Bar'), h('p.sub', {}, 'Pick a drink and the bartender pours it. Everything is on the house.')), close),
    h('div.body.stack', {}, opts.cutOff ? h('p.note.warn', { role: 'status' }, "The bartender thinks you've had enough. Water's on the house.") : null, list),
    h('footer', {}, h('span.grow', {}, 'A drink goes to your head for a minute or so, and the view goes with it.')),
  );
  const modal = openModal(el);
  close.addEventListener('click', () => modal.close());
  setTimeout(() => (list.querySelector('li[tabindex="0"]') as HTMLElement | null)?.focus(), 30);
}
