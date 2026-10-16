# Website

The public marketing site, separate from the 3D office client in `src/client/`.
React, Vite and Tailwind; an npm workspace using the root `package-lock.json`.

- From the repository root: `npm run dev:website`, `npm run build:website`.
- `npm run typecheck` and `npm run lint` include the website.
- `npm run deploy:website` uses Firebase CLI to deploy only Hosting to project `droid-office`.
  The root `firebase.json` typechecks and builds first, then publishes `website/dist`.
- The public site is https://droid-office.web.app.
- Preserve the supplied design and content, including explicit video placeholders until footage is ready.
