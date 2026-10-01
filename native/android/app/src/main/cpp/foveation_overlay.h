#pragma once
#include <GLES3/gl3.h>
#include <string>

namespace office {
/**
 * Diagnostic view of the runtime's actual foveation: a full-screen pass over the bound world
 * framebuffer, coloured by the measured shading density (foveation_overlay_shader.h). GL thread
 * only.
 */
class FoveationOverlay {
  public:
    ~FoveationOverlay();
    bool initialize(bool multiview, std::string &error);
    /**
     * centers holds the runtime's NDC foveation centres (left x, y, right x, y) for this frame;
     * centerValid is false in fixed mode or when the runtime reports no valid centre.
     * firstView selects the eye for a non-multiview pass.
     */
    void render(int firstView, int width, int height, const float centers[4], bool centerValid);

  private:
    GLuint program = 0, vao = 0;
    GLint eyeUniform = -1, sizeUniform = -1, centersUniform = -1, validUniform = -1;
};
} // namespace office
