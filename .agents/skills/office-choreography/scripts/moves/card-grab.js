// MOVE_ARG="#153|desk-3": aim at issue #153's card, E takes it, walk it to desk-3, E there.
// Handing a card to a free desk hires a worker on that issue at once (no dialog), in a worktree
// only when the tab's droid-office.worktree pref is '1' (boot.sh sets it). Leave out "|desk" to
// stop once the card is in hand. Dry-run the aim first (see SKILL.md): a miss wastes a take.
(async () => {
  const o = window.office;
  const [needle, desk] = String(window.__arg || '').split('|');
  await __sleep(800);
  await __hold(['KeyW'], 450);
  await __pan(76, 22, 1300);
  if (!(await __aim(needle))) return `MISSED: ${__hint()}`;
  await __sleep(500);
  __tap('KeyE', 'e');
  await __sleep(1600);
  if (!desk) return JSON.stringify({ carrying: o.state().player.carrying });
  await o.goTo(desk, { walk: true });
  await __sleep(400);
  __tap('KeyE', 'e');
  await __sleep(6000);
  return JSON.stringify({ carrying: o.state().player.carrying, workers: o.state().workers.map((w) => `${w.name}@${w.desk}:${w.status}`) });
})();
