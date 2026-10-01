/**
 * Help stays inside the compositor panel rather than in an operating-system tooltip. It says what
 * a control does, never which key or button does it (native/mode.ts controlHintsShown): desktop
 * shortcut letters, key combinations and "press E" clauses are left out.
 */
export function nativeTooltipText(element: Element): string {
  const title = element.getAttribute('title')?.trim();
  if (!title) return '';
  return (
    title
      // "(M)", "(C at the desk)", "(Tab)", "(Esc)", "(Shift+Esc or Ctrl+])".
      .replace(/\s*\((?:[A-Z/](?: at the desk)?|[^()]*\b(?:Tab|Esc|Shift|Ctrl)\b[^()]*)\)/g, '')
      // "· Esc goes to the terminal", ", and press E there".
      .replace(/\s*·\s*Esc\b[^·]*/g, '')
      .replace(/,?\s*(?:and\s+)?press E\b[^.·;]*/gi, '')
      .trim()
      .slice(0, 500)
  );
}

export function mountNativeTooltips(): void {
  const tip = document.createElement('div');
  tip.id = 'native-tooltip';
  tip.className = 'native-tooltip hidden';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  let target: HTMLElement | null = null;
  let previousDescription: string | null = null;
  let timer = 0;

  const hide = () => {
    clearTimeout(timer);
    if (target) {
      if (previousDescription) target.setAttribute('aria-describedby', previousDescription);
      else target.removeAttribute('aria-describedby');
    }
    target = null;
    tip.classList.add('hidden');
  };
  const show = (event: Event, temporary = false) => {
    const next = (event.target as Element | null)?.closest<HTMLElement>('[title]');
    const text = next ? nativeTooltipText(next) : '';
    if (!next || !text || next.closest('.native-kb') || next.getClientRects().length === 0) return hide();
    if (next !== target) {
      hide();
      target = next;
      previousDescription = next.getAttribute('aria-describedby');
      next.setAttribute('aria-describedby', [previousDescription, tip.id].filter(Boolean).join(' '));
    }
    clearTimeout(timer);
    tip.textContent = text;
    tip.classList.remove('hidden');
    if (temporary) timer = window.setTimeout(hide, 2800);
  };
  document.addEventListener('pointerover', (event) => show(event));
  document.addEventListener('focusin', (event) => show(event));
  document.addEventListener('pointerdown', (event) => show(event, true));
  document.addEventListener('pointerout', (event) => {
    if (!timer && target && !target.contains((event as PointerEvent).relatedTarget as Node | null)) hide();
  });
  document.addEventListener('focusout', () => {
    if (!timer) hide();
  });
  document.addEventListener('droid-office:native-panel', (event) => {
    if (!(event as CustomEvent<{ open: boolean }>).detail.open) hide();
  });
}
