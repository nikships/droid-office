# Galaxy XR performance handoff

## Current acceptance criteria

The owner has superseded the original WebXR performance target. The target is now an
installable Galaxy XR client with sustained **90 Hz**, sharp text, eye-tracked foveation,
Galaxy XR motion controllers. It must connect to the laptop's existing
office server and use the same first-person world as desktop players. Worker, terminal,
board and elevator interactions are the priority; further mini-game support is deferred.

The native OpenXR implementation is in `native/android`. It now renders the original
populated office on the real headset with multiview, tile MSAA and gaze-driven foveation.
The native work is merged into `main`, and the latest published release is
[v0.1.289](https://github.com/nikships/droid-office/releases/tag/v0.1.289).
Its exact APK is installed; pulling the installed bytes reproduced the published checksum,
with the existing release signature and retained app data. The matching `v0.1.289` desktop server is running detached on the
laptop. The headset reconnected over Wi-Fi, and an authenticated observer verified its
original profile and existing shared shell in the same world. Both floor PTY hosts and their
worker processes survived the server replacement without restarting.

The two worn-headset screenshots from 2026-09-30 identified terminal glyph clipping and
blurry in-world laptop text. The new release fits Nerd Font icons to the shared monospace
cells, waits for loaded terminal fonts and repaints idle laptops. Its sharp-screen sampler
retains more fine-stroke contrast while preserving mip/anisotropic filtering. Graphics now
offers a world-resolution slider, 1% steps, Recommended/Maximum presets and foveation Off.
At the captured runtime limits, Maximum selects approximately 169.8%, allocating 3152×3668
world pixels per eye instead of stopping at the recommended 1856×2160. The menu reports
selected/applied pixels and runtime bounds; these are render dimensions, not a physical-panel
pixel mapping. Failed target preflight preserves the active render targets. Host and browser
checks pass. Actual headset Recommended/Maximum/minimum and foveation Off/On transitions
passed without GL errors; loaded-font widths and Android panel captures confirmed unclipped
terminal glyphs and clean graphics rows. Maximum exceeded the frame budget (58.68 fps with
Balanced foveation, 45.007 fps Off in sampled loading windows) despite a 90 Hz display, so it
is not a 90 FPS preset. Original settings were restored. Fully resident required-view timing
and the owner's physical sharpness review remain open.

The next requested controller work replaces native one-press gong, ladder and pole actions
with physical strikes and held-grip movement, adds a rear-holstered held-grip gun and a new
shared desktop/native gun model, and separates left/right face-button and stick-click jobs.
Right Menu is reserved for Android XR; left Menu owns the workspace and grip never navigates
menus. Desktop and WebXR control schemes remain authoritative for their own clients.

The owner wore the installed combined APK on 2026-09-29 and reported that it looked good,
with one concrete defect: worker laptop terminal screens remained pixelated at high settings.
The source canvases retain their 2048×1360 resolution. The release includes a cropped,
full-resolution unfoveated laptop-screen pass with world/controller depth occlusion, alongside
the foveated world render. Its host checks and device depth probe passed. The crop was
installed and measured: a later enabled window reached 89.82 fps with no missed predicted
periods, but its first activation missed frames. Physical crop alignment, terminal readability
and consistent 90 Hz in required views remain acceptance checks.

The latest instruction supersedes the earlier hand-tracking criterion: **motion controllers
are the only supported native input scheme**, and the **left controller’s Menu button** opens
and closes the workspace. Grip must not open or close it. The controller-only migration is
installed with actual Samsung controller meshes; hand extensions, permission and active
input/rendering were removed. Native controller regressions and actual-page synthetic
left-Menu/grip/right-Menu replay passed. WebXR keeps its existing controls. Earlier hand-mesh
and fingertip evidence is historical and does not describe the supported native controls.

The release includes XR menus/tooltips, graphics settings, a persistent FPS option, command
palette access, panel dropdowns and keyboard, remembered position and current worker recovery
flows. Actual WebView and browser layout/input replays passed; physical comfort and controller
use still need review. The latest [CI run](https://github.com/nikships/droid-office/actions/runs/36774073302)
passed all 646 desktop tests, all 12 native host checks, both Android variants and signed release
publication, from source commit `733d7d3`.

The installed app now discovers laptop servers under **Nearby offices** and automatically
reopens the last successfully connected office on ordinary launch. Fourteen checks against the
published APK passed on the real headset, including Wi-Fi discovery, failed-connection recovery
and wrapped, scrollable office rows at a synthetic 1280×720 viewport.
Reviewed Android picker and keyboard captures have no overlapping text. Start the current
desktop server on the same Wi-Fi, select the laptop and sign in once; see
[connection instructions](vr-native-android.md#connect-to-your-laptop). The browser QR route remains
separate from the installed app's nearby picker.

The published v0.1.284 APK produced 65 seconds of populated-world launch measurements after
excluding an initial empty window. Actual refresh and compositor FPS were 90 throughout;
submitted FPS was 86.023–90.225, with 25 missed predicted periods (21 in the first populated
window and four later). The following windows measured 89.620–90.225 submitted FPS. Scene
packets continued advancing, while textures were still loading. Gaze was invalid and the
sharp-screen pass was inactive in that view, so this capture does not close the physical
acceptance checks or establish fully resident, perfectly steady 90 FPS. The owner requests
focused 1–2 minute checks rather than long soaks;
ordinary thermal throttling is not a reason to stop or cool the app.

See [resolution and glyph release validation](vr-native-android.md#resolution-and-glyph-release-validation-2026-09-30),
[published v0.1.284 validation](vr-native-android.md#published-release-validation-2026-09-30)
and [acceptance status](vr-native-android.md#acceptance-status) for current evidence and limits.

## Native measurements, 2026-09-29

The original native display foundation held approximately 90 submitted fps with 90
compositor fps and no measured missed periods, but it contained no office geometry.
Those readings establish the display path only.

The first populated-office build was compiled without native optimization. It suffered
shader/upload startup stalls up to 451 ms, then ran below 90 submitted fps. The runtime
changed its refresh rate from 90 to 72 Hz about 55 seconds after the world started loading.
After all 103 textures were resident, scene GPU time was approximately 5.9 ms and runtime
app GPU time approximately 8.7 ms. Thermal throttling was observed, but several costs and
settings changed together; the run does not isolate the cause of the refresh-rate change.

A subsequent experiment reduced GPU cost by strengthening foveation, but detaching the
closed workspace's virtual-display Surface stopped page updates. It rendered a stale
office snapshot, so that run is excluded from acceptance. The Surface remains attached;
the closed workspace now hides its DOM and pauses CSS animations instead.

The optimized APK uses `-O2`, eye-tracked foveation gain 4, fovea area 2 and minimum pixel
density 0.25, updating every supported focal point. It connected through the original
authentication and profile flow to the isolated laptop server at `http://192.168.1.26:4761`.
In the recorded closed-workspace windows from 18:39:18 to 18:39:48 (device log time), submitted
fps was 90.005–90.018, actual refresh and compositor fps were 90, and missed predicted periods
were zero. Runtime app GPU time was 6.31–6.50 ms; CPU p99 was 3.46–6.23 ms. Scene packet
sequence continued rising at approximately 29 updates per second. The world contained
1,741 objects and drew 134 color calls in the sampled view, plus 64 shadow calls on shadow
update frames. A headset screenshot showed the office, desks, chairs, boards, signs and
night lighting. This is live populated-world evidence, not the empty foundation result.

A later check from 18:53:15 to 18:55:10 measured 90.003–90.019 submitted fps at actual
90 Hz, zero missed predicted periods and no pending uploads or rejected packets. All 105
textures were resident across 1,770 objects; scene sequence advanced from 26,641 to 30,032.
Runtime app GPU time was 6.50–6.87 ms and maximum window CPU p99 was 5.77 ms. This is the
baseline for focused 1–2 minute checks after interface, control or graphics-setting changes.

The renderer currently reports a `GlassDark` material approximation: clearcoat is represented
by roughness. Scene export errors are empty. Other views, invalid-gaze fallback, sharp-text
review and physical hand/controller use remain visual/input checks. See
[the native client document](vr-native-android.md#acceptance-status) for the current scope,
build instructions and measurement definitions.

Everything below records the earlier WebXR investigation. Its 72 fps target and suggestions
to remove parts of the world are historical, and do not describe the current acceptance criteria.

## Original WebXR goal

VR in the office on the Samsung Galaxy XR must be excellent:

- Text is sharp.
- The frame rate holds a steady 72 fps, including after the headset heats up.
- Any VR-only change is allowed, including dropping heavy features. The owner has explicitly
  allowed removing the outside city and loading only the current floor, with a loading screen
  between floors.
- The Android XR WebXR docs are the authority on platform behavior.

## Where it stands

The real rendering path (three's `XRProjectionLayer` plus two quad-layer panels) runs at
**about 48-53 fps** with the GPU **84-97% busy**, so it is GPU-bound. After a clean reload
it draws 194 calls per frame (97 per eye) and ~89k triangles per eye, in the office at
night (`draws1.js`). After shader A/B runs the batcher may be unbatched, and counts are
higher until the next reload.

An earlier reading of 60-67 fps came from an `XRWebGLLayer` base layer. That path showed a
black world in the headset (see "Chrome issues" below), so those numbers are void. The code
now stays on the projection layer.

It is still unproven whether the remaining cost is ours or Chrome's. The key evidence:

- In the `noRender` arm the page clears its render target and draws nothing (no scene, no
  MSAA blit). GPU busy time drops from ~19 ms to ~9 ms per frame, and the frame rate reaches
  72. **About 9 ms of GPU time per frame remains with nothing drawn.** That counter covers
  every GPU client: Chrome's layer handling, the system compositor with the two quad layers,
  and anything else the system draws. The budget at 72 Hz is 13.9 ms.
- Caveat: the GPU governor lowers the clock when the load drops, and busy time at a lower
  clock overstates the fixed cost. Pin or record the clock (`devfreq/cur_freq`) when
  re-measuring it.
- If the 9 ms holds, it leaves roughly 5 ms for the whole scene. Today the scene costs ~10 ms.

## Test device and setup

| Item | Value |
| --- | --- |
| Headset | Samsung Galaxy XR, Adreno 740, 72 Hz, adb serial `R3GYB022DBM` |
| Browser | Chrome 153 (`ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)`, WebGL 2) |
| XR framebuffer | 3712×2159 (both eyes, side by side) at framebuffer scale 1.0 |
| MSAA | three allocates its own 4× renderbuffer and blits it into the projection layer every frame. Pages get no `WEBGL_multisampled_render_to_texture` and no `OVR_multiview2` |
| Max layers | `session.maxRenderLayers` = 7 (one is the projection layer) |

### Connect over USB (works with the Mac on VPN)

The VPN routes 192.168.1.x away from the LAN, so Wi-Fi adb fails. USB works whatever the VPN
does.

```bash
# Office server on the Mac (build first: node bin/droid-office.js runs dist/)
npm run build
node bin/droid-office.js /Users/nanand/agent-office --password dev --port 4600

# Headset reaches the office at http://localhost:4600 (localhost is a secure context, so WebXR
# runs without HTTPS), and DevTools comes back to the Mac on :9333
adb -s R3GYB022DBM reverse tcp:4600 tcp:4600
adb -s R3GYB022DBM forward tcp:9333 localabstract:chrome_devtools_remote

# Open the office tab in the headset's Chrome, then log in once (password dev)
adb -s R3GYB022DBM shell am start -a android.intent.action.VIEW -d http://localhost:4600/ com.android.chrome
```

`tools/galaxy-xr/xr.sh` wraps all of this. For Wi-Fi instead, set
`ANDROID_SERIAL=192.168.1.19:5555 XR_URL=https://192.168.1.26:4601/ XR_MATCH=:4601/` and run
`node tools/vr.mjs` for the HTTPS proxy on 4601.

### First-run VR permission prompt

The first `requestSession` on the `localhost` origin shows a Chrome permission sheet that CDP
cannot grant. Tap it with adb (find the button with `adb shell uiautomator dump` if the
layout moves):

```bash
adb -s R3GYB022DBM shell input tap 768 589   # "Allow while visiting the site"; the second tap took
```

### System keyboard after entering VR

Entering VR often pops the Android system keyboard over the session
(`SHOW_AUTO_EDITOR_FORWARD_NAV` on Chrome's `XrHostActivity`). The session goes
`visible-blurred` and every measurement is wrong. It happens with a bare session on a blank
page too, so it is Chrome or Android, not the office. Send Back **only when the keyboard is
shown**. Back with no keyboard closes the office tab.

```bash
adb -s R3GYB022DBM shell 'dumpsys input_method | grep -q "mInputShown=true"' && adb -s R3GYB022DBM shell input keyevent KEYCODE_BACK
```

## Iteration tools (`tools/galaxy-xr/`)

Everything that drove the device work. The shell scripts `cd` to their own folder, so run
them from anywhere. `cdp.mjs` runs a JS file (or expression) in the office tab through the
remote DevTools socket, with a user gesture, and prints the result or the page exception.
`window.__office` is the page's debug handle (`main.ts`); `window.__office.vr` is the
`VRSession`.

### Start here

| Command | What it does |
| --- | --- |
| `sh tools/galaxy-xr/xr.sh status` | Awake/worn state, VR session state, layers |
| `sh tools/galaxy-xr/xr.sh reload` | Closes and reopens the office tab (a page reload hits the "Reload site?" prompt) |
| `sh tools/galaxy-xr/enter.sh` | Enters VR without a reload, drops the keyboard, hides the controls card, prints `visible XRQuadLayer+…+XRProjectionLayer` |
| `sh tools/galaxy-xr/xr.sh fps` | XR frame rate over ~120 frames (fps, p50, p95) |
| `sh tools/galaxy-xr/measure.sh` | Reload, enter, three fps readings, GPU busy/clock/temperature, and the pixels of a screenshot |
| `python3 tools/galaxy-xr/px.py shot.png` | Mean color and dark fraction of a PNG. **Always check a screenshot with this.** A black frame looks fast |
| `T=$(sh tools/galaxy-xr/tab.sh); node tools/galaxy-xr/cdp.mjs "$T" file.js` | Runs any page script below. Set `CDP_TIMEOUT=<s>` for long runs |

### A/B harnesses

Thermals move the GPU clock by up to 30% within minutes, so never compare runs taken minutes
apart. Every harness here interleaves arms (off, on, off, on…) and reports medians.

| Script | What it does |
| --- | --- |
| `abgpu.sh <setup.js> [rounds]` | **The best one.** Interleaved A/B on GPU busy ms per frame from `/sys/class/kgsl/kgsl-3d0/gpubusy`, plus fps and the thermal level. Frame rates snap to 72/36 steps at vsync, so the GPU milliseconds are the reliable number. Stops if the session is lost or not visible |
| `abx.js` | Older interleaved fps-only A/B over `window.__ab` (set `window.__abRounds`) |
| `ab-gpu1.js`, `ab-gpu2.js`, `ab-gpu3.js` | Setups for `abgpu.sh`: MSAA, labels, transparents, street, tower, basic shading, a quarter of the pixels, label properties, `noRender` |
| `ab-proj.js`, `ab-lrz.js`, `ab-parts.js`, `ab-prec.js` | Setups for `abx.js`: projection-path levers, label depth-write/discard, outside parts, shader precision |
| `ab-all.js`, `ab-now.js`, `ab-cpu.js`, `ab-flat.js`, other `ab-*.js` | Earlier setups: shader patches through the sky's `onBeforeCompile`, CPU levers (hover, matrices, batcher checks), flat uniform arrays |
| `base-ab.sh` | Interleaved projection-layer vs `XRWebGLLayer` session restarts (Wi-Fi era; a fresh CDP call per arm keeps user activation) |

Shader A/B arms recompile materials, which bumps material versions. The static batcher reads
that as a recolor and unbatches everything (614 draws instead of ~270). The setups freeze it
(`batcher.check = () => false`) and restore it with `window.__abThaw()`.

### Inspection

| Script | What it shows |
| --- | --- |
| `draws1.js` | Draw calls and triangles per eye in exactly one XR frame (the reliable count) |
| `census.js` + `census.py` | Visible meshes, triangles and draws per scene subtree (counts two frames: halve its draw numbers) |
| `parts.js` | `office.group`'s children with mesh counts and world bounds (finds the street, tower, clouds) |
| `labels.js`, `panels.js` | The textured transparent planes and the VR UI panels: size, texture, distance, blending |
| `drawstate.js` | Draws that combine depth writes with blending or discard (these can disable Adreno's hidden-surface pass) |
| `texchurn.js`, `uploads.js` | Texture re-uploads per frame |
| `projinfo.js` | The projection layer, three's render target (samples, depth), GL extensions |
| `fbcheck.js` | Which framebuffer the draws land in during an XR frame |
| `long.js`, `rafsplit.js`, `hist.js` | Long frames and where the frame time goes |
| `cpuprof3.mjs` | CPU profile of the page over CDP |
| `pickcost.js`, `pickbench.js`, `rayprof.js` | Cost of hover picking and the matrix walk |
| `count.js`, `calls.js`, `dyn.js`, `merge.js`, `mats.js` | Draw calls, GL calls, which meshes the batcher considers dynamic, merge candidates, materials |
| `bare-shot.sh`, `wl.sh`, `wl2.sh`, `shotcheck.sh` | Bare-session layer tests that isolated the `XRWebGLLayer` black-screen bug |
| `kb*.sh`, `grant.mjs`, `tapvr.mjs`, `focus.js` | Keyboard popup and permission prompt experiments |
| `vite.emu.config.ts` | Vite config for the IWSDK emulator runs (desktop only; not the headset) |

GPU counters: `adb shell cat /sys/class/kgsl/kgsl-3d0/{gpu_busy_percentage,gpubusy,devfreq/cur_freq,temp,thermal_pwrlevel}`.
The clock steps between 285 and 788 MHz. Thermal level 0 is no cap.

## Changes in this branch

All are VR-only unless noted. Measured numbers are from the interleaved harnesses above.
Rows marked † were measured while the session ran on the `XRWebGLLayer` path, which showed a
black world. Their CPU savings are real, because the page did the same CPU work, but their
absolute fps numbers are void.

| Change | Files | Effect |
| --- | --- | --- |
| World at framebuffer scale 1.0, foveation 0 | `vr/session.ts` | At native scale (1.7) an empty scene ran at 35 fps; 1.0 holds 72 empty. Chrome ignores foveation |
| Text panels as `XRQuadLayer`s, punched out of the world pass | `vr/layers.ts`, `vr/panel.ts`, `vr/attach.ts`, `vr/session.ts` | Sharp text at native resolution without rendering the world at 1.7 |
| Static batching of opaque meshes (colors baked into vertex colors per look) | `vr/batch.ts`, `tests/vr-batch.test.ts` | ~1,480 draws per eye down to ~135 per eye; took the ~20 fps baseline into the 30s-40s together with the shader fix below |
| † Static batching of flat, depth-free transparent layers (glass, shine) | `vr/batch.ts`, `tests/vr-batch.test.ts` | 314 to 206 draws per frame; 194 per frame (97 per eye) now |
| `forceSinglePass` on transparent double-sided materials | `world/office.ts`, `tower.ts`, `gong.ts`, `holiday.ts`, `rooftop.ts`, `vr/session.ts` | Removes ~240 program re-checks a frame (also on desktop) |
| BVH ray picking (`three-mesh-bvh`, loaded lazily) | `vr/pick.ts`, `tests/vr-pick.test.ts`, `package.json` | Hover pick measured at ~0.66 ms per frame over 1,433 meshes |
| Street-lamp loop skipped for indoor pixels | `world/sky.ts` | ~33 to ~47-50 fps at the time. The loop ran for every indoor pixel, then multiplied by 0 |
| † Sky light uniforms as flat `Float32Array`s (`Slots`) | `world/sky.ts` | three's array uniform setters flattened `Vector4`/`Color` arrays on every material switch. It was the largest CPU cost then (A/B 51 to 72 fps while CPU-bound). Also applies on desktop |
| Controls card layout fix | `vr/controls.ts`, `tests/vr-controls.test.ts` | Layout only |

## Measurements on the real path (projection layer)

GPU ms per frame is the change in total GPU busy time per page frame from `abgpu.sh` (median
of three interleaved rounds). The 72 Hz budget is 13.9 ms, and the baseline is ~18-19.5 ms.
The two MSAA rows ran at thermal level 2 (clock capped); the rest ran at level 0.

| Arm | GPU ms/frame (delta) | fps off → on |
| --- | --- | --- |
| `noRender` (clear only, nothing drawn) | −10.0 (to ~9.1) | 47.4 → **72.0** |
| `basicAll` (every material a flat `MeshBasicMaterial`) | −4.9 | 48.0 → 66.1 |
| `msaa0` (no MSAA) | −4.4 | 41.1 → 50.7 |
| `noLabels` (hide the 20 text signs and the 2 panel punch-outs) | −4.3 | 51.4 → 65.0 |
| `noTransparent` (hide every transparent mesh) | −4.2 | 51.3 → 65.7 |
| `msaa2` | −3.5 | 44.5 → 53.7 |
| `quarterPixels` (viewport halved each way) | −2.4 | 47.3 → 49.3 |
| `noPunches` (hide the 2 quad-layer punch-out meshes) | −2.2 | 47.8 → 47.8 |
| `noOutside` (street, tower and clouds hidden) | −2.0 | 48.3 → 54.7 |
| `noTextLabels` (the 20 signs only) | −1.7 | 46.7 → 46.3 |
| `labelsNoDepthWrite` (signs and punches stop writing depth) | −1.2 | 51.3 → 50.4 |
| `textOpaque` (signs not transparent) | −1.2 | 48.8 → 45.5 |
| `noStreet` | −0.8 | 51.7 → 54.4 |
| `noTower`, `textNoAlphaTest`, `textAniso1`, `textNoMips` | ~0 | ~0 |

Shader precision (`abx.js`, fps only): `mediump` on every material made no difference, and
`mediump` in fragment shaders only was 2.8 fps slower.

Single fps readings move by several fps between windows, so a delta under ~1 ms (or an fps
change under ~3) is noise.

What this says:

- Cutting pixels barely helps (`quarterPixels` −2.4 ms), and cutting geometry barely helps
  (`noOutside` −2 ms). Transparency, MSAA and the lit shaders cost the most.
- Two tiny punch-out meshes cost ~2 ms, and 22 small transparent, depth-writing planes cost
  ~4 ms. That is far more than their pixel count explains. It fits Adreno's LRZ
  (low-resolution Z, its early hidden-surface pass) switching off for the rest of the pass
  once a draw blends while writing depth, which would make every later draw more expensive.
  This is **not yet proven**: stopping depth writes on all 22 gave only −1.2 ms.
- The fixed cost with nothing drawn (~9 ms, with the clock caveat above) leaves only ~5 ms
  for the scene at 72 Hz. The Android XR WebXR docs and Chrome's `xr_projection_layer` and
  OpenXR sources are where to look for what that 9 ms is.

## Chrome issues found

1. **`XRWebGLLayer` renders black when the session has the `layers` feature.** A bare session
   that clears the layer red every frame shows red with `{}` or `optionalFeatures:
   ['local-floor']`, and solid black with `optionalFeatures: ['layers']`. This holds with or
   without quad layers, as `baseLayer` or in `layers: [base]`, on a fresh canvas or the
   office's. Draws do land in the layer's framebuffer (`fbcheck.js`). Reproduce with
   `bare-shot.sh` and `wl2.sh`, then check the pixels with `px.py`. The projection layer path
   renders correctly. PNG file sizes cannot tell solid red from solid black.
2. **The system keyboard pops over new sessions** (see "System keyboard after entering VR").
3. **`XRProjectionLayer.fixedFoveation` is ignored.** Nothing in Blink or `device/vr/openxr`
   reads it.
4. **No `WEBGL_multisampled_render_to_texture` and no `OVR_multiview2`.** three must render
   4× MSAA into its own renderbuffer and blit it every frame, and each eye is a separate draw.
5. **~9 ms of GPU time per frame with nothing drawn** at 3712×2159 with two quad layers. It is
   not yet known how much of that is inherent, and a native OpenXR app would be a useful
   comparison.

## Historical WebXR follow-ups

These proposed follow-ups belonged to the original 72 Hz browser investigation. The native
client and current priorities above supersede this plan.

1. **Rule Chrome in or out first.** Measure a bare WebXR page (projection layer, clear only,
   no quad layers, then add each back) with `abgpu.sh`. If that alone is ~9 ms at scale 1.0,
   the scene gets ~5 ms at 72 Hz whatever we do. Then the plan is scale 0.8-0.9 for the world
   plus quad layers for all text, or accepting 72 fps with reprojection.
2. **Test the LRZ theory directly.** Make the two punch-out meshes and the signs not write
   depth (or draw them last), then re-measure every opaque cost. If it holds, the fix is
   cheap: no depth-writing blends anywhere in the VR pass.
3. **Drop the heavy parts in VR** (within the original scope). Measured candidates:
   - MSAA to 2× (−3.5 ms) or 0 (−4.4 ms), with quad layers carrying text sharpness.
   - The outside (−2 ms): street, neighbour buildings, clouds, tower. Could be a skybox.
   - Transparent decor (−4.2 ms for all of it): the window glass and shine layers could go opaque or disappear in VR.
   - The text signs as quad layers or opaque planes (layer budget is 6).
   - Only the current floor loaded, with a loading screen on floor change.
4. **Then the CPU** (it becomes the limit near 72): hover picking (+7 fps when off),
   `matrixAutoUpdate` for the static office (+5.5), the batcher's per-frame checks (+2.6).
5. Verify the visible populated world at the original 72 fps target, with `px.py` on screenshots.
