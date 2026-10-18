# Website

The public marketing site, separate from the 3D office client in `src/client/`.
React, Vite and Tailwind; an npm workspace using the root `package-lock.json`.

- From the repository root: `npm run dev:website`, `npm run build:website`.
- `npm run typecheck` and `npm run lint` include the website.
- `npm run deploy:website` uses Firebase CLI to deploy only Hosting to project `droid-office`.
  The root `firebase.json` typechecks and builds first, then publishes `website/dist`.
- The public site is https://droid-office.web.app.
- Preserve the supplied design and content.
- The videos and their posters are in `public/videos/` (1280×720 H.264, no audio, `+faststart`). They are captured from a clone of the owner's office with the `office-video-capture` skill; replace a clip by re-recording it, not with mocked footage.
