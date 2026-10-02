# Unity headset client, Track C

Follow `../../docs/unity-headset.md`. Device acceptance is still pending.

- Unity 6000.3.25f1. Packages are pinned via UPM Client APIs, never edited by hand.
  Keep glTFast 6.19.0 and Collections 2.6.7 together for Extensions 1.4.
- Use explicit absolute `--project-path` with unity-cli. Author scenes/assets
  through the running Editor, not YAML edits. Save scenes before builds.
- No WebView, microphone or hand tracking. Never bind the right Menu button.
  Physical gestures use fresh tracked grip poses, never aim-pose fallback.
- `Protocol/Generated` and `Layout/office-layout.json` are generated. Run
  `node --import tsx native/unity/Tools/snapshot.ts` from the repository root.
  Track B owns the eventual shared generator. Do not change server/shared/client
  sources, root tests, npm configuration, CI or Track A docs here.
- OfficeStore is the only server-state owner. Parse JSON and receive network
  frames off the Unity thread. Ordered bounded drains spend at most 1 ms/frame.
  Views subscribe to coalesced topic events and never write server DTOs.
- Development builds use an explicit loopback adapter for current protocol-1.
  Do not pretend this is Track B negotiation, durable pairing or idempotency.
  Unsupported capabilities disable consequential features.
- Keep tokens, URLs containing admission secrets, cookies and credentials out
  of logs, PlayerPrefs, scenes and captures. Android TLS trust is per-client
  pinned SPKI plus hostname checks, never global certificate acceptance.
- Development ID stays `dev.droidoffice.xr.unity`. No installs over the current
  APK and no release identity/signing switch without U8 migration evidence.
- Existing `Assets/Art/Props` files belong to the prior prop work. Preserve them.
- Source and generated `.meta` files travel together. Caches and evidence stay
  ignored. Record physical checks as NOT RUN until actually performed.
- UI is uGUI/TMP, not OnGUI. Section 16 review and owner device approval are
  required before a surface or physical milestone is marked complete.

Local checks: `Tools/check.sh` runs snapshot drift checks and isolated EditMode
tests. `build.sh` creates a debug ARM64 IL2CPP APK. Neither proves device timing,
input, comfort, fine-eye foveation, QR scanning or production readiness.
