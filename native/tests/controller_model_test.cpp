#include "controller_model.h"
#include <cassert>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <limits>
#include <nlohmann/json.hpp>
using namespace office;
std::string read(const std::string &file) {
    std::ifstream stream(file, std::ios::binary);
    assert(stream);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
int main() {
    const std::string root = "native/android/app/src/main/assets/controllers/samsung-galaxyxr/";
    for (const auto side : {"left", "right"}) {
        auto metadata = read(root + side + ".json"), binary = read(root + side + ".bin");
        auto parse = [&](const std::string &json, size_t bytes) {
            return parseControllerModel(json, reinterpret_cast<const uint8_t *>(binary.data()),
                                        bytes);
        };
        auto m = parse(metadata, binary.size());
        assert(m.vertices.size() / 8 > 3000 && m.draws.size() == 8);
        assert(m.indices.size() / 3 == 3712 && m.images.size() == 4 && !m.responses.empty());
        std::array<Matrix, 128> neutral{}, pressed{};
        controllerTransforms(m, {}, neutral.data(), neutral.size());
        controllerTransforms(m, {1, 1, 1, 0, true, true, true, true}, pressed.data(),
                             pressed.size());
        bool changed = false;
        for (size_t j = 0; j < m.nodes.size(); j++)
            for (int k = 0; k < 16; k++) {
                assert(std::isfinite(neutral[j][k]) && std::isfinite(pressed[j][k]));
                changed |= std::abs(neutral[j][k] - pressed[j][k]) > 1e-6f;
            }
        assert(changed);
        auto rejects = [&](const std::string &json, size_t bytes) {
            try {
                parse(json, bytes);
                return false;
            } catch (const std::exception &) {
                return true;
            }
        };
        assert(rejects(metadata, binary.size() - 1));
        assert(rejects("{}", binary.size()));
        auto bad = nlohmann::json::parse(metadata);
        bad["images"][0] = "../escape.png";
        assert(rejects(bad.dump(), binary.size()));
        assert(rejects(std::string(262145, ' '), binary.size()));
    }
    ControllerPose a, b;
    b.position = {1, 0, 0};
    b.rotation = yaw(1);
    auto p = interpolateControllerPose(a, b, .5f);
    assert(std::abs(p.position.x - .5f) < 1e-6f);
    auto q = rotate(p.rotation, {0, 0, -1});
    assert(std::abs(q.x + std::sin(.5f)) < 1e-5f);
    std::puts("Pinned Galaxy XR meshes, bounds and controller animation tests passed");
}
