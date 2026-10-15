# Tools

Generators and measurement scripts. They are not part of `npm test` or the release build (the pure parts of `frame-bench` are covered by `tests/frame-bench.test.ts`).

- `tools/props/generate.py` runs inside Blender:

  ```bash
  blender --background --python tools/props/generate.py
  blender --background --python tools/props/generate.py -- macbook-base macbook-lid
  ```

  Props are metres, on the same scale as `DESK_SIZE` in `src/shared/layout.ts`. Output is `src/client/public/props/<name>.glb` and `manifest.json`. Passing names after `--` rebuilds those props and leaves the others byte-identical. The per-prop triangle budget is `TRI_BUDGET` in the script. After a regenerate, `node tools/props/verify.mjs` loads every GLB and checks it against the manifest.

- `node tools/android-terminal.mjs` copies xterm.js, its CSS, the Unicode 11 addon and xterm's licence from the root `node_modules` into `android/app/src/main/assets/`, so the Android app's terminal page runs the same emulator as the office. Run it after `npm ci` whenever `@xterm/xterm` or `@xterm/addon-unicode11` changes in `package-lock.json`, and commit what it writes; `tests/android-terminal.test.ts` fails until the copies match. The copies under `terminal/vendor/` are left out of Biome in `biome.jsonc`.

- `tools/terminal-symbols.py` rebuilds the office's OFL icon font from the Nerd Fonts subset whose hash is pinned in the script. It needs the fonttools and brotli versions named in that header. Output is the woff2 files under `src/client/public/fonts/`. Read `docs/terminal-glyphs.md` before changing the advance width or the outlines.

- `tools/frame-bench/` measures frame pacing and input-to-display latency of the packaged Mac app on a clone of the owner's office (read its `README.md` first). `bench.mjs` runs fixed scenarios at each frame rate cap and graphics configuration and collects `office.frameStats()`; `latency.mjs` measures a mouse move to the display; `display-trace/display-trace.swift` is the ScreenCaptureKit recorder both use (`swiftc -O`, needs Screen Recording permission). They only ever run an app with `--user-data-dir` against a clone (`launch.mjs` refuses the installed app, the owner's userData and :4600). Take the display lock when other agents share the machine, and record background load with every result.
