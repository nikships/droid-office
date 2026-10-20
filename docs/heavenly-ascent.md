# Heavenly ascent

`src/client/world/casualties.ts` renders departure after a fully charged gunshot or wand bolt.
Normal hits only open terminals. There is no downed state, bleed-out animation or revival control.

A charged dismissal casts a soft white-gold beam over the worker immediately. The worker
eases face-up as the beam appears for 0.8 seconds, then floats directly upward at full size
for 3.6 seconds, through the ceiling. There are no medics, stretcher, routes or elevator interactions.

The laptop shuts and shrinks. Once the whole worker clears the ceiling, the empty beam fades
over 0.7 seconds. The scene releases the worker, laptop and beam resources exactly once.
Changing floors cancels the visual sequence and releases dismissed workers.

The beam uses two translucent columns, a floor glow and a small warm light. Each beam owns
its geometry and materials; shared worker materials remain untouched.

`tests/casualties.test.ts` covers immediate ascent, phase boundaries and cleanup.
`tests/casualties-ascent.test.ts` checks real worker geometry at different headings and sizes,
floor and loft heights, both weapon looks, smooth phase boundaries and resource disposal.
