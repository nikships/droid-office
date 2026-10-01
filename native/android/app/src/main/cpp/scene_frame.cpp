#include "scene_frame.h"

#include <algorithm>
#include <cmath>

namespace office {

using namespace office::scene;

namespace {

Mat4 toMat(const float *m) {
    Mat4 r;
    std::copy(m, m + 16, r.begin());
    return r;
}

/** Which views see the sphere (bit per view), and the distance from the nearest eye (0 inside
 * it). */
uint8_t sharpViewMask(const Sphere &sp, const SharpView *views, int count, float &distance) {
    uint8_t mask = 0;
    distance = INFINITY;
    for (int i = 0; i < count; i++) {
        if (views[i].frustum.intersects(sp))
            mask |= uint8_t(1u << i);
        float d = sp.infinite() ? 0.0f : std::max(0.0f, length(sp.c - views[i].eye) - sp.r);
        distance = std::min(distance, d);
    }
    return mask;
}

/** The pixels the box [lo, hi] may cover through `m` (clip from box coordinates), see below. */
PixelRect projectedBox(const float lo[3], const float hi[3], const Mat4 &vp, int w, int h) {
    PixelRect full{0, 0, w, h};
    float x0 = INFINITY, y0 = INFINITY, x1 = -INFINITY, y1 = -INFINITY;
    for (int c = 0; c < 8; c++) {
        float x = c & 1 ? hi[0] : lo[0], y = c & 2 ? hi[1] : lo[1], z = c & 4 ? hi[2] : lo[2];
        float cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        if (cw < 1e-4f)
            return full;
        float nx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw,
              ny = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw;
        x0 = std::min(x0, nx);
        x1 = std::max(x1, nx);
        y0 = std::min(y0, ny);
        y1 = std::max(y1, ny);
    }
    auto px = [](float ndc, int size) { return (ndc * 0.5f + 0.5f) * float(size); };
    PixelRect r{int(std::floor(std::max(-1.0f, px(x0, w)))) - 1,
                int(std::floor(std::max(-1.0f, px(y0, h)))) - 1,
                int(std::ceil(std::min(float(w) + 1, px(x1, w)))) + 1,
                int(std::ceil(std::min(float(h) + 1, px(y1, h)))) + 1};
    return intersect(r, full);
}

/**
 * The pixels a sphere may cover in a w x h viewport: its bounding box's corners projected, with
 * a pixel of margin. A corner at or behind the eye covers the whole viewport.
 */
PixelRect projectedRect(const Sphere &sp, const Mat4 &vp, int w, int h) {
    if (sp.empty())
        return {};
    if (sp.infinite())
        return {0, 0, w, h};
    const float lo[3] = {sp.c.x - sp.r, sp.c.y - sp.r, sp.c.z - sp.r};
    const float hi[3] = {sp.c.x + sp.r, sp.c.y + sp.r, sp.c.z + sp.r};
    return projectedBox(lo, hi, vp, w, h);
}

} // namespace

SharpView sharpView(const SceneEye &e) {
    SharpView v;
    Mat4 view = toMat(e.view), inv;
    v.viewProj = multiply(toMat(e.projection), view);
    v.frustum = Frustum::fromViewProj(v.viewProj);
    if (!invert(view, inv))
        inv = identity();
    v.eye = {inv[12], inv[13], inv[14]};
    return v;
}

// ---- Controller attachments
// ----------------------------------------------------------------------

void SceneFramePlanner::beginFrame() {
    grips_.valid[0] = grips_.valid[1] = grips_.held[0] = grips_.held[1] = false;
    heldHands_ = 0;
    culledItems_ = 0;
}

void SceneFramePlanner::syncAttachments(const RenderState &s) {
    if (placedSerial_ == s.serial)
        return;
    placed_.clear();
    placed_.reserve(s.attachedItems);
    for (const DrawItem &it : s.items)
        if (it.attachment >= 0)
            placed_.push_back(it);
    placedSerial_ = s.serial;
    compose(s);
}

/** Places every attached item at its valid grip (matrices only). */
void SceneFramePlanner::compose(const RenderState &s) {
    size_t k = 0;
    for (const DrawItem &it : s.items) {
        if (it.attachment < 0)
            continue;
        if (grips_.valid[it.attachment])
            placeAttachment(it, grips_.grip[it.attachment], placed_[k]);
        k++;
    }
}

void SceneFramePlanner::setControllerPoses(const SceneControllerPoses &poses,
                                           const RenderState *drawn) {
    for (int h = 0; h < 2; h++) {
        grips_.valid[h] = poses.valid[h] && rigidPose(poses.grip[h]);
        grips_.held[h] = grips_.valid[h] && poses.held[h];
        std::copy(poses.grip[h], poses.grip[h] + 16, grips_.grip[h]);
    }
    heldHands_ = 0;
    if (const RenderState *s = drawn) {
        if (placedSerial_ != s->serial)
            syncAttachments(*s);
        else
            compose(*s);
        for (const DrawItem &it : placed_)
            if (placedAt(it))
                heldHands_ |= 1u << it.attachment;
    }
}

size_t SceneFramePlanner::attachedBounds(float (*out)[4], size_t max) const {
    if (!heldHands_)
        return 0;
    size_t count = 0;
    for (const DrawItem &it : placed_) {
        if (count >= max)
            break;
        if (!placedAt(it) || it.sphere.empty() || it.sphere.infinite())
            continue;
        out[count][0] = it.sphere.c.x;
        out[count][1] = it.sphere.c.y;
        out[count][2] = it.sphere.c.z;
        out[count][3] = it.sphere.r;
        count++;
    }
    return count;
}

// ---- The world pass
// ------------------------------------------------------------------------------

void SceneFramePlanner::buildLists(const RenderState &s, const SceneEye *eyes, int count,
                                   bool multiviewPass, SceneResidency &residency,
                                   SceneDrawSet set) {
    opaque_.clear();
    transparent_.clear();
    Frustum fr[2];
    Mat4 vp0 = multiply(toMat(eyes[0].projection), toMat(eyes[0].view));
    for (int i = 0; i < count; i++)
        fr[i] = Frustum::fromViewProj(multiply(toMat(eyes[i].projection), toMat(eyes[i].view)));
    syncAttachments(s);
    size_t attached = 0, considered = 0;
    if (set != SceneDrawSet::World)
        attachedPlaced_ = 0;
    for (const DrawItem &source : s.items) {
        const DrawItem *drawn = &source;
        if (source.attachment >= 0) {
            drawn = &placed_[attached++];
            if (set == SceneDrawSet::World)
                continue;
            considered++;
            // Without this frame's tracked grip there is no pose to draw it at: never a stale
            // one. A grip-held item drops on the display frame its squeeze is released.
            if (!placedAt(source))
                continue;
            attachedPlaced_++;
        } else if (set == SceneDrawSet::Attached) {
            continue;
        } else {
            considered++;
        }
        const DrawItem &it = *drawn;
        bool seen = false;
        for (int i = 0; i < count && !seen; i++)
            seen = fr[i].intersects(it.sphere);
        if (!seen)
            continue;
        ProgramKey k = it.key;
        k.multiview = multiviewPass;
        const ScenePipeline *p = residency.drawPipeline(k);
        if (!p)
            continue;
        Vec3 c = it.sphere.c;
        float w = vp0[3] * c.x + vp0[7] * c.y + vp0[11] * c.z + vp0[15];
        float z = (vp0[2] * c.x + vp0[6] * c.y + vp0[10] * c.z + vp0[14]) / (w != 0 ? w : 1);
        (it.material->transparent ? transparent_ : opaque_).push_back({&it, p, z});
    }
    std::stable_sort(opaque_.begin(), opaque_.end(), [](const SceneDraw &a, const SceneDraw &b) {
        const DrawItem &x = *a.item, &y = *b.item;
        if (x.groupOrder != y.groupOrder)
            return x.groupOrder < y.groupOrder;
        if (x.renderOrder != y.renderOrder)
            return x.renderOrder < y.renderOrder;
        if (x.material->id != y.material->id)
            return x.material->id < y.material->id;
        if (a.z != b.z)
            return a.z < b.z;
        return x.id < y.id;
    });
    std::stable_sort(transparent_.begin(), transparent_.end(),
                     [](const SceneDraw &a, const SceneDraw &b) {
                         const DrawItem &x = *a.item, &y = *b.item;
                         if (x.groupOrder != y.groupOrder)
                             return x.groupOrder < y.groupOrder;
                         if (x.renderOrder != y.renderOrder)
                             return x.renderOrder < y.renderOrder;
                         if (a.z != b.z)
                             return a.z > b.z;
                         return x.id < y.id;
                     });
    // The attached pass follows a world pass of the same frame and adds its own culls.
    const auto culled = uint32_t(considered - opaque_.size() - transparent_.size());
    culledItems_ = set == SceneDrawSet::Attached ? culledItems_ + culled : culled;
}

// ---- The screen layer
// ----------------------------------------------------------------------------

/** The drawn state's tagged screens and overlay candidates, found once per state. */
void SceneFramePlanner::sharpIndex(const RenderState &s) const {
    if (sharpIndexSerial_ == s.serial)
        return;
    taggedScreens_.clear();
    taggedOverlays_.clear();
    for (const DrawItem &it : s.items) {
        if (it.sharpText)
            taggedScreens_.push_back(&it);
        else if (it.sharpOverlay)
            taggedOverlays_.push_back(&it);
    }
    sharpIndexSerial_ = s.serial;
}

/**
 * Tagged screens the layer can draw now: texture resident, seen, near enough, program linked.
 * With `out` null, whether there is any; else fills `out` (z: eye distance, views: which views
 * see it).
 */
bool SceneFramePlanner::sharpCandidates(const RenderState &s, const SharpView *views, int count,
                                        SharpDepth kind, bool multiviewKey,
                                        std::vector<SceneDraw> *out,
                                        const SceneResidency &residency) const {
    sharpIndex(s);
    for (const DrawItem *it : taggedScreens_) {
        if (!residency.textureResident(it->material->map))
            continue;
        float distance = 0;
        uint8_t mask = sharpViewMask(it->sphere, views, count, distance);
        if (!mask || distance > options.sharpMaxDistance)
            continue;
        ProgramKey k = it->key;
        k.multiview = multiviewKey;
        k.sharpDepth = kind;
        k.sharpOverlay = false;
        const ScenePipeline *p = residency.readyPipeline(k);
        if (!p)
            continue;
        if (!out)
            return true;
        out->push_back({it, p, distance, mask});
    }
    return out && !out->empty();
}

bool SceneFramePlanner::hasSharpAnywhere(const RenderState &s,
                                         const SceneResidency &residency) const {
    if (!s.sharpItems)
        return false;
    for (const DrawItem &it : s.items) {
        if (!it.sharpText || !residency.textureResident(it.material->map))
            continue;
        bool linked = false;
        sharpKeyVariants(options.multiview, it.key,
                         [&](ProgramKey k) { linked |= residency.readyPipeline(k) != nullptr; });
        if (linked)
            return true;
    }
    return false;
}

bool SceneFramePlanner::hasSharp(const RenderState &s, const SceneEye *eyes, bool arrayDepth,
                                 const SceneResidency &residency) const {
    if (!s.sharpItems)
        return false;
    SharpView views[2] = {sharpView(eyes[0]), sharpView(eyes[1])};
    if (options.multiview)
        return arrayDepth &&
               sharpCandidates(s, views, 2, SharpDepth::Array, true, nullptr, residency);
    return sharpCandidates(s, views, 2, arrayDepth ? SharpDepth::Array : SharpDepth::Texture2D,
                           false, nullptr, residency);
}

bool SceneFramePlanner::selectSharp(const RenderState &s, const SharpView *views, int count,
                                    SharpDepth kind, bool multiviewKey, const int w[2],
                                    const int h[2], PixelRect cover[2],
                                    const SceneResidency &residency) {
    cover[0] = cover[1] = PixelRect{};
    sharpScreens_.clear();
    sharpOverlays_.clear();
    sharpCandidates(s, views, count, kind, multiviewKey, &sharpScreens_, residency);
    // The nearest few, drawn far to near (the world depth already hides a screen behind another
    // laptop; the order only settles ties).
    std::stable_sort(sharpScreens_.begin(), sharpScreens_.end(),
                     [](const SceneDraw &a, const SceneDraw &b) { return a.z < b.z; });
    if (int(sharpScreens_.size()) > std::max(0, options.sharpMaxScreens))
        sharpScreens_.resize(size_t(std::max(0, options.sharpMaxScreens)));
    std::reverse(sharpScreens_.begin(), sharpScreens_.end());
    if (sharpScreens_.empty())
        return false;
    float farthest = 0;
    for (const SceneDraw &d : sharpScreens_) {
        for (int i = 0; i < count; i++)
            if (d.views & (1u << i))
                cover[i] =
                    unite(cover[i], itemRect(*d.item, views[i].viewProj, w[i], h[i], residency));
        farthest = std::max(farthest, d.z + 2 * std::max(0.0f, d.item->sphere.r));
    }
    if (options.sharpMaxOverlays <= 0)
        return true;
    for (const DrawItem *it : taggedOverlays_) {
        float distance = 0;
        uint8_t seen = sharpViewMask(it->sphere, views, count, distance), mask = 0;
        if (!seen || distance > farthest)
            continue;
        for (int i = 0; i < count; i++)
            if ((seen & (1u << i)) && !cover[i].empty() &&
                !intersect(itemRect(*it, views[i].viewProj, w[i], h[i], residency), cover[i])
                     .empty())
                mask |= uint8_t(1u << i);
        if (!mask)
            continue;
        ProgramKey k = it->key;
        k.multiview = multiviewKey;
        k.sharpDepth = kind;
        k.sharpOverlay = true;
        const ScenePipeline *p = residency.readyPipeline(k);
        if (p)
            sharpOverlays_.push_back({it, p, distance, mask});
    }
    std::stable_sort(sharpOverlays_.begin(), sharpOverlays_.end(),
                     [](const SceneDraw &a, const SceneDraw &b) { return a.z < b.z; });
    if (int(sharpOverlays_.size()) > options.sharpMaxOverlays)
        sharpOverlays_.resize(size_t(options.sharpMaxOverlays));
    const Mat4 &vp0 = views[0].viewProj;
    for (SceneDraw &d : sharpOverlays_) {
        Vec3 c = d.item->sphere.c;
        float cw = vp0[3] * c.x + vp0[7] * c.y + vp0[11] * c.z + vp0[15];
        d.z = (vp0[2] * c.x + vp0[6] * c.y + vp0[10] * c.z + vp0[14]) / (cw != 0 ? cw : 1);
    }
    std::stable_sort(sharpOverlays_.begin(), sharpOverlays_.end(),
                     [](const SceneDraw &a, const SceneDraw &b) {
                         const DrawItem &x = *a.item, &y = *b.item;
                         if (x.groupOrder != y.groupOrder)
                             return x.groupOrder < y.groupOrder;
                         if (x.renderOrder != y.renderOrder)
                             return x.renderOrder < y.renderOrder;
                         if (a.z != b.z)
                             return a.z > b.z;
                         return x.id < y.id;
                     });
    return true;
}

/**
 * The pixels an item may cover: the box of its vertex positions, through its model matrix,
 * projected like projectedRect. Without a usable box (not uploaded, empty, non-finite), its
 * bounding sphere. Only for non-instanced, non-sprite triangles, whose vertex stage is exactly
 * viewProj * model * position.
 */
PixelRect SceneFramePlanner::itemRect(const DrawItem &it, const Mat4 &vp, int w, int h,
                                      const SceneResidency &residency) const {
    float lo[3], hi[3];
    if (it.instances || it.key.model == ShadeModel::Sprite ||
        !residency.vertexBox(it.vertices->serial, lo, hi))
        return projectedRect(it.sphere, vp, w, h);
    return projectedBox(lo, hi, multiply(vp, toMat(it.model)), w, h);
}

bool SceneFramePlanner::planSharp(const std::shared_ptr<const RenderState> &current, bool usable,
                                  uint64_t frame, const SceneEye *eyes, const int *w, const int *h,
                                  bool arrayDepth, SharpScreenPlan &plan,
                                  const SceneResidency &residency) {
    plan = SharpScreenPlan{};
    sharpPlanState_.reset();
    sharpScreens_.clear();
    sharpOverlays_.clear();
    const RenderState *s = current.get();
    const bool mv = options.multiview;
    bool sizes =
        w[0] > 0 && h[0] > 0 && w[1] > 0 && h[1] > 0 && (!mv || (w[0] == w[1] && h[0] == h[1]));
    PixelRect cover[2];
    bool any = usable && s && s->sharpItems && sizes && (!mv || arrayDepth);
    if (any) {
        SharpView views[2] = {sharpView(eyes[0]), sharpView(eyes[1])};
        any = selectSharp(*s, views, 2, arrayDepth ? SharpDepth::Array : SharpDepth::Texture2D, mv,
                          w, h, cover, residency);
    }
    if (any) {
        PixelRect region[2];
        for (int i = 0; i < 2; i++) {
            PixelRect full{0, 0, w[i], h[i]};
            PixelRect v = options.sharpCropToScreens ? intersect(cover[i], full) : full;
            if (v.empty()) {
                // A view that sees none of the screens presents a few transparent pixels. With
                // multiview they sit inside the other view's pixels, which the pass clears in
                // both views anyway.
                int b = std::min({2 * kSharpGuardPixels, w[i], h[i]});
                PixelRect other = intersect(cover[1 - i], full);
                int x = mv && !other.empty() ? other.x0 : (w[i] - b) / 2;
                int y = mv && !other.empty() ? other.y0 : (h[i] - b) / 2;
                v = intersect({x, y, x + b, y + b}, full);
            }
            region[i] = intersect({v.x0 - kSharpGuardPixels, v.y0 - kSharpGuardPixels,
                                   v.x1 + kSharpGuardPixels, v.y1 + kSharpGuardPixels},
                                  full);
            int *r = plan.viewRect[i];
            r[0] = v.x0;
            r[1] = v.y0;
            r[2] = v.x1 - v.x0;
            r[3] = v.y1 - v.y0;
        }
        if (mv)
            region[0] = region[1] = unite(region[0], region[1]);
        for (int i = 0; i < 2; i++) {
            int *r = plan.region[i];
            r[0] = region[i].x0;
            r[1] = region[i].y0;
            r[2] = region[i].x1 - region[i].x0;
            r[3] = region[i].y1 - region[i].y0;
            plan.width[i] = w[i];
            plan.height[i] = h[i];
            plan.eyes[i] = eyes[i];
        }
        plan.any = true;
        plan.arrayDepth = arrayDepth;
        plan.token = ++sharpPlanToken_;
        sharpPlanFrame_ = frame;
        sharpPlanState_ = current;
    }
    return plan.any;
}

bool SceneFramePlanner::planIsCurrent(const SharpScreenPlan &plan, uint64_t frame,
                                      const std::shared_ptr<const RenderState> &current) const {
    return plan.any && plan.token == sharpPlanToken_ && sharpPlanFrame_ == frame &&
           sharpPlanState_ && sharpPlanState_ == current;
}

} // namespace office
