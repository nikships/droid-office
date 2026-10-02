# U0 feasibility spike

This is throwaway measurement tooling, not the shipped headset app. Follow
`../../docs/unity-headset.md`, especially sections 3.2, 14, 20 and 25.

- Use Unity 6000.3.25f1 and the exact packages resolved in `Packages/`.
- Drive this project's Editor with unity-cli and an explicit absolute
  `--project-path`. Never modify the stray root Unity project.
- No WebView, microphone, hand tracking, server changes, or production credentials.
- Build as `dev.droidoffice.xr.unity`. Never install over `dev.droidoffice.xr`
  without a separate, explicitly approved data-preservation test.
- Editor timings and synthetic inputs are not Galaxy XR measurements. Record
  requested values separately from actual runtime values. Missing metrics are
  unavailable, never zero.
- Keep logs, captures, APKs and test reports in ignored `Evidence/` or `Builds/`.
  Commit source and Unity-generated `.meta` files together.
- U1 cannot close, nor can device-dependent U-D decisions settle, without device
  evidence. Keep the partial report honest when the headset is unavailable.

Validation: run the spike EditMode tests through the Editor, build the Android
ARM64 IL2CPP APK, inspect its manifest, and record outcomes in section 25.
