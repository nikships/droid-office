#pragma once
#include "hand_mesh.h"
#include "xr_input.h"
#include <GLES3/gl3.h>

namespace office {
class HandRenderer {
  public:
    ~HandRenderer();
    void initialize(bool multiview, bool srgbFramebuffer, const std::array<HandMesh, 2> &meshes);
    void update(const InputFrame &frame);
    void render(const Matrix &left, const Matrix &right);
    bool visible(int hand) const { return hands[hand].visible; }

  private:
    struct GpuHand {
        GLuint vao = 0, vbo = 0, ebo = 0;
        GLsizei count = 0;
        bool visible = false;
        HandMesh mesh;
        std::array<Matrix, XR_HAND_JOINT_COUNT_EXT> bones{};
    };
    std::array<GpuHand, 2> hands;
    GLuint program = 0;
    GLint pvLocation = -1, bonesLocation = -1, colorLocation = -1;
    bool stereo = false;
};
} // namespace office
