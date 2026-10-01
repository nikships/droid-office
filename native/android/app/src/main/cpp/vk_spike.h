#pragma once
// Debug-only Vulkan eye-tracked foveation spike (vulkan-port.md milestone M1). Built only with
// OFFICE_VULKAN_SPIKE (debug builds) and started by OfficeActivity with
// `--es xr_renderer vulkan-spike`. It renders a test room, never the office.
#include <atomic>
#include <functional>
#include <jni.h>
#include <string>

namespace office::spike {
/** What the spike borrows from office_xr.cpp's JNI host. */
struct Host {
    JavaVM *vm = nullptr;
    JNIEnv *env = nullptr;
    jobject activity = nullptr;
    std::string options;
    std::atomic<bool> *stopping = nullptr;
    std::atomic<bool> *focused = nullptr;
    std::atomic<bool> *statusProducerVisible = nullptr;
    std::atomic<float> *observedRefreshRate = nullptr;
    std::function<void(const std::string &)> publishMetrics;
};
/** Runs the spike's OpenXR session on the calling thread until it stops or ends; throws on
 *  failure (the caller reports it through onNativeEnded, as for the GLES office). */
void run(const Host &host);
} // namespace office::spike
