# Native laptop-screen sampling

The 2026-09-30 laptop-blur report concerns the in-world laptop canvas. A nearby screen
can already reach the unfoveated sharp-screen layer and still lose thin stroke contrast
when its source texture is slightly larger than its eye-space footprint. This sampling
change complements the maximum world resolution control and the terminal font correction.

## Change

Mapped screen draws in the sharp-screen layer use `texture(uMap, vMapUv, -0.5)`. The
half-mip bias prefers a slightly more detailed mip level while retaining implicit
derivatives, trilinear minification and the existing anisotropic texture filtering.
It does not force mip level zero at every distance. GLSL ES 3.00 supports the optional
bias in its mip-level selection; see the [Khronos texture reference](https://registry.khronos.org/OpenGL-Refpages/es3.0/html/texture.xhtml).

The world pass and transparent sharp-layer overlays retain their original sampling.
Screen geometry, canvas dimensions, UV transforms, crop selection, depth occlusion,
premultiplied overlay output and projection remain unchanged. The generated shader still
performs one color texture lookup; the bias adds no extra screen draw or texture upload.

## Regression coverage

The existing office fixture uses smooth texture gradients. It verifies scene and color
parity, depth occlusion and crops, but does not establish fine terminal stroke contrast.
The required GLES framebuffer suite now adds a 256×128 source containing 5×7 glyphs with
two-texel stems and a one-texel black/white checker. It renders the source at 170×85 pixels,
approximately 1.5× minification, with three subpixel phases. Both two-dimensional and array
world-depth shader variants must satisfy these checks:

- The screen's glyph region gains more than 1% RMS contrast against an independently
  generated unbiased sampling reference, with opaque screen coverage retained.
- World pixels and half-opacity overlay pixels differ from the unbiased reference by
  at most one channel value, including overlay premultiplication.
- Distant and oblique checker regions still converge to a constant instead of leaving
  a high-frequency pattern. These include head-on distance 3, 50° at distance 2 and
  65° at distance 4, across all three phases.
- All generated programs link and the raster checks produce no GL error.

The 1% contrast minimum distinguishes an observable gain from eight-bit quantization
without requiring the same anisotropic implementation or subpixel phase on every GL driver.
These assertions exercise rendered pixels rather than matching generated shader text.

The new checks run through the existing registered scene suite; CI registration and
thresholds for the previous scene and shader comparisons are unchanged. The suite writes
`sampling-source.ppm`, `sampling-unbiased.ppm` and `sampling-sharp.ppm` beside its other
framebuffer evidence for inspection.

## Host evidence, 2026-09-30

On Apple M5 Pro through ANGLE 2.1.28007, the screen glyph-region RMS contrast changed
from 91.686 to 93.247 at phase 0, 92.493 to 95.072 at phase 0.25 and 91.918 to 93.844
at phase 0.75: approximately 1.7–2.8%. Both depth variants agreed. The existing scene
fixture and the new pixel assertions passed with AddressSanitizer and
UndefinedBehaviorSanitizer enabled. The source fixture contained 1,202 objects,
70 textures and 232 packets; packet/model validation passed 1,655 checks.

Strict host compilation, the pinned Android NDK cross-compile, all 2,684 generated
GLSL stages, all 1,342 program links and the required browser comparison against
three.js r186 passed. The changed C++ files pass clang-format 20.1.8.

This is a conservative contrast improvement. Host raster evidence does not establish
Galaxy XR performance, temporal shimmer during physical head movement or the owner's
worn-headset text readability. The combined font, resolution and sampling build still
requires those device and wearer checks; increasing resolution alone is not proof of
sharp text at the final compositor output.
