# Whiteboard

The Whiteboard is the floor's shared board of cards that agents and the owner make: Markdown, video, image (PNG/JPEG/WebP/GIF/SVG), custom HTML, links and canvases, with comments, stickies and pictures on them. The owner opens it from the ☰ menu, the 3D east wall or the web companion. Android shows it in the Board tab.

## Sub-features

- `wb-open` opens the Whiteboard window from the ☰ menu (`await open('whiteboard')`).
- `wb-cards` shows every card on the floor newest first with format badges (`MD`, `VIDEO`, `IMG`, `HTML`, `CANVAS`), search (`input.wb-search`, `/` shortcut, `Escape` clears) and filter chips (`.wb-filters button.chip`).
- `wb-add-edit` creates Markdown, video/image, pasted Factory HTML, file/folder or dropped cards (`.modal.wb-add[aria-label="Add card"]` or drop onto `.wb-grid-wrap`), edits unlinked Markdown in place (`.modal.wb-add[aria-label="Edit Markdown"]`), edits owner comments inline (`button.wb-msg-act`), seeks live videos from `@mm:ss` timestamps (`button.wb-timecode`), and switches adjacent cards (`[` / `]` or `.wb-nav`).
- `wb-companion` opens the same board from the web companion's **Whiteboard** button (`/dashboard`).
- `wb-android` lists and filters the same cards in the Android Board tab (`board.grid`, `board.search`, `board.filter/<id>`, `board.card/<id>`, `board.card.format`).

## How to get to it (user POV)

- ☰ menu → Whiteboard in the office, or walk up to the 3D east-wall Whiteboard (`window.office.goTo('whiteboard')`).
- **Whiteboard** in the web companion's top bar (`/dashboard`).
- The **Board** tab in the Android app.

## Driving it with drive.sh and window.office

Preconditions:

- `doctor.sh "$RUN"` passes.
- In a clone, the floor's Whiteboard is the owner's copy. A fresh office starts with an empty board. When a card is selected on the wall (`b.selection.kind === 'card'`), opening the Whiteboard opens directly to that card (`.modal.wb.wb-on-card`); click `.modal.wb header button.wb-back` (`← Grid`) to return to `.wb-grid`.

- **Open.** In a steps file, run `await open('whiteboard')`. `office.state().modals` contains `{ label: 'Whiteboard' }`, and `.modal.wb[aria-label=Whiteboard]` is visible. Shot `wb-open.png`.
- **Cards, search & filters.** Read `.wb-tile` nodes and `.wb-format-badge` labels in `.wb-grid`. Press `/` to focus `input.wb-search`, type a query, press `Escape` to clear without closing the window, and click `.wb-filters button.chip` to filter by format or status.
- **Create, edit & video seek.** Click **Add card** to open `.modal.wb-add[aria-label="Add card"]` (`Markdown`, `Video / Image`, `Paste HTML` → `Load Factory starter`, `HTML file`, `Folder`) or drop a file onto `.wb-grid-wrap`. On an unlinked Markdown card, click **Edit Markdown** (`textarea[aria-label="Markdown source"]` → **Save Markdown**). In **Mark up**, click `.wb-catcher` to pin a comment; in `.wb-panel`, click **Edit** (`button.wb-msg-act`) to edit an owner comment or click `.wb-timecode` (`@0:02`) on a video card to jump `video#wb-video`.
- **Companion.** Open `/dashboard` in a second page and click the `Whiteboard` button. The same cards, format badges and live card frames render.
- **Android.** On a paired device, tap `tab.board`. `board.grid` lists `board.card/<id>` nodes with `board.card.format` and `board.card.title` matching the office's cards, filtered via `board.search` and `board.filter/<id>`.

## Gotchas

- Card renders need the Chromium that `node bin/droid-office.js browser install` downloads. Without it, the board says why it can't render cards.
- In-place card edits mount a double-buffered `iframe.wb-frame.incoming` until loaded; target `iframe.wb-frame:not(.incoming)` after `incoming` detaches.
- A card made only for a check is real data. Remove it in the same run (`Select` → `.wb-tile` → `Delete` → `.modal[aria-label^="Delete the card"] footer button.btn.danger`, or `whiteboard_card` with `action: "remove"`).
