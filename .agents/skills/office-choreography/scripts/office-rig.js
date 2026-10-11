// The camera rig: smooth, scriptable first-person moves on top of `window.office`.
// Load it into the office tab with `agent-browser eval --stdin < office-rig.js` (boot.sh does).
// It only touches this tab: an injected stylesheet and synthetic pointer/key events.
//
// Facing convention, as office.state().player reports it: forward at facing f is (sin f, cos f)
// in x/z, and one pixel of drag turns 0.005 rad.
(() => {
  if (!document.getElementById('__cap_css')) {
    const s = document.createElement('style');
    s.id = '__cap_css';
    // The FPS counter, the "Click to look around" hint and the jukebox's SoundCloud player.
    s.textContent = `#fps, .look-hint { display: none !important; }
      details:has(.jb-sc-title) { display: none !important; }`;
    document.head.appendChild(s);
  }
  const scene = document.getElementById('scene');
  const P = () => window.office.state().player;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // A real click in a dialog grabs pointer lock, and drag-to-look does nothing while it is held.
  const unlock = () =>
    new Promise((r) => {
      if (!document.pointerLockElement) return r();
      document.exitPointerLock();
      setTimeout(r, 120);
    });
  window.__unlock = unlock;

  // Drag-to-look with a touch pointer (no pointer lock), eased, one move per frame: reads as a dolly.
  window.__pan = (dx, dy = 0, ms = 2000) =>
    unlock().then(
      () =>
        new Promise((resolve) => {
          const x0 = 960,
            y0 = 540;
          let lx = x0,
            ly = y0;
          scene.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: x0, clientY: y0, bubbles: true }));
          const t0 = performance.now();
          const step = (now) => {
            const t = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
            const k = ease(t);
            const nx = x0 + dx * k,
              ny = y0 + dy * k;
            if (nx !== lx || ny !== ly) {
              window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: nx, clientY: ny, bubbles: true }));
              lx = nx;
              ly = ny;
            }
            if (t < 1) requestAnimationFrame(step);
            else {
              window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 7, clientX: nx, clientY: ny, bubbles: true }));
              resolve(JSON.stringify(P()));
            }
          };
          requestAnimationFrame(step);
        }),
    );

  const kd = (code, key) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: key ?? code, bubbles: true }));
  const ku = (code, key) => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: key ?? code, bubbles: true }));
  // Hold keys by code (['KeyW','ShiftLeft'] runs forward) for ms.
  window.__hold = (codes, ms) =>
    new Promise((resolve) => {
      codes.forEach((c) => kd(c));
      setTimeout(() => {
        codes.forEach((c) => ku(c));
        resolve(JSON.stringify(P()));
      }, ms);
    });
  // One key press: __tap('KeyE','e'), __tap('Digit7','7'), __tap('Space',' '), __tap('ArrowLeft').
  window.__tap = (code, key) => {
    kd(code, key);
    setTimeout(() => ku(code, key), 60);
    return 'tapped';
  };
  window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Hide the side panels (Workers list and friends) for a clean frame; the crosshair hint stays.
  window.__clean = (on = true) => {
    let s = document.getElementById('__cap_clean');
    if (!s) {
      s = document.createElement('style');
      s.id = '__cap_clean';
      document.head.appendChild(s);
    }
    s.textContent = on ? 'aside.side { display: none !important; }' : '';
    return `clean=${on}`;
  };

  // Turn to an absolute yaw and/or pitch (radians; null keeps the current one) over ms.
  window.__look = (yaw, pitch, ms = 1200) => {
    const p = P();
    const dyaw = yaw == null ? 0 : wrap(yaw - p.facing);
    const dp = pitch == null ? 0 : pitch - p.lookPitch;
    return window.__pan(-dyaw / 0.005, -dp / 0.005, ms);
  };
  // The yaw that faces a floor point.
  window.__yawTo = (x, z) => {
    const p = P();
    return Math.atan2(x - p.x, z - p.z);
  };

  // Walk (or run) to (x, z), holding W and steering every frame. Collisions are real: route round
  // chairs, plants and desks with several short __walkTo calls (waypoints). Stops after maxMs.
  window.__walkTo = (x, z, { run = false, tol = 0.35, pitch = null, maxMs = 20000 } = {}) =>
    unlock().then(
      () =>
        new Promise((resolve) => {
          const codes = run ? ['KeyW', 'ShiftLeft'] : ['KeyW'];
          let lx = 960,
            ly = 540;
          scene.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 8, clientX: lx, clientY: ly, bubbles: true }));
          codes.forEach((c) => kd(c));
          const t0 = performance.now();
          const step = (now) => {
            const p = P();
            const d = Math.hypot(x - p.x, z - p.z);
            if (d < tol || now - t0 > maxMs) {
              codes.forEach((c) => ku(c));
              window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 8, clientX: lx, clientY: ly, bubbles: true }));
              return resolve(JSON.stringify(P()));
            }
            const err = wrap(window.__yawTo(x, z) - p.facing);
            const turn = Math.max(-0.06, Math.min(0.06, err * 0.12));
            let dy = 0;
            if (pitch != null) dy = -Math.max(-0.02, Math.min(0.02, (pitch - p.lookPitch) * 0.1)) / 0.005;
            lx += -turn / 0.005;
            ly += dy;
            window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 8, clientX: lx, clientY: ly, bubbles: true }));
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );

  // What the crosshair is on right now (`#hint`), e.g. "📌 #153 Jukebox: …ETake itORead it".
  window.__hint = () => document.getElementById('hint')?.textContent || '';
  // Nudge the crosshair in a small spiral until the hint contains `needle` (an issue number, a
  // worker name). Resolves true when it is on target. Aim close first (goTo + a __pan).
  window.__aim = async (needle, step = 12) => {
    const tries = [
      [step, 0],
      [0, step],
      [-2 * step, 0],
      [0, -2 * step],
      [3 * step, 0],
      [0, 3 * step],
      [-4 * step, 0],
      [0, -4 * step],
    ];
    for (const [dx, dy] of tries) {
      if (window.__hint().includes(needle)) return true;
      await window.__pan(dx, dy, 180);
    }
    return window.__hint().includes(needle);
  };

  return 'rig loaded';
})();
