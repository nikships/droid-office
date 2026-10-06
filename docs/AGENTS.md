# Docs

- `guide.md` is the user-facing description of how the office behaves. A change to a subsystem updates the matching bullet under "How it works" in the same change. A rule that only an agent editing the repo needs goes in the nearest `AGENTS.md`.
- Links in `guide.md` are written from the repository root (`install.sh`, `.env.example`, `electron-builder.yml`), matching the rest of that file.
- Command blocks in the guide match the `package.json` scripts and the CLI help.
- `single-owner.md` is implemented. The office has one owner: no multiplayer, accounts, voice, chat or presence. `tests/no-media.test.ts` guards that boundary.
- Pictures in this directory are what the README shows. Replacing one is its own change.
