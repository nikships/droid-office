// 7 draws the wand; 1-6 cast Lumos, Swish and flick, Sparkler, Ship it (confetti), Run the build, Protego.
// This take: draw, Sparkler, Ship it (~5-6.5 s), Run the build, Swish. ~12.8 s.
(async () => {
  await __sleep(400);
  __tap('Digit7', '7');
  await __sleep(1400);
  __tap('Digit3', '3');
  await __sleep(2600);
  __tap('Digit4', '4');
  await __sleep(3000);
  __tap('Digit5', '5');
  await __sleep(2800);
  __tap('Digit2', '2');
  await __sleep(2400);
  return JSON.stringify(window.office.state().player);
})();
