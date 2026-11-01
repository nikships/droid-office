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
  lastInput = performance.now();
  // xterm scrolls its own virtual viewport, which does not always emit a DOM
  // scroll event. Its scrollbar is a child of the terminal, not a native one.
  if (event.target instanceof Element && (event.type !== 'pointerdown' || event.target.closest('.scrollbar'))) {
    const terminal = event.target.closest('.xterm');
    if (terminal) showScrollbar(terminal);
  }
}

document.addEventListener('wheel', input, { capture: true, passive: true });
document.addEventListener('touchmove', input, { capture: true, passive: true });
document.addEventListener('pointerdown', input, true);
document.addEventListener(
  'keydown',
  (event) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab'].includes(event.key)) input(event);
  },
  true,
);
document.addEventListener(
  'scroll',
  (event) => {
    if (performance.now() - lastInput < 1000 && event.target instanceof Element) showScrollbar(event.target);
  },
  true,
);
