// Back of the centre aisle, looking down it toward the boards. Pair with aisle-dolly.js at FPS=60.
(async () => {
  const o = window.office;
  await o.closeAll();
  await o.goTo('desk-12');
  await __walkTo(-6.0, 9.6, { run: true, maxMs: 8000 });
  await __look(Math.PI, -0.1, 800);
  await __sleep(600);
  return JSON.stringify(o.state().player);
})();
