# React Native companion

- `host.ts` defines the native boundary; `native.ts` implements it. Coordinate changes with the Android bridge. Native owns credentials, sockets, HTTP routing, photo uploads and terminal input. Do not add direct JS networking or expose tokens to management pages.
- Reuse pure `src/shared/` roster, workspace, thread and command logic. A browser helper is eligible only when its entire runtime import graph is free of DOM, Node and three.js dependencies.
- Subscribe before bootstrapping. Preserve native message sequence and socket epoch ordering. A connected socket alone is not ready: wait for its authoritative welcome and every floor arrival.
- Keep actions bound to their connection, floor and worker/session. Never replay an uncertain request. Floor switches preserve per-floor drafts; actual connection loss clears every floor's unsent text and pictures. Persist layout only.
- Terminal holds are shared with native views. Only active, ready, nonzero-size terminal views may type or resize. Stop hidden Thread polling and keep visible panes plus child reads within the server reader's bounded cache.
- Give actionable controls `testID` and accessible names/states. Verify phone and wide-screen navigation, including notification and management-tool links.
- Put pure model/session regression tests in root `tests/*.test.ts`. Validate native startup, keyboard, pairing and the sealed management host on an emulator. Do not substitute mocked runtime office data.
