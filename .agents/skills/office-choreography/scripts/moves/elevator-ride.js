// Elevator panel (every floor's busy/waiting counts) for 3 s, then ride to MOVE_ARG (a floor id).
// The panel shows at ~0.5-3.5 s and the doors open on the new floor at ~5-6 s.
(async () => {
  const o = window.office;
  await __sleep(500);
  await o.open('elevator');
  await __sleep(3000);
  await o.closeAll();
  o.ride(window.__arg); // not awaited: the recording keeps running through the ride
  await __sleep(9000);
  return JSON.stringify({ floor: o.state().floor.id, riding: o.state().riding });
})();
