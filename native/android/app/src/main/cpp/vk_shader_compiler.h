// GLSL (the generator's Vulkan dialect) to SPIR-V at runtime with libshaderc, the runtime library
// Android's "Vulkan shader compilers on Android" describes ("Runtime compilation"; the NDK's
// shaderc, built with ndk-build as its "Gradle's CMake integration" section says). One compiler
// per thread: the Vulkan scene renderer's pipeline workers each own one.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace office::vkscene {

class ShaderCompiler {
  public:
    ShaderCompiler();
    ~ShaderCompiler();
    ShaderCompiler(const ShaderCompiler &) = delete;
    ShaderCompiler &operator=(const ShaderCompiler &) = delete;

    /**
     * Compiles one stage for Vulkan 1.1 (SPIR-V 1.3). `name` labels errors. False with `error` set
     * when the source does not compile; warnings fail too, as `glslc -Werror` does in the host
     * shader suite.
     */
    bool compile(const std::string &source, bool vertex, const std::string &name,
                 std::vector<uint32_t> &spirv, std::string &error);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace office::vkscene
