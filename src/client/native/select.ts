import { h, openModal } from '../ui/dom';

/** Keep single-choice dropdowns on the compositor Surface, not Android's unreachable popup window. */
export function installNativeSelects() {
  const selectAt = (event: Event) => {
    const target = event.target;
    const select = target instanceof Element ? target.closest('select') : null;
    return select instanceof HTMLSelectElement && !select.disabled && !select.multiple && select.size <= 1 ? select : null;
  };
  const suppressPopup = (event: Event) => {
    if (selectAt(event)) event.preventDefault();
  };
  document.addEventListener('pointerdown', suppressPopup, true);
  document.addEventListener('mousedown', suppressPopup, true);
  document.addEventListener(
    'click',
    (event) => {
      const select = selectAt(event);
      if (!select) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const options = [...select.options];
      const snapshot = () => JSON.stringify([...select.options].map((option) => [option.value, option.label, option.disabled, option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled]));
      const original = snapshot();
      let observer: MutationObserver | null = null;
      const restoreFocus = () => {
        observer?.disconnect();
        if (select.isConnected) select.focus();
      };
      const choices = h('div.native-select-choices', { role: 'listbox', 'aria-label': select.getAttribute('aria-label') ?? 'Choose an option' });
      const modal = openModal(h('div.modal.native-select', {}, h('header', {}, h('h2', {}, select.getAttribute('aria-label') ?? 'Choose an option')), choices), { onClose: restoreFocus });
      const current = () => select.isConnected && !select.disabled && !select.multiple && snapshot() === original;
      observer = new MutationObserver(() => {
        if (!current()) modal.close();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      let group: Element | null = null;
      for (const option of options) {
        if (option.parentElement instanceof HTMLOptGroupElement && option.parentElement !== group) choices.append(h('h3', {}, option.parentElement.label));
        group = option.parentElement;
        const disabled = option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
        const button = h('button.btn', { type: 'button', role: 'option', 'aria-selected': String(option.selected), disabled }, option.label);
        button.addEventListener('click', () => {
          if (!current() || disabled) return modal.close();
          const changed = select.value !== option.value;
          select.value = option.value;
          if (changed) {
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          modal.close();
        });
        choices.append(button);
      }
    },
    true,
  );
}
