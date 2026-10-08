# Client UI

DOM windows and panels. The three.js scene is `../world`.

- Build nodes with `h()` from `dom.ts`. Open a window with `openModal` so Esc, the stack, the ✕ control, `doing` and `reading` stay one system.
- Actions on workers, the queue, meetings and floors are `ClientMsg` through `Net`. A new HTTP route is a branch in `src/server/server.ts` in the same change; the current ones are the `/api/*` handlers there.
- Issue, pull-request and doc HTML goes through `markdown.ts` (`marked`, then DOMPurify). Anywhere else, forge or doc text is text.
- Styles live in `../style.css`. Biome does not format CSS.
- Check a window in the running office (`npm run dev`, page on :5173, server on :4600). Click through the open, update and close path, including Esc.

## The UI kit

Every window builds from the shared classes in the "UI kit" block of `../style.css` and the base sections above it (`:root` tokens, `.btn`, `.modal`, inputs, `.seg`, `.key`, `.pill`, toasts). A window's own section styles only what is its alone; it never restyles a kit class. No `style:` attributes: add a class.

- Tokens: `--space-1..8` (4, 8, 12, 16, 20, 24, 32, 40px; no other gap, padding or margin values), `--radius` 4px for controls, `--radius-lg` 8px for windows and groups, `--radius-xs` for chips and pills, `--control-h` 32px (`-sm` 26, `-lg` 38), `--shadow-window`, `--text-body` 13.5px, `--text-small` 12px, `--text-label` 10.5px.
- Type: body copy and row titles are sentence-case sans at 400/500. Mono uppercase is only for window titles, labels, eyebrows, buttons, badges and keycaps. No 700/900 in body text.
- Window anatomy: `.modal` (560px, the default) or `.sm` 420 (confirms), `.lg` 760, `.xl` 960, `.full` (terminal, diff, PR); `openModal(el, { size })` adds it. There is no `.md` size class: `.md` is the Markdown body (`markdown.ts`), so never put it on a window. `header` > `.titles` (`h2` + `p.sub`) + `.actions`, then the ✕ that `openModal` appends last. `.body` scrolls (`.body.flush` has no padding). `footer`: `.grow` on the left (a hint, meta or the destructive action), Cancel as `.btn.ghost`, the primary button rightmost. Show a shortcut as a `.key`, not a sentence.
- Buttons: `.btn` (secondary), `.primary` (white), `.accent` (orange, the one "make it happen" button), `.danger`, `.ghost`; `.sm`, `.lg`, `.icon` (square). `.seg` is a row of buttons; with `role=radiogroup`/`group` or a button lit `.on` it becomes one joined segmented control.
- Layout: `.stack` (column, 16px; `.tight` 8, `.loose` 24), `.row` (`.between`, `.wrap`; a `.grow` child fills), `.split` (220px sidebar + pane), `.section` > `.eyebrow` (optional `.no` index) + content, `hr.divider`.
- Forms: `.field` > `label` + control + `.field-hint` / `.field-error`, `.field.inline` (label left). `.input` and `select.select` (custom chevron) anywhere; bare text inputs, textareas and selects in a `.modal` get the same look at low specificity. `.input-group` joins an input and a button.
- Choices: `label.toggle` (input, `.track`, `.toggle-text` with `small`) for on/off. Every switch in the app is a `span.track`: one outside a `label.toggle` (a ☰ menu row's `role=menuitemcheckbox` button, say) is on when an element around it is `[aria-checked=true]` or `[aria-pressed=true]`, and dims when it is `:disabled` or `[aria-disabled=true]`. `.choices` > `label.choice` (input, `.choice-body` with `.choice-icon`, `b`, `small`) for 2–4 alternatives; `.chips` > `.chip` for property pickers.
- Lists: `.list` > `.list-row` (an `li`, or a `button` or `a` that looks the same; `.on` or `aria-selected=true` is picked) with `.list-icon` (20px column), `.list-main` > `.list-title` + `.list-meta`, `.list-end`; `.list.boxed` for hairline rows in a box.
- Settings rows: `.group-title` above a `.group` of `.group-row`s, each a `.group-label` (`b` + `small`) and its control.
- Feedback: `.note` callout (`.info`, `.warn`, `.bad`, `.good`; `.setting-note` is the same), `.empty-state` (`.empty-icon`, `b`, `p`, an action), `.spinner`, `.skeleton`, `.pill`, `.key`. Tabs: `.tabs` > `button.tab` (`.on` or `aria-selected=true`).
- `kit.ts` builds the fiddly ones on `h()`: `toggle({ label, description?, checked?, onChange?, id?, disabled?, bare? })` (the label, with `.input`), `choices(name, options, selected, onChange)` (with `.value()` and `.select(v)`), `field(label, control, hint?)`, `groupRow(title, description, control)`, `emptyState(icon, title, text?, action?)`, `windowHeader(title, sub?, ...actions)`.
- Long names, branches and paths ellipsize with a `title`; nothing makes a window wider than its size class. Check at 1440×900 and 1024×700.
