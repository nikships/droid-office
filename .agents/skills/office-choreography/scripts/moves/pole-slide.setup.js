// On a floor that has another below it: stand back from the fire pole (layout POLES: x 6.8, z 1.6)
// and face it, so the take is the walk up and the slide.
(async () => {
  const o = window.office;
  await o.closeAll();
  await o.goTo('elevator');
  await __walkTo(8.3, -3, { run: true, maxMs: 6000 });
  await __walkTo(7.0, -4.5, { maxMs: 4000 });
  await __look(__yawTo(6.8, 1.6), -0.12, 600);
  await __sleep(600);
  return JSON.stringify(o.state().player);
})();
