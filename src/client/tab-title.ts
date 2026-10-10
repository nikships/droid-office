/**
 * The browser tab's name. The waiting count is a badge for when you've left the tab: it shows
 * while the tab is in the background and disappears once it's focused again.
 */
export function officeTitle(name: string | undefined, waiting: number, background: boolean): string {
  const base = `${name ? `${name} · ` : ''}Droid Office`;
  if (!background || waiting < 1) return base;
  return `(${waiting}) ${base}`;
}
