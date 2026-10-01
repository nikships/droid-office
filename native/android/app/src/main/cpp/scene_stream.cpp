#include "scene_stream.h"

#include <algorithm>
#include <chrono>

#ifdef __ANDROID__
#include <android/log.h>
#define SCENE_LOG(...) __android_log_print(ANDROID_LOG_INFO, "OfficeScene", __VA_ARGS__)
#else
#include <cstdio>
#define SCENE_LOG(...) (std::fprintf(stderr, __VA_ARGS__), std::fputc('\n', stderr))
#endif

namespace office {

using namespace office::scene;
using Clock = std::chrono::steady_clock;

namespace {
double seconds() { return std::chrono::duration<double>(Clock::now().time_since_epoch()).count(); }
} // namespace

SceneStream::SceneStream(const SceneStreamOptions &o) : options(o), model(o.model) {}

/**
 * A rejected packet asks for one reset; packets still in flight from the old stream are then
 * dropped quietly instead of asking again (which would restart the snapshot in a loop). The
 * request repeats only if no reset arrives within a few seconds. Called with modelMutex held.
 */
void SceneStream::reject(const std::string &message) {
    double now = seconds();
    bool ask = !awaitingReset || now - resetRequestedAt > 5.0;
    std::lock_guard<std::mutex> s(shared);
    packetsRejected++;
    if (!ask)
        return;
    SCENE_LOG("%s", message.c_str());
    error = message;
    resetRequest = true;
    awaitingReset = true;
    resetRequestedAt = now;
}

bool SceneStream::apply(const nlohmann::json &packet) {
    std::lock_guard<std::mutex> lock(modelMutex);
    auto t0 = Clock::now();
    ApplyResult result;
    try {
        result = model.apply(packet, seconds());
    } catch (const std::exception &e) {
        reject(std::string("scene packet rejected: ") + e.what());
        return false;
    }
    if (packet.is_object() && packet.value("reset", false))
        awaitingReset = false;
    publish(std::move(result));
    std::lock_guard<std::mutex> s(shared);
    packetsApplied++;
    sceneSeq = model.lastSeq();
    commits = model.commits();
    blobBytes = model.blobBytes();
    applyMs = std::chrono::duration<float, std::milli>(Clock::now() - t0).count();
    applyMaxMs = std::max(applyMaxMs, applyMs);
    return true;
}

void SceneStream::publish(ApplyResult &&result) {
    std::lock_guard<std::mutex> lock(shared);
    for (auto &op : result.textures) {
        if (op.kind == TextureOp::Clear) {
            textureOps.clear();
            queuedTextureBytes = 0;
        } else if (op.kind == TextureOp::Upload) {
            // A newer image of a texture replaces one still waiting (video frames, canvases),
            // unless another op on that texture sits between them.
            auto same = std::find_if(textureOps.rbegin(), textureOps.rend(),
                                     [&](const TextureOp &q) { return q.id == op.id; });
            if (same != textureOps.rend() && same->kind == TextureOp::Upload) {
                queuedTextureBytes = queuedTextureBytes - same->bytes() + op.bytes();
                *same = std::move(op);
                continue;
            }
            queuedTextureBytes += op.bytes();
        }
        textureOps.push_back(std::move(op));
    }
    if (result.state)
        latest_ = std::move(result.state);
}

bool SceneStream::enqueueJson(std::string_view text) {
    if (text.size() > options.maxPacketBytes) {
        std::lock_guard<std::mutex> lock(modelMutex);
        reject("scene packet of " + std::to_string(text.size()) + " bytes is over the " +
               std::to_string(options.maxPacketBytes) + " byte limit");
        return false;
    }
    auto t0 = Clock::now();
    nlohmann::json j = nlohmann::json::parse(text.begin(), text.end(), nullptr, false);
    {
        std::lock_guard<std::mutex> lock(shared);
        parseMs = std::chrono::duration<float, std::milli>(Clock::now() - t0).count();
    }
    if (j.is_discarded()) {
        std::lock_guard<std::mutex> lock(modelMutex);
        reject("scene packet is not valid JSON");
        return false;
    }
    return enqueue(std::move(j));
}

bool SceneStream::enqueue(nlohmann::json &&j) {
    // The frame() envelope {scene, control, panel}; a bare packet has "v".
    if (j.is_object() && !j.contains("v") && j.contains("scene")) {
        nlohmann::json scene = std::move(j["scene"]);
        if (scene.is_null()) {
            tick();
            return true;
        }
        return apply(scene);
    }
    return apply(j);
}

void SceneStream::tick() {
    std::lock_guard<std::mutex> lock(modelMutex);
    ApplyResult r = model.tick(seconds());
    if (r.state || !r.textures.empty())
        publish(std::move(r));
}

bool SceneStream::acceptsPackets() const {
    std::lock_guard<std::mutex> lock(shared);
    return queuedTextureBytes < options.maxQueuedBytes;
}

bool SceneStream::takeResetRequest() {
    std::lock_guard<std::mutex> lock(shared);
    bool r = resetRequest;
    resetRequest = false;
    return r;
}

std::shared_ptr<const RenderState> SceneStream::latest() const {
    std::lock_guard<std::mutex> lock(shared);
    return latest_;
}

std::deque<TextureOp> SceneStream::takeTextureOps(size_t uploadsWaiting, size_t uploadLimit) {
    std::deque<TextureOp> ops;
    std::lock_guard<std::mutex> lock(shared);
    size_t waiting = uploadsWaiting;
    while (!textureOps.empty()) {
        TextureOp &op = textureOps.front();
        if (op.kind == TextureOp::Upload) {
            if (waiting >= uploadLimit)
                break;
            waiting++;
            queuedTextureBytes -= op.bytes();
        }
        ops.push_back(std::move(op));
        textureOps.pop_front();
    }
    return ops;
}

bool SceneStream::cameraWorld(float out[16]) const {
    std::lock_guard<std::mutex> lock(shared);
    if (!latest_ || !latest_->hasCamera)
        return false;
    std::copy(latest_->camera, latest_->camera + 16, out);
    return true;
}

SceneStreamStats SceneStream::stats() const {
    std::lock_guard<std::mutex> lock(shared);
    SceneStreamStats st;
    st.queuedTextureOps = uint32_t(textureOps.size());
    st.queuedBytes = queuedTextureBytes + blobBytes;
    st.packetsApplied = packetsApplied;
    st.packetsRejected = packetsRejected;
    st.commits = commits;
    st.sceneSeq = sceneSeq;
    st.parseMs = parseMs;
    st.applyMs = applyMs;
    st.applyMaxMs = applyMaxMs;
    applyMaxMs = 0;
    return st;
}

void SceneStream::setError(const std::string &message) {
    std::lock_guard<std::mutex> lock(shared);
    error = message;
}

std::string SceneStream::lastError() const {
    std::lock_guard<std::mutex> lock(shared);
    return error;
}

} // namespace office
