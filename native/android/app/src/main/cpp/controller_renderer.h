#pragma once
#include "controller_model.h"
#include "xr_input.h"
#include <GLES3/gl3.h>
#include <android/asset_manager.h>
#include <map>

namespace office {
/** Samsung's pinned model data uploads once. Grip poses and button transforms stay native. */
class ControllerRenderer {
  public:
    ~ControllerRenderer();
    void initialize(bool multiview, bool srgbFramebuffer, AAssetManager *assets);
    void update(const InputFrame &frame);
    void render(const Matrix &left, const Matrix &right);

  private:
    struct Model {
        ControllerModel data;
        GLuint vertices = 0, indices = 0;
        std::vector<GLuint> arrays, textures;
        std::array<Matrix, 128> nodes;
        Matrix grip{};
        bool active = false;
    };
    std::array<Model, 2> models;
    std::map<std::string, GLuint> textures;
    GLuint program = 0;
    bool stereo = false;
    XrVector3f head{};
    GLint viewLocation = -1, modelLocation = -1, headLocation = -1, colorLocation = -1,
          emissiveLocation = -1, metalLocation = -1, roughLocation = -1, mapsLocation = -1;
};
} // namespace office
