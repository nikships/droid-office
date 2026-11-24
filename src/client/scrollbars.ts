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

function input() {
  lastInput = performance.now();
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable], .xterm');
}

document.addEventListener('wheel', input, { capture: true, passive: true });
document.addEventListener('touchmove', input, { capture: true, passive: true });
document.addEventListener('pointerdown', input, true);
document.addEventListener(
  'keydown',
  (event) => {
    if (isEditable(event.target)) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab'].includes(event.key)) input();
  },
  true,
);
document.addEventListener(
  'scroll',
  (event) => {
    // xterm terminals manage their own minimal scrollbar in term-scrollbar.ts.
    if (performance.now() - lastInput < 1000 && event.target instanceof Element && !event.target.closest('.xterm')) showScrollbar(event.target);
  },
  true,
);
