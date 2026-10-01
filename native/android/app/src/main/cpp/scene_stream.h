// The bridge side of a native world renderer, without a graphics API: it applies the page's scene
// packets (src/client/native/wire.ts) to the SceneModel on the bridge threads, publishes the
// newest RenderState and the texture changes in order for the render thread, and applies
// backpressure and reset requests. Every backend owns one. See scene_renderer.h and
// docs/vr-native-android.md.
#pragma once

#include "scene_model.h"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>

namespace office {

struct SceneStreamOptions {
    scene::ModelOptions model;
    size_t maxPacketBytes = 64u << 20;  // one JSON packet
    size_t maxQueuedBytes = 192u << 20; // decoded texture data waiting for the render thread
};

/** The stream's share of SceneStats. */
struct SceneStreamStats {
    uint32_t queuedTextureOps = 0; // waiting for the render thread
    uint64_t queuedBytes = 0;      // decoded texture bytes queued + blob parts being assembled
    uint64_t packetsApplied = 0, packetsRejected = 0, commits = 0, sceneSeq = 0;
    // Last packet: JSON parse (enqueueJson only) and model apply + publish; applyMaxMs is the
    // worst apply since the previous stats() call.
    float parseMs = 0, applyMs = 0, applyMaxMs = 0;
};

class SceneStream {
  public:
    explicit SceneStream(const SceneStreamOptions &options);
    SceneStream(const SceneStream &) = delete;
    SceneStream &operator=(const SceneStream &) = delete;

    // ---- Bridge threads (calls are serialized internally; they never wait for the render
    // thread)
    /**
     * A Packet, or the frame() envelope `{scene, control, panel}` (only `scene` is read). A null
     * scene still runs the static batcher. False when the packet was rejected (see lastError).
     */
    bool enqueueJson(std::string_view json);
    bool enqueue(nlohmann::json &&packet);
    /** Runs the static batcher without a packet (enqueueJson with a null scene does the same). */
    void tick();
    /** False under backpressure: pull with {skipScene: true} until it is true again. */
    bool acceptsPackets() const;
    /** True once after a rejected packet or a seq gap: the next pull passes {sceneReset: true}. */
    bool takeResetRequest();

    // ---- Render thread
    /** The newest published state (null before the first commit). */
    std::shared_ptr<const scene::RenderState> latest() const;
    /**
     * The queued texture changes in order, stopping before the upload that would make more than
     * `uploadLimit` uploads waiting on the render thread, which already has `uploadsWaiting`.
     * Most uploads stay queued here, where a newer image of a texture still replaces a waiting
     * one.
     */
    std::deque<scene::TextureOp> takeTextureOps(size_t uploadsWaiting, size_t uploadLimit);

    // ---- Any thread
    /** The page camera's world matrix (column-major) from the latest state; false before any. */
    bool cameraWorld(float out[16]) const;
    /** The counters; applyMaxMs restarts with each call. */
    SceneStreamStats stats() const;
    /** A render-side error, reported by lastError like the stream's own. */
    void setError(const std::string &message);
    std::string lastError() const;

  private:
    void reject(const std::string &message);
    bool apply(const nlohmann::json &packet);
    void publish(scene::ApplyResult &&result);

    SceneStreamOptions options;
    scene::SceneModel model;

    // ---- Bridge side ----------------------------------------------------------------------------
    std::mutex modelMutex; // serializes apply and tick
    bool awaitingReset = false;
    double resetRequestedAt = 0;

    // ---- Shared (guarded by `shared`) -----------------------------------------------------------
    mutable std::mutex shared;
    std::shared_ptr<const scene::RenderState> latest_;
    std::deque<scene::TextureOp> textureOps;
    size_t queuedTextureBytes = 0;
    size_t blobBytes = 0;
    std::string error;
    bool resetRequest = false;
    uint64_t packetsApplied = 0, packetsRejected = 0, commits = 0, sceneSeq = 0;
    float parseMs = 0, applyMs = 0;
    mutable float applyMaxMs = 0; // since the last stats() call
};

} // namespace office
