#include "foveation_filter.h"

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
        error = std::string("Foveation filter shader: ") + log;
        glDeleteShader(shader);
        return 0;
    }
    return shader;
}

GLuint link(const std::string &vertexCode, const std::string &fragmentCode, std::string &error) {
    GLuint vertex = compile(GL_VERTEX_SHADER, vertexCode, error);
    if (!vertex)
        return 0;
    GLuint fragment = compile(GL_FRAGMENT_SHADER, fragmentCode, error);
    if (!fragment) {
        glDeleteShader(vertex);
        return 0;
    }
    GLuint program = glCreateProgram();
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
        error = std::string("Foveation filter program: ") + log;
        glDeleteProgram(program);
        return 0;
    }
    return program;
}

/** State both passes rely on; the scene renderer re-establishes its own on every draw. */
void fullScreenState() {
    glDisable(GL_DEPTH_TEST);
    glDepthMask(GL_FALSE);
    glDisable(GL_CULL_FACE);
    glDisable(GL_BLEND);
    glDisable(GL_STENCIL_TEST);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_POLYGON_OFFSET_FILL);
    glDisable(GL_SAMPLE_ALPHA_TO_COVERAGE);
    glDisable(GL_SAMPLE_COVERAGE);
}

void restoreState() {
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glDepthMask(GL_TRUE);
    glEnable(GL_DEPTH_TEST);
    glUseProgram(0);
    glBindVertexArray(0);
}
} // namespace

FoveationFilter::~FoveationFilter() {
    if (density)
        glDeleteProgram(density);
    if (filter)
        glDeleteProgram(filter);
    if (vao)
        glDeleteVertexArrays(1, &vao);
    if (sampler)
        glDeleteSamplers(1, &sampler);
}

bool FoveationFilter::initialize(bool useMultiview, std::string &error) {
    multiview = useMultiview;
    const auto source = foveationFilterShaders(multiview);
    density = link(source.vertex, source.densityFragment, error);
    if (!density)
        return false;
    filter = link(source.vertex, source.resolveFragment, error);
    if (!filter)
        return false;
    glUseProgram(filter);
    glUniform1i(glGetUniformLocation(filter, "source"), 0);
    glUseProgram(0);
    glGenVertexArrays(1, &vao);
    // Linear taps between texels; texelFetch ignores the sampler. Edge taps clamp, so the image
    // border is not mixed with the opposite side.
    glGenSamplers(1, &sampler);
    glSamplerParameteri(sampler, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glSamplerParameteri(sampler, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glSamplerParameteri(sampler, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glSamplerParameteri(sampler, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    const auto glError = glGetError();
    if (glError != GL_NO_ERROR) {
        error = "Foveation filter GL error " + std::to_string(glError);
        return false;
    }
    return true;
}

void FoveationFilter::markDensity() {
    glBindVertexArray(vao);
    fullScreenState();
    glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_TRUE);
    glUseProgram(density);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    restoreState();
}

void FoveationFilter::resolve(GLuint source) {
    const GLenum target = multiview ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D;
    glBindVertexArray(vao);
    fullScreenState();
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(target, source);
    glBindSampler(0, sampler);
    glUseProgram(filter);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glBindSampler(0, 0);
    glBindTexture(target, 0);
    restoreState();
}
} // namespace office
