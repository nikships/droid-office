/** Preserve a keyed control through a repaint without moving focus into a previously unfocused area. */
export function retainFocus(parent: HTMLElement): () => void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && parent.contains(active) ? active.dataset.focusKey : undefined;
  const selection = active instanceof HTMLTextAreaElement ? ([active.selectionStart, active.selectionEnd] as const) : undefined;
  return () => {
    if (key === undefined) return;
    const target = [...parent.querySelectorAll<HTMLElement>('[data-focus-key]')].find((node) => node.dataset.focusKey === key);
    target?.focus({ preventScroll: true });
    if (selection && target instanceof HTMLTextAreaElement) target.setSelectionRange(...selection);
  };
}
