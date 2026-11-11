# Client UI

DOM windows and panels (`../world` owns the three.js scene).

- Build elements with `h()` (`dom.ts`) and open windows with `openModal` so Esc, stacking, the ✕ button, `doing` and `reading` stay one system. Click through open, update, close and Esc in the running office at both `1440×900` and `1024×700`, ellipsizing long names, branches and paths with `title` so windows stay within their size class.
- Render issue, pull-request and doc Markdown exclusively through `markdown.ts` (`marked` + DOMPurify); insert forge or doc strings as plain text everywhere else.
- Pair any new `/api/*` fetch with its handler in `src/server/server.ts` in the same change.
- Author styles in `../style.css` (Biome skips CSS) with classes rather than `style:` attributes (for dynamic colors, set `el.style` in JS as `colorDot` in `kit.ts` does).

## The UI kit

Build windows from `:root` tokens, base controls (`.btn`, `.modal`, inputs, `.seg`, `.key`, `.pill`, toasts) and the "UI kit" block of `../style.css`. Scope a window's own CSS to what belongs to that window alone rather than restyling kit classes. Keep kit selectors at single-class specificity (`0,1,0`, wrapping modifiers, element qualifiers and child resets in `:where()`) so a window's single-class rule later in `style.css` wins cleanly.

- **Tokens & type**: Use `--space-1..8` (4px grid: 4–40px) for all gaps, padding and margins; `--radius-xs` / `--radius` / `--radius-lg`; `--control-h` (`-sm`, `-lg`); `--shadow-window`; `--text-body` / `--text-small` / `--text-label`. Keep body copy and row titles in sentence-case sans at 400/500; reserve uppercase mono for window titles, labels, eyebrows, buttons, badges and `.key` keycaps.
- **Window anatomy**: `openModal(el, { size })` sets `.modal` (560px default) plus `.sm` (420, confirms), `.lg` (760), `.xl` (960) or `.full` (terminal, diff, PR); `.md` is Markdown body (`markdown.ts`), never a window size. Structure: `header` > `.titles` (`h2` + `p.sub`) + `.actions` (before the appended ✕); scrollable `.body` (`.body.flush` removes padding); `footer` with `.grow` left (hint, meta or destructive action), Cancel as `.btn.ghost`, and primary action rightmost. Render shortcuts as `.key`.
- **Buttons**: `.btn` (secondary), `.primary` (white), `.accent` (orange primary CTA), `.danger`, `.ghost`, with `.sm`, `.lg`, `.icon` (square). `.seg` joins buttons when given `role=radiogroup`/`group` or an `.on` child.
- **Layout**: `.stack` (`.tight`, `.loose`), `.row` (`.between`, `.wrap`, `.grow` child), `.split` (sidebar `--split-side`, default 220px, + scrolling pane), `.section` > `.eyebrow` (optional `.no` index) + content, `hr.divider`.
- **Forms**: `.field` (`.inline`) > `label` + control + `.field-hint` / `.field-error`; `.input`, `select.select` (custom chevron), `.input-group`.
- **Choices & switches**: `label.toggle` (`input`, `span.track`, `.toggle-text` with `small`). Standalone `span.track` (e.g. a ☰ `menuitemcheckbox` row) lights on ancestor `[aria-checked=true]` or `[aria-pressed=true]` and dims on `:disabled` or `[aria-disabled=true]`. `.choices` (`.rows` for full-width icon-column cards) > `label.choice` for 2–4 options; `.chips` > `.chip` for property pickers.
- **Lists & tabs**: `.list` (`.boxed`) > `.list-row` (`li`, `button` or `a`, non-shrinking for flex scroll; `.on` active, `.cursor` or `aria-selected=true` keyboard focus; `.list-icon`, `.list-main` > `.list-title` + `.list-meta`, `.list-end`). `.tabs` > `button.tab` (`.on` or `aria-selected=true`).
- **Settings & disclosure**: `.group-title` above `.group` > `.group-row` (`.group-label` + right control, auto-wrapping below 720px; `.muted` when inactive; `.block` stacks full-width children beneath the label while keeping an adjacent `.btn`, `.toggle`, `select`, `.seg` or `.pill` top-right). `.group-nest` indents dependent rows behind a guide line (hide rather than disable when inapplicable). Fold long lists or occasional forms in `details.disclosure` (`summary` > `.disclosure-label` + `.disclosure-meta`, `.disclosure-body`).
- **Feedback**: `.note` / `.setting-note` (`.info`, `.warn`, `.bad`, `.good`; outside `.md`, whose GitHub alerts use `blockquote.alert.note`), `.empty-state` (`.empty-icon`, `b`, `p`, action), `.spinner`, `.skeleton`, `.pill`, `.key`.
- **Builders & model picker**: Use `kit.ts` (`toggle`, `choices`, `field`, `groupRow`, `disclosure`, `emptyState`, `windowHeader`, `colorDot`) for composite markup, and `modelPicker` (`model-picker.ts`, fed via `pickerModel` in `models.ts`; effort stays a `select`) wherever the owner chooses a model.
