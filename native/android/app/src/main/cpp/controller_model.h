#pragma once
#include "xr_math.h"
#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace office {
struct ControllerPose {
    XrVector3f position{0, 0, 0}, scale{1, 1, 1};
    XrQuaternionf rotation{0, 0, 0, 1};
};
struct ControllerNode {
    ControllerPose pose;
    int parent = -1;
};
struct ControllerDraw {
    uint32_t node = 0, material = 0, firstVertex = 0, vertexCount = 0, firstIndex = 0,
             indexCount = 0;
};
struct ControllerMaterial {
    int base = -1, normal = -1, metallicRoughness = -1, emissive = -1;
    std::array<float, 4> color{1, 1, 1, 1};
    XrVector3f emissiveFactor{0, 0, 0};
    float metallic = 1, roughness = 1;
    bool transparent = false, doubleSided = false;
};
enum class ControllerChannel { Trigger, Squeeze, StickClick, Primary, Secondary, Menu, X, Y };
struct ControllerResponse {
    uint32_t node = 0;
    ControllerChannel channel = ControllerChannel::Trigger;
    ControllerPose min, max;
};
struct ControllerButtons {
    float trigger = 0, squeeze = 0, x = 0, y = 0;
    bool stickClick = false, primary = false, secondary = false, menu = false;
};
struct ControllerModel {
    std::vector<ControllerNode> nodes;
    std::vector<ControllerDraw> draws;
    std::vector<ControllerMaterial> materials;
    std::vector<ControllerResponse> responses;
    std::vector<std::string> images;
    std::vector<float> vertices; // position3, normal3, UV2
    std::vector<uint16_t> indices;
};

/** Startup-only parser for bundled, pinned data. Throws on malformed or oversized assets. */
ControllerModel parseControllerModel(std::string_view metadata, const uint8_t *geometry,
                                     size_t bytes);
ControllerPose interpolateControllerPose(const ControllerPose &a, const ControllerPose &b,
                                         float amount);
/** Bounded, allocation-free hierarchy update. Matrices are local grip-space transforms. */
void controllerTransforms(const ControllerModel &model, ControllerButtons buttons, Matrix *matrices,
                          size_t capacity);
} // namespace office
