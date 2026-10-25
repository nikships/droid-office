# README media

Eight short loops, each 960 × 540, 3–5 seconds and at most 2,500,000 bytes per animated file. Every loop has an animated WebP, a 30 FPS palette-generated GIF fallback and a JPEG poster.

The README selects the JPEG for `prefers-reduced-motion: reduce`, WebP otherwise, and GIF when WebP is unsupported. HTML images have no video-style `poster` attribute: a JPEG is not claimed to appear while an animation downloads. The [static gallery](posters.md) also works without media-query support.

## Sources

The new captures use this repository at `0ea0f060`, built locally, against a clone of the owner's installed office. They use the owner's real floors, boards and settings, not fabricated workers or API responses. The source takes are recorded at 1280 × 720 and 60 FPS with `?pace=full` through the `office-clone`, `office-choreography` and `office-video-capture` skills.

Worker and collaboration excerpts come from the already-published 1920 × 1080, 30 FPS website recordings in this repository (media revision `fe893cf7`). Their real-office clone provenance is documented in `website/AGENTS.md`. They stay at their native 30 FPS: neither the old 8.33 FPS README GIFs nor interpolated frames are used. No new workers, cloud sessions, issues or pull requests are created for these captures.

| Asset | Source | Start | Length | WebP FPS |
| --- | --- | ---: | ---: | ---: |
| `hero-tour` | Fresh clone, `aisle-dolly` setup and move | 0 s | 3.4 s | 60 |
| `card-grab` | `website/public/videos/tour-04.mp4` | 5.4 s | 3 s | 30 |
| `worker-status` | `website/public/videos/reel.mp4` | 68.5 s | 3.3 s | 30 |
| `merge-gong` | Fresh clone, press E at the brass gong | 0 s | 3.4 s | 60 |
| `worktrees` | Fresh clone, Settings → Workers → Worktrees | 0 s | 3.9 s | 60 |
| `elevator-floors` | Fresh clone, elevator from project floor to roof | 0 s | 4 s | 60 |
| `whiteboard-collab` | `website/public/videos/tour-06.mp4` | 15.3 s | 4.5 s | 30 |
| `team-subagents` | `website/public/videos/team-lead.mp4` | 9 s | 4.5 s | 30 |

The gong excerpt shows a manual strike, not a newly staged merge or a simulated dance party. The worker-status excerpt shows completion, not a montage claiming to demonstrate every tool pose. The worktree excerpt shows real setup settings, not a simulated multi-worker run. The Android section uses the existing real app screenshots in `android/docs/`, not an invented phone notification or an animation presented as an app recording.

## Re-recording

Follow `.agents/skills/office-clone/SKILL.md`, then boot the choreography session against the clone's URL with its `load-settings.js`, `OFFICE_FLOOR=droid-office`, `CAPTURE_W=1280` and `CAPTURE_H=720`. Wait for `#warmup.on` to disappear before recording the world: the player can move before the light bake finishes. Never point recording commands at the owner's running office.

- **Hero:** `FPS=60 rec.sh hero-tour moves/aisle-dolly.setup.js moves/aisle-dolly.js`.
- **Gong:** `office.goTo('gong')`, step back for 200 ms with `__hold(['KeyS'], 200)`, then record a 300 ms hold, `office.interact('E')` and a 3 s hold.
- **Worktrees:** open Settings → Workers. Start `#settings-pane-workers` at scroll position 350, wait 500 ms, scroll smoothly to its bottom, then hold for 3.3 s. This only reads the existing setup.
- **Elevator:** `office.goTo('elevator')`, then record `await office.ride('roof')`, `await __look(0, -0.1, 700)` and `await __sleep(1700)`.

The names above refer to the scripts under `.agents/skills/office-choreography/scripts/` and `.agents/skills/office-video-capture/scripts/`. Use each skill's full environment setup. Review contact sheets and moving-frame uniqueness before encoding; static holds naturally repeat.

## Encoding

Trim the ranges above, scale with Lanczos to 960 × 540 and keep the source frame rate. Dissolve the final 0.25 s into the opening 0.25 s for a soft loop boundary. From that trimmed, silent master:

```bash
# Use an ffmpeg build with libwebp_anim, or img2webp as described below.
ffmpeg -i loop.mp4 -an -c:v libwebp_anim -q:v 72 \
  -compression_level 4 -loop 0 loop.webp

ffmpeg -i loop.mp4 -filter_complex \
  "[0:v]fps=30,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
  -loop 0 loop.gif

gifsicle -O3 --lossy=80 loop.gif -o loop.optimized.gif

ffmpeg -ss 2 -i loop.mp4 -frames:v 1 -q:v 2 loop.poster.jpg
```

These WebPs use `img2webp` (libwebp) because the capture machine's ffmpeg lacks a WebP encoder. Extract PNG frames from the master, then pass them in frame order to `img2webp -loop 0 -min_size -lossy -q 72 -m 4`, with a `-d` duration before each frame and `-o loop.webp` at the end. Frame `i` gets `round((i + 1) * 1000 / fps) - round(i * 1000 / fps)` milliseconds, with `i` starting at zero.

Keep both formats below 2.5 MB: lower WebP quality, GIF palette size or GIF precision rather than lowering resolution or inserting repeated frames. GIF optimization uses `gifsicle -O3` with lossiness increased only as needed to fit the budget. GIF's centisecond timing approximates 30 FPS with alternating 30/40 ms delays; WebP preserves 60 FPS with 16/17 ms delays where captured.

Check dimensions, frame delays, total duration, infinite looping, file sizes and local links. On GitHub itself, inspect desktop and narrow/mobile layouts, light and dark themes, all loaded images, WebP selection, GIF fallback and reduced-motion posters. Browser screenshots are verification evidence, not replacement demo footage.
