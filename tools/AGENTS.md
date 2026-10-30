# Tools

Generators and measurement scripts. They are not part of `npm test` or the release build (the pure parts of `frame-bench` are covered by `tests/frame-bench.test.ts`).

- `tools/props/generate.py` runs inside Blender:

  ```bash
  blender --background --python tools/props/generate.py
  blender --background --python tools/props/generate.py -- macbook-base macbook-lid
  ```

  Props are metres, on the same scale as `DESK_SIZE` in `src/shared/layout.ts`. Output is `src/client/public/props/<name>.glb` and `manifest.json`. Passing names after `--` rebuilds those props and leaves the others byte-identical. The per-prop triangle budget is `TRI_BUDGET` in the script. After a regenerate, `node tools/props/verify.mjs` loads every GLB and checks it against the manifest.

- `node tools/android-terminal.mjs` copies xterm.js, its CSS, the Unicode 11 addon and xterm's licence from the root `node_modules` into `android/app/src/main/assets/`, so the Android app's terminal page runs the same emulator as the office. Run it after `npm ci` whenever `@xterm/xterm` or `@xterm/addon-unicode11` changes in `package-lock.json`, and commit what it writes; `tests/android-terminal.test.ts` fails until the copies match. The copies under `terminal/vendor/` are left out of Biome in `biome.jsonc`.

- `node --import tsx tools/android-model-icons.mjs` renders the web's pinned LobeHub SVGs into 128px transparent PNGs for native Android, preserving the official colors, gradients and masks without a runtime SVG dependency. It uses the installed Whiteboard Chromium with its sandbox on, no network. Run after changing `MODEL_BRANDS` or the bundled SVGs and commit the PNGs and hash manifest; `tests/model-brand.test.ts` checks source/output hashes, dimensions and monochrome exceptions.

- `uv run --with pillow python tools/tray-icon.py` draws the Mac app's menu bar icon from the glyph in `build/icon.png` into `src/desktop/tray-icon.ts`: 18 pt at @1x and @2x, orange for a running office and dimmed orange for a stopped one, never a template image (DroidProxy's icon is the same glyph in the menu bar's colour). Run it after changing the app icon and commit what it writes.

- `tools/terminal-symbols.py` rebuilds the office's OFL icon font from the Nerd Fonts subset whose hash is pinned in the script. It needs the fonttools and brotli versions named in that header. Output is the woff2 files under `src/client/public/fonts/`. Read `docs/terminal-glyphs.md` before changing the advance width or the outlines.

- `tools/frame-bench/` measures frame pacing and input-to-display latency of the packaged Mac app on a clone of the owner's office (read its `README.md` first). `bench.mjs` runs fixed scenarios at each frame rate cap and graphics configuration and collects `office.frameStats()`; `latency.mjs` measures a mouse move to the display; `matrix.sh` runs all of it on one build unattended; `display-trace/display-trace.swift` is the ScreenCaptureKit recorder both use (`control.mjs` and `native-control.mjs` measure its floor) (`swiftc -O`, needs Screen Recording permission). They only ever run an app with `--user-data-dir` against a clone (`launch.mjs` refuses the installed app, the owner's userData and :4600). Take the display lock when other agents share the machine, and record background load with every result.

- `tools/frame-bench/thermal.mjs` compares already-built revisions using real macmon CPU/GPU sensor readings and counterbalanced ABBA trials. It owns a clone-only server, sensor and isolated native app per trial; default 120 FPS must be both actually drawn and natively presented. `thermal-lib.mjs` holds the pure validation/statistics covered by `tests/thermal-bench.test.ts`; `thermal-report.mjs` creates the local report. Never run heavy checks alongside the sensor windows or commit raw clone/profile/sensor artifacts. The reusable agent playbook is `.agents/skills/office-thermals/SKILL.md`.

- `tools/scene-hash.mjs` hashes what the baked bounce light is a picture of (`SCENE_INPUTS`); `vite.config.ts` puts the result into the client as `__SCENE_HASH__`. Add a path to the list when a new folder or file feeds the scene the probes bake; `tests/scene-hash.test.ts` fails if one of them is gone.
