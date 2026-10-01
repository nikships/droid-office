// The GL-free frame planner (scene_frame.h) with a fake backend: what every world renderer
// shares. The GLES renderer's use of it is covered by the render suite (app/src/test/cpp).
#include "scene_frame.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <memory>
#include <set>
#include <thread>
using namespace office;
using namespace office::scene;

namespace {

/** A backend whose pipelines are ready unless refused, with every texture resident. */
struct FakeResidency : SceneResidency {
    ScenePipeline pipeline;
    std::set<uint32_t> refused; // ProgramKey::bits() without a pipeline
    std::set<uint32_t> missingTextures;
    mutable int drawRequests = 0;
    bool box = false;
    float lo[3] = {-.2f, -.1f, 0}, hi[3] = {.2f, .1f, 0};

    const ScenePipeline *drawPipeline(const ProgramKey &key) override {
        ++drawRequests;
        return refused.count(key.bits()) ? nullptr : &pipeline;
    }
    const ScenePipeline *readyPipeline(const ProgramKey &key) const override {
        return refused.count(key.bits()) ? nullptr : &pipeline;
    }
    bool textureResident(uint32_t id) const override { return !missingTextures.count(id); }
    bool vertexBox(uint64_t, float l[3], float h[3]) const override {
        if (!box)
            return false;
        std::copy(lo, lo + 3, l);
        std::copy(hi, hi + 3, h);
        return true;
    }
};

const float kIdentity[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};

/** An eye at the origin looking down -z with a 90 degree symmetric frustum (GL clip). */
SceneEye eyeAtOrigin() {
    SceneEye e;
    std::copy(kIdentity, kIdentity + 16, e.view);
    const float n = .1f, f = 100;
    const float p[16] = {
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, -2 * f * n / (f - n), 0};
    std::copy(p, p + 16, e.projection);
    return e;
}

std::shared_ptr<MaterialState> material(uint32_t id, bool transparent) {
    auto m = std::make_shared<MaterialState>();
    m->id = id;
    m->transparent = transparent;
    m->map = 100 + id;
    return m;
}

DrawItem item(uint32_t id, float x, float y, float z, std::shared_ptr<MaterialState> m) {
    DrawItem it;
    it.vertices = std::make_shared<GpuVertices>();
    it.material = std::move(m);
    it.id = id;
    it.sphere.c = {x, y, z};
    it.sphere.r = .25f;
    it.model[12] = x;
    it.model[13] = y;
    it.model[14] = z;
    return it;
}

void budget() {
    FrameBudget work;
    const auto t0 = FrameBudget::Clock::now();
    work.start(t0, 1000, 2, 0);
    assert(work.bytes == 1000 && work.links == 2 && !work.worked);
    // The first piece always runs, even with no time left.
    assert(work.mayWork());
    work.worked = true;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    assert(!work.mayWork());
    work.start(FrameBudget::Clock::now(), 0, 0, 1000);
    work.worked = true;
    assert(work.mayWork());
}

void worldLists() {
    auto opaqueA = material(2, false), opaqueB = material(1, false), glass = material(3, true);
    auto s = std::make_shared<RenderState>();
    s->serial = 1;
    s->items.push_back(item(1, 0, 0, -5, opaqueA));
    s->items.push_back(item(2, 0, 0, -2, opaqueA)); // nearer, same material: first
    s->items.push_back(item(3, 0, 0, -9, opaqueB)); // lower material id: before both
    s->items.push_back(item(4, 0, 0, 5, opaqueA));  // behind the eye: culled
    s->items.push_back(item(5, 0, 0, -3, glass));
    s->items.push_back(item(6, 0, 0, -7, glass)); // farther transparent: first
    auto late = item(7, 0, 0, -4, opaqueB);
    late.renderOrder = 1; // render order before material and depth
    s->items.push_back(late);
    auto refused = item(8, 0, 0, -6, opaqueB);
    refused.key.model = ShadeModel::Toon;
    s->items.push_back(refused);

    FakeResidency gpu;
    ProgramKey toon;
    toon.model = ShadeModel::Toon;
    gpu.refused.insert(toon.bits());
    SceneFramePlanner planner({});
    const SceneEye eye = eyeAtOrigin();
    planner.buildLists(*s, &eye, 1, false, gpu);
    std::vector<uint32_t> opaque, transparent;
    for (const auto &d : planner.opaque())
        opaque.push_back(d.item->id);
    for (const auto &d : planner.transparent())
        transparent.push_back(d.item->id);
    assert((opaque == std::vector<uint32_t>{3, 2, 1, 7}));
    assert((transparent == std::vector<uint32_t>{6, 5}));
    // Culled and without a pipeline both count as not drawn.
    assert(planner.culledItems() == 2);
    for (const auto &d : planner.opaque())
        assert(d.program == &gpu.pipeline);
    // Multiview asks for the multiview variant of every visible key.
    gpu.refused.clear();
    ProgramKey single;
    gpu.refused.insert(single.bits()); // only the single-view basic key is missing
    planner.buildLists(*s, &eye, 1, true, gpu);
    assert(planner.opaque().size() == 5 && planner.transparent().size() == 2);
}

void attachments() {
    auto m = material(1, false);
    auto s = std::make_shared<RenderState>();
    s->serial = 7;
    auto held = item(1, 0, 0, -1, m);
    held.attachment = 0;
    held.sphere.c = {0, 0, 0}; // grip-relative
    s->items.push_back(held);
    auto card = item(2, 0, 0, -1, m);
    card.attachment = 1;
    card.gripHeld = true;
    card.sphere.c = {0, 0, 0};
    s->items.push_back(card);
    s->attachedItems = 2;

    FakeResidency gpu;
    SceneFramePlanner planner({});
    const SceneEye eye = eyeAtOrigin();
    planner.beginFrame();
    planner.buildLists(*s, &eye, 1, false, gpu);
    assert(planner.opaque().empty() && planner.attachedPlaced() == 0);

    SceneControllerPoses poses;
    for (int h = 0; h < 2; ++h) {
        poses.valid[h] = true;
        poses.grip[h][14] = -2; // two metres ahead
    }
    planner.setControllerPoses(poses, s.get());
    planner.buildLists(*s, &eye, 1, false, gpu);
    // The card needs its squeeze; the other is drawn at grip * relative.
    assert(planner.attachedPlaced() == 1 && planner.opaque().size() == 1);
    const DrawItem &placed = *planner.opaque()[0].item;
    assert(placed.id == 1 && std::fabs(placed.model[14] + 3) < 1e-6f);
    assert(std::fabs(placed.sphere.c.z + 2) < 1e-6f);
    poses.held[1] = true;
    planner.setControllerPoses(poses, s.get());
    planner.buildLists(*s, &eye, 1, false, gpu);
    assert(planner.attachedPlaced() == 2 && planner.opaque().size() == 2);
    // A non-rigid grip is invalid; a new frame forgets every grip.
    poses.grip[0][0] = 2;
    planner.setControllerPoses(poses, s.get());
    planner.buildLists(*s, &eye, 1, false, gpu);
    assert(planner.attachedPlaced() == 1);
    planner.beginFrame();
    planner.buildLists(*s, &eye, 1, false, gpu);
    assert(planner.attachedPlaced() == 0 && planner.opaque().empty());
}

void screenLayer() {
    auto screenMaterial = material(1, false);
    auto s = std::make_shared<RenderState>();
    s->serial = 3;
    auto screen = item(1, 0, 0, -1, screenMaterial);
    screen.sharpText = true;
    s->items.push_back(screen);
    auto far = item(2, 0, 0, -20, screenMaterial); // beyond sharpMaxDistance
    far.sharpText = true;
    s->items.push_back(far);
    s->sharpItems = 2;

    FakeResidency gpu;
    gpu.box = true;
    ScenePlanOptions options;
    SceneFramePlanner planner(options);
    const SceneEye eyes[2] = {eyeAtOrigin(), eyeAtOrigin()};
    assert(planner.hasSharpAnywhere(*s, gpu));
    assert(planner.hasSharp(*s, eyes, false, gpu));
    const int w[2] = {1000, 1000}, h[2] = {800, 800};
    SharpScreenPlan plan;
    assert(planner.planSharp(s, true, 5, eyes, w, h, false, plan, gpu));
    assert(planner.sharpScreens().size() == 1 && planner.sharpScreens()[0].item->id == 1);
    // The box +-0.2 x +-0.1 m at 1 m covers x 400..600 of 1000 and y 360..440 of 800 in a 90
    // degree view, plus a pixel of margin on each side (a pixel of rounding either way).
    const int *r = plan.viewRect[0];
    auto near = [](int a, int b) { return std::abs(a - b) <= 1; };
    assert(near(r[0], 399) && near(r[1], 359) && near(r[0] + r[2], 601) && near(r[1] + r[3], 441));
    const int *g = plan.region[0];
    assert(g[0] == r[0] - kSharpGuardPixels && g[2] == r[2] + 2 * kSharpGuardPixels);
    assert(planner.planIsCurrent(plan, 5, s));
    assert(!planner.planIsCurrent(plan, 6, s));
    auto other = std::make_shared<RenderState>(*s);
    assert(!planner.planIsCurrent(plan, 5, other));
    planner.forgetPlan();
    assert(!planner.planIsCurrent(plan, 5, s));
    // Without its texture or program the screen is not drawn, and neither without `usable`.
    gpu.missingTextures.insert(screenMaterial->map);
    assert(!planner.hasSharpAnywhere(*s, gpu));
    assert(!planner.planSharp(s, true, 7, eyes, w, h, false, plan, gpu) && !plan.any);
    gpu.missingTextures.clear();
    assert(!planner.planSharp(s, false, 8, eyes, w, h, false, plan, gpu));
    // Multiview needs equal sizes and the array depth.
    ScenePlanOptions mv;
    mv.multiview = true;
    SceneFramePlanner stereo(mv);
    assert(!stereo.planSharp(s, true, 9, eyes, w, h, false, plan, gpu));
    assert(stereo.planSharp(s, true, 9, eyes, w, h, true, plan, gpu));
    assert(plan.region[0][0] == plan.region[1][0] && plan.region[0][3] == plan.region[1][3]);
}

void rects() {
    const PixelRect a{0, 0, 10, 10}, b{5, 5, 20, 8}, empty{};
    const auto u = unite(a, b), i = intersect(a, b);
    assert(u.x0 == 0 && u.y0 == 0 && u.x1 == 20 && u.y1 == 10);
    assert(i.x0 == 5 && i.y0 == 5 && i.x1 == 10 && i.y1 == 8);
    assert(unite(empty, b).x1 == 20 && intersect(a, PixelRect{20, 20, 30, 30}).empty());
    int count = 0;
    sharpKeyVariants(false, ProgramKey{}, [&](ProgramKey k) {
        assert(!k.multiview && k.sharpDepth != SharpDepth::None);
        ++count;
    });
    sharpKeyVariants(true, ProgramKey{}, [&](ProgramKey k) {
        assert(k.multiview && k.sharpDepth == SharpDepth::Array);
        ++count;
    });
    assert(count == 3);
}

} // namespace

int main() {
    budget();
    worldLists();
    attachments();
    screenLayer();
    rects();
    std::cout << "scene frame planner tests passed\n";
}
