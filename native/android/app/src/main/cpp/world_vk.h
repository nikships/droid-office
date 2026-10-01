#pragma once
#include "world_renderer.h"
#include <memory>
namespace office {
std::unique_ptr<WorldRenderer> makeVulkanWorld(const WorldHost &host);
}
