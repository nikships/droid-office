// Replays a recorded packet stream (a JSON array of wire packets, as window.officeNative.drain
// returns them) through SceneModel on the host and prints what the renderer would draw.
//   replay <packets.json> [--static-after seconds] [--fps n]
// Exit code 0 when every packet applies and the stream commits at least once.
#include "scene_model.h"

#include <chrono>
#include <cstdio>
#include <fstream>
#include <map>
#include <sstream>

using namespace office::scene;

int main(int argc, char **argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: replay <packets.json> [--static-after s] [--fps n]\n");
        return 2;
    }
    ModelOptions options;
    options.multiview = true;
    double fps = 30;
    for (int i = 2; i + 1 < argc; i += 2) {
        std::string a = argv[i];
        if (a == "--static-after")
            options.staticAfterSeconds = float(std::atof(argv[i + 1]));
        else if (a == "--fps")
            fps = std::atof(argv[i + 1]);
    }
    std::ifstream in(argv[1], std::ios::binary);
    std::stringstream buf;
    buf << in.rdbuf();
    json packets = json::parse(buf.str());
    if (!packets.is_array()) {
        std::fprintf(stderr, "not an array\n");
        return 2;
    }
    SceneModel model(options);
    std::shared_ptr<const RenderState> state;
    size_t uploads = 0, uploadBytes = 0, commits = 0, failures = 0;
    double applyMs = 0, worstMs = 0, now = 0;
    for (const auto &p : packets) {
        auto t0 = std::chrono::steady_clock::now();
        try {
            ApplyResult r = model.apply(p, now);
            for (const auto &op : r.textures)
                if (op.kind == TextureOp::Upload) {
                    uploads++;
                    uploadBytes += op.bytes();
                }
            if (r.state)
                state = r.state;
            if (r.committed)
                commits++;
        } catch (const std::exception &e) {
            failures++;
            std::fprintf(stderr, "seq %llu: %s\n", (unsigned long long)p.value("seq", 0ull),
                         e.what());
        }
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0)
                        .count();
        applyMs += ms;
        worstMs = std::max(worstMs, ms);
        now += 1.0 / fps;
    }
    // Let everything that holds still merge, as it would a few seconds after loading.
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < 8; i++) {
        now += options.staticAfterSeconds;
        ApplyResult r = model.tick(now);
        if (r.state)
            state = r.state;
    }
    double batchMs =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    if (!state) {
        std::fprintf(stderr, "no state was published\n");
        return 1;
    }
    std::map<int, int> byModel;
    size_t opaque = 0, transparent = 0, tris = 0, instanced = 0, casters = 0;
    for (const auto &it : state->items) {
        byModel[int(it.material->model)]++;
        (it.material->transparent ? transparent : opaque)++;
        if (it.instances)
            instanced++;
        if (it.castShadow)
            casters++;
        if (it.mode == DrawMode::Triangles)
            tris += size_t(it.count / 3) * (it.instances ? it.instances->count : 1);
    }
    std::printf("packets %zu, failures %zu, commits %zu, apply %.1f ms total (worst %.1f ms), "
                "batching %.1f ms\n",
                packets.size(), failures, commits, applyMs, worstMs, batchMs);
    std::printf("objects %u (visible %u), batched %u into %u batches, dynamic %u\n", state->objects,
                state->visibleObjects, state->batchedObjects, state->staticBatches,
                state->dynamicObjects);
    std::printf(
        "draw items %zu (opaque %zu, transparent %zu, instanced %zu, casters %zu), triangles %zu\n",
        state->items.size(), opaque, transparent, instanced, casters, tris);
    std::printf("geometries %u, materials %u, textures %u (%zu uploads, %.1f MB), unsupported %u\n",
                state->geometries, state->materialCount, state->textureCount, uploads,
                uploadBytes / 1048576.0, state->unsupported);
    std::printf("items by shade model:");
    const char *names[] = {"basic", "toon",   "lambert", "phong",   "standard", "points",
                           "line",  "sprite", "beam",    "skyDome", "depth"};
    for (auto [m, n] : byModel)
        std::printf(" %s=%d", names[m], n);
    std::printf("\nfog %d, sky %s, shadow %d (map %d), background %d\n",
                int(state->frame.fogColor.w), state->sky.haze.y > 0 ? "on" : "off", state->shadow,
                state->shadowMapSize, state->hasBackground);
    return failures || !commits ? 1 : 0;
}
