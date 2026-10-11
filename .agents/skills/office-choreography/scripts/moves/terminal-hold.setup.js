// Terminal already open at a desk, for still-ish B-roll of a live PTY. MOVE_ARG = desk id or worker name.
(async () => {
  const o = window.office;
  await o.closeAll();
  await o.goTo(window.__arg || 'desk-1');
  await __sleep(500);
  await o.interact('E');
  await __sleep(1800);
  return JSON.stringify(o.state().modals);
})();
