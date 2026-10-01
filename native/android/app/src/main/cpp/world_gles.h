// The GLES world renderer, the office's shipping path (world_gles.cpp). See world_renderer.h.
#pragma once
#include "world_renderer.h"

#include <memory>

namespace office {

/** Created before the instance; nothing touches EGL or GL until createDevice. */
std::unique_ptr<WorldRenderer> makeGlesWorld(const WorldHost &host);

} // namespace office
