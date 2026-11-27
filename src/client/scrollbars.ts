// Programmatic output and layout changes should not light up scrollbars.
let lastInput = -Infinity;
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function showScrollbar(element: Element) {
  element.classList.add('user-scrolling');
  clearTimeout(timers.get(element));
  timers.set(
    element,
    setTimeout(() => {
      element.classList.remove('user-scrolling');
      timers.delete(element);
    }, 900),
  );
}

function input(event: Event) {
  if (event.target instanceof Element && event.target.closest('.office-wterm')) return;
  lastInput = performance.now();
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable], .office-wterm');
}

document.addEventListener('wheel', input, { capture: true, passive: true });
document.addEventListener('touchmove', input, { capture: true, passive: true });
document.addEventListener('pointerdown', input, true);
document.addEventListener(
  'keydown',
  (event) => {
    if (isEditable(event.target)) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab'].includes(event.key)) input(event);
  },
  true,
);
document.addEventListener(
  'scroll',
  (event) => {
    // Terminals handle their own scroll gestures.
    if (performance.now() - lastInput < 1000 && event.target instanceof Element && !event.target.closest('.office-wterm')) showScrollbar(event.target);
  },
  true,
);
