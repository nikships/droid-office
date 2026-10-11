// Walk up to the pole's railing gap, look down the hole, E: hop on, slide (speed lines, floor
// sign) and land one floor down. The hole opens toward -z, so approach from that side.
(async () => {
  const o = window.office;
  await __sleep(500);
  await __walkTo(6.8, 0.3, { tol: 0.3, maxMs: 5000 });
  await __look(null, -0.3, 400);
  __tap('KeyE', 'e');
  await __sleep(6500);
  return JSON.stringify({ floor: o.state().floor.id, player: o.state().player });
})();
