# Client UI

DOM windows and panels. The three.js scene is `../world`.

- Build nodes with `h()` from `dom.ts`. Open a window with `openModal` so Esc, the stack, the ✕ control, `doing` and `reading` stay one system.
- Actions on workers, the queue, meetings and floors are `ClientMsg` through `Net`. A new HTTP route is a branch in `src/server/server.ts` in the same change; the current ones are the `/api/*` handlers there.
- Issue, pull-request and doc HTML goes through `markdown.ts` (`marked`, then DOMPurify). Anywhere else, forge or doc text is text.
- Styles live in `../style.css`. Biome does not format CSS.
- Check a window in the running office (`npm run dev`, page on :5173, server on :4600). Click through the open, update and close path, including Esc.
