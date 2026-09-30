import { h, openModal, type Modal } from '../ui/dom';

/** Keep select choices on the compositor panel, where controller pointer events can reach them. */
export function mountNativeSelects() {
  let active: Modal | null = null;
  const source = (target: EventTarget | null) => {
    const select = target instanceof Element ? target.closest('select') : null;
    return select instanceof HTMLSelectElement && !select.disabled && !select.multiple && select.size <= 1 ? select : null;
  };
  const open = (select: HTMLSelectElement) => {
    active?.close();
    const label = select.getAttribute('aria-label') || select.title || selectLabel(select) || 'Choose an option';
    const choices = h('div.native-select-options', { role: 'listbox', 'aria-label': label });
    const buttons: HTMLButtonElement[] = [];
    let group: Element | null = null;
    for (const option of select.options) {
      const parent = option.parentElement;
      if (option.hidden || (parent instanceof HTMLOptGroupElement && parent.hidden)) continue;
      if (parent !== group) {
        group = parent;
        if (parent instanceof HTMLOptGroupElement && parent.label) choices.append(h('h3.native-select-group', {}, parent.label));
      }
      const disabled = option.disabled || (parent instanceof HTMLOptGroupElement && parent.disabled);
      const button = h(
        'button.btn.native-select-option',
        {
          type: 'button',
          role: 'option',
          'aria-selected': String(option.selected),
          disabled,
          onclick: () => {
            const currentGroup = option.parentElement;
            if (!select.isConnected || select.disabled || option.closest('select') !== select || option.disabled || (currentGroup instanceof HTMLOptGroupElement && currentGroup.disabled)) return active?.close();
            const changed = select.selectedIndex !== option.index;
            select.selectedIndex = option.index;
            modal.close();
            if (changed) {
              select.dispatchEvent(new Event('input', { bubbles: true }));
              select.dispatchEvent(new Event('change', { bubbles: true }));
            }
          },
        },
        h('span', {}, option.label || option.text),
        h('span.native-select-check', { 'aria-hidden': 'true' }, option.selected ? '✓' : ''),
      );
      button.dataset.optionIndex = String(option.index);
      choices.append(button);
      if (!disabled) buttons.push(button);
    }
    const content = h('section.modal.native-select', { role: 'dialog', 'aria-label': label }, h('header', {}, h('h2', {}, label)), h('div.body', {}, choices));
    const observer = new MutationObserver((records) => {
      if (!select.isConnected || select.disabled || records.some((record) => record.target === select || select.contains(record.target))) modal.close();
    });
    const modal = openModal(content, {
      onClose: () => {
        observer.disconnect();
        if (active === modal) active = null;
        if (select.isConnected) select.focus({ preventScroll: true });
      },
    });
    active = modal;
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
    content.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !buttons.length) return;
      e.preventDefault();
      e.stopPropagation();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus({ preventScroll: true });
      buttons[next].scrollIntoView({ block: 'nearest' });
    });
    const selected = buttons.find((button) => button.getAttribute('aria-selected') === 'true') ?? buttons[0];
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: 'nearest' });
  };
  for (const kind of ['pointerdown', 'mousedown']) {
    document.addEventListener(
      kind,
      (e) => {
        const select = source(e.target);
        if (!select) return;
        e.preventDefault();
        select.focus({ preventScroll: true });
      },
      true,
    );
  }
  document.addEventListener(
    'click',
    (e) => {
      const select = source(e.target);
      if (!select) return;
      e.preventDefault();
      open(select);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      const select = source(e.target);
      if (!select || e.repeat || e.ctrlKey || e.metaKey) return;
      if (e.key !== 'Enter' && e.key !== ' ' && !(e.altKey && e.key === 'ArrowDown')) return;
      e.preventDefault();
      open(select);
    },
    true,
  );
}

function selectLabel(select: HTMLSelectElement): string {
  const label = select.labels?.item(0)?.cloneNode(true) as HTMLElement | undefined;
  if (!label) return '';
  for (const control of label.querySelectorAll('select, input, button, small')) control.remove();
  return label.textContent?.trim() ?? '';
}
