# Heavenly ascent

`src/client/world/casualties.ts` renders downed workers and their departure. The server
still owns the 30-second revival deadline and dismissal; only the cleanup animation changes.

A confirmed dismissal, either a second hit or an expired revival window, casts a soft
white-gold beam over the fallen worker. The body eases face-up as the beam appears for
0.8 seconds, then floats directly upward at full size for 3.6 seconds, through the ceiling.
There are no medics, stretcher, routes or elevator interactions.

The blood pool or spell circle shrinks away during the rise. The laptop shuts and shrinks
as before. Once the whole worker clears the ceiling, the empty beam fades over 0.7 seconds.
The scene releases the worker, laptop and beam resources exactly once. Changing floors
cancels the visual sequence and releases dismissed workers; revivable ones return to their seats.

The beam uses two translucent columns, a floor glow and a small warm light. Each beam owns
its geometry and materials; shared worker materials remain untouched.

`tests/casualties.test.ts` covers falling, revival, confirmation, vertical ascent and cleanup.
`tests/casualties-ascent.test.ts` checks real worker geometry at different headings and sizes,
floor and loft heights, both downed looks, smooth phase boundaries and resource disposal.
