# Native headset panel UI

The native Galaxy XR app ([vr-native-android.md](vr-native-android.md)) shows the office page's
DOM at `/?native=1` on a 2400×1600 compositor panel, which the page sees as a 1600×1019 CSS
viewport at device pixel ratio 1.5. `body.native-xr` switches on the panel presentation in
`src/client/native/native.css` and `src/client/login.css`; the desktop page keeps
its own layout and never loads those rules' effects.

## Layout rules

- **Targets.** Every control is at least 44×44 CSS px, and lists and rows are at least 48 px
  tall. That includes the queue's move/remove buttons and the meeting room's worker count
  steppers, which are compact on the desktop.
- **Text.** Panel text is at least 12 CSS px. Small desktop eyebrows (queue, team, changes,
  search headings), the search status, elevator and floor-list subtitles, and the terminal's
  "typing" note are raised on the panel.
- **No lost text.** Names and descriptions wrap rather than being cut off. The Home floor
  name and meta, the worker names, and the terminal window's title wrap. A worker's subtitle
  (agent, desk, branch, task) shows up to three lines; the row's tooltip carries the full text.
  Queue titles and meta wrap. Model and effort pickers keep minimum widths so the chosen value
  stays readable; the row wraps instead.
- **No on-screen keyboard.** The office page docks no keyboard and remembers none: a keyboard
  paired to the headset types into the open terminal or the focused field. Windows, the ☰ menu,
  the floor list and the terminal use the panel's full height. Only the sign-in page docks a
  controller keyboard (`native/keyboard.ts`), for the office password.
- **Feedback on top.** Toasts stack above office windows (`z-index: 75`), wrap at up to
  900 px, and take no taps. The desktop layers are unchanged.
- **Desktop-only hints.** The ☰ menu hides shortcut letters. The chat placeholder and the
  chat panel's description drop "T". Tooltips say what a control does and never which key or
  button does it (`nativeTooltipText`).
- **Tooltips.** Titles show in a panel tooltip at the bottom left instead of an
  operating-system tooltip. A tap shows it for 2.8 s.
- **Dropdowns.** Single-choice fields show their options inside the compositor panel instead
  of Android's separate popup window. Choices preserve the original field and its change
  handlers, disabled options and groups, and keyboard focus. Cancel changes nothing. A field
  removed or changed while its choices are open closes the stale chooser.
- **Rows in scrolling lists.** Board cards, queue rows, search hits and the other listed rows keep
  `flex-shrink: 0` with their 48 px minimum, so a long column scrolls instead of squeezing cards
  until their titles overlap.

## Desktop features on the panel

- **Command palette.** Y opens the desktop's own Find anything palette (`ui/palette.ts`,
  entries from main.ts). The paired keyboard can also use its normal shortcut while the workspace
  is open.
- **Settings.** The categorized sidebar stays vertical at both check sizes, with 52 px category
  rows. The You category shows
  **Headset view: First person, head-tracked** as a fixed state and no first/third person choice,
  because the installed app always renders the head-tracked view. **Headset movement** states the
  controllers-only scheme before the locomotion choices the native controls read
  (`settings.vr`). Notifications replaces the browser-notification switch with a note: the headset
  app shows waiting workers on Home instead.
- **Boards.** The title filter is 48 px with a 44 px clear button; the label picker's chips, footer
  and Clear button follow the target and text rules.
- **Providers and repositories.** The original worker list and terminal header retain provider
  metadata. The hire form's **Also work in** picks, the Changes window's repository tabs
  and the pull request rows are 44 px targets and wrap long folder names.
- **Terminal header.** Its buttons (including the native **📎 Picture** button) keep their size and
  wrap as a group beside a wrapping title; viewer initials are 30 px.
- **Deleted worktrees.** Opening a lost worker's terminal opens the desktop's original recovery
  dialog. Prompt, Changes and creation of a new PR wait until recovery; an existing PR remains
  viewable. Recovery remains available if the worker's process is still running in its deleted
  directory.

The installed app’s target input is Galaxy XR motion controllers only. The left controller's
Menu button opens APK-native settings; **Office workspace** opens the page's office navigation.
Trigger at an occupied desk opens its shared terminal. Trigger also points/clicks; grip is for
grabbing objects, never workspace navigation. B goes back through windows or closes a panel.
The workspace starts closed on every launch and reload. Text goes in
from a keyboard paired to the headset; the sign-in page's keyboard is operated with the
controller ray and trigger. Hand gestures and fingertip input are outside the native app’s
supported scheme.

## Checking the panel

Use a browser session at 1600×1019 with device scale 1.5, and at 1280×720. Open
`/?native=1`, sign in with the panel keyboard, and check that the office page arrives with the
workspace closed and no keyboard. Then open office navigation, the ☰
menu (scrolled to its end), the floor list, a shell worker's terminal, and text size −/+. Open
the command palette with Y or the paired keyboard; type, choose with Enter and close with Esc
on the browser's own keyboard, standing in for one paired to the headset. Walk each Settings
category, and type into a board column's title filter. `window.__office.nativeUi`
offers `setPanelOpen`, `setCarrying`, `panelState` and `back` for
reaching states without the headset. Long content can be staged in the page's own `window.__office.store` (queue tasks,
workers, the project name) followed by `store.emit(topic)`; that changes only that page.
Look for text cut off with an ellipsis, controls under 44 px, text under 12 px and controls
outside a scrollable area. Also confirm the desktop route `/` still looks the same.

A browser check establishes layout and DOM input only. Sharpness on the compositor layer,
reading distance, controller ray hit accuracy, and comfort need the physical headset.
