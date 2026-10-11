// Indoors, in the aisle by the desks (busy background). Holsters the wand first if it is out.
// Settings -> You picks the sidearm: check state().player.sidearm === 'wand' before filming.
(async () => {
  const o = window.office;
  await o.closeAll();
  if (o.state().player.sidearm !== 'wand') return `SIDEARM IS NOT THE WAND: ${o.state().player.sidearm}`;
  if (o.state().player.gun) {
    __tap('Digit7', '7');
    await __sleep(1500);
  }
  await o.goTo('desk-4');
  await __walkTo(-3.0, 2.5, { run: true, maxMs: 8000 });
  await __look(Math.PI + 0.12, 0.06, 500);
  await __sleep(600);
  return JSON.stringify(o.state().player);
})();
