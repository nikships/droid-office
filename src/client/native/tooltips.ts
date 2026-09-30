/** Help stays inside the compositor panel rather than in an operating-system tooltip. */
export function nativeTooltipText(element: Element): string {
  const title = element.getAttribute('title')?.trim();
  if (!title) return '';
  return (
    title
      .replace(/press E\b/gi, 'press the controller trigger')
      .replace(/\(Q\)/g, '(Put back)')
      // Office-wide shortcut letters and desk keys are desktop-only; the panel keyboard's Tab moves focus instead.
      .replace(/\s*\((?:Tab|[A-Z/](?: at the desk)?)\)/g, '')
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
