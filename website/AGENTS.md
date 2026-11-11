# Website

Public React, Vite and Tailwind marketing site (`https://droid-office.web.app`), managed as an npm workspace under the root `package-lock.json` and separate from `src/client/`.

- Run from the repository root: `npm run dev:website`, `npm run build:website`, and `npm run deploy:website` (Firebase Hosting project `droid-office`; `firebase.json` runs typecheck and build before publishing `website/dist`). Root `npm run lint` and `npm run typecheck` cover this workspace.
- Preserve the supplied design and copy unless asked to change them.
- `public/videos/` holds 1920×1080 H.264 (`+faststart`) captures and posters from a clone of the owner's office recorded with the `office-video-capture` skill (only the reel carries an AAC Lyria bed and plays unmuted with controls); replace clips by re-recording from a real-office clone rather than mocking footage.
