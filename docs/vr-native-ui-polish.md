# Native headset panel UI

The native Galaxy XR app ([vr-native-android.md](vr-native-android.md)) shows the office page's
DOM at `/?native=1` on a 2400×1600 compositor panel, which the page sees as a 1600×1019 CSS
viewport at device pixel ratio 1.5. `body.native-xr` switches on the panel presentation in
`src/client/native/native.css`, `graphics.css` and `src/client/login.css`; the desktop page keeps
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
- **Bottom boundary.** `--native-bottom` is the keyboard's height when it shows, or the
  floating **Keyboard** button's 64 px strip when it's hidden. Windows, the ☰ menu, the floor
  list and the terminal stop above it, so that button never covers their last row or scrollbar.
- **Feedback on top.** Toasts stack above Home, windows and the keyboard (`z-index: 75`),
  wrap at up to 900 px, and take no taps. The desktop layers are unchanged.
- **Desktop-only hints.** The ☰ menu hides shortcut letters. The chat placeholder and the
  chat panel's description drop "T". Tooltips remove office-wide shortcut letters, desk keys
  and "(Tab)" (on the panel keyboard, Tab moves focus), and say "press the controller trigger"
  for "press E". The terminal's Shift+Esc and Ctrl+] hints stay, because the panel keyboard has
  those keys.
- **Tooltips.** Titles show in a panel tooltip at the bottom left, above the keyboard, instead
  of an operating-system tooltip. A tap shows it for 2.8 s.

The installed app’s target input is Galaxy XR motion controllers only. Use the left
controller’s Menu button to toggle the workspace, trigger for pointing/clicking, and grip for
grabbing/returning cards. The panel keyboard is operated with the controller ray and trigger.
Hand gestures and fingertip input are outside the native app’s supported scheme.

## Checking the panel

Use a browser session at 1600×1019 with device scale 1.5, and at 1280×720. Open
`/?native=1`, sign in with the panel keyboard, and walk Home, every Home tile's window, the ☰
menu (scrolled to its end), the floor list, a shell worker's terminal with the keyboard shown and
hidden, and text size −/+. `window.__office.nativeUi` offers `setPanelOpen`, `showHome`,
`setCarrying`, `updatePerformance` and `keyboard.show(true)` for reaching states without the
headset. Long content can be staged in the page's own `window.__office.store` (queue tasks,
workers, the project name) followed by `store.emit(topic)`; that changes only that page.
Look for text cut off with an ellipsis, controls under 44 px, text under 12 px and controls
outside a scrollable area. Also confirm the desktop route `/` still looks the same.

A browser check establishes layout and DOM input only. Sharpness on the compositor layer,
reading distance, controller ray hit accuracy, and comfort need the physical headset.
