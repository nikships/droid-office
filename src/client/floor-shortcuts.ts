/** Command+1–9 selects the numbered floor; Command+0 selects floor 10. */
export function floorShortcut(e: KeyboardEvent, floors: readonly { id: string }[], go: (floor: string) => void): boolean {
  if (e.defaultPrevented || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return false;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (!digit) return false;
  const floor = floors[(Number(digit[1]) || 10) - 1];
  if (!floor) return false;
  // Capture before terminals, emotes and the browser's tab shortcuts get the number.
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!e.repeat) go(floor.id);
  return true;
}
