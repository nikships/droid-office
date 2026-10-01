// Renders a recorded packet stream with the real SceneRenderer on a host GLES 3 (ANGLE), the way
// the headset does: into a GL_SRGB8_ALPHA8 target, in mono, stereo fallback (two passes) and
// multiview (one pass into a 2-layer array, when GL_OVR_multiview2 is present). Writes each image
// as a PPM and checks that the three paths agree and that no GL error or shader failure happened.
// Every frame calls prepareFrame with an unrelated framebuffer, read framebuffer, viewport and
// scissor bound and checks it restores them (the first shadow map allocation happens inside it). A
// second renderer never calls prepareFrame, so render prepares inside the eye framebuffer; that
// must stay bound too.
//   render <packets.json> <out-dir> [--size px] [--seconds s] [--look ex,ey,ez,tx,ty,tz]
// Without --look the eyes sit at the page camera from the stream.
#include "foveation_filter.h"
#include "foveation_filter_shader.h"
#include "layer_occlusion.h"
#include "panel_cutout.h"
#include "scene_renderer.h"
#include "scene_shaders.h"
#include "scene_uniforms.h"

#include <EGL/egl.h>
#include <GLES3/gl3.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifndef GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_NUM_VIEWS_OVR
#define GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_NUM_VIEWS_OVR 0x9630
#endif

using namespace office;
using json = nlohmann::json;

namespace {

typedef void (*MultiviewFn)(GLenum, GLenum, GLuint, GLint, GLint, GLsizei);

struct Mat {
    float m[16];
};

Mat perspective(float fovDeg, float aspect, float n, float f) {
    float t = 1.0f / std::tan(fovDeg * 3.14159265f / 360.0f);
    Mat r{};
    r.m[0] = t / aspect;
    r.m[5] = t;
    r.m[10] = -(f + n) / (f - n);
    r.m[11] = -1;
    r.m[14] = -2 * f * n / (f - n);
    return r;
}

/** Inverse of a rigid (rotation + translation) world matrix given as 12 affine floats. */
Mat viewFromWorld(const std::vector<float> &a, float eyeOffsetX) {
    // Columns: x = a[0..2], y = a[3..5], z = a[6..8], t = a[9..11]. Offset the eye along its x
    // axis.
    float t[3] = {a[9] + a[0] * eyeOffsetX, a[10] + a[1] * eyeOffsetX, a[11] + a[2] * eyeOffsetX};
    Mat v{};
    for (int r = 0; r < 3; r++) {
        v.m[0 * 4 + r] = a[r * 3 + 0];
        v.m[1 * 4 + r] = a[r * 3 + 1];
        v.m[2 * 4 + r] = a[r * 3 + 2];
    }
    for (int r = 0; r < 3; r++)
        v.m[12 + r] = -(a[r * 3 + 0] * t[0] + a[r * 3 + 1] * t[1] + a[r * 3 + 2] * t[2]);
    v.m[15] = 1;
    return v;
}

bool writePpm(const std::string &path, const std::vector<uint8_t> &rgba, int w, int h) {
    FILE *f = std::fopen(path.c_str(), "wb");
    if (!f)
        return false;
    std::fprintf(f, "P6\n%d %d\n255\n", w, h);
    for (int y = h - 1; y >= 0; y--)
        for (int x = 0; x < w; x++)
            std::fwrite(&rgba[size_t(y * w + x) * 4], 1, 3, f);
    std::fclose(f);
    return true;
}

std::vector<uint8_t> readPixels(int w, int h) {
    std::vector<uint8_t> px(size_t(w) * h * 4);
    glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, px.data());
    return px;
}

struct Diff {
    double mean = 0;
    double over8 = 0; // fraction of pixels with a channel off by more than 8
};

Diff compare(const std::vector<uint8_t> &a, const std::vector<uint8_t> &b) {
    Diff d;
    size_t n = a.size() / 4, bad = 0;
    double sum = 0;
    for (size_t i = 0; i < n; i++) {
        int worst = 0;
        for (int c = 0; c < 3; c++) {
            int e = std::abs(int(a[i * 4 + c]) - int(b[i * 4 + c]));
            sum += e;
            worst = std::max(worst, e);
        }
        if (worst > 8)
            bad++;
    }
    d.mean = sum / double(n * 3);
    d.over8 = double(bad) / double(n);
    return d;
}

/** Fraction of pixels that are not the clear color, and the number of distinct coarse colors. */
void coverage(const std::vector<uint8_t> &px, double &lit, int &colors) {
    size_t n = px.size() / 4, on = 0;
    std::vector<bool> seen(4096);
    colors = 0;
    for (size_t i = 0; i < n; i++) {
        const uint8_t *p = &px[i * 4];
        if (p[0] | p[1] | p[2])
            on++;
        int k = (p[0] >> 4) << 8 | (p[1] >> 4) << 4 | (p[2] >> 4);
        if (!seen[size_t(k)]) {
            seen[size_t(k)] = true;
            colors++;
        }
    }
    lit = double(on) / double(n);
}

void printStats(const char *label, const SceneStats &s) {
    std::printf(
        "%-10s draws %u (shadow %u, last map %u, redraws %llu), items %u (culled %u), tris %u, "
        "points %u, lines %u, programs %u (compiling %u, failed %u), textures %u, buffers %u, "
        "vertex arrays %u, pending uploads %u, "
        "cpu %.2f ms (prepare %.2f, draw %.2f, 90-frame max %.2f), gpu %.2f ms, state %llu%s\n",
        label, s.drawCalls, s.shadowDrawCalls, s.shadowMapDraws,
        (unsigned long long)s.shadowRedraws, s.drawItems, s.culledItems, s.triangles, s.points,
        s.lines, s.programs, s.programsCompiling, s.programsFailed, s.textures, s.buffers,
        s.vertexArrays, s.pendingUploads, double(s.cpuMs), double(s.prepareMs), double(s.drawMs),
        double(s.cpuMaxMs), double(s.gpuMs), (unsigned long long)s.stateSerial,
        s.waitingState ? " (newer state uploading)" : "");
}

/** A camera world matrix (12 affine floats) at `e` looking at `t`, world up +y. */
std::vector<float> lookCamera(const float e[3], const float t[3]) {
    float f[3] = {t[0] - e[0], t[1] - e[1], t[2] - e[2]};
    float fl = std::sqrt(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
    for (float &v : f)
        v /= fl;
    float z[3] = {-f[0], -f[1], -f[2]}; // camera +z points back
    float x[3] = {z[2], 0, -z[0]};      // up (0,1,0) x z
    float xl = std::sqrt(x[0] * x[0] + x[2] * x[2]);
    for (float &v : x)
        v /= xl;
    float y[3] = {z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]};
    return {x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2], e[0], e[1], e[2]};
}

struct Bindings {
    GLint draw = 0, read = 0, viewport[4] = {};
    GLboolean scissor = GL_FALSE;
    static Bindings now() {
        Bindings b;
        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &b.draw);
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &b.read);
        glGetIntegerv(GL_VIEWPORT, b.viewport);
        b.scissor = glIsEnabled(GL_SCISSOR_TEST);
        return b;
    }
    bool operator==(const Bindings &o) const {
        return draw == o.draw && read == o.read && scissor == o.scissor &&
               std::memcmp(viewport, o.viewport, sizeof viewport) == 0;
    }
    void print(const char *label) const {
        std::printf("  %s: draw fbo %d, read fbo %d, viewport %d,%d %dx%d, scissor %d\n", label,
                    draw, read, viewport[0], viewport[1], viewport[2], viewport[3], int(scissor));
    }
};

// ---- The high-resolution laptop screen layer ---------------------------------------------------

/** Window depth of a point `meters` in front of the eye, for `proj` (OpenGL clip). */
float windowDepth(const Mat &proj, float meters) {
    float ndc = (-proj.m[10] * meters + proj.m[14]) / meters;
    return ndc * 0.5f + 0.5f;
}

struct Layer {
    std::vector<uint8_t> px;
    int w = 0, h = 0;
    size_t covered = 0, partial = 0, dirtyEmpty = 0, left = 0;
    double red = 0; // mean red minus green over covered pixels (the pane is red)
};

Layer analyze(std::vector<uint8_t> px, int w, int h) {
    Layer l;
    l.w = w;
    l.h = h;
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            const uint8_t *p = &px[size_t(y * w + x) * 4];
            if (p[3] == 255) {
                l.covered++;
                l.left += x < w / 2;
                l.red += double(p[0]) - double(p[1]);
            } else if (p[3] == 0) {
                l.dirtyEmpty += (p[0] | p[1] | p[2]) != 0;
            } else {
                l.partial++;
            }
        }
    if (l.covered)
        l.red /= double(l.covered);
    l.px = std::move(px);
    return l;
}

/**
 * Renders the world into a sub-rectangle of a larger depth/color target, as the headset's render
 * scale does, then the screen layer from that depth, and checks what the layer keeps: the laptop
 * screen with the same pixels as the world draw, nothing elsewhere, nothing behind a nearer depth
 * (the whole view, or half of it), no self-occlusion from lower-resolution depth, head-on and
 * oblique, a 2D depth and a layer of a depth array, fade, bindings, stats and GL errors. The
 * cropped layer (planSharpScreens) must keep exactly the whole-image layer's pixels inside its
 * crop, with none outside it, a transparent guard band, a crop within a few pixels of the screen,
 * no reads of the world depth outside sharpDepthRegion, and sub-view edges that keep pixels in
 * place.
 */
template <typename Prepare, typename CheckBindings>
int sharpChecks(SceneRenderer &r, Prepare &&prepare, CheckBindings &&checkBindings, int high,
                const std::string &out, std::vector<std::string> &failed) {
    int failures = 0;
    auto expect = [&](bool ok, const std::string &what) {
        std::printf("  sharp: %s %s\n", ok ? "ok  " : "FAIL", what.c_str());
        failures += !ok;
        if (!ok)
            failed.push_back("sharp: " + what);
    };
    const int n = high / 2, off = 40, big = n + 2 * off;
    const float uv[4] = {float(off) / big, float(off) / big, float(n) / big, float(n) / big};
    Mat proj = perspective(70, 1, 0.05f, 320);

    // World targets: a 2D depth texture, and a 2-layer depth array whose layer 1 holds the world.
    GLuint worldColor = 0, worldDepth = 0, worldFbo = 0, arrayDepth = 0, arrayFbo = 0;
    glGenTextures(1, &worldColor);
    glBindTexture(GL_TEXTURE_2D, worldColor);
    glTexStorage2D(GL_TEXTURE_2D, 1, GL_SRGB8_ALPHA8, big, big);
    glGenTextures(1, &worldDepth);
    glBindTexture(GL_TEXTURE_2D, worldDepth);
    glTexStorage2D(GL_TEXTURE_2D, 1, GL_DEPTH_COMPONENT24, big, big);
    glGenFramebuffers(1, &worldFbo);
    glBindFramebuffer(GL_FRAMEBUFFER, worldFbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, worldColor, 0);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, worldDepth, 0);
    glGenTextures(1, &arrayDepth);
    glBindTexture(GL_TEXTURE_2D_ARRAY, arrayDepth);
    glTexStorage3D(GL_TEXTURE_2D_ARRAY, 1, GL_DEPTH_COMPONENT24, big, big, 2);
    glGenFramebuffers(1, &arrayFbo);
    // Screen layer targets: the same size as the world view, and the high-resolution one.
    GLuint layerColor[2] = {}, layerFbo[2] = {};
    glGenTextures(2, layerColor);
    glGenFramebuffers(2, layerFbo);
    for (int i = 0; i < 2; i++) {
        int s = i ? high : n;
        glBindTexture(GL_TEXTURE_2D, layerColor[i]);
        glTexStorage2D(GL_TEXTURE_2D, 1, GL_SRGB8_ALPHA8, s, s);
        glBindFramebuffer(GL_FRAMEBUFFER, layerFbo[i]);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, layerColor[i],
                               0);
    }
    glBindTexture(GL_TEXTURE_2D, 0);
    glBindTexture(GL_TEXTURE_2D_ARRAY, 0);

    auto eyeAt = [&](std::initializer_list<float> e, std::initializer_list<float> t) {
        SceneEye eye;
        Mat v = viewFromWorld(lookCamera(e.begin(), t.begin()), 0);
        std::memcpy(eye.view, v.m, sizeof v.m);
        std::memcpy(eye.projection, proj.m, sizeof proj.m);
        return eye;
    };
    auto world = [&](const SceneEye &eye, GLuint fbo) {
        prepare(r);
        glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        glViewport(off, off, n, n);
        r.render(eye, n);
    };
    // Clears the world depth to `depth` (optionally only the left half of the view) instead.
    auto fakeDepth = [&](float depth, bool leftHalf) {
        prepare(r);
        glBindFramebuffer(GL_FRAMEBUFFER, worldFbo);
        glDepthMask(GL_TRUE);
        glClearDepthf(1);
        glClear(GL_DEPTH_BUFFER_BIT);
        glEnable(GL_SCISSOR_TEST);
        glScissor(off, off, leftHalf ? n / 2 : n, n);
        glClearDepthf(depth);
        glClear(GL_DEPTH_BUFFER_BIT);
        glDisable(GL_SCISSOR_TEST);
        glClearDepthf(1);
    };
    auto layer = [&](const SceneEye &eye, int which, const SharpScreenDepth &depth, float fade) {
        int s = which ? high : n;
        glBindFramebuffer(GL_FRAMEBUFFER, layerFbo[which]);
        glViewport(0, 0, s, s);
        // Stale pixels that the layer's clear must remove.
        glClearColor(0.3f, 0.6f, 0.9f, 0.5f);
        glClear(GL_COLOR_BUFFER_BIT);
        Bindings want = Bindings::now();
        SceneEye pair[2] = {eye, eye};
        r.renderSharpScreens(pair, s, s, depth, fade);
        checkBindings("renderSharpScreens", want);
        glFinish();
        glBindFramebuffer(GL_READ_FRAMEBUFFER, layerFbo[which]);
        return analyze(readPixels(s, s), s, s);
    };
    SharpScreenDepth flat;
    flat.texture = worldDepth;
    std::copy(uv, uv + 4, flat.uvRect);
    SharpScreenDepth layered = flat;
    layered.texture = arrayDepth;
    layered.arrayTexture = true;
    layered.layer = 1;

    // The fixture's laptop screen is centred near (0, 1.335, 6.26), facing +z.
    SceneEye headOn = eyeAt({0, 1.45f, 6.95f}, {0, 1.33f, 6.26f});
    SceneEye oblique = eyeAt({0.62f, 1.42f, 6.55f}, {0, 1.33f, 6.26f});
    SceneEye away = eyeAt({0, 1.45f, 6.95f}, {0, 1.45f, 8.5f});
    SceneEye far = eyeAt({0, 1.6f, 19.0f}, {0, 1.33f, 6.26f});
    SceneEye pair[2] = {headOn, headOn};

    for (int i = 0; i < 120 && r.stats().programsCompiling + !r.hasSharpScreens(); i++)
        prepare(r); // links any screen layer program still waiting
    expect(r.hasSharpScreens(), "the drawn state has a sharp screen ready");
    expect(r.hasSharpScreens(pair, false) && r.hasSharpScreens(pair, true),
           "the head-on view has one, with 2D and array depth");
    SceneEye awayPair[2] = {away, away}, farPair[2] = {far, far};
    expect(!r.hasSharpScreens(awayPair, false), "a view facing away has none");
    expect(!r.hasSharpScreens(farPair, false), "a view 12 m away has none");
    expect(r.stats().sharpItems == 1, "stats count one sharp item");

    // Same resolution as the world: the kept pixels are the world's screen pixels.
    world(headOn, worldFbo);
    SceneStats before = r.stats();
    glBindFramebuffer(GL_READ_FRAMEBUFFER, worldFbo);
    std::vector<uint8_t> worldPx(size_t(n) * n * 4);
    glReadPixels(off, off, n, n, GL_RGBA, GL_UNSIGNED_BYTE, worldPx.data());
    Layer same = layer(headOn, 0, flat, 0);
    SceneStats after = r.stats();
    size_t match = 0;
    for (size_t i = 0; i < worldPx.size() / 4; i++) {
        if (same.px[i * 4 + 3] != 255)
            continue;
        int worst = 0;
        for (int c = 0; c < 3; c++)
            worst = std::max(worst, std::abs(int(same.px[i * 4 + c]) - int(worldPx[i * 4 + c])));
        match += worst <= 8;
    }
    std::printf("  sharp: head-on %dx%d covers %zu px, %zu match the world, pane redness %.1f, "
                "overlays %u, draws %u\n",
                n, n, same.covered, match, same.red, after.sharpOverlays, after.sharpDrawCalls);
    writePpm(out + "/sharp-world.ppm", worldPx, n, n);
    writePpm(out + "/sharp-same.ppm", same.px, n, n);
    expect(same.covered > size_t(n) * n / 20, "the screen covers the view");
    expect(match >= same.covered * 995 / 1000,
           "kept pixels equal the world's (same matrices, texture and pane)");
    expect(same.partial == 0 && same.dirtyEmpty == 0, "uncovered pixels are (0,0,0,0)");
    expect(after.sharpScreens == 1 && after.sharpOverlays >= 1 && after.sharpDrawCalls >= 2,
           "stats: one screen and the pane over it");
    expect(after.drawCalls == before.drawCalls && after.triangles == before.triangles,
           "the world's draw stats are unchanged");

    // High resolution from the lower-resolution depth: no self-occlusion, head-on and oblique.
    for (const SceneEye *eye : {&headOn, &oblique}) {
        const char *name = eye == &headOn ? "head-on" : "oblique";
        world(*eye, worldFbo);
        Layer real = layer(*eye, 1, flat, 0);
        writePpm(out + "/sharp-" + name + ".ppm", real.px, high, high);
        fakeDepth(1, false);
        Layer open = layer(*eye, 1, flat, 0);
        std::printf("  sharp: %s %dx%d covers %zu px with the world depth, %zu with none\n", name,
                    high, high, real.covered, open.covered);
        expect(open.covered > size_t(high) * high / 50, std::string(name) + " screen is seen");
        expect(real.covered * 1000 >= open.covered * 995,
               std::string(name) + " screen is not rejected by its own lower-resolution depth");
        expect(real.partial == 0 && real.dirtyEmpty == 0,
               std::string(name) + " uncovered pixels are (0,0,0,0)");
    }

    // A nearer surface over the whole view, then over its left half, hides the screen there.
    float wall = windowDepth(proj, 0.3f);
    fakeDepth(wall, false);
    Layer hidden = layer(headOn, 1, flat, 0);
    expect(hidden.covered == 0 && hidden.dirtyEmpty == 0 && hidden.partial == 0,
           "a wall 0.3 m from the eye hides the whole screen and the pane");
    fakeDepth(wall, true);
    Layer half = layer(headOn, 1, flat, 0);
    fakeDepth(1, false);
    Layer whole = layer(headOn, 1, flat, 0);
    std::printf("  sharp: half wall keeps %zu px (%zu left of centre) of %zu\n", half.covered,
                half.left, whole.covered);
    expect(half.left == 0 && whole.left > 0 && half.covered + whole.left <= whole.covered + 64,
           "a wall over the left half hides exactly that half");
    // A surface a few centimetres in front of the screen's nearest edge (about 0.645 m) hides it.
    fakeDepth(windowDepth(proj, 0.61f), false);
    Layer close = layer(headOn, 1, flat, 0);
    expect(close.covered == 0, "a surface 3.5 cm in front of the screen hides it");

    // A layer of a depth array; the other layer is nearer everywhere.
    world(headOn, worldFbo);
    Layer from2d = layer(headOn, 1, flat, 0);
    prepare(r);
    glBindFramebuffer(GL_FRAMEBUFFER, arrayFbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, worldColor, 0);
    glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, arrayDepth, 0, 0);
    glDepthMask(GL_TRUE);
    glClearDepthf(0);
    glClear(GL_DEPTH_BUFFER_BIT);
    glClearDepthf(1);
    glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, arrayDepth, 0, 1);
    glViewport(off, off, n, n);
    r.render(headOn, n);
    Layer fromArray = layer(headOn, 1, layered, 0);
    SharpScreenDepth wrongLayer = layered;
    wrongLayer.layer = 0;
    Layer fromLayer0 = layer(headOn, 1, wrongLayer, 0);
    expect(fromArray.covered == from2d.covered && compare(fromArray.px, from2d.px).over8 == 0,
           "array layer 1 keeps the same pixels as the 2D depth");
    expect(fromLayer0.covered == 0, "array layer 0 (nearer everywhere) hides the screen");

    // Fade to black keeps coverage and darkens the color.
    Layer black = layer(headOn, 1, flat, 1);
    bool dark = true;
    for (size_t i = 0; i < black.px.size() / 4; i++)
        dark &= black.px[i * 4] <= 1 && black.px[i * 4 + 1] <= 1 && black.px[i * 4 + 2] <= 1;
    expect(black.covered == from2d.covered && dark, "full fade keeps the coverage, all black");

    // Nothing to draw: the layer is still cleared.
    Layer none = layer(away, 1, flat, 0);
    expect(none.covered == 0 && none.dirtyEmpty == 0 && none.partial == 0,
           "a view without screens leaves the layer cleared");

    // The caller's scissor limits the clear and draw, and is restored.
    glBindFramebuffer(GL_FRAMEBUFFER, layerFbo[1]);
    glViewport(0, 0, high, high);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, high / 2, high);
    GLint box[4] = {};
    Bindings want = Bindings::now();
    world(headOn, worldFbo);
    glBindFramebuffer(GL_FRAMEBUFFER, layerFbo[1]);
    glViewport(0, 0, high, high);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, high / 2, high);
    r.renderSharpScreens(pair, high, high, flat, 0);
    checkBindings("renderSharpScreens with a scissor", want);
    glGetIntegerv(GL_SCISSOR_BOX, box);
    expect(box[0] == 0 && box[1] == 0 && box[2] == high / 2 && box[3] == high,
           "the caller's scissor box is restored");
    glDisable(GL_SCISSOR_TEST);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, layerFbo[1]);
    Layer scissored = analyze(readPixels(high, high), high, high);
    expect(scissored.covered == scissored.left && scissored.left > 0,
           "only the scissored half is drawn");

    // ---- The cropped layer (planSharpScreens + planned renderSharpScreens) ----------------------
    const int ws[2] = {high, high}, hs[2] = {high, high};
    // Plans for `e`, then draws view `view` over stale pixels; returns the read-back layer.
    auto planned = [&](const SceneEye(&e)[2], int view, const SharpScreenDepth &depth,
                       SharpScreenPlan &plan) {
        r.planSharpScreens(e, ws, hs, depth.arrayTexture, plan);
        glBindFramebuffer(GL_FRAMEBUFFER, layerFbo[1]);
        glViewport(0, 0, high, high);
        glClearColor(0.3f, 0.6f, 0.9f, 0.5f);
        glClear(GL_COLOR_BUFFER_BIT);
        Bindings want = Bindings::now();
        r.renderSharpScreens(plan, view, depth, 0);
        checkBindings("planned renderSharpScreens", want);
        glFinish();
        glBindFramebuffer(GL_READ_FRAMEBUFFER, layerFbo[1]);
        return analyze(readPixels(high, high), high, high);
    };
    auto inside = [](const int *rc, int x, int y) {
        return x >= rc[0] && y >= rc[1] && x < rc[0] + rc[2] && y < rc[1] + rc[3];
    };
    // Every pixel the whole-image layer covers lies in viewRect and is identical there; the rest
    // of the region is transparent black.
    auto sameAsWhole = [&](const Layer &whole, const Layer &crop, const SharpScreenPlan &plan,
                           int view, const std::string &name) {
        const int *vr = plan.viewRect[view], *rg = plan.region[view];
        size_t outside = 0, differ = 0, dirty = 0, compared = 0;
        for (int y = 0; y < high; y++)
            for (int x = 0; x < high; x++) {
                const uint8_t *a = &whole.px[size_t(y * high + x) * 4];
                const uint8_t *b = &crop.px[size_t(y * high + x) * 4];
                if (inside(vr, x, y)) {
                    compared++;
                    differ += std::memcmp(a, b, 4) != 0;
                } else if (inside(rg, x, y)) {
                    dirty += (b[0] | b[1] | b[2] | b[3]) != 0;
                }
                outside += !inside(vr, x, y) && a[3] != 0;
            }
        std::printf("  sharp: cropped %s: view %d,%d %dx%d (%.1f%% of %dx%d), region %dx%d, "
                    "%zu px compared, %zu differ, %zu screen px outside, %zu dirty guard px\n",
                    name.c_str(), vr[0], vr[1], vr[2], vr[3],
                    100.0 * double(vr[2]) * vr[3] / (double(high) * high), high, high, rg[2], rg[3],
                    compared, differ, outside, dirty);
        expect(outside == 0,
               "cropped " + name + ": no whole-image screen pixel is outside the crop");
        expect(differ == 0, "cropped " + name + ": the crop's pixels equal the whole image's");
        expect(dirty == 0, "cropped " + name + ": the guard band is transparent black");
        expect(rg[0] <= vr[0] && rg[1] <= vr[1] && rg[0] + rg[2] >= vr[0] + vr[2] &&
                   rg[1] + rg[3] >= vr[1] + vr[3],
               "cropped " + name + ": the region contains the crop");
    };

    SceneEye near2 = eyeAt({0, 1.45f, 8.9f}, {0, 1.33f, 6.26f}); // about 2.6 m away
    for (const SceneEye *eye : {&headOn, &oblique, &near2}) {
        const char *name = eye == &headOn ? "head-on" : eye == &oblique ? "oblique" : "2.6 m";
        world(*eye, worldFbo);
        Layer whole = layer(*eye, 1, flat, 0);
        SharpScreenPlan plan;
        SceneEye both[2] = {*eye, *eye};
        Layer crop = planned(both, 0, flat, plan);
        SceneStats st = r.stats();
        expect(plan.any, std::string("cropped ") + name + ": planned");
        sameAsWhole(whole, crop, plan, 0, name);
        expect(crop.covered == whole.covered && crop.covered > 0,
               std::string("cropped ") + name + ": same coverage as the whole image");
        expect(st.sharpScreens >= 1 && st.sharpViewPixels > 0 &&
                   st.sharpRegionPixels >= uint64_t(plan.viewRect[0][2]) * plan.viewRect[0][3],
               std::string("cropped ") + name + ": stats count the crop");
        if (eye == &near2)
            expect(double(plan.viewRect[0][2]) * plan.viewRect[0][3] < 0.1 * high * high,
                   "cropped 2.6 m: the crop is under 10% of the image");
    }

    // Tight bounds: without occlusion the crop hugs the screen's pixels (its vertex box, not its
    // bounding sphere), a few pixels of margin at most.
    {
        fakeDepth(1, false);
        SceneEye both[2] = {near2, near2};
        SharpScreenPlan plan;
        Layer crop = planned(both, 0, flat, plan);
        int x0 = high, y0 = high, x1 = -1, y1 = -1;
        for (int y = 0; y < high; y++)
            for (int x = 0; x < high; x++)
                if (crop.px[size_t(y * high + x) * 4 + 3] == 255) {
                    x0 = std::min(x0, x);
                    y0 = std::min(y0, y);
                    x1 = std::max(x1, x);
                    y1 = std::max(y1, y);
                }
        const int *vr = plan.viewRect[0];
        int slack =
            std::max({x0 - vr[0], y0 - vr[1], vr[0] + vr[2] - 1 - x1, vr[1] + vr[3] - 1 - y1});
        std::printf("  sharp: tight crop: screen px %d,%d..%d,%d, crop %d,%d %dx%d, slack %d px\n",
                    x0, y0, x1, y1, vr[0], vr[1], vr[2], vr[3], slack);
        expect(x1 >= x0 && slack <= 4 && x0 >= vr[0] && y0 >= vr[1],
               "tight crop: within 4 px of the screen's own pixels");
    }

    // Two different eyes in single view: each view's plan matches its own whole image.
    {
        SceneEye left = eyeAt({-0.032f, 1.45f, 6.95f}, {-0.032f, 1.33f, 6.26f});
        SceneEye right = eyeAt({0.032f, 1.45f, 6.95f}, {0.032f, 1.33f, 6.26f});
        SceneEye both[2] = {left, right};
        world(right, worldFbo);
        Layer whole = layer(right, 1, flat, 0);
        SharpScreenPlan plan;
        Layer crop = planned(both, 1, flat, plan);
        sameAsWhole(whole, crop, plan, 1, "right eye of two");
        expect(plan.viewRect[0][0] != plan.viewRect[1][0], "two eyes: each view has its own crop");
    }

    // A view that sees no screen presents a few transparent pixels.
    {
        SceneEye both[2] = {headOn, away};
        world(away, worldFbo);
        SharpScreenPlan plan;
        Layer crop = planned(both, 1, flat, plan);
        const int *vr = plan.viewRect[1];
        expect(plan.any && vr[2] > 0 && vr[3] > 0 && vr[2] * vr[3] <= 64 && crop.covered == 0,
               "a view without screens presents a small transparent crop");
    }

    // The world depth outside sharpDepthRegion is never sampled: making it nearer everywhere there
    // (what an invalidate may leave) changes nothing.
    {
        SceneEye both[2] = {near2, near2};
        world(near2, worldFbo);
        SharpScreenPlan plan;
        Layer intact = planned(both, 0, flat, plan);
        int keep[4], spans[4][4];
        sharpDepthRegion(plan, 0, flat.uvRect, big, big, keep);
        int count = sharpComplement(keep, big, big, spans);
        long long area = 0;
        prepare(r);
        glBindFramebuffer(GL_FRAMEBUFFER, worldFbo);
        glEnable(GL_SCISSOR_TEST);
        glDepthMask(GL_TRUE);
        glClearDepthf(0);
        for (int k = 0; k < count; k++) {
            glScissor(spans[k][0], spans[k][1], spans[k][2], spans[k][3]);
            glClear(GL_DEPTH_BUFFER_BIT);
            area += (long long)spans[k][2] * spans[k][3];
        }
        glClearDepthf(1);
        glDisable(GL_SCISSOR_TEST);
        Layer rest = planned(both, 0, flat, plan);
        std::printf(
            "  sharp: depth kept %d,%d %dx%d of %dx%d, %d spans (%lld texels) overwritten\n",
            keep[0], keep[1], keep[2], keep[3], big, big, count, area);
        expect(count > 0 && area + (long long)keep[2] * keep[3] == (long long)big * big,
               "the kept depth and its complement tile the texture");
        expect(intact.covered > 0 && rest.covered == intact.covered &&
                   compare(rest.px, intact.px).over8 == 0 &&
                   std::memcmp(rest.px.data(), intact.px.data(), rest.px.size()) == 0,
               "depth outside sharpDepthRegion is never sampled");
    }

    // Presenting the crop with sharpSubTangents places every pixel where the whole image does,
    // also through the angle round trip of XrFovf and with an asymmetric view.
    {
        const SharpTangents whole{-1.07f, 0.84f, -0.97f, 0.79f};
        const int W = 3152, H = 3682, crop[4] = {1013, 2107, 641, 409};
        SharpTangents sub = sharpSubTangents(whole, W, H, crop);
        SharpTangents trip{std::tan(std::atan(sub.left)), std::tan(std::atan(sub.right)),
                           std::tan(std::atan(sub.down)), std::tan(std::atan(sub.up))};
        double worst = 0;
        for (int i = 0; i <= 20; i++)
            for (int j = 0; j <= 20; j++) {
                float tx = sub.left + (sub.right - sub.left) * float(i) / 20;
                float ty = sub.down + (sub.up - sub.down) * float(j) / 20;
                double fx = (tx - whole.left) / (whole.right - whole.left) * W;
                double fy = (ty - whole.down) / (whole.up - whole.down) * H;
                double cx = crop[0] + (tx - trip.left) / (trip.right - trip.left) * crop[2];
                double cy = crop[1] + (ty - trip.down) / (trip.up - trip.down) * crop[3];
                worst = std::max({worst, std::abs(fx - cx), std::abs(fy - cy)});
            }
        std::printf("  sharp: sub-tangent placement error %.4f px\n", worst);
        expect(worst < 0.05, "the cropped view's edges keep every pixel in place (< 0.05 px)");
        int full[4] = {0, 0, W, H};
        SharpTangents same = sharpSubTangents(whole, W, H, full);
        expect(same.left == whole.left && same.right == whole.right && same.down == whole.down &&
                   same.up == whole.up,
               "the whole image keeps the whole view's edges");
    }

    GLenum err = glGetError();
    expect(err == GL_NO_ERROR, "no GL error");
    expect(r.lastError().empty(), "no renderer error (" + r.lastError() + ")");

    // A plan from an earlier frame draws nothing and is reported (last: it sets lastError).
    {
        world(headOn, worldFbo);
        SceneEye both[2] = {headOn, headOn};
        const int ws[2] = {high, high}, hs[2] = {high, high};
        SharpScreenPlan old;
        r.planSharpScreens(both, ws, hs, false, old);
        prepare(r);
        glBindFramebuffer(GL_FRAMEBUFFER, layerFbo[1]);
        glViewport(0, 0, high, high);
        glClearColor(0.3f, 0.6f, 0.9f, 0.5f);
        glClear(GL_COLOR_BUFFER_BIT);
        r.renderSharpScreens(old, 0, flat, 0);
        glFinish();
        glBindFramebuffer(GL_READ_FRAMEBUFFER, layerFbo[1]);
        Layer stale = analyze(readPixels(high, high), high, high);
        expect(old.any && stale.covered == 0 &&
                   r.lastError().find("latest planSharpScreens") != std::string::npos,
               "a plan from an earlier frame draws no screen and is reported");
    }
    glDeleteFramebuffers(1, &worldFbo);
    glDeleteFramebuffers(1, &arrayFbo);
    glDeleteFramebuffers(2, layerFbo);
    GLuint tex[] = {worldColor, worldDepth, arrayDepth, layerColor[0], layerColor[1]};
    glDeleteTextures(5, tex);
    return failures;
}

/**
 * Exercises generated screen shaders with actual thin glyph strokes and a one-texel checker.
 * The office fixture's smooth gradients establish color/occlusion parity but cannot detect
 * softened terminal strokes or a mipmap change that aliases at distance.
 */
void sharpSamplingChecks(const std::string &out, std::vector<std::string> &failed) {
    using namespace office::scene;
    auto expect = [&](bool ok, const std::string &what) {
        std::printf("  sampling: %s %s\n", ok ? "ok  " : "FAIL", what.c_str());
        if (!ok)
            failed.push_back("sampling: " + what);
    };
    auto compile = [&](const ShaderSource &source) {
        GLuint stages[2]{};
        for (int i = 0; i < 2; ++i) {
            stages[i] = glCreateShader(i ? GL_FRAGMENT_SHADER : GL_VERTEX_SHADER);
            const char *text = (i ? source.fragment : source.vertex).c_str();
            glShaderSource(stages[i], 1, &text, nullptr);
            glCompileShader(stages[i]);
            GLint status = 0;
            glGetShaderiv(stages[i], GL_COMPILE_STATUS, &status);
            if (!status) {
                char log[4096]{};
                glGetShaderInfoLog(stages[i], sizeof log, nullptr, log);
                expect(false, std::string("shader compilation: ") + log);
                glDeleteShader(stages[0]);
                if (stages[1])
                    glDeleteShader(stages[1]);
                return GLuint(0);
            }
        }
        GLuint program = glCreateProgram();
        for (GLuint stage : stages) {
            glAttachShader(program, stage);
            glDeleteShader(stage);
        }
        glLinkProgram(program);
        GLint status = 0;
        glGetProgramiv(program, GL_LINK_STATUS, &status);
        if (!status) {
            char log[4096]{};
            glGetProgramInfoLog(program, sizeof log, nullptr, log);
            expect(false, std::string("program link: ") + log);
            glDeleteProgram(program);
            return GLuint(0);
        }
        glUniformBlockBinding(program, glGetUniformBlockIndex(program, "View"), kBlockView);
        return program;
    };

    constexpr int width = 170, height = 85, sourceWidth = 256, sourceHeight = 128;
    // "XR TEXT", 5x7 letters with two-texel stems, repeated in terminal cells on the left.
    const uint8_t glyphs[][7] = {{17, 17, 10, 4, 10, 17, 17},  {30, 17, 17, 30, 20, 18, 17},
                                 {0, 0, 0, 0, 0, 0, 0},        {31, 4, 4, 4, 4, 4, 4},
                                 {31, 16, 16, 30, 16, 16, 31}, {17, 17, 10, 4, 10, 17, 17},
                                 {31, 4, 4, 4, 4, 4, 4}};
    std::vector<uint8_t> pixels(size_t(sourceWidth) * sourceHeight * 4, 255);
    for (int y = 0; y < sourceHeight; ++y)
        for (int x = 0; x < sourceWidth; ++x) {
            const int gx = (x % 12) / 2, gy = 6 - (y % 18) / 2;
            const bool on = x >= sourceWidth / 2
                                ? (x + y) % 2
                                : gx < 5 && gy >= 0 && (glyphs[(x / 12) % 7][gy] & (1 << (4 - gx)));
            for (int c = 0; c < 3; ++c)
                pixels[size_t(y * sourceWidth + x) * 4 + c] = on ? 255 : 0;
        }
    writePpm(out + "/sampling-source.ppm", pixels, sourceWidth, sourceHeight);

    GLuint textures[4]{}, buffers[2]{}, vao = 0, framebuffer = 0;
    glGenTextures(4, textures);
    glActiveTexture(GL_TEXTURE0 + kUnitMap);
    glBindSampler(kUnitMap, 0);
    glBindTexture(GL_TEXTURE_2D, textures[0]);
    glTexStorage2D(GL_TEXTURE_2D, 9, GL_SRGB8_ALPHA8, sourceWidth, sourceHeight);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, sourceWidth, sourceHeight, GL_RGBA, GL_UNSIGNED_BYTE,
                    pixels.data());
    glGenerateMipmap(GL_TEXTURE_2D);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    GLint extensions = 0;
    glGetIntegerv(GL_NUM_EXTENSIONS, &extensions);
    for (int i = 0; i < extensions; ++i)
        if (!std::strcmp(reinterpret_cast<const char *>(glGetStringi(GL_EXTENSIONS, GLuint(i))),
                         "GL_EXT_texture_filter_anisotropic")) {
            GLfloat maximum = 1;
            glGetFloatv(0x84FF /* GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT */, &maximum);
            glTexParameterf(GL_TEXTURE_2D, 0x84FE /* GL_TEXTURE_MAX_ANISOTROPY_EXT */,
                            std::min(16.0f, maximum));
        }
    glActiveTexture(GL_TEXTURE0 + kUnitSharpDepth);
    glBindSampler(kUnitSharpDepth, 0);
    const float depth[2]{1, 1}; // no foreground occluder; actual occlusion is tested above
    glBindTexture(GL_TEXTURE_2D, textures[1]);
    glTexStorage2D(GL_TEXTURE_2D, 1, GL_R32F, 1, 1);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 1, 1, GL_RED, GL_FLOAT, depth);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glBindTexture(GL_TEXTURE_2D_ARRAY, textures[2]);
    glTexStorage3D(GL_TEXTURE_2D_ARRAY, 1, GL_R32F, 1, 1, 2);
    glTexSubImage3D(GL_TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 2, GL_RED, GL_FLOAT, depth);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, textures[3]);
    glTexStorage2D(GL_TEXTURE_2D, 1, GL_SRGB8_ALPHA8, width, height);
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, textures[3], 0);
    expect(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE,
           "fine-text framebuffer complete");
    glBindTexture(GL_TEXTURE_2D, textures[0]);

    const float vertices[]{-1, -1, 0, 0, 0, 1, -1, 0, 1, 0, 1,  1, 0, 1, 1,
                           -1, -1, 0, 0, 0, 1, 1,  0, 1, 1, -1, 1, 0, 0, 1};
    glGenVertexArrays(1, &vao);
    glBindVertexArray(vao);
    glGenBuffers(2, buffers);
    glBindBuffer(GL_ARRAY_BUFFER, buffers[0]);
    glBufferData(GL_ARRAY_BUFFER, sizeof vertices, vertices, GL_STATIC_DRAW);
    glEnableVertexAttribArray(kAttrPosition);
    glVertexAttribPointer(kAttrPosition, 3, GL_FLOAT, GL_FALSE, 5 * sizeof(float), nullptr);
    glEnableVertexAttribArray(kAttrUv);
    glVertexAttribPointer(kAttrUv, 2, GL_FLOAT, GL_FALSE, 5 * sizeof(float),
                          reinterpret_cast<const void *>(3 * sizeof(float)));
    glVertexAttrib4f(kAttrColor, 1, 1, 1, 1);
    ViewBlock view;
    const Mat projection = perspective(90, 1, .05f, 320);
    for (int i = 0; i < 2; ++i) {
        std::copy(projection.m, projection.m + 16, view.viewProj[i].m);
        std::copy(projection.m, projection.m + 16, view.proj[i].m);
    }
    view.viewport = {height, height / 2.0f, 0, 0};
    glBindBuffer(GL_UNIFORM_BUFFER, buffers[1]);
    glBufferData(GL_UNIFORM_BUFFER, sizeof view, &view, GL_STATIC_DRAW);
    glBindBufferBase(GL_UNIFORM_BUFFER, kBlockView, buffers[1]);

    ProgramKey key;
    key.model = ShadeModel::Basic;
    key.map = key.opaque = key.linearOutput = true;
    ShaderSource reference = generateShader(key);
    reference.fragment = R"(#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uMap;
uniform float uReadAlpha;
in vec2 vMapUv;
out vec4 pc_fragColor;
void main() {
    vec4 color = texture(uMap, vMapUv);
    pc_fragColor = vec4(color.rgb * uReadAlpha, uReadAlpha);
}
)";
    GLuint programs[6]{compile(reference), compile(generateShader(key))};
    key.sharpDepth = SharpDepth::Texture2D;
    programs[2] = compile(generateShader(key));
    key.opaque = false;
    key.sharpOverlay = true;
    programs[3] = compile(generateShader(key));
    key.sharpDepth = SharpDepth::Array;
    key.opaque = true;
    key.sharpOverlay = false;
    programs[4] = compile(generateShader(key));
    key.opaque = false;
    key.sharpOverlay = true;
    programs[5] = compile(generateShader(key));
    const bool linked = std::all_of(programs, programs + 6, [](GLuint p) { return p != 0; });
    if (linked) {
        auto draw = [&](GLuint program, float angle, float distance, float phase, float alpha) {
            glUseProgram(program);
            auto location = [&](const char *name) { return glGetUniformLocation(program, name); };
            Mat4Std model;
            const float radians = angle * 3.14159265f / 180;
            model.m[0] = model.m[10] = std::cos(radians);
            model.m[2] = -std::sin(radians);
            model.m[8] = std::sin(radians);
            model.m[12] = phase * 2 * distance / width;
            model.m[14] = -distance;
            const float uv[]{1, 0, 0, 0, 1, 0, 0, 0, 1};
            glUniformMatrix4fv(location("uModel"), 1, GL_FALSE, model.m);
            glUniformMatrix3fv(location("uMapTransform"), 1, GL_FALSE, uv);
            glUniform4f(location("uColor"), 1, 1, 1, alpha);
            glUniform1f(location("uReadAlpha"), alpha);
            glUniform1i(location("uMap"), kUnitMap);
            glUniform1i(location("uSharpDepth"), kUnitSharpDepth);
            glUniform4f(location("uSharpRect"), 0, 0, 1, 1);
            glUniform4f(location("uSharpParams"), 1.0f / width, 1.0f / height, 4, 1);
            glUniform4f(location("uSharpBias"), .003f, .06f, 0, .001f);
            glViewport(0, 0, width, height);
            glDisable(GL_SCISSOR_TEST);
            glDisable(GL_DEPTH_TEST);
            glDisable(GL_BLEND);
            glDisable(GL_CULL_FACE);
            glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
            glClearColor(0, 0, 0, 0);
            glClear(GL_COLOR_BUFFER_BIT);
            glDrawArrays(GL_TRIANGLES, 0, 6);
            return readPixels(width, height);
        };
        auto error = [](const std::vector<uint8_t> &a, const std::vector<uint8_t> &b) {
            int maximum = 0;
            for (size_t i = 0; i < a.size(); ++i)
                maximum = std::max(maximum, std::abs(int(a[i]) - int(b[i])));
            return maximum;
        };
        auto rms = [&](const std::vector<uint8_t> &px, int x0, int x1, int y0, int y1) {
            double sum = 0, squares = 0, count = 0;
            for (int y = y0; y < y1; ++y)
                for (int x = x0; x < x1; ++x) {
                    const double c = px[size_t(y * width + x) * 4];
                    sum += c;
                    squares += c * c;
                    count++;
                }
            return std::sqrt(std::max(0.0, squares / count - (sum / count) * (sum / count)));
        };
        for (float phase : {0.0f, .25f, .75f}) {
            const auto normal = draw(programs[0], 0, 1, phase, 1);
            expect(error(normal, draw(programs[1], 0, 1, phase, 1)) <= 1,
                   "world fine-text pixels retain unbiased trilinear sampling");
            const auto transparent = draw(programs[0], 0, 1, phase, .5f);
            const double baseline = rms(normal, 8, width / 2 - 8, 8, height - 8);
            for (int i : {2, 4}) {
                const auto sharp = draw(programs[i], 0, 1, phase, 1);
                const double contrast = rms(sharp, 8, width / 2 - 8, 8, height - 8);
                std::printf("  sampling: %s depth, phase %.2f: glyph RMS %.3f -> %.3f\n",
                            i == 2 ? "2D" : "array", phase, baseline, contrast);
                // Require an observable contrast gain, without assuming the same subpixel
                // phase or anisotropic implementation on every host GL driver.
                expect(contrast > baseline * 1.01,
                       "slightly minified fine-text strokes retain more contrast");
                bool opaque = true;
                for (int y = 8; y < height - 8; ++y)
                    for (int x = 8; x < width - 8; ++x)
                        opaque &= sharp[size_t(y * width + x) * 4 + 3] == 255;
                expect(opaque, "screen sampling keeps opaque screen coverage");
                expect(error(transparent, draw(programs[i + 1], 0, 1, phase, .5f)) <= 1,
                       "overlay fine-text pixels and premultiplied alpha remain unchanged");
                if (phase == 0 && i == 2) {
                    writePpm(out + "/sampling-unbiased.ppm", normal, width, height);
                    writePpm(out + "/sampling-sharp.ppm", sharp, width, height);
                }
                for (const auto &pose : {std::pair<float, float>{0, 3}, {50, 2}, {65, 4}}) {
                    const auto distant = draw(programs[i], pose.first, pose.second, phase, 1);
                    const float radians = pose.first * 3.14159265f / 180;
                    const int x = int(
                        (.5f * std::cos(radians) / (pose.second + .5f * std::sin(radians)) * .5f +
                         .5f) *
                            width +
                        phase);
                    // The checker averages to a constant at these footprints. Sampling level 0
                    // or nearest texels instead leaves a changing high-frequency pattern here.
                    expect(rms(distant, x - 2, x + 3, height / 2 - 2, height / 2 + 3) <= 1,
                           "oblique/distant checker retains mip filtering across pixel phases");
                }
            }
        }
    }
    expect(glGetError() == GL_NO_ERROR, "fine-text sampling has no GL errors");
    glUseProgram(0);
    glBindVertexArray(0);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteProgram(programs[0]);
    for (int i = 1; i < 6; ++i)
        if (programs[i])
            glDeleteProgram(programs[i]);
    glDeleteBuffers(2, buffers);
    glDeleteVertexArrays(1, &vao);
    glDeleteFramebuffers(1, &framebuffer);
    glDeleteTextures(4, textures);
}

// The foveation filter's GLSL on a real GLES driver against its C++ reference
// (foveation_filter_shader.h): the density code of synthetic positions and steps, the density
// pass at full density, and the resolve of a driver-style upscaled image with every block width,
// start and an undescribed width, single-view and (with GL_OVR_multiview2) multiview.
void foveationFilterChecks(std::vector<std::string> &failed, bool hasMultiview,
                           MultiviewFn multiviewFn) {
    auto expect = [&](bool ok, const std::string &what) {
        std::printf("  foveation filter: %s %s\n", ok ? "ok  " : "FAIL", what.c_str());
        if (!ok)
            failed.push_back("foveation filter: " + what);
    };
    auto compile = [&](GLenum type, const std::string &code) {
        GLuint shader = glCreateShader(type);
        const char *text = code.c_str();
        glShaderSource(shader, 1, &text, nullptr);
        glCompileShader(shader);
        GLint good = 0;
        glGetShaderiv(shader, GL_COMPILE_STATUS, &good);
        if (!good) {
            char log[2048]{};
            glGetShaderInfoLog(shader, sizeof log, nullptr, log);
            expect(false, std::string("compile: ") + log);
        }
        return shader;
    };

    // 1. axisCode in GLSL equals densityAxisCode for positions on a quarter-pixel grid and every
    //    step class, including widths and starts the code cannot describe.
    {
        const float steps[16] = {1.f,  1.2f, 2.f, 2.01f, 4.f,  3.98f, 8.f,  8.05f,
                                 1.5f, 3.f,  6.f, 16.f,  2.3f, 0.f,   -4.f, 12.f};
        constexpr int w = 256, h = 16;
        GLuint tex = 0, fbo = 0;
        glGenTextures(1, &tex);
        glBindTexture(GL_TEXTURE_2D, tex);
        glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, w, h);
        glGenFramebuffers(1, &fbo);
        glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
        const auto vs = compile(GL_VERTEX_SHADER, foveationFilterShaders(false).vertex);
        const auto fs = compile(GL_FRAGMENT_SHADER,
                                "#version 300 es\nprecision highp float;\nprecision highp int;\n"
                                "flat in int layer;\nuniform float steps[16];\nout vec4 pixel;\n" +
                                    densityAxisCodeGlsl() +
                                    "void main() {\n"
                                    "    float fc = floor(gl_FragCoord.x) * 0.25 + 0.5;\n"
                                    "    float s = steps[int(gl_FragCoord.y)];\n"
                                    "    pixel = vec4(float(axisCode(fc, abs(s))) / 255.0, 0.0, "
                                    "0.0, 1.0);\n"
                                    "}\n");
        GLuint program = glCreateProgram();
        glAttachShader(program, vs);
        glAttachShader(program, fs);
        glLinkProgram(program);
        GLint linked = 0;
        glGetProgramiv(program, GL_LINK_STATUS, &linked);
        expect(linked == GL_TRUE, "axisCode test program links");
        glUseProgram(program);
        glUniform1fv(glGetUniformLocation(program, "steps"), 16, steps);
        GLuint vao = 0;
        glGenVertexArrays(1, &vao);
        glBindVertexArray(vao);
        glViewport(0, 0, w, h);
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_BLEND);
        glDrawArrays(GL_TRIANGLES, 0, 3);
        const auto px = readPixels(w, h);
        int mismatches = 0, unknown = 0, described = 0;
        for (int y = 0; y < h; ++y)
            for (int x = 0; x < w; ++x) {
                const int gpu = px[size_t(y * w + x) * 4];
                const int cpu = densityAxisCode(float(x) * .25f + .5f, std::abs(steps[y]));
                mismatches += gpu != cpu;
                unknown += cpu == kDensityUnknown;
                described += cpu > 0 && cpu < kDensityUnknown;
            }
        expect(mismatches == 0 && unknown > 0 && described > 0,
               "GLSL axisCode matches densityAxisCode (" + std::to_string(mismatches) +
                   " mismatches of " + std::to_string(w * h) + ")");
        glUseProgram(0);
        glBindVertexArray(0);
        glDeleteVertexArrays(1, &vao);
        glDeleteProgram(program);
        glDeleteShader(vs);
        glDeleteShader(fs);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glDeleteFramebuffers(1, &fbo);
        glDeleteTextures(1, &tex);
    }

    // A driver-style image: bins at block widths (x by y) with blocks starting off their grid,
    // each block repeating its centre's scene value, the alpha holding the density pass's code.
    constexpr int w = 96, h = 64;
    struct Region {
        int x0, x1, y0, y1, sx, sy;
    };
    const Region regions[] = {{0, 23, 0, 64, 1, 1},  {23, 47, 0, 30, 2, 1},  {23, 47, 30, 64, 2, 4},
                              {47, 79, 0, 33, 4, 4}, {47, 79, 33, 64, 8, 2}, {79, 96, 0, 64, 3, 2}};
    const auto scene = [](float x, float y, int c) {
        const float edge = (x + .6f * y > 50.f) ? .55f : 0.f;
        return std::clamp(.15f + .004f * x * float(c + 1) + .003f * y + edge +
                              .08f * std::sin(.9f * x + .4f * y + float(c)),
                          0.f, 1.f);
    };
    const auto build = [&](int layer) {
        std::vector<uint8_t> image(size_t(w * h * 4));
        for (const auto &r : regions)
            for (int y = r.y0; y < r.y1; ++y)
                for (int x = r.x0; x < r.x1; ++x) {
                    const int kx = (x - r.x0) / r.sx, ky = (y - r.y0) / r.sy;
                    const float cx = float(r.x0) + (float(kx) + .5f) * float(r.sx);
                    const float cy = float(r.y0) + (float(ky) + .5f) * float(r.sy);
                    uint8_t *p = &image[size_t(y * w + x) * 4];
                    for (int c = 0; c < 3; ++c)
                        p[c] = uint8_t(std::lround(255.f * scene(cx + float(layer) * 7.f, cy, c)));
                    p[3] = encodeDensityCode(densityAxisCode(cx, float(r.sx)),
                                             densityAxisCode(cy, float(r.sy)));
                }
        return image;
    };
    // The resolve as resolveFragment computes it, on the 8-bit image.
    const auto reference = [&](const std::vector<uint8_t> &image) {
        std::vector<float> out(size_t(w * h * 3));
        for (int y = 0; y < h; ++y)
            for (int x = 0; x < w; ++x) {
                const int code = image[size_t(y * w + x) * 4 + 3];
                const auto texel = [&](int tx, int ty, int c) {
                    tx = std::clamp(tx, 0, w - 1);
                    ty = std::clamp(ty, 0, h - 1);
                    return float(image[size_t(ty * w + tx) * 4 + size_t(c)]);
                };
                const auto tap = [&](float ax, float ay, int c) {
                    const float tx = ax - .5f, ty = ay - .5f;
                    const int x0 = int(std::floor(tx)), y0 = int(std::floor(ty));
                    const float fx = tx - float(x0), fy = ty - float(y0);
                    return (texel(x0, y0, c) * (1 - fx) + texel(x0 + 1, y0, c) * fx) * (1 - fy) +
                           (texel(x0, y0 + 1, c) * (1 - fx) + texel(x0 + 1, y0 + 1, c) * fx) * fy;
                };
                const int cx = code / kDensityCodeLevels, cy = code % kDensityCodeLevels;
                const float ax = densityTapCoordinate(x, decodeDensityAxis(cx));
                const float ay = densityTapCoordinate(y, decodeDensityAxis(cy));
                const float spreadX = cx == kDensityUnknown ? .5f : 0.f;
                const float spreadY = cy == kDensityUnknown ? .5f : 0.f;
                for (int c = 0; c < 3; ++c) {
                    float v = 0;
                    if (code == 0)
                        v = texel(x, y, c);
                    else if (!spreadX && !spreadY)
                        v = tap(ax, ay, c);
                    else
                        v = .25f * (tap(ax - spreadX, ay - spreadY, c) +
                                    tap(ax + spreadX, ay + spreadY, c) +
                                    tap(ax + spreadX, ay - spreadY, c) +
                                    tap(ax - spreadX, ay + spreadY, c));
                    out[size_t(y * w + x) * 3 + size_t(c)] = v;
                }
            }
        return out;
    };
    const auto compareResolve = [&](const std::vector<uint8_t> &image,
                                    const std::vector<uint8_t> &px, const std::string &label) {
        const auto ref = reference(image);
        int copyErrors = 0, far = 0, alphaErrors = 0;
        float worst = 0;
        for (int y = 0; y < h; ++y)
            for (int x = 0; x < w; ++x) {
                const bool full = image[size_t(y * w + x) * 4 + 3] == 0;
                for (int c = 0; c < 3; ++c) {
                    const float got = float(px[size_t(y * w + x) * 4 + size_t(c)]);
                    const float err = std::abs(got - ref[size_t(y * w + x) * 3 + size_t(c)]);
                    worst = std::max(worst, err);
                    if (full && got != float(image[size_t(y * w + x) * 4 + size_t(c)]))
                        ++copyErrors;
                    if (err > 1.5f)
                        ++far;
                }
                alphaErrors += px[size_t(y * w + x) * 4 + 3] != 255;
            }
        expect(copyErrors == 0, label + ": full-density pixels are exact copies");
        expect(far == 0, label + ": reduced bins match the bilinear reference (worst " +
                             std::to_string(worst) + " of 255)");
        expect(alphaErrors == 0, label + ": the submitted image is opaque");
    };
    const auto uploadTarget = [&](GLuint &tex, GLenum target, int layers) {
        glGenTextures(1, &tex);
        glBindTexture(target, tex);
        if (layers > 1)
            glTexStorage3D(target, 1, GL_RGBA8, w, h, layers);
        else
            glTexStorage2D(target, 1, GL_RGBA8, w, h);
    };

    // 2. The density pass at full density writes code 0 into the alpha only.
    {
        FoveationFilter filter;
        std::string error;
        expect(filter.initialize(false, error), "initialize single-view: " + error);
        GLuint tex = 0, fbo = 0;
        uploadTarget(tex, GL_TEXTURE_2D, 1);
        glGenFramebuffers(1, &fbo);
        glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
        glViewport(0, 0, w, h);
        glClearColor(.2f, .4f, .6f, 1.f);
        glClear(GL_COLOR_BUFFER_BIT);
        filter.markDensity();
        const auto px = readPixels(w, h);
        bool alphaZero = true, rgbKept = true;
        for (size_t i = 0; i < px.size(); i += 4) {
            alphaZero = alphaZero && px[i + 3] == 0;
            rgbKept = rgbKept && std::abs(int(px[i]) - 51) <= 1 &&
                      std::abs(int(px[i + 1]) - 102) <= 1 && std::abs(int(px[i + 2]) - 153) <= 1;
        }
        expect(alphaZero, "density pass at full density writes code 0");
        expect(rgbKept, "density pass leaves the colour alone");

        // 3. Resolve, single view.
        const auto image = build(0);
        GLuint source = 0;
        glGenTextures(1, &source);
        glBindTexture(GL_TEXTURE_2D, source);
        glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, w, h);
        glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, image.data());
        glBindTexture(GL_TEXTURE_2D, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        glViewport(0, 0, w, h);
        filter.resolve(source);
        compareResolve(image, readPixels(w, h), "single-view resolve");
        expect(glGetError() == GL_NO_ERROR, "single-view GL errors");
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glDeleteFramebuffers(1, &fbo);
        glDeleteTextures(1, &tex);
        glDeleteTextures(1, &source);
    }

    // 4. Resolve, multiview: both layers of a 2-layer array in one draw.
    if (!hasMultiview) {
        std::printf("  foveation filter: skip multiview resolve (no GL_OVR_multiview2)\n");
        return;
    }
    FoveationFilter filter;
    std::string error;
    expect(filter.initialize(true, error), "initialize multiview: " + error);
    const auto left = build(0), right = build(1);
    GLuint source = 0, tex = 0, fbo = 0, readFbo = 0;
    glGenTextures(1, &source);
    glBindTexture(GL_TEXTURE_2D_ARRAY, source);
    glTexStorage3D(GL_TEXTURE_2D_ARRAY, 1, GL_RGBA8, w, h, 2);
    glTexSubImage3D(GL_TEXTURE_2D_ARRAY, 0, 0, 0, 0, w, h, 1, GL_RGBA, GL_UNSIGNED_BYTE,
                    left.data());
    glTexSubImage3D(GL_TEXTURE_2D_ARRAY, 0, 0, 0, 1, w, h, 1, GL_RGBA, GL_UNSIGNED_BYTE,
                    right.data());
    glBindTexture(GL_TEXTURE_2D_ARRAY, 0);
    uploadTarget(tex, GL_TEXTURE_2D_ARRAY, 2);
    glGenFramebuffers(1, &fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    multiviewFn(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, tex, 0, 0, 2);
    expect(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE,
           "multiview target complete");
    glViewport(0, 0, w, h);
    filter.resolve(source);
    glGenFramebuffers(1, &readFbo);
    for (int layer = 0; layer < 2; ++layer) {
        glBindFramebuffer(GL_FRAMEBUFFER, readFbo);
        glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, tex, 0, layer);
        compareResolve(layer ? right : left, readPixels(w, h),
                       std::string("multiview resolve layer ") + std::to_string(layer));
    }
    expect(glGetError() == GL_NO_ERROR, "multiview GL errors");
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteFramebuffers(1, &fbo);
    glDeleteFramebuffers(1, &readFbo);
    glDeleteTextures(1, &tex);
    glDeleteTextures(1, &source);
}

} // namespace

std::string base64(const void *data, size_t size) {
    static const char *a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const auto *s = static_cast<const uint8_t *>(data);
    std::string out;
    for (size_t i = 0; i < size; i += 3) {
        uint32_t n = uint32_t(s[i]) << 16 | (i + 1 < size ? uint32_t(s[i + 1]) << 8 : 0) |
                     (i + 2 < size ? s[i + 2] : 0);
        out += a[(n >> 18) & 63];
        out += a[(n >> 12) & 63];
        out += i + 1 < size ? a[(n >> 6) & 63] : '=';
        out += i + 2 < size ? a[n & 63] : '=';
    }
    return out;
}

/**
 * Objects attached to a controller grip (ObjectItem hand) draw at the grip of the frame's
 * setControllerPoses, follow it every frame without a packet, never batch or leave a copy where
 * they were, hide when the frame has no valid grip, and draw at their world matrix once dropped.
 */
void attachmentChecks(std::vector<std::string> &failed) {
    auto expect = [&](bool ok, const std::string &what) {
        std::printf("  attachment: %s %s\n", ok ? "ok  " : "FAIL", what.c_str());
        if (!ok)
            failed.push_back("attachment: " + what);
    };
    constexpr int size = 64;
    GLuint color = 0, depth = 0, fbo = 0;
    glGenRenderbuffers(1, &color);
    glBindRenderbuffer(GL_RENDERBUFFER, color);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, size, size);
    glGenRenderbuffers(1, &depth);
    glBindRenderbuffer(GL_RENDERBUFFER, depth);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, size, size);
    glGenFramebuffers(1, &fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, color);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);

    SceneRendererOptions options;
    options.srgbFramebuffer = false;
    options.shadows = false;
    options.checkGlErrors = true;
    options.staticAfterSeconds = 0.05f;
    auto r = std::make_unique<SceneRenderer>(options);
    if (!r->initialize()) {
        expect(false, "initialize: " + r->lastError());
        return;
    }
    // A 0.2 m square facing +Z, in front of an eye at the origin looking down -Z.
    const float quad[18] = {-.1f, -.1f, 0, .1f, -.1f, 0, .1f,  .1f, 0,
                            -.1f, -.1f, 0, .1f, .1f,  0, -.1f, .1f, 0};
    const json data = json::object({{"d", base64(quad, sizeof quad)}});
    const json position = json::object({{"n", 3}, {"data", data}});
    const json geometry = json::object({{"id", 1},
                                        {"rev", 0},
                                        {"count", 6},
                                        {"attrs", {{"position", position}}},
                                        {"groups", json::array()},
                                        {"range", {0, -1}},
                                        {"sphere", {0, 0, 0, .15}}});
    const json materials = json::array(
        {json::object({{"id", 1}, {"type", "basic"}, {"color", {1, 0, 0}}, {"opacity", 1}}),
         json::object({{"id", 2}, {"type", "basic"}, {"color", {0, 1, 0}}, {"opacity", 1}})});
    auto object = [](uint32_t id, uint32_t mat, json hand, std::vector<float> m) {
        json o = {{"id", id}, {"kind", "mesh"}, {"geo", 1}, {"mat", mat}, {"m", m}};
        if (!hand.is_null())
            o["hand"] = hand;
        return o;
    };
    const std::vector<float> atGrip = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0};
    const json desk = object(12, 2, nullptr, {1, 0, 0, 0, 1, 0, 0, 0, 1, .45f, -.3f, -1.5f});
    uint64_t seq = 0;
    auto send = [&](json objects, bool reset) {
        json p = {{"v", 1}, {"seq", ++seq}, {"commit", true}, {"objects", std::move(objects)}};
        if (reset) {
            p["reset"] = true;
            p["geometries"] = json::array({geometry});
            p["materials"] = materials;
        }
        expect(r->enqueue(std::move(p)), "packet " + std::to_string(seq) + " is accepted");
    };

    SceneEye eye;
    const Mat proj = perspective(60, 1, .05f, 100);
    const Mat view = {{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}};
    std::memcpy(eye.view, view.m, sizeof view.m);
    std::memcpy(eye.projection, proj.m, sizeof proj.m);
    auto gripAt = [](float x, float y, float z, float yawRad = 0, float scale = 1) {
        SceneControllerPoses g;
        const float c = std::cos(yawRad) * scale, s = std::sin(yawRad) * scale;
        const float m[16] = {c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, x, y, z, 1};
        for (int h = 0; h < 2; h++) {
            std::copy(m, m + 16, g.grip[h]);
            g.valid[h] = true;
        }
        return g;
    };
    struct Image {
        std::vector<uint8_t> px;
        size_t red = 0, green = 0;
        double redX = 0; // mean column of the red pixels
        bool redAt(int x, int y) const {
            const uint8_t *p = &px[size_t(y * size + x) * 4];
            return p[0] > 150 && p[1] < 80 && p[2] < 80;
        }
    };
    // One display frame; `poses` null: no setControllerPoses call this frame.
    auto frame = [&](const SceneControllerPoses *poses) {
        r->tick();
        r->prepareFrame();
        if (poses)
            r->setControllerPoses(*poses);
        glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        glViewport(0, 0, size, size);
        r->render(eye, size);
        glFinish();
        Image im;
        im.px = readPixels(size, size);
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++) {
                const uint8_t *p = &im.px[size_t(y * size + x) * 4];
                if (im.redAt(x, y)) {
                    im.red++;
                    im.redX += x;
                }
                im.green += p[1] > 150 && p[0] < 80 && p[2] < 80;
            }
        if (im.red)
            im.redX /= double(im.red);
        return im;
    };
    auto loaded = [&] {
        const SceneStats s = r->stats();
        return s.stateSerial && !s.pendingUploads && !s.waitingState && !s.programsCompiling &&
               !s.queuedTextureOps && !s.queuedBytes;
    };
    const auto center = gripAt(0, 0, -1);
    // The same square at the same depth covers the same pixels, give or take its edges.
    auto same = [](size_t a, size_t b) { return a + 12 >= b && b + 12 >= a; };
    auto settle = [&](const SceneControllerPoses *poses) {
        for (int i = 0; i < 600 && !loaded(); i++)
            frame(poses);
        expect(loaded(), "the state loads");
    };

    send(json::array({object(10, 1, 0, atGrip), desk}), true);
    settle(&center);
    Image held = frame(&center);
    SceneStats st = r->stats();
    expect(held.red > 50 && held.redAt(size / 2, size / 2), "the held object draws at the grip");
    expect(held.green > 20, "the world object draws");
    expect(st.attachedItems == 1 && st.attachedPlaced == 1,
           "stats count one attached item, placed at its grip");

    // Every frame, without a packet: the grip moves left, the object follows.
    auto left = gripAt(-.35f, 0, -1);
    Image moved = frame(&left);
    expect(same(moved.red, held.red) && moved.redX < held.redX - 8 &&
               !moved.redAt(size / 2, size / 2),
           "the object follows the grip on the next frame");
    // A grip turned 60 degrees around Y narrows the square: the composition uses its rotation.
    auto turned = gripAt(0, 0, -1, 1.0472f);
    Image narrow = frame(&turned);
    expect(narrow.red > held.red / 3 && narrow.red < held.red * 2 / 3,
           "the grip's rotation turns the object");

    // No valid grip this frame: nothing is drawn, not even where it was last.
    Image none = frame(nullptr);
    expect(none.red == 0 && none.green == held.green,
           "a frame without controller poses hides only the attached object");
    expect(r->stats().attachedPlaced == 0, "nothing is placed without a grip");
    SceneControllerPoses lost = center;
    lost.valid[0] = false;
    lost.valid[1] = true;
    expect(frame(&lost).red == 0, "the other hand's valid grip does not place it");
    auto scaled = gripAt(0, 0, -1, 0, 2);
    expect(frame(&scaled).red == 0, "a non-rigid grip hides it");
    SceneControllerPoses broken = center;
    broken.grip[0][12] = std::nanf("");
    expect(frame(&broken).red == 0, "a non-finite grip hides it");
    const SceneControllerPoses &valid = center;
    expect(same(frame(&valid).red, held.red), "a valid grip shows it again");

    // Hold still past staticAfterSeconds: the world object batches; the held one never does and
    // leaves no copy behind when the grip then moves.
    // Batching follows wall time; a loaded host may take longer than staticAfterSeconds.
    const auto batchDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    do {
        frame(&valid);
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        settle(&valid);
        st = r->stats();
    } while (!st.staticBatches && std::chrono::steady_clock::now() < batchDeadline);
    expect(st.staticBatches == 1 && st.batchedObjects == 1 && st.attachedItems == 1,
           "only the world object is batched (batches " + std::to_string(st.staticBatches) +
               ", batched objects " + std::to_string(st.batchedObjects) + ", attached " +
               std::to_string(st.attachedItems) + ")");
    const SceneControllerPoses &leftValid = left;
    Image after = frame(&leftValid);
    expect(same(after.red, held.red) && !after.redAt(size / 2, size / 2) &&
               after.green == held.green,
           "a still held object moves without a ghost at its old place");

    // Dropped (re-sent without hand, at a world matrix): drawn there regardless of the grips.
    send(json::array({object(10, 1, nullptr, {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1})}), false);
    settle(&leftValid);
    Image dropped = frame(&leftValid);
    expect(dropped.redAt(size / 2, size / 2) && same(dropped.red, held.red),
           "a dropped object draws at its world matrix, not the grip");
    expect(same(frame(nullptr).red, held.red), "a dropped object does not hide without a grip");
    expect(r->stats().attachedItems == 0, "a dropped object is no longer attached");

    // Picked up again, then a reset without it: nothing attached remains.
    send(json::array({object(10, 1, 1, atGrip)}), false);
    settle(&leftValid);
    Image picked = frame(&leftValid);
    expect(same(picked.red, held.red) && picked.redX < held.redX - 8,
           "picking it up attaches it to the other hand");
    send(json::array({desk}), true);
    settle(&leftValid);
    Image reset = frame(&leftValid);
    expect(reset.red == 0 && reset.green == held.green && r->stats().attachedItems == 0,
           "a reset clears the attachment");

    // A grip-held gun (left of the grip) and an ordinary card (right of it) on the same hand: on
    // the display frame the squeeze is released the gun is gone and the card stays, before any
    // packet from the page.
    json gun = object(20, 1, 0, {1, 0, 0, 0, 1, 0, 0, 0, 1, -.25f, 0, 0});
    gun["gripHeld"] = true;
    send(json::array({gun, object(21, 1, 0, {1, 0, 0, 0, 1, 0, 0, 0, 1, .25f, 0, 0})}), true);
    SceneControllerPoses squeezed = center;
    squeezed.held[0] = true;
    settle(&squeezed);
    auto halves = [&](const Image &im) {
        size_t left = 0, right = 0;
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
                if (im.redAt(x, y))
                    (x < size / 2 ? left : right)++;
        return std::pair<size_t, size_t>(left, right);
    };
    const auto both = halves(frame(&squeezed));
    expect(both.first > 50 && same(both.first, both.second),
           "a squeezed grip draws the gun and the card");
    const auto released = halves(frame(&center));
    expect(released.first == 0 && same(released.second, both.second),
           "the gun hides on the release frame; the card stays on its grip");
    expect(r->stats().attachedPlaced == 1, "only the card is placed after the release");
    SceneControllerPoses otherHand = center;
    otherHand.held[1] = true;
    expect(halves(frame(&otherHand)).first == 0, "the other hand's squeeze does not hold it");
    SceneControllerPoses heldLost = squeezed;
    heldLost.valid[0] = false;
    const auto lostBoth = halves(frame(&heldLost));
    expect(lostBoth.first == 0 && lostBoth.second == 0,
           "a squeeze without a tracked grip draws neither");
    const auto again = halves(frame(&squeezed));
    expect(same(again.first, both.first), "squeezing again draws the gun again");
    expect(r->lastError().empty(), "renderer error: " + r->lastError());
    expect(glGetError() == GL_NO_ERROR, "no GL error");
    r.reset();
    glDeleteFramebuffers(1, &fbo);
    glDeleteRenderbuffers(1, &color);
    glDeleteRenderbuffers(1, &depth);
}

/**
 * The workspace panel beneath the world layer (panel_cutout.h), drawn the way office_xr.cpp
 * draws a frame with it open: SceneDrawSet::World, PanelCutout::punch, SceneDrawSet::Attached,
 * PanelCutout::seal. Inside the panel's hole the world is transparent black, also where it is
 * nearer than the panel; an object held in front of the panel is opaque there, one behind it is
 * not; outside the hole everything is opaque and unchanged. attachedHands reports the hands whose
 * attached object is placed. Single view (the multiview program differs only in its view index).
 */
void panelUnderlayChecks(std::vector<std::string> &failed) {
    auto expect = [&](bool ok, const std::string &what) {
        std::printf("  panel underlay: %s %s\n", ok ? "ok  " : "FAIL", what.c_str());
        if (!ok)
            failed.push_back("panel underlay: " + what);
    };
    constexpr int size = 64;
    GLuint color = 0, depth = 0, fbo = 0;
    glGenRenderbuffers(1, &color);
    glBindRenderbuffer(GL_RENDERBUFFER, color);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, size, size);
    glGenRenderbuffers(1, &depth);
    glBindRenderbuffer(GL_RENDERBUFFER, depth);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, size, size);
    glGenFramebuffers(1, &fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, color);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);

    SceneRendererOptions options;
    options.srgbFramebuffer = false;
    options.shadows = false;
    options.checkGlErrors = true;
    auto r = std::make_unique<SceneRenderer>(options);
    if (!r->initialize()) {
        expect(false, "initialize: " + r->lastError());
        return;
    }
    PanelCutout cutout;
    try {
        cutout.initialize(false);
    } catch (const std::exception &e) {
        expect(false, std::string("cutout initialize: ") + e.what());
        return;
    }
    // A 0.2 m square facing +Z; objects scale it.
    const float quad[18] = {-.1f, -.1f, 0, .1f, -.1f, 0, .1f,  .1f, 0,
                            -.1f, -.1f, 0, .1f, .1f,  0, -.1f, .1f, 0};
    const json data = json::object({{"d", base64(quad, sizeof quad)}});
    const json geometry = json::object({{"id", 1},
                                        {"rev", 0},
                                        {"count", 6},
                                        {"attrs", {{"position", {{"n", 3}, {"data", data}}}}},
                                        {"groups", json::array()},
                                        {"range", {0, -1}},
                                        {"sphere", {0, 0, 0, .15}}});
    const json materials = json::array(
        {json::object({{"id", 1}, {"type", "basic"}, {"color", {1, 0, 0}}, {"opacity", 1}}),
         json::object({{"id", 2}, {"type", "basic"}, {"color", {0, 1, 0}}, {"opacity", 1}})});
    // Green: a world object 1 m away, nearer than the panel, half inside the panel's hole.
    // Red: a gun held on the left grip.
    json world = {{"id", 12},
                  {"kind", "mesh"},
                  {"geo", 1},
                  {"mat", 2},
                  {"m", {3, 0, 0, 0, 3, 0, 0, 0, 3, -.35f, 0, -1}}};
    json gun = {{"id", 20},
                {"kind", "mesh"},
                {"geo", 1},
                {"mat", 1},
                {"hand", 0},
                {"gripHeld", true},
                {"m", {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0}}};
    json p = {{"v", 1},
              {"seq", 1},
              {"commit", true},
              {"reset", true},
              {"geometries", json::array({geometry})},
              {"materials", materials},
              {"objects", json::array({world, gun})}};
    expect(r->enqueue(std::move(p)), "the packet is accepted");

    SceneEye eye;
    const Mat proj = perspective(60, 1, .05f, 100);
    const float identity[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    std::memcpy(eye.view, identity, sizeof identity);
    std::memcpy(eye.projection, proj.m, sizeof proj.m);
    float views[2][16];
    std::memcpy(views[0], proj.m, sizeof proj.m); // the view is the identity
    std::memcpy(views[1], proj.m, sizeof proj.m);
    // A 1 x 1 m panel 1.5 m ahead: its hole spans pixels 14..50 of 64 both ways.
    const auto c = panelCutoutCorners({{0, 0, 0, 1}, {0, 0, -1.5f}}, 1, 1, 0);
    float corners[4][3];
    for (int i = 0; i < 4; i++) {
        corners[i][0] = c[size_t(i)].x;
        corners[i][1] = c[size_t(i)].y;
        corners[i][2] = c[size_t(i)].z;
    }
    auto grip = [](float x, float z, bool squeezed) {
        SceneControllerPoses g;
        const float m[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1};
        std::copy(m, m + 16, g.grip[0]);
        g.valid[0] = true;
        g.held[0] = squeezed;
        return g;
    };
    std::vector<uint8_t> px;
    auto at = [&](int x, int y) { return &px[size_t(y * size + x) * 4]; };
    auto is = [&](int x, int y, int red, int green, int blue, int alpha) {
        const uint8_t *q = at(x, y);
        auto near = [](int a, int b) { return std::abs(a - b) <= 2; };
        return near(q[0], red) && near(q[1], green) && near(q[2], blue) && near(q[3], alpha);
    };
    // One display frame with the panel open; `seal` before the attached pass to test the seal.
    auto frame = [&](const SceneControllerPoses &poses, bool sealFirst) {
        r->tick();
        r->prepareFrame();
        r->setControllerPoses(poses);
        glBindFramebuffer(GL_FRAMEBUFFER, fbo);
        glViewport(0, 0, size, size);
        r->render(eye, size, SceneDrawSet::World);
        cutout.punch(views, corners);
        if (sealFirst)
            cutout.seal(views, corners);
        r->render(eye, size, SceneDrawSet::Attached);
        glFinish();
        px = readPixels(size, size);
    };
    const auto front = grip(.3f, -1, true);
    for (int i = 0; i < 600; i++) {
        frame(front, false);
        const SceneStats st = r->stats();
        if (st.stateSerial && !st.pendingUploads && !st.waitingState && !st.programsCompiling &&
            !st.queuedTextureOps && !st.queuedBytes)
            break;
    }
    frame(front, false);
    expect(r->attachedHands() == 1, "the squeezed left grip holds the gun");
    float bounds[4][4] = {};
    expect(r->attachedBounds(bounds, 4) == 1 && std::abs(bounds[0][0] - .3f) < 1e-4f &&
               std::abs(bounds[0][1]) < 1e-4f && std::abs(bounds[0][2] + 1) < 1e-4f &&
               std::abs(bounds[0][3] - .15f) < 1e-4f,
           "attachedBounds gives the held gun's sphere at its grip");
    expect(r->attachedBounds(bounds, 0) == 0, "attachedBounds writes no more than asked");
    expect(is(4, 4, 0, 0, 0, 255) && is(60, 60, 0, 0, 0, 255),
           "outside the hole the background stays opaque");
    expect(is(6, 32, 0, 255, 0, 255), "outside the hole the world stays opaque and unchanged");
    expect(is(22, 32, 0, 0, 0, 0), "inside the hole a world object nearer than the panel is cut");
    expect(is(36, 20, 0, 0, 0, 0), "inside the hole the background is cut");
    expect(is(45, 32, 255, 0, 0, 255), "a gun held in front of the panel stays opaque over it");
    expect(is(52, 32, 255, 0, 0, 255), "the gun beside the panel is drawn as before");

    // Behind the panel (2 m away), the held gun is hidden by the panel's depth.
    frame(grip(.3f, -2, true), false);
    expect(is(40, 32, 0, 0, 0, 0), "a gun behind the panel stays hidden behind it");

    // Released (gripHeld): nothing in the hand, nothing drawn in the hole.
    frame(grip(.3f, -1, false), false);
    expect(r->attachedHands() == 0 && r->attachedBounds(bounds, 4) == 0,
           "a released gun is not in the hand");
    expect(is(45, 32, 0, 0, 0, 0), "a released gun is not drawn");
    SceneControllerPoses lost = front;
    lost.valid[0] = false;
    frame(lost, false);
    expect(r->attachedHands() == 0, "a lost grip holds nothing");

    // The seal: the hole's depth becomes the near plane, so nothing drawn after it shows there
    // (the screen layer tests against this depth), and its color is untouched.
    frame(front, true);
    expect(is(45, 32, 0, 0, 0, 0) && is(22, 32, 0, 0, 0, 0),
           "after the seal nothing draws inside the hole");
    expect(is(52, 32, 255, 0, 0, 255) && is(6, 32, 0, 255, 0, 255),
           "the seal leaves everything outside the hole as it was");

    // The world pass alone has no gun; the attached pass alone keeps what is there.
    r->tick();
    r->prepareFrame();
    r->setControllerPoses(front);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    r->render(eye, size, SceneDrawSet::World);
    glFinish();
    px = readPixels(size, size);
    expect(is(45, 32, 0, 0, 0, 255) && is(22, 32, 0, 255, 0, 255),
           "SceneDrawSet::World draws the world without the attached gun");
    glClearColor(0, 0, 1, 1);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    r->render(eye, size, SceneDrawSet::Attached);
    glFinish();
    px = readPixels(size, size);
    expect(is(45, 32, 255, 0, 0, 255) && is(22, 32, 0, 0, 255, 255),
           "SceneDrawSet::Attached draws only the gun and never clears");
    expect(r->stats().attachedPlaced == 1, "the attached pass counts the placed gun");

    // Both calls leave the documented state.
    GLint func = 0, program = 1, array = 1;
    GLboolean mask[4] = {}, depthWrite = GL_FALSE;
    GLfloat range[2] = {};
    cutout.punch(views, corners);
    cutout.seal(views, corners);
    glGetIntegerv(GL_DEPTH_FUNC, &func);
    glGetIntegerv(GL_CURRENT_PROGRAM, &program);
    glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &array);
    glGetBooleanv(GL_COLOR_WRITEMASK, mask);
    glGetBooleanv(GL_DEPTH_WRITEMASK, &depthWrite);
    glGetFloatv(GL_DEPTH_RANGE, range);
    expect(func == GL_LEQUAL && depthWrite && glIsEnabled(GL_DEPTH_TEST) &&
               !glIsEnabled(GL_BLEND) && mask[0] && mask[1] && mask[2] && mask[3] &&
               range[0] == 0 && range[1] == 1 && program == 0 && array == 0,
           "punch and seal leave depth LEQUAL with writes, no blend, full mask, range 0..1");
    expect(r->lastError().empty(), "renderer error: " + r->lastError());
    expect(glGetError() == GL_NO_ERROR, "no GL error");
    r.reset();
    glDeleteFramebuffers(1, &fbo);
    glDeleteRenderbuffers(1, &color);
    glDeleteRenderbuffers(1, &depth);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: render <packets.json> <out-dir> [--size px] [--seconds s]\n");
        return 2;
    }
    // The renderer logs to stderr; line-buffered stdout keeps each check line whole in the
    // captured log.
    std::setvbuf(stdout, nullptr, _IOLBF, 0);
    std::string out = argv[2];
    int size = 768;
    double settle = 4.0;
    std::vector<float> lookAt;
    for (int i = 3; i + 1 < argc; i += 2) {
        std::string a = argv[i];
        if (a == "--size")
            size = std::atoi(argv[i + 1]);
        else if (a == "--seconds")
            settle = std::atof(argv[i + 1]);
        else if (a == "--look") {
            std::stringstream ss(argv[i + 1]);
            for (std::string part; std::getline(ss, part, ',');)
                lookAt.push_back(std::stof(part));
            if (lookAt.size() != 6) {
                std::fprintf(stderr, "--look wants ex,ey,ez,tx,ty,tz\n");
                return 2;
            }
        }
    }

    EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (!eglInitialize(dpy, nullptr, nullptr)) {
        std::fprintf(stderr, "eglInitialize failed\n");
        return 1;
    }
    const EGLint cfgAttr[] = {EGL_RENDERABLE_TYPE,
                              EGL_OPENGL_ES3_BIT,
                              EGL_SURFACE_TYPE,
                              EGL_PBUFFER_BIT,
                              EGL_RED_SIZE,
                              8,
                              EGL_GREEN_SIZE,
                              8,
                              EGL_BLUE_SIZE,
                              8,
                              EGL_ALPHA_SIZE,
                              8,
                              EGL_NONE};
    EGLConfig cfg;
    EGLint n = 0;
    eglChooseConfig(dpy, cfgAttr, &cfg, 1, &n);
    const EGLint pbAttr[] = {EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE};
    EGLSurface surf = eglCreatePbufferSurface(dpy, cfg, pbAttr);
    const EGLint ctxAttr[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    EGLContext ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, ctxAttr);
    if (!n || !surf || !ctx || !eglMakeCurrent(dpy, surf, surf, ctx)) {
        std::fprintf(stderr, "EGL context creation failed\n");
        return 1;
    }
    std::printf("GL: %s | %s\n", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    auto multiviewFn =
        reinterpret_cast<MultiviewFn>(eglGetProcAddress("glFramebufferTextureMultiviewOVR"));
    GLint extCount = 0;
    bool hasMultiview = false;
    glGetIntegerv(GL_NUM_EXTENSIONS, &extCount);
    for (GLint i = 0; i < extCount; i++)
        if (std::strcmp(reinterpret_cast<const char *>(glGetStringi(GL_EXTENSIONS, GLuint(i))),
                        "GL_OVR_multiview2") == 0)
            hasMultiview = true;
    hasMultiview = hasMultiview && multiviewFn;

    std::ifstream in(argv[1], std::ios::binary);
    std::stringstream buf;
    buf << in.rdbuf();
    json packets = json::parse(buf.str());
    if (!packets.is_array()) {
        std::fprintf(stderr, "not an array of packets\n");
        return 2;
    }
    std::vector<float> camera = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1.6f, 0};
    float fov = 55, nearZ = 0.1f, farZ = 320;
    for (const auto &p : packets)
        if (p.contains("camera")) {
            camera = p["camera"]["m"].get<std::vector<float>>();
            fov = p["camera"].value("fov", fov);
            nearZ = p["camera"].value("near", nearZ);
            farZ = p["camera"].value("far", farZ);
        }
    if (!lookAt.empty()) {
        // eye x,y,z then target x,y,z: build a camera world matrix looking at the target.
        camera = lookCamera(&lookAt[0], &lookAt[3]);
    }
    SceneEye eyes[2];
    Mat proj = perspective(fov, 1.0f, nearZ, farZ);
    for (int e = 0; e < 2; e++) {
        Mat v = viewFromWorld(camera, e == 0 ? -0.032f : 0.032f);
        std::memcpy(eyes[e].view, v.m, sizeof v.m);
        std::memcpy(eyes[e].projection, proj.m, sizeof proj.m);
    }

    // Targets: one sRGB texture per eye for mono and the stereo fallback, and a 2-layer array for
    // multiview.
    GLuint depth = 0, color[2] = {}, fbo[2] = {};
    glGenRenderbuffers(1, &depth);
    glBindRenderbuffer(GL_RENDERBUFFER, depth);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, size, size);
    glGenTextures(2, color);
    glGenFramebuffers(2, fbo);
    for (int e = 0; e < 2; e++) {
        glBindTexture(GL_TEXTURE_2D, color[e]);
        glTexStorage2D(GL_TEXTURE_2D, 1, GL_SRGB8_ALPHA8, size, size);
        glBindFramebuffer(GL_FRAMEBUFFER, fbo[e]);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color[e], 0);
        glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);
        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            std::fprintf(stderr, "eye framebuffer incomplete\n");
            return 1;
        }
    }
    GLuint arrayColor = 0, arrayDepth = 0, mvFbo = 0, readFbo = 0;
    if (hasMultiview) {
        glGenTextures(1, &arrayColor);
        glBindTexture(GL_TEXTURE_2D_ARRAY, arrayColor);
        glTexStorage3D(GL_TEXTURE_2D_ARRAY, 1, GL_SRGB8_ALPHA8, size, size, 2);
        glGenTextures(1, &arrayDepth);
        glBindTexture(GL_TEXTURE_2D_ARRAY, arrayDepth);
        glTexStorage3D(GL_TEXTURE_2D_ARRAY, 1, GL_DEPTH_COMPONENT24, size, size, 2);
        glGenFramebuffers(1, &mvFbo);
        glBindFramebuffer(GL_FRAMEBUFFER, mvFbo);
        multiviewFn(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, arrayColor, 0, 0, 2);
        multiviewFn(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, arrayDepth, 0, 0, 2);
        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            std::fprintf(stderr, "multiview framebuffer incomplete; skipping multiview\n");
            hasMultiview = false;
        }
        glGenFramebuffers(1, &readFbo);
    }
    std::printf("multiview: %s\n", hasMultiview ? "yes" : "no (GL_OVR_multiview2 missing)");

    // The framebuffer the root has bound when it calls prepareFrame (its own, not an eye's).
    GLuint rootColor = 0, rootFbo = 0;
    glGenRenderbuffers(1, &rootColor);
    glBindRenderbuffer(GL_RENDERBUFFER, rootColor);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, 64, 64);
    glGenFramebuffers(1, &rootFbo);
    glBindFramebuffer(GL_FRAMEBUFFER, rootFbo);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rootColor);

    SceneRendererOptions single;
    single.multiview = false;
    single.checkGlErrors = true;
    SceneRendererOptions multi = single;
    multi.multiview = true;
    SceneRenderer mono(single);
    SceneRenderer implicit(single); // never calls prepareFrame
    std::unique_ptr<SceneRenderer> mv =
        hasMultiview ? std::make_unique<SceneRenderer>(multi) : nullptr;
    if (!mono.initialize() || !implicit.initialize() || (mv && !mv->initialize())) {
        std::fprintf(stderr, "initialize failed: %s\n", mono.lastError().c_str());
        return 1;
    }
    int bindingFailures = 0;
    // Every failed check is named here and listed again at the end, so a truncated log still
    // says which ones failed.
    std::vector<std::string> failed;
    auto check = [&](bool ok, const std::string &what) {
        if (ok)
            return;
        std::printf("FAIL: %s\n", what.c_str());
        failed.push_back(what);
    };
    auto checkBindings = [&](const char *what, const Bindings &want) {
        Bindings got = Bindings::now();
        if (got == want)
            return;
        if (bindingFailures++ < 3) {
            std::printf("FAIL: %s changed the caller's bindings\n", what);
            want.print("before");
            got.print("after");
        }
    };
    auto prepare = [&](SceneRenderer &r) {
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, rootFbo);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo[1]);
        glViewport(3, 5, 17, 19);
        glEnable(GL_SCISSOR_TEST);
        Bindings want = Bindings::now();
        r.prepareFrame();
        checkBindings("prepareFrame", want);
        glDisable(GL_SCISSOR_TEST);
    };

    auto t0 = std::chrono::steady_clock::now();
    // Feed the stream as the bridge would, a few packets per frame, drawing in between.
    size_t next = 0, rejected = 0;
    uint64_t shadowAllocChecked = 0;
    auto feed = [&](SceneRenderer &r) {
        json copy = packets[next];
        if (!r.enqueue(std::move(copy)))
            rejected++;
    };
    auto drawMono = [&]() {
        prepare(mono);
        glBindFramebuffer(GL_FRAMEBUFFER, fbo[0]);
        glViewport(0, 0, size, size);
        mono.render(eyes[0], size);
    };
    auto drawStereo = [&]() {
        prepare(mono);
        mono.renderStereo(eyes, size, [&](int e) {
            glBindFramebuffer(GL_FRAMEBUFFER, fbo[e]);
            glViewport(0, 0, size, size);
        });
    };
    auto drawMultiview = [&]() {
        prepare(*mv);
        glBindFramebuffer(GL_FRAMEBUFFER, mvFbo);
        glViewport(0, 0, size, size);
        mv->renderStereo(eyes, size);
    };
    // prepareFrame runs inside render here, in the eye framebuffer (the shadow map is allocated
    // there).
    auto drawImplicit = [&]() {
        glBindFramebuffer(GL_FRAMEBUFFER, fbo[0]);
        glViewport(0, 0, size, size);
        Bindings want = Bindings::now();
        uint64_t before = implicit.stats().shadowRedraws;
        implicit.render(eyes[0], size);
        checkBindings("render without prepareFrame", want);
        if (before == 0 && implicit.stats().shadowRedraws > 0)
            shadowAllocChecked++;
    };
    double worstFrame = 0, maxPrepare = 0, firstStateS = -1;
    int frames = 0, prepareOver3 = 0, prepareFrames = 0, firstStateFrame = -1;
    auto noteFrame = [&]() {
        SceneStats st = mono.stats();
        prepareFrames++;
        maxPrepare = std::max(maxPrepare, double(st.prepareMs));
        if (st.prepareMs > 3)
            prepareOver3++;
        if (firstStateFrame < 0 && st.stateSerial) {
            firstStateFrame = prepareFrames;
            firstStateS =
                std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        }
    };
    while (next < packets.size()) {
        for (int k = 0; k < 4 && next < packets.size(); k++, next++) {
            feed(mono);
            feed(implicit);
            if (mv)
                feed(*mv);
        }
        auto f0 = std::chrono::steady_clock::now();
        uint64_t before = mono.stats().shadowRedraws;
        drawStereo();
        if (before == 0 && mono.stats().shadowRedraws > 0)
            shadowAllocChecked++;
        noteFrame();
        drawImplicit();
        if (mv)
            drawMultiview();
        glFinish();
        worstFrame = std::max(worstFrame, std::chrono::duration<double, std::milli>(
                                              std::chrono::steady_clock::now() - f0)
                                              .count());
        frames++;
    }
    double loadS = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::printf("streamed %zu packets in %.2f s over %d frames (worst frame %.1f ms incl. "
                "glFinish, worst prepareFrame %.2f ms), rejected %zu\n",
                packets.size(), loadS, frames, worstFrame, maxPrepare, rejected);
    auto stillFrame = [&]() {
        mono.tick();
        implicit.tick();
        if (mv)
            mv->tick();
        uint64_t before = mono.stats().shadowRedraws;
        drawStereo();
        if (before == 0 && mono.stats().shadowRedraws > 0)
            shadowAllocChecked++;
        noteFrame();
        drawImplicit();
        if (mv)
            drawMultiview();
        glFinish();
    };
    // Hold still so static batches form, as a few seconds after load on the headset.
    auto s0 = std::chrono::steady_clock::now();
    while (std::chrono::duration<double>(std::chrono::steady_clock::now() - s0).count() < settle) {
        stillFrame();
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    // The renderers share one context and budget their uploads and links per prepareFrame, so
    // one that prepares behind queued GPU work loads fewer bytes per frame. The images are
    // compared only once each has drawn the whole stream: a state, every texture and program,
    // and nothing queued.
    struct Renderer {
        const char *name;
        SceneRenderer *r;
    };
    std::vector<Renderer> renderers = {{"mono", &mono}, {"implicit", &implicit}};
    if (mv)
        renderers.push_back({"multiview", mv.get()});
    auto loaded = [](const SceneStats &s) {
        return s.stateSerial && !s.pendingUploads && !s.waitingState && !s.programsCompiling &&
               !s.queuedTextureOps && !s.queuedBytes;
    };
    auto allLoaded = [&]() {
        for (const Renderer &x : renderers)
            if (!loaded(x.r->stats()))
                return false;
        return true;
    };
    const int maxLoadFrames = 3000;
    int loadFrames = 0;
    for (; loadFrames < maxLoadFrames && !allLoaded(); loadFrames++)
        stillFrame();
    std::printf("all renderers loaded after %d more frames (limit %d)\n", loadFrames,
                maxLoadFrames);
    for (const Renderer &x : renderers) {
        SceneStats s = x.r->stats();
        check(loaded(s), std::string(x.name) + " did not finish loading: state " +
                             std::to_string(s.stateSerial) + ", pending uploads " +
                             std::to_string(s.pendingUploads) + ", newer state waiting " +
                             std::to_string(int(s.waitingState)) + ", compiling " +
                             std::to_string(s.programsCompiling) + ", queued ops " +
                             std::to_string(s.queuedTextureOps) + ", queued bytes " +
                             std::to_string(s.queuedBytes));
    }
    std::printf("first state drawn at frame %d (%.2f s); prepareFrame over 3 ms in %d of %d frames "
                "(budget %.1f ms, worst %.2f ms)\n",
                firstStateFrame, firstStateS, prepareOver3, prepareFrames,
                double(single.prepareBudgetMs), maxPrepare);
    // Steady-state frames for timing.
    double monoMs = 0, stereoMs = 0, mvMs = 0;
    const int timed = 30;
    for (int i = 0; i < timed; i++) {
        auto a = std::chrono::steady_clock::now();
        drawMono();
        glFinish();
        auto b = std::chrono::steady_clock::now();
        drawStereo();
        glFinish();
        auto c = std::chrono::steady_clock::now();
        if (mv)
            drawMultiview();
        glFinish();
        auto d = std::chrono::steady_clock::now();
        monoMs += std::chrono::duration<double, std::milli>(b - a).count();
        stereoMs += std::chrono::duration<double, std::milli>(c - b).count();
        mvMs += std::chrono::duration<double, std::milli>(d - c).count();
    }
    std::printf("steady frame incl. glFinish (host GPU, not the headset): mono %.2f ms, stereo "
                "2-pass %.2f ms, multiview %.2f ms\n",
                monoMs / timed, stereoMs / timed, mv ? mvMs / timed : 0.0);

    GLenum err = glGetError();
    char hex[16];
    std::snprintf(hex, sizeof hex, "0x%x", err);
    check(err == GL_NO_ERROR, std::string("GL error ") + hex);
    // Both renderers allocated their shadow map inside a checked call.
    check(shadowAllocChecked >= 2, "the shadow map was not first drawn inside a checked call (" +
                                       std::to_string(shadowAllocChecked) + " of 2)");
    std::printf("binding checks: %s (%d failed)\n", bindingFailures ? "FAIL" : "ok",
                bindingFailures);
    check(bindingFailures == 0, "prepareFrame or render changed the caller's bindings");
    for (SceneRenderer *r : {&mono, &implicit, mv.get()})
        if (r)
            check(r->lastError().empty(), "renderer error: " + r->lastError());

    drawMono();
    glFinish();
    printStats("mono", mono.stats());
    glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo[0]);
    auto monoPx = readPixels(size, size);
    drawStereo();
    glFinish();
    printStats("stereo", mono.stats());
    glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo[0]);
    auto left = readPixels(size, size);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo[1]);
    auto right = readPixels(size, size);
    writePpm(out + "/mono.ppm", monoPx, size, size);
    writePpm(out + "/stereo-left.ppm", left, size, size);
    writePpm(out + "/stereo-right.ppm", right, size, size);

    double lit = 0;
    int colors = 0;
    coverage(monoPx, lit, colors);
    std::printf("mono image: %.1f%% non-black pixels, %d distinct colors (4-bit)\n", lit * 100,
                colors);
    check(lit >= 0.5 && colors >= 64, "the mono image looks empty");
    Diff ml = compare(monoPx, left);
    std::printf("mono vs stereo left: mean %.3f, %.3f%% pixels > 8\n", ml.mean, ml.over8 * 100);
    check(ml.over8 <= 0.001, "mono and stereo left differ in more than 0.1% of pixels");
    drawImplicit();
    glFinish();
    printStats("implicit", implicit.stats());
    glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo[0]);
    Diff im = compare(monoPx, readPixels(size, size));
    std::printf("mono vs implicit prepare: mean %.3f, %.3f%% pixels > 8\n", im.mean,
                im.over8 * 100);
    check(im.over8 <= 0.001, "mono and implicit prepare differ in more than 0.1% of pixels");
    Diff lr = compare(left, right);
    std::printf("stereo left vs right (6.4 cm apart): mean %.3f, %.2f%% pixels > 8\n", lr.mean,
                lr.over8 * 100);

    if (mv) {
        drawMultiview();
        glFinish();
        printStats("multiview", mv->stats());
        std::vector<uint8_t> layers[2];
        for (int e = 0; e < 2; e++) {
            glBindFramebuffer(GL_READ_FRAMEBUFFER, readFbo);
            glFramebufferTextureLayer(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, arrayColor, 0, e);
            layers[e] = readPixels(size, size);
            writePpm(out + (e ? "/multiview-right.ppm" : "/multiview-left.ppm"), layers[e], size,
                     size);
        }
        Diff a = compare(left, layers[0]), b = compare(right, layers[1]);
        std::printf(
            "stereo vs multiview: left mean %.3f (%.3f%% > 8), right mean %.3f (%.3f%% > 8)\n",
            a.mean, a.over8 * 100, b.mean, b.over8 * 100);
        check(a.over8 <= 0.002 && b.over8 <= 0.002, "multiview differs from the two-pass stereo");
    }
    int bindingFailuresBefore = bindingFailures;
    sharpChecks(mono, prepare, checkBindings, size, out, failed);
    check(bindingFailures == bindingFailuresBefore,
          "the screen layer changed the caller's bindings");
    SceneStats st = mono.stats();
    std::printf("packets applied %llu, rejected %llu, commits %llu, last apply %.2f ms, queued "
                "%llu bytes\n",
                (unsigned long long)st.packetsApplied, (unsigned long long)st.packetsRejected,
                (unsigned long long)st.commits, double(st.applyMs),
                (unsigned long long)st.queuedBytes);
    check(!st.packetsRejected && !rejected,
          "packets rejected: " + std::to_string(st.packetsRejected) + " by the renderer, " +
              std::to_string(rejected) + " at enqueue");
    check(!st.programsFailed && !st.programsCompiling,
          std::to_string(st.programsFailed) + " programs failed, " +
              std::to_string(st.programsCompiling) + " still compiling");
    check(!st.pendingUploads && !st.waitingState, "uploads still pending after settling");
    sharpSamplingChecks(out, failed);
    attachmentChecks(failed);
    panelUnderlayChecks(failed);
    foveationFilterChecks(failed, hasMultiview, multiviewFn);
    for (const std::string &what : failed)
        std::printf("failed: %s\n", what.c_str());
    if (failed.empty())
        std::printf("OK\n");
    else
        std::printf("FAILED (%zu)\n", failed.size());
    mv.reset();
    // mono is destroyed with the context current (end of scope) before EGL teardown below.
    return failed.empty() ? 0 : 1;
}
