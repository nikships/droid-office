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
#include "scene_renderer.h"
#include "scene_shaders.h"
#include "scene_uniforms.h"

#include <EGL/egl.h>
#include <GLES3/gl3.h>

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

} // namespace

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
