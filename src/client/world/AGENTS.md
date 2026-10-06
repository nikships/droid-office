# Client world

The three.js scene. DOM windows are `../ui`.

- Units are metres, +y is up. The floor is y = 0 and its XZ box is `FLOOR` in `src/shared/layout.ts`. A desk at `rotY` 0 seats the worker on the desk's +z side, facing −z. Change a wall, desk, seat or storey in `layout.ts` and render from that record.
- Three.js object forward is −z. `Object3D.lookAt` aims +z at the target, so it turns a −z-fronted mesh around. `player.ts` looks along `(-sin(camYaw), 0, -cos(camYaw))`. Take a new heading from that code. The magnum in `gun.ts` is built pointing +z; holders rotate the whole prop.
- A loaded GLB's front is whatever the generator exported. Measure it (the manifest bounds, or a test like `tests/gun.test.ts`) before mounting. A movement, camera or facing change gets a test that asserts a concrete direction.
- The mesh and the collider for one solid come from the same record in `layout.ts` or the prop manifest.
- Lit solids use `toon()` or `toonUnique()` from `toon.ts`. Screens, sprites, glass and decals use `MeshBasicMaterial`. Convert a loaded GLB's `MeshStandardMaterial` at load, the way `factory-props.ts` and `laptop.ts` do.
- GLBs in `public/props/` come from `tools/props/generate.py`. Regenerate there, then run `node tools/props/verify.mjs`.
- This tree stays importable from `node --import tsx` with no `window`, `document` or WebGL context created at import time. `gun.ts` says so at the top; keep it true for anything `tests/` loads.
