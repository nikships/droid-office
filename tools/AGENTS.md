# Tools

Generators. They are not part of `npm test` or the release build.

- `tools/props/generate.py` runs inside Blender:

  ```bash
  blender --background --python tools/props/generate.py
  blender --background --python tools/props/generate.py -- macbook-base macbook-lid
  ```

  Props are metres, on the same scale as `DESK_SIZE` in `src/shared/layout.ts`. Output is `src/client/public/props/<name>.glb` and `manifest.json`. Passing names after `--` rebuilds those props and leaves the others byte-identical. The per-prop triangle budget is `TRI_BUDGET` in the script. After a regenerate, `node tools/props/verify.mjs` loads every GLB and checks it against the manifest.

- `tools/terminal-symbols.py` rebuilds the office's OFL icon font from the Nerd Fonts subset whose hash is pinned in the script. It needs the fonttools and brotli versions named in that header. Output is the woff2 files under `src/client/public/fonts/`. Read `docs/terminal-glyphs.md` before changing the advance width or the outlines.
