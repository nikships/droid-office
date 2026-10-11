# From takes to a finished video

Cut takes into a finished piece (a demo reel, a feature clip, a launch video) with HyperFrames. **First load the `hyperframes` skill**, which routes the work. The notes below are what the office adds to it. `example-launch/` holds the brief and the composition of the October 2026 launch video (46 s, 16:9, for X). Generated attributes are left out of it, and its asset paths point into its own project.

## Look

- Background `#070403`, text `#f6efe8`, accent `#ff6a1f`. These are the app's `#020202` and `#ee6018`, brightened for video.
- Geist and Geist Mono from `src/client/public/fonts/`.
- The icon `build/icon.png`.
- The Android screenshots in `android/docs/*.jpg` for a phone beat.
- Put a dark plate behind captions, because office footage is busy.
- If the piece is public, add a small line on the end card: "A community project. Not affiliated with or endorsed by Factory."

## Voiceover and timing

- Generate the voiceover with `gemini-aio generate_speech`. Fenrir or Puck suit hype; put the delivery in `style`. About 95 words fill 43 s.
- Transcribe it with `transcribe_audio` (`verbatim`, `word_timestamps: true`), then run `scripts/words.py <output> words.json`. It prints sentence start and end times.
- Put each cut on a sentence's first word, with one feature per sentence.
- If a take runs long, rewrite the words; don't speed up the audio.

## Music

- Generate the bed with `generate_music` (`lyria-3.5`, wav). Write the prompt as a timeline (cold open, the drop at N s, room for a voice, a breakdown, the final hit).
- Measure what came back with `scripts/energy.sh` and `npx hyperframes beats`. The sections rarely land where you asked.
- Put the drop on the voiceover's turn. Split the bed into two clips to skip a dip.
- Carve the bed under the voice with `hyperframes-audio`'s `carve.mjs --core <dir>`. `<dir>` is a local `npm i @hyperframes/core@<cli version>`, in a folder whose name does not start with a dot. Carving a bed that already has fades writes a second `data-automation` attribute; merge its `lanes` into the first.

## Footage in the edit

- Each cut is its own `<video class="clip">`.
- Set the source in-point with `data-media-start`.
- Set the speed with `data-playback-rate`: 0.44–0.5 for 60 fps dollies, 1.2–2 to tighten slow UI.
- Office footage is dark. Brighten it with `npx hyperframes media-treatment --selector "video.grade" --grading '{"adjust":{"exposure":0.4,"shadows":0.35,"blacks":0.08,"vibrance":0.15}}' --apply`. The key is `adjust`.

## Check and render

- Run `lint` and `check`.
  - For a second writer on a relative tween, write absolute values instead.
  - For `content_overlap` on layering you meant, mark it with `data-layout-allow-overlap`.
- Take `snapshot`s at one time per sentence and review them.
- Render with `render --quality delivery --video-frame-format png`; PNG frames keep UI text sharp.
- Run `scripts/verify.sh <mp4>`. It prints the streams, the loudness (aim for about −16 to −14 LUFS with a true peak under −1 dBFS) and a 16-frame sheet.
