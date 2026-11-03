# Website sections

The public marketing site at https://droid-office.web.app is one landing page of numbered sections: hero, play, tour, agents, pocket, why, workers and install. Each has a heading and captured videos from the owner's office.

## Sub-features

- `site-sections` renders every section with its heading.
- `site-tour` switches the tour panel with its tabs (`#tour-panel`, `tab-<id>`).
- `site-console` loads with no console errors.

## How to get to it (user POV)

- Open the site and scroll, or follow the header links to `#play`, `#tour` and the other ids.

## Driving it with website-sections.mjs

Preconditions:

- `bun install` at the root (the website is a Bun workspace).
- Port 5199 is free, so the run does not take the office's Vite port 5173.

- **Serve.** Run `bun run --cwd website dev --port 5199 --strictPort` as a background process in its own process group. Vite prints `Local: http://127.0.0.1:5199/`.
- **Check the sections.** Run `node .agents/skills/verify-droid-office/scripts/website-sections.mjs http://127.0.0.1:5199/ "$EVIDENCE/website"`. Exit code `0`. It prints one `section <id>: <heading>` line for each of the eight ids, saves `section-<id>.png` for each, and writes `website.json` with the page's console errors.
- **Stop.** Kill the dev server's process group, and only that.
- **Production build.** Run `bun run build:website`. Exit code `0`. `website/dist/index.html` exists.

## Gotchas

- Pass Vite flags to the website's own `dev` script (`bun run --cwd website dev --port …`), not through the root `dev:website` alias.
- The videos are real captures. Replace one by re-recording it with `office-video-capture`, never with a mock.
- A new section needs its id in `SECTIONS` in `website-sections.mjs`, or the check passes without it.
