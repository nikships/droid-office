import { store } from '../state';
import { visibleModels } from '../../shared/model-visibility';
import { type Child, claimEscape, h } from './dom';
import { modelLogo, providerLogo } from './model-logo';
import { availabilityOf, canPick, highlightRanges, multiplierLabel, offersSubscriptions, type PickerModel, pushRecent, scopesOf, type Section, sectionsFor, splitFamily, withAvailability } from './model-search';

/** What the picker offers on top, for "no choice": the model droid runs when nobody picks one. */
export interface NoneOption {
  label: string;
  /** Muted after the label: the model it runs, "Sonnet 5.5". */
  note?: string;
  /** Its cost, drawn like a model's. */
  cost?: number;
  detail?: string;
  /** The model it runs, so the picker can say when that one can't run now. */
  model?: string;
}

export interface ModelPickerOptions {
  /** The control's accessible name, and the popover's. */
  label: string;
  id?: string;
  models: PickerModel[];
  value?: string;
  none?: NoneOption;
  /** Offers whatever is typed as a choice of its own, for fields that take an id droid does not list. */
  allowCustom?: boolean;
  /** Shown in the trigger while nothing is picked and there is no `none` row. */
  placeholder?: string;
  small?: boolean;
  /** Where the `change` event goes besides the trigger itself. */
  onChange?: (value: string) => void;
}

export interface ModelPicker {
  /** The button that opens the list. It fires a bubbling `change` event when the choice changes. */
  element: HTMLButtonElement;
  value(): string;
  /** Moves to `value` without a `change` event. */
  set(value: string): void;
  setModels(models: PickerModel[], none?: NoneOption): void;
  setDisabled(disabled: boolean): void;
  close(): void;
}

const RECENTS_KEY = 'droid-office.model-recents';
const NONE = '\u0000none';
const CUSTOM = '\u0000custom';
/** Fired on `window` to open Settings on a pane: `detail.pane` is the pane id. main.ts opens it. */
export const OPEN_SETTINGS_EVENT = 'office:settings';
/** The longest model id the office accepts (see fetchCatalogue in models.ts). */
const MODEL_ID_MAX = 256;

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').slice(0, 4) : [];
  } catch {
    return [];
  }
}

function saveRecent(id: string) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(pushRecent(loadRecents(), id)));
  } catch {
    // storage blocked
  }
}

let counter = 0;

/** The pinwheel that stands for DroidProxy (public/factory-glyph.svg). */
const pinwheel = () => h('img.glyph', { src: '/factory-glyph.svg', alt: '', 'aria-hidden': 'true' });

function costClass(cost: number): string {
  if (cost <= 0.3) return 'cheap';
  if (cost >= 4) return 'dear';
  return '';
}

function costPill(cost: number | undefined): HTMLElement | null {
  if (cost === undefined) return null;
  return h('span.mp-cost', { class: costClass(cost), title: 'Credits per token, against the base rate' }, multiplierLabel(cost));
}

/** A typed id the office would accept as a model of its own. */
const isCustomId = (text: string) => text !== '' && text.length <= MODEL_ID_MAX && !/[\s\p{Cc}\p{Cf}]/u.test(text);

/** `text` with the parts the query matched wrapped in <mark>. */
function marked(text: string, query: string): (string | HTMLElement)[] {
  const ranges = highlightRanges(text, query);
  if (!ranges.length) return [text];
  const out: (string | HTMLElement)[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) out.push(text.slice(at, from));
    out.push(h('mark', {}, text.slice(from, to)));
    at = to;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * A model chooser for lists too long for the system dropdown: a button that opens a searchable
 * popover with filter chips, the last few picks on top, sections by provider or gateway and the
 * credit cost on every row. Keyboard first: type to search, arrows move, Enter picks, Esc closes.
 */
export function modelPicker(opts: ModelPickerOptions): ModelPicker {
  const uid = ++counter;
  let source = opts.models;
  let none = opts.none;
  let value = opts.value ?? '';
  let customValue = '';

  const trigger = h('button.mp-trigger', {
    type: 'button',
    id: opts.id,
    'aria-label': opts.label,
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    class: opts.small ? 'sm' : '',
  });

  /** The models as they can run right now: read when drawn, so a quota that runs out shows up in an open list. */
  const listed = (): PickerModel[] => withAvailability(visibleModels(source, store.hiddenModels), store.subscriptions, Date.now());
  const known = (id: string) => withAvailability(source, store.subscriptions, Date.now()).find((m) => m.id === id);
  /** Why the `none` row's model can't run now, if it can't. */
  const noneReason = () => availabilityOf(none?.model, store.subscriptions, Date.now()).reason;

  /** The default model's logo, label and note, as the trigger and its row both draw them. */
  const noneParts = (option: NoneOption): Child[] => [modelLogo({ id: option.model, name: option.note }), h('span.mp-name', {}, option.label), option.note ? h('span.mp-note', {}, option.note) : null];

  const triggerParts = (m: PickerModel | undefined): Child[] => {
    if (!value) return none ? noneParts(none) : [h('span.mp-name.mp-placeholder', {}, opts.placeholder ?? 'Choose a model')];
    if (!m) return [modelLogo({ id: value }), h('span.mp-name', {}, value)];
    const { family, rest } = splitFamily(m.name);
    return [modelLogo(m), h('span.mp-name', {}, family ? h('span.mp-family', {}, `${family}: `) : null, rest), m.unavailable ? h('span.mp-tag', {}, m.reason ? 'can’t run' : 'unavailable') : null];
  };

  const paintTrigger = () => {
    const m = known(value);
    const cost = value ? m?.cost : none?.cost;
    const pill = costPill(cost);
    trigger.replaceChildren(h('span.mp-value', {}, ...triggerParts(m)), ...(pill ? [pill] : []));
    trigger.title = m ? `${m.name} · ${m.id}${m.reason ? ` · ${m.reason}` : ''}` : value || none?.label || '';
  };

  // ---- The popover ------------------------------------------------------------------------------

  let pop: HTMLElement | null = null;
  let scrim: HTMLElement | null = null;
  let withdraw: (() => void) | null = null;
  /** A window that redraws can take the trigger away while the list is open; the list goes with it. */
  let watchTrigger: ReturnType<typeof setInterval> | undefined;
  let query = '';
  let scope = '';
  let cursor = 0;
  /** The rows on screen, in order: the `none` row, then each section's models. */
  let rows: { key: string; model?: PickerModel; el: HTMLElement }[] = [];
  let ui: { input: HTMLInputElement; chips: HTMLElement; list: HTMLElement; detail: HTMLElement; count: HTMLElement; offer: HTMLElement };
  let stopWatching: (() => void) | null = null;
  /** What the open list showed last, to redraw only when a `subscriptions` message changes it. */
  let drawn = '';

  const place = () => {
    if (!pop) return;
    const r = trigger.getBoundingClientRect();
    const gap = 4;
    const margin = 12;
    const width = Math.min(Math.max(r.width, 400), window.innerWidth - margin * 2);
    const left = Math.min(Math.max(r.left, margin), window.innerWidth - margin - width);
    const below = window.innerHeight - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const flip = below < 300 && above > below;
    pop.classList.toggle('up', flip);
    pop.style.setProperty('--mp-left', `${left}px`);
    pop.style.setProperty('--mp-width', `${width}px`);
    pop.style.setProperty('--mp-max', `${Math.min(Math.max(flip ? above : below, 240), 520)}px`);
    if (flip) {
      pop.style.setProperty('--mp-bottom', `${window.innerHeight - r.top + gap}px`);
      pop.style.removeProperty('--mp-top');
    } else {
      pop.style.setProperty('--mp-top', `${r.bottom + gap}px`);
      pop.style.removeProperty('--mp-bottom');
    }
  };

  /** What picking a row sets: nothing for `none`, the typed text for the custom row, else the model's id. */
  const valueOfRow = (key: string, model?: PickerModel): string => {
    if (key === NONE) return '';
    if (key === CUSTOM) return customValue;
    return model?.id ?? '';
  };

  const rowBody = (key: string, model: PickerModel | undefined, flat: boolean): Child[] => {
    if (key === NONE) return none ? [...noneParts(none), noneReason() ? h('span.mp-why', {}, noneReason()) : null] : [];
    if (key === CUSTOM) return [modelLogo({ id: customValue }), h('span.mp-name', {}, 'Use ', h('b', {}, customValue)), h('span.mp-note', {}, 'as typed')];
    if (!model) return [];
    const { family, rest } = splitFamily(model.name);
    return [
      modelLogo(model),
      h('span.mp-name', {}, family ? h('span.mp-family', {}, ...marked(`${family}: `, query)) : null, ...marked(rest, query)),
      ...(model.tags ?? []).map((t) => h('span.mp-tag', {}, t)),
      model.unavailable && !model.reason ? h('span.mp-tag', {}, 'unavailable') : null,
      model.reason ? h('span.mp-why', {}, model.reason) : null,
      flat ? h('span.mp-where', {}, model.group) : null,
    ];
  };

  const row = (key: string, model: PickerModel | undefined, flat: boolean): HTMLElement => {
    const id = `mp-${uid}-${rows.length}`;
    const selected = key === NONE ? !value : model?.id === value;
    const refused = key === NONE ? !!noneReason() : !canPick(model);
    const el = h(
      'div.mp-row',
      { id, role: 'option', 'aria-selected': String(selected), 'aria-disabled': refused ? 'true' : undefined, class: `${selected ? 'on' : ''} ${refused ? 'refused' : ''}` },
      h('span.mp-check', { 'aria-hidden': 'true' }, selected ? '✓' : ''),
      h('span.mp-main', {}, ...rowBody(key, model, flat)),
      costPill(key === NONE ? none?.cost : model?.cost),
    );
    el.addEventListener('mousemove', () => {
      const i = rows.findIndex((r) => r.el === el);
      if (i >= 0 && i !== cursor) moveTo(i, false);
    });
    el.addEventListener('click', () => {
      if (!refused) choose(valueOfRow(key, model));
    });
    rows.push({ key, model, el });
    return el;
  };

  const paintChips = () => {
    const models = listed();
    const scopes = scopesOf(models);
    ui.chips.classList.toggle('hidden', scopes.length < 2);
    const chip = (key: string, label: string, count: number) => {
      const on = scope === key;
      return h(
        'button.mp-chip',
        {
          type: 'button',
          class: on ? 'on' : '',
          'aria-pressed': String(on),
          onclick: () => {
            scope = key;
            paintList();
            ui.input.focus({ preventScroll: true });
          },
        },
        providerLogo(key),
        label,
        h('small', {}, String(count)),
      );
    };
    ui.chips.replaceChildren(chip('', 'All', models.length), ...scopes.map((s) => chip(s.key, s.key, s.count)));
  };

  const paintDetail = () => {
    const r = rows[cursor];
    const m = r?.model;
    if (m) {
      ui.detail.replaceChildren(h('code', {}, m.id), ...(m.reason || m.note || m.detail ? [h('span', {}, m.reason ?? m.note ?? m.detail)] : []));
      return;
    }
    if (r?.key === NONE) ui.detail.replaceChildren(noneReason() ?? none?.detail ?? 'Droid’s own default');
    else if (r?.key === CUSTOM) ui.detail.replaceChildren('Sent as typed');
    else ui.detail.replaceChildren();
  };

  const moveTo = (i: number, scroll = true) => {
    rows[cursor]?.el.classList.remove('cursor');
    if (!rows.length) {
      ui.input.removeAttribute('aria-activedescendant');
      paintDetail();
      return;
    }
    cursor = (i + rows.length) % rows.length;
    const el = rows[cursor].el;
    el.classList.add('cursor');
    ui.input.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
    paintDetail();
  };

  const paintList = () => {
    rows = [];
    const models = listed();
    const typed = query.trim();
    const sections: Section[] = sectionsFor(models, { query, scope, recents: loadRecents() });
    const nodes: HTMLElement[] = [];
    const wantsNone = none && !scope && (!typed || `${none.label} ${none.note ?? ''} default`.toLowerCase().includes(typed.toLowerCase()));
    if (wantsNone) nodes.push(row(NONE, undefined, false));
    for (const s of sections) {
      nodes.push(h('div.mp-head', { role: 'presentation' }, s.key.startsWith('g:') ? (s.models[0]?.glyph ? pinwheel() : providerLogo(s.label)) : null, s.label, h('small', {}, s.flat ? '' : String(s.models.length))));
      for (const m of s.models) nodes.push(row(m.id, m, !!s.flat));
    }
    if (opts.allowCustom && isCustomId(typed) && !known(typed) && !store.hiddenModels.includes(typed)) {
      customValue = typed;
      nodes.push(row(CUSTOM, undefined, false));
    }
    ui.list.replaceChildren(...(nodes.length ? nodes : [h('div.mp-empty', {}, h('b', {}, 'No model matches'), h('span', {}, typed ? `Nothing is called “${typed}”. Clear the search or pick another group.` : 'The list is empty.'))]));
    const total = models.length;
    ui.count.textContent = typed || scope ? `${rows.filter((r) => r.model).length} of ${total}` : `${total} models`;
    paintChips();
    paintOffer();
    drawn = stamp();
    const selectedAt = typed
      ? Math.max(
          0,
          rows.findIndex((r) => !r.el.classList.contains('refused')),
        )
      : rows.findIndex((r) => r.el.classList.contains('on'));
    moveTo(selectedAt >= 0 ? selectedAt : 0, false);
    if (selectedAt >= 0 && !typed) rows[selectedAt].el.scrollIntoView({ block: 'center' });
    else ui.list.scrollTop = 0;
  };

  /** Hidden ids also affect typed custom choices that aren't in this picker's catalogue. */
  const stamp = () => JSON.stringify([store.hiddenModels, listed().map((m) => [m.id, m.reason, m.note]), noneReason(), offersSubscriptions(store.subscriptions)]);

  const paintOffer = () => {
    const offered = offersSubscriptions(store.subscriptions);
    ui.offer.classList.toggle('hidden', !offered);
    if (!offered || ui.offer.firstChild) return;
    ui.offer.append(
      h(
        'button.mp-offer-btn',
        {
          type: 'button',
          onclick: () => {
            close();
            window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { pane: 'subscriptions' } }));
          },
        },
        'Use your Claude or ChatGPT plan',
        h('span', { 'aria-hidden': 'true' }, '→'),
      ),
    );
  };

  /** A `subscriptions` message while the list is open: redraw if it changed what is shown, and keep the place in the list. */
  const onSubscriptions = () => {
    if (!pop || drawn === stamp()) return;
    const at = rows[cursor]?.key;
    const top = ui.list.scrollTop;
    paintList();
    const back = rows.findIndex((r) => r.key === at);
    if (back >= 0) moveTo(back, false);
    ui.list.scrollTop = top;
    paintTrigger();
  };

  function choose(next: string) {
    if (next && store.hiddenModels.includes(next)) return;
    if (next && !canPick(known(next))) return;
    const changed = next !== value;
    value = next;
    if (next) saveRecent(next);
    close(true);
    paintTrigger();
    if (changed) {
      opts.onChange?.(value);
      trigger.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function close(refocus = false) {
    if (!pop) return;
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', onScroll, true);
    withdraw?.();
    withdraw = null;
    clearInterval(watchTrigger);
    stopWatching?.();
    stopWatching = null;
    pop.remove();
    scrim?.remove();
    pop = null;
    scrim = null;
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus) trigger.focus({ preventScroll: true });
  }

  const onScroll = (e: Event) => {
    if (pop && !pop.contains(e.target as Node)) place();
  };

  const onKey = (e: KeyboardEvent) => {
    const inInput = e.target === ui.input;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveTo(cursor + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      moveTo(Math.min(Math.max(cursor + (e.key === 'PageDown' ? 8 : -8), 0), rows.length - 1));
    } else if ((e.key === 'Home' || e.key === 'End') && !inInput) {
      e.preventDefault();
      moveTo(e.key === 'Home' ? 0 : rows.length - 1);
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      const r = rows[cursor];
      if (r) choose(valueOfRow(r.key, r.model));
    } else if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && !inInput) {
      ui.input.focus({ preventScroll: true });
    }
  };

  function open() {
    if (pop || trigger.disabled) return;
    query = '';
    scope = '';
    const input = h('input.mp-input', {
      type: 'text',
      role: 'combobox',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'Search models, providers…',
      'aria-label': `Search ${opts.label.toLowerCase()}`,
      'aria-expanded': 'true',
      'aria-controls': `mp-${uid}-list`,
    }) as HTMLInputElement;
    const chips = h('div.mp-chips', { role: 'group', 'aria-label': 'Filter by group' });
    const list = h('div.mp-list', { id: `mp-${uid}-list`, role: 'listbox', 'aria-label': opts.label });
    const detail = h('span.mp-detail');
    const count = h('span.mp-count');
    const offer = h('div.mp-offer.hidden');
    ui = { input, chips, list, detail, count, offer };
    pop = h(
      'div.mp-pop',
      { role: 'dialog', 'aria-label': opts.label, tabindex: -1 },
      h('div.mp-search', {}, h('span.mp-glass', { 'aria-hidden': 'true' }, '⌕'), input, h('kbd.key', {}, 'esc')),
      chips,
      list,
      offer,
      h('div.mp-foot', {}, detail, count),
    );
    scrim = h('div.mp-scrim');
    scrim.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      close();
    });
    pop.addEventListener('keydown', onKey);
    pop.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && pop && !pop.contains(to) && to !== trigger) close();
    });
    input.addEventListener('input', () => {
      query = input.value;
      paintList();
    });
    document.body.append(scrim, pop);
    trigger.setAttribute('aria-expanded', 'true');
    withdraw = claimEscape(trigger, () => {
      if (!pop) return false;
      close(true);
      return true;
    });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    const offSubscriptions = store.on('subscriptions', onSubscriptions);
    const offHidden = store.on('hiddenModels', onSubscriptions);
    stopWatching = () => {
      offSubscriptions();
      offHidden();
    };
    watchTrigger = setInterval(() => {
      if (!trigger.isConnected) close();
    }, 400);
    place();
    paintList();
    if (window.matchMedia('(pointer: coarse)').matches) pop.focus({ preventScroll: true });
    else input.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', () => (pop ? close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });

  paintTrigger();
  return {
    element: trigger,
    value: () => value,
    set(next) {
      value = next;
      paintTrigger();
      if (pop) paintList();
    },
    setModels(next, nextNone) {
      source = next;
      none = nextNone;
      paintTrigger();
      if (pop) paintList();
    },
    setDisabled(disabled) {
      trigger.disabled = disabled;
      if (disabled) close();
    },
    close: () => close(),
  };
}
