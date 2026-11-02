# Whiteboard

The Whiteboard is the floor's shared board of cards that agents and the owner make: HTML, files, images, links and canvases, with comments, stickies and pictures on them. The owner opens it from the ☰ menu or the companion. Android shows it in the Board tab.

## Sub-features

- `wb-open` opens the Whiteboard window from the ☰ menu.
- `wb-cards` shows every card on the floor, newest first.
- `wb-companion` opens the same board from the web companion's **Whiteboard** button.
- `wb-android` lists the same cards in the Android Board tab (`board.grid`, `board.card/<id>`).

## How to get to it (user POV)

- ☰ menu → Whiteboard in the office.
- **Whiteboard** in the web companion's top bar.
- The **Board** tab in the Android app.

## Driving it with drive.sh and window.office

Preconditions:

- `doctor.sh "$RUN"` passes.
- In a clone, the floor's Whiteboard is the owner's copy. A fresh office starts with an empty board.

- **Open.** In a steps file, run `await open('whiteboard')`. `office.state().modals` contains `{ label: 'Whiteboard' }`, and `.modal.wb[aria-label=Whiteboard]` is visible. Shot `wb-open.png`.
- **Cards.** Read the card titles in the window. In a clone they match `<floor>/.droid-office/` Whiteboard state copied from the owner. In a fresh office the window shows its empty state.
- **Companion.** Open `/dashboard` in a second page and click the `Whiteboard` button. The same cards render.
- **Android.** On a paired device, tap `tab.board`. `board.grid` lists `board.card/<id>` nodes whose `board.card.title` match the office's cards.

## Gotchas

- Not yet driven live. The first run of this recipe should confirm the handles above and update this file.
- Card renders need the Chromium that `node bin/droid-office.js browser install` downloads. Without it, the board says why it can't render cards.
- A card made only for a check is real data. Remove it in the same run (`whiteboard_card` with `action: "remove"` from the worker that made it, or the window's controls).
