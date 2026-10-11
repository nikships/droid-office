// Back off a wall board and turn a little right of it. MOVE_ARG = issues | pulls | actions | ci | computers | services.
(async () => {
  const o = window.office;
  await o.closeAll();
  await o.goTo(window.__arg || 'computers');
  await __hold(['KeyS'], 650);
  await __sleep(300);
  const p = o.state().player;
  window.__boardFacing = p.facing;
  await __look(p.facing + 0.2, p.lookPitch - 0.12, 400);
  await __sleep(400);
  return 'ok';
})();
