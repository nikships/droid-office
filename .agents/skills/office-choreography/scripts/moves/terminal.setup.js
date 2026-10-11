// Stand at a worker's desk, terminal closed. MOVE_ARG = desk id or worker name (default desk-1).
(async () => {
  const o = window.office;
  await o.closeAll();
  await o.goTo(window.__arg || 'desk-1');
  await __sleep(800);
  return JSON.stringify(o.state().player);
})();
