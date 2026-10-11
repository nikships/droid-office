// Walk straight down the aisle. Stops at z 2.3, short of the potted plant. ~3.4 s; play at 0.5x.
(async () => {
  await __sleep(600);
  const r = await __walkTo(-6.0, 2.3, { maxMs: 12000, pitch: -0.05, tol: 0.25 });
  await __sleep(1200);
  return r;
})();
