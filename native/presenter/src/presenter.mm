#import <AppKit/AppKit.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <QuartzCore/CAMetalDisplayLink.h>
#include <napi.h>
#import "input_view.h"

static NSString *const kShader = @R"(
#include <metal_stdlib>
using namespace metal;
struct V { float4 pos [[position]]; float2 uv; };
vertex V vs(uint vid [[vertex_id]]) {
  float2 p = float2((vid << 1) & 2, vid & 2);
  V o; o.pos = float4(p * 2.0 - 1.0, 0, 1); o.uv = float2(p.x, 1.0 - p.y); return o;
}
fragment half4 fs(V in [[stage_in]], texture2d<half> t [[texture(0)]]) {
  constexpr sampler s(filter::linear, address::clamp_to_edge);
  return t.sample(s, in.uv);
}
)";

static id<MTLDevice> gDevice;
static id<MTLCommandQueue> gQueue;
static CAMetalLayer *gLayer;
static NSView *gView;
static id<MTLRenderPipelineState> gPipe[2];

static Napi::Value Attach(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  NSView *host = (__bridge NSView *)(*reinterpret_cast<void **>(buf.Data()));
  gDevice = MTLCreateSystemDefaultDevice();
  gQueue = [gDevice newCommandQueue];
  gView = [[NSView alloc] initWithFrame:host.bounds];
  gView.wantsLayer = YES;
  gLayer = [CAMetalLayer layer];
  gLayer.device = gDevice;
  gLayer.pixelFormat = MTLPixelFormatBGRA8Unorm;
  gLayer.framebufferOnly = NO;
  gLayer.displaySyncEnabled = YES;
  gLayer.contentsScale = host.window.backingScaleFactor;
  gLayer.frame = host.bounds;
  gLayer.drawableSize = CGSizeMake(host.bounds.size.width * gLayer.contentsScale, host.bounds.size.height * gLayer.contentsScale);
  gView.layer = gLayer;
  gView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [host addSubview:gView];
  NSError *err = nil;
  id<MTLLibrary> lib = [gDevice newLibraryWithSource:kShader options:nil error:&err];
  if (!lib) { Napi::Error::New(env, err.localizedDescription.UTF8String).ThrowAsJavaScriptException(); return env.Undefined(); }
  MTLPixelFormat fmts[2] = {MTLPixelFormatBGRA8Unorm, MTLPixelFormatRGBA16Float};
  for (int i = 0; i < 2; i++) {
    MTLRenderPipelineDescriptor *d = [MTLRenderPipelineDescriptor new];
    d.vertexFunction = [lib newFunctionWithName:@"vs"];
    d.fragmentFunction = [lib newFunctionWithName:@"fs"];
    d.colorAttachments[0].pixelFormat = fmts[i];
    gPipe[i] = [gDevice newRenderPipelineStateWithDescriptor:d error:&err];
  }
  return env.Undefined();
}

static Napi::Value Present(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  IOSurfaceRef surf = *reinterpret_cast<IOSurfaceRef *>(buf.Data());
  uint32_t pf = IOSurfaceGetPixelFormat(surf);
  MTLPixelFormat mf = pf == 0x52476841u ? MTLPixelFormatRGBA16Float : MTLPixelFormatBGRA8Unorm;
  MTLTextureDescriptor *td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:mf width:IOSurfaceGetWidth(surf) height:IOSurfaceGetHeight(surf) mipmapped:NO];
  td.usage = MTLTextureUsageShaderRead;
  td.storageMode = MTLStorageModeShared;
  id<MTLTexture> tex = [gDevice newTextureWithDescriptor:td iosurface:surf plane:0];
  if (!tex) { Napi::Error::New(env, "texture import failed").ThrowAsJavaScriptException(); return env.Undefined(); }
  MTLPixelFormat want = mf;
  if (gLayer.pixelFormat != want) {
    gLayer.pixelFormat = want;
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(want == MTLPixelFormatRGBA16Float ? kCGColorSpaceExtendedLinearSRGB : kCGColorSpaceSRGB);
    gLayer.colorspace = cs;
    CGColorSpaceRelease(cs);
    gLayer.wantsExtendedDynamicRangeContent = want == MTLPixelFormatRGBA16Float;
  }
  id<CAMetalDrawable> dr = [gLayer nextDrawable];
  MTLRenderPassDescriptor *rp = [MTLRenderPassDescriptor renderPassDescriptor];
  rp.colorAttachments[0].texture = dr.texture;
  int pi = want == MTLPixelFormatRGBA16Float ? 1 : 0;
  rp.colorAttachments[0].loadAction = MTLLoadActionDontCare;
  rp.colorAttachments[0].storeAction = MTLStoreActionStore;
  id<MTLCommandBuffer> cb = [gQueue commandBuffer];
  id<MTLRenderCommandEncoder> enc = [cb renderCommandEncoderWithDescriptor:rp];
  [enc setRenderPipelineState:gPipe[pi]];
  [enc setFragmentTexture:tex atIndex:0];
  [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
  [enc endEncoding];
  [cb presentDrawable:dr];
  static dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  if (info.Length() > 1 && info[1].IsBuffer()) {
    auto out = info[1].As<Napi::Buffer<uint8_t>>();
    uint8_t *dst = out.Data(); size_t cap = out.Length();
    id<MTLTexture> dt = dr.texture;
    [cb addCompletedHandler:^(id<MTLCommandBuffer>) {
      size_t w = dt.width, h = dt.height;
      size_t bpp = dt.pixelFormat == MTLPixelFormatRGBA16Float ? 8 : 4;
      if (w * h * bpp <= cap) [dt getBytes:dst bytesPerRow:w * bpp fromRegion:MTLRegionMake2D(0, 0, w, h) mipmapLevel:0];
      dispatch_semaphore_signal(sem);
    }];
    [cb commit];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
  } else {
    [cb commit];
  }
  Napi::Object r = Napi::Object::New(env);
  r.Set("pixelFormat", Napi::String::New(env, std::string((char *)&pf, 4)));
  r.Set("dw", (double)dr.texture.width);
  r.Set("w", (double)IOSurfaceGetWidth(surf));
  r.Set("h", (double)IOSurfaceGetHeight(surf));
  return r;
}

static Napi::Value Readback(const Napi::CallbackInfo &info) {
  IOSurfaceRef surf = *reinterpret_cast<IOSurfaceRef *>(info[0].As<Napi::Buffer<uint8_t>>().Data());
  auto out = info[1].As<Napi::Buffer<uint8_t>>();
  IOSurfaceLock(surf, kIOSurfaceLockReadOnly, nullptr);
  size_t bpr = IOSurfaceGetBytesPerRow(surf), h = IOSurfaceGetHeight(surf);
  const uint8_t *base = (const uint8_t *)IOSurfaceGetBaseAddress(surf);
  size_t row = IOSurfaceGetWidth(surf) * IOSurfaceGetBytesPerElement(surf);
  for (size_t y = 0; y < h; y++) memcpy(out.Data() + y * row, base + y * bpr, row);
  IOSurfaceUnlock(surf, kIOSurfaceLockReadOnly, nullptr);
  return Napi::Number::New(info.Env(), (double)IOSurfaceGetBytesPerElement(surf));
}

static Napi::Value Probe(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object r = Napi::Object::New(env);
  id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
  if (!dev) { Napi::Error::New(env, "no Metal device").ThrowAsJavaScriptException(); return env.Undefined(); }
  NSError *err = nil;
  id<MTLLibrary> lib = [dev newLibraryWithSource:kShader options:nil error:&err];
  if (!lib) { Napi::Error::New(env, std::string("shader compile failed: ") + err.localizedDescription.UTF8String).ThrowAsJavaScriptException(); return env.Undefined(); }
  NSDictionary *props = @{(id)kIOSurfaceWidth: @16, (id)kIOSurfaceHeight: @16, (id)kIOSurfaceBytesPerElement: @8, (id)kIOSurfacePixelFormat: @(0x52476841u)};
  IOSurfaceRef surf = IOSurfaceCreate((__bridge CFDictionaryRef)props);
  bool imported = false;
  if (surf) {
    MTLTextureDescriptor *td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float width:16 height:16 mipmapped:NO];
    td.usage = MTLTextureUsageShaderRead;
    imported = [dev newTextureWithDescriptor:td iosurface:surf plane:0] != nil;
    CFRelease(surf);
  }
  CAMetalLayer *layer = [CAMetalLayer layer];
  layer.device = dev;
  layer.displaySyncEnabled = YES;
  r.Set("device", Napi::String::New(env, dev.name.UTF8String));
  r.Set("unifiedMemory", Napi::Boolean::New(env, dev.hasUnifiedMemory));
  r.Set("ioSurfaceImport", Napi::Boolean::New(env, imported));
  bool displayLink = false;
  if (@available(macOS 14.0, *)) displayLink = true;
  r.Set("displayLink", Napi::Boolean::New(env, displayLink));
  r.Set("layer", Napi::Boolean::New(env, layer.device != nil));
  if (!imported) { Napi::Error::New(env, "IOSurface texture import failed").ThrowAsJavaScriptException(); return env.Undefined(); }
  return r;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("probe", Napi::Function::New(env, Probe));
  exports.Set("readback", Napi::Function::New(env, Readback));
  exports.Set("present", Napi::Function::New(env, Present));
  DOInputRegisterExports(env, exports);
  return exports;
}
NODE_API_MODULE(presenter, Init)
