# README media

Seven short loops, each 960 × 540, 3–5 seconds and at most 2,500,000 bytes per animated file. Every loop has an animated WebP, a 30 FPS palette-generated GIF fallback and a JPEG poster.

The visual sequence leads with occupied desks, large live screens in the 3D room, opening a worker's terminal and a connected team. Worker status, physical issue cards and Whiteboard feedback follow. There are no settings-only, empty-office or rooftop demos.

The README selects the JPEG for `prefers-reduced-motion: reduce`, WebP otherwise, and GIF when WebP is unsupported. HTML images have no video-style `poster` attribute: a JPEG is not claimed to appear while an animation downloads. The [static gallery](posters.md) also works without media-query support.

## Sources

All excerpts come from the already-published 1920 × 1080, 30 FPS website recordings in this repository (media revision `fe893cf7`). Their real-office clone provenance is documented in `website/AGENTS.md`. They stay at their native 30 FPS: neither the old 8.33 FPS README GIFs nor interpolated frames are used. No new workers, cloud sessions, issues or pull requests are created for these excerpts.

| Asset | Source | Start | Length | WebP FPS |
| --- | --- | ---: | ---: | ---: |
| `hero-workers` | `website/public/videos/reel.mp4` | 1.7 s | 3 s | 30 |
| `spatial-terminals` | `website/public/videos/tour-01.mp4` | 11.5 s | 4.3 s | 30 |
| `live-terminal` | `website/public/videos/tour-02.mp4` | 0.3 s | 3.5 s | 30 |
| `team-subagents` | `website/public/videos/team-lead.mp4` | 9 s | 4.5 s | 30 |
| `worker-status` | `website/public/videos/reel.mp4` | 68.5 s | 3.3 s | 30 |
| `card-grab` | `website/public/videos/tour-04.mp4` | 5.4 s | 3 s | 30 |
| `whiteboard-collab` | `website/public/videos/tour-06.mp4` | 15.3 s | 4.5 s | 30 |

The spatial-terminals excerpt shows live output on two workers' physical screens. The live-terminal excerpt shows opening a worker's terminal, not a settings panel. The team excerpt shows real workers and their floor links, not simulated worktree creation. The worker-status excerpt shows completion, not a montage of every tool pose or a merge celebration. The Android section uses the existing real app screenshots in `android/docs/`.

## Re-recording

Follow `.agents/skills/office-clone/SKILL.md` and `.agents/skills/office-demo-staging/SKILL.md` for a populated clone with real workers. Obtain the owner's go-ahead for paid sessions or external writes. Never film the owner's running terminals without permission or replace worker activity with fabricated output.

Use `office-choreography` to frame the active desks and `office-video-capture` to record. Wait for `#warmup.on` to disappear: the player can move before the light bake finishes. Use `?pace=full`, record camera movement at 60 FPS, and preserve the actual capture rate when encoding. Review the action, terminal content and moving-frame uniqueness before cutting; a technically smooth empty room is not a worker demo.

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

Keep both formats below 2.5 MB: lower WebP quality, GIF palette size or GIF precision rather than lowering resolution or inserting repeated frames. GIF optimization uses `gifsicle -O3` with lossiness increased only as needed to fit the budget. GIF's centisecond timing approximates 30 FPS with alternating 30/40 ms delays; WebP uses 33/34 ms delays. An encoder may combine identical frames into a longer hold.

Check dimensions, frame delays, total duration, infinite looping, file sizes and local links. On GitHub itself, inspect desktop and narrow/mobile layouts, light and dark themes, all loaded images, WebP selection, GIF fallback and reduced-motion posters. Browser screenshots are verification evidence, not replacement demo footage.
