// Up on the roof, a few steps out from the elevator, looking right of the skyline.
(async () => {
  const o = window.office;
  await o.closeAll();
  if (!o.state().onRoof) await o.goTo('roof');
  await __sleep(1500);
  await __walkTo(8.5, -5, { maxMs: 6000 });
  await __look(0.5, 0.12, 600);
  await __sleep(500);
  return JSON.stringify(o.state().player);
})();
