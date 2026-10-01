#pragma once
#include "foveation_filter_shader.h"
#include <GLES3/gl3.h>
#include <string>

namespace office {
/**
 * Filtered reconstruction of runtime scaled-bin foveation (foveation_filter_shader.h). GL thread
 * only. markDensity runs last in the foveated world framebuffer; resolve draws the submitted
 * image from that world image into the currently bound, unfoveated framebuffer.
 */
class FoveationFilter {
  public:
    ~FoveationFilter();
    bool initialize(bool multiview, std::string &error);
    /** Writes each invocation's neighbour steps into the bound world framebuffer's alpha. */
    void markDensity();
    /** Draws the filtered image from source (a world image: a 2D array in multiview). */
    void resolve(GLuint source);

  private:
    bool multiview = false;
    GLuint density = 0, filter = 0, vao = 0, sampler = 0;
};
} // namespace office
