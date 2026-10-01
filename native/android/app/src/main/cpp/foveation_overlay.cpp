#include "foveation_overlay.h"

namespace office {
namespace {
GLuint compile(GLenum type, const std::string &code, std::string &error) {
    GLuint shader = glCreateShader(type);
    const char *source = code.c_str();
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    GLint good = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &good);
    if (!good) {
        char log[2048]{};
        glGetShaderInfoLog(shader, sizeof(log), nullptr, log);
        error = std::string("Foveation overlay shader: ") + log;
        glDeleteShader(shader);
        return 0;
    }
    return shader;
}
} // namespace

FoveationOverlay::~FoveationOverlay() {
    if (program)
        glDeleteProgram(program);
    if (vao)
        glDeleteVertexArrays(1, &vao);
}

bool FoveationOverlay::initialize(bool multiview, std::string &error) {
    const auto source = foveationOverlayShader(multiview);
    GLuint vertex = compile(GL_VERTEX_SHADER, source.vertex, error);
    if (!vertex)
        return false;
    GLuint fragment = compile(GL_FRAGMENT_SHADER, source.fragment, error);
    if (!fragment) {
        glDeleteShader(vertex);
        return false;
    }
    program = glCreateProgram();
    glAttachShader(program, vertex);
    glAttachShader(program, fragment);
    glLinkProgram(program);
    glDeleteShader(vertex);
    glDeleteShader(fragment);
    GLint good = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &good);
    if (!good) {
        char log[2048]{};
        glGetProgramInfoLog(program, sizeof(log), nullptr, log);
        error = std::string("Foveation overlay program: ") + log;
        glDeleteProgram(program);
        program = 0;
        return false;
    }
    eyeUniform = glGetUniformLocation(program, "eye");
    sizeUniform = glGetUniformLocation(program, "size");
    centersUniform = glGetUniformLocation(program, "centers");
    markerUniform = glGetUniformLocation(program, "marker");
    glGenVertexArrays(1, &vao);
    return true;
}

void FoveationOverlay::render(int firstView, int width, int height, const float centers[4],
                              FoveaMarker marker) {
    if (!program)
        return;
    glBindVertexArray(vao);
    glDisable(GL_DEPTH_TEST);
    glDepthMask(GL_FALSE);
    glDisable(GL_CULL_FACE);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glUseProgram(program);
    if (eyeUniform >= 0)
        glUniform1i(eyeUniform, firstView);
    glUniform2f(sizeUniform, static_cast<float>(width), static_cast<float>(height));
    glUniform4fv(centersUniform, 1, centers);
    glUniform1i(markerUniform, static_cast<int>(marker));
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glUseProgram(0);
    glBindVertexArray(0);
    glDisable(GL_BLEND);
    glDepthMask(GL_TRUE);
    glEnable(GL_DEPTH_TEST);
}
} // namespace office
