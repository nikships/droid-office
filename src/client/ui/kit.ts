import { type Child, h } from './dom';

// Builders for the UI kit's fiddlier markup (the classes are in style.css's "UI kit" block).

let ids = 0;
const nextId = (prefix: string) => `${prefix}-${++ids}`;

export type Toggle = HTMLLabelElement & { input: HTMLInputElement };

/**
 * An on/off switch: `label.toggle` with its checkbox, track and text. `bare` leaves the text out
 * (the label becomes the checkbox's aria-label), for a group row that already says what it is.
 */
export function toggle(opts: { label: string; description?: string; checked?: boolean; onChange?: (on: boolean, e: Event) => void; id?: string; disabled?: boolean; bare?: boolean }): Toggle {
  const input = h('input', {
    type: 'checkbox',
    id: opts.id,
    checked: !!opts.checked,
    disabled: !!opts.disabled,
    'aria-label': opts.bare ? opts.label : undefined,
    onchange: (e: Event) => opts.onChange?.(input.checked, e),
  });
  const text = opts.bare ? null : h('span.toggle-text', {}, opts.label, opts.description ? h('small', {}, opts.description) : null);
  return Object.assign(h('label.toggle', {}, input, h('span.track', { 'aria-hidden': 'true' }), text), { input });
}

export interface ChoiceOption {
  value: string;
  title: string;
  description?: string;
  icon?: string;
}

export type Choices = HTMLDivElement & { value(): string; select(value: string): void };

/** Option cards for picking one of a few alternatives: `.choices` of `label.choice` radios named `name`. */
export function choices(name: string, options: ChoiceOption[], selected: string, onChange?: (value: string) => void): Choices {
  const radios = options.map((o) =>
    h('input', {
      type: 'radio',
      name,
      value: o.value,
      checked: o.value === selected,
      onchange: () => onChange?.(o.value),
    }),
  );
  const el = h(
    'div.choices',
    { role: 'radiogroup' },
    ...options.map((o, i) => h('label.choice', {}, radios[i], h('span.choice-body', {}, o.icon ? h('span.choice-icon', { 'aria-hidden': 'true' }, o.icon) : null, h('b', {}, o.title), o.description ? h('small', {}, o.description) : null))),
  );
  return Object.assign(el, {
    value: () => radios.find((r) => r.checked)?.value ?? '',
    select(value: string) {
      for (const r of radios) r.checked = r.value === value;
    },
  });
}

/** A labeled form field: `.field` with its label (tied to the control when it's an input, select or textarea), the control and a hint. */
export function field(label: string, control: HTMLElement, hint?: Child): HTMLDivElement {
  const labelable = control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement;
  if (labelable && !control.id) control.id = nextId('field');
  return h('div.field', {}, h('label', { for: labelable ? control.id : undefined }, label), control, hint ? h('p.field-hint', {}, hint) : null);
}

/** A settings row for a `.group`: title and description on the left, its control on the right. */
export function groupRow(title: string, description: Child, control: Child): HTMLDivElement {
  return h('div.group-row', {}, h('div.group-label', {}, h('b', {}, title), description ? h('small', {}, description) : null), control);
}

/** What a list or pane shows when it has nothing in it: an icon, a title, a line of text and an optional action. */
export function emptyState(icon: string, title: string, text?: Child, action?: HTMLElement): HTMLDivElement {
  return h('div.empty-state', {}, h('div.empty-icon', { 'aria-hidden': 'true' }, icon), h('b', {}, title), text ? h('p', {}, text) : null, action ?? null);
}

/** A window's header: its title, an optional subtitle under it, and header actions before the ✕ that openModal adds. */
export function windowHeader(title: Child, sub?: Child, ...actions: Child[]): HTMLElement {
  const shown = actions.filter((a) => a !== null && a !== undefined && a !== false);
  return h('header', {}, h('div.titles', {}, h('h2', {}, title), sub ? h('p.sub', {}, sub) : null), shown.length ? h('div.actions', {}, ...shown) : null);
}
