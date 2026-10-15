// The native Metal presenter: shows the offscreen page's shared texture (an IOSurface) in a
// CAMetalLayer view with no CPU copy.
//
// Threads: JS (the Electron main thread) calls submit() and the setters; a dedicated run-loop
// thread receives CAMetalDisplayLink ticks and presents; Metal's completion threads hand each
// texture back to JS (threadsafe function) once the GPU has finished reading it.
#import <AppKit/AppKit.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalDisplayLink.h>
#import <QuartzCore/CAMetalLayer.h>
#include <napi.h>

#include <algorithm>
#include <atomic>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

#import "input_view.h"

static NSString *const kShader = @R"(
#include <metal_stdlib>
using namespace metal;
struct V { float4 pos [[position]]; float2 uv; };
vertex V vs(uint vid [[vertex_id]]) {
  float2 p = float2((vid << 1) & 2, vid & 2);
  V o; o.pos = float4(p * 2.0 - 1.0, 0, 1); o.uv = float2(p.x, 1.0 - p.y); return o;
}
fragment float4 fs(V in [[stage_in]], texture2d<float> t [[texture(0)]]) {
  constexpr sampler s(filter::linear, address::clamp_to_edge);
  return t.sample(s, in.uv);
}
)";

static const uint32_t kPixelFormatBGRA = 'BGRA';
static const uint32_t kPixelFormatRGBAHalf = 0x52476841u;  // kCVPixelFormatType_64RGBAHalf, 'RGhA'
static const size_t kRingCapacity = 8192;
static const size_t kSampleStride = 6;
static const size_t kTextureCacheLimit = 24;
// Without a new frame for this long the display link pauses; the next submit() resumes it.
static const double kIdlePauseSeconds = 0.25;

namespace {

struct Frame {
  uint32_t id = 0;
  uint32_t frameCount = 0;
  IOSurfaceRef surface = nullptr;
  double submittedAt = 0;
};

// One presented frame. Times are CACurrentMediaTime seconds, the clock of drawable.presentedTime.
struct Sample {
  double id, submittedAt, tickAt, target, presentedAt, gpuMs;
};

struct Counters {
  uint64_t submitted = 0, dropped = 0, presented = 0, notShown = 0, ticks = 0, ticksWithFrame = 0, importFailures = 0, released = 0;
  uint32_t inFlight = 0, maxInFlight = 0;
};

struct Callbacks {
  Napi::ThreadSafeFunction release, state, event;
  bool hasState = false, hasEvent = false;
};

Napi::Value toJS(Napi::Env env, id obj) {
  if ([obj isKindOfClass:NSNumber.class]) {
    NSNumber *n = obj;
    if (CFGetTypeID((__bridge CFTypeRef)n) == CFBooleanGetTypeID()) return Napi::Boolean::New(env, n.boolValue);
    return Napi::Number::New(env, n.doubleValue);
  }
  if ([obj isKindOfClass:NSString.class]) return Napi::String::New(env, [(NSString *)obj UTF8String]);
  if ([obj isKindOfClass:NSArray.class]) {
    NSArray *a = obj;
    Napi::Array out = Napi::Array::New(env, a.count);
    for (NSUInteger i = 0; i < a.count; i++) out.Set((uint32_t)i, toJS(env, a[i]));
    return out;
  }
  if ([obj isKindOfClass:NSDictionary.class]) {
    Napi::Object out = Napi::Object::New(env);
    [(NSDictionary *)obj enumerateKeysAndObjectsUsingBlock:^(id key, id val, BOOL *) {
      out.Set([[key description] UTF8String], toJS(env, val));
    }];
    return out;
  }
  return env.Null();
}

}  // namespace

class Core;

@interface DOLinkDelegate : NSObject <CAMetalDisplayLinkDelegate> {
 @public
  std::shared_ptr<Core> core;
}
@end

class Core : public std::enable_shared_from_this<Core> {
 public:
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  id<MTLRenderPipelineState> pipeline;
  DOPresenterView *view;
  CAMetalLayer *layer;
  MTLPixelFormat layerFormat;

  std::mutex lock;  // mailbox, counters, ring, texture cache
  Frame mailbox;
  Counters counters;
  std::vector<Sample> ring;
  size_t ringNext = 0;
  std::unordered_map<uint32_t, id<MTLTexture>> textures;

  std::mutex cbLock;
  Callbacks callbacks;
  bool callbacksOpen = true;

  std::atomic<bool> linkPaused{false}, closed{false};
  std::atomic<bool> captureArmed{false};
  std::mutex captureLock;
  Napi::ThreadSafeFunction captureFn;
  bool hasCapture = false;

  NSThread *thread;
  CFRunLoopRef runLoop = nullptr;
  CAMetalDisplayLink *link API_AVAILABLE(macos(14.0));
  DOLinkDelegate *delegate;
  double lastFrameAt = 0;
  id observers[3] = {nil, nil, nil};

  void notifyRelease(uint32_t id) {
    std::lock_guard<std::mutex> g(cbLock);
    if (!callbacksOpen) return;
    callbacks.release.NonBlockingCall(new uint32_t(id), [](Napi::Env env, Napi::Function fn, uint32_t *p) {
      fn.Call({Napi::Number::New(env, *p)});
      delete p;
    });
    std::lock_guard<std::mutex> s(lock);
    counters.released++;
  }

  void emit(Napi::ThreadSafeFunction &fn, bool enabled, NSDictionary *dict) {
    std::lock_guard<std::mutex> g(cbLock);
    if (!callbacksOpen || !enabled) return;
    fn.NonBlockingCall((void *)CFBridgingRetain(dict), [](Napi::Env env, Napi::Function f, void *p) {
      NSDictionary *d = (NSDictionary *)CFBridgingRelease(p);
      f.Call({toJS(env, d)});
    });
  }

  void emitState(NSDictionary *d) { emit(callbacks.state, callbacks.hasState, d); }
  void emitEvent(NSDictionary *d) { emit(callbacks.event, callbacks.hasEvent, d); }

  id<MTLTexture> textureFor(IOSurfaceRef surf) {
    uint32_t sid = IOSurfaceGetID(surf);
    {
      std::lock_guard<std::mutex> g(lock);
      auto it = textures.find(sid);
      if (it != textures.end() && it->second.width == IOSurfaceGetWidth(surf) && it->second.height == IOSurfaceGetHeight(surf)) return it->second;
    }
    uint32_t pf = IOSurfaceGetPixelFormat(surf);
    MTLPixelFormat mf = pf == kPixelFormatRGBAHalf ? MTLPixelFormatRGBA16Float : MTLPixelFormatBGRA8Unorm;
    if (mf != layerFormat || (pf != kPixelFormatRGBAHalf && pf != kPixelFormatBGRA)) return nil;
    MTLTextureDescriptor *td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:mf width:IOSurfaceGetWidth(surf) height:IOSurfaceGetHeight(surf) mipmapped:NO];
    td.usage = MTLTextureUsageShaderRead;
    td.storageMode = MTLStorageModeShared;
    id<MTLTexture> tex = [device newTextureWithDescriptor:td iosurface:surf plane:0];
    if (!tex) return nil;
    std::lock_guard<std::mutex> g(lock);
    if (textures.size() >= kTextureCacheLimit) textures.clear();
    textures[sid] = tex;
    return tex;
  }

  void record(const Sample &s) {
    std::lock_guard<std::mutex> g(lock);
    if (ring.size() < kRingCapacity) ring.push_back(s);
    else ring[ringNext] = s;
    ringNext = (ringNext + 1) % kRingCapacity;
  }

  // Called on the link thread for every display refresh.
  void tick(CAMetalDisplayLinkUpdate *update) API_AVAILABLE(macos(14.0)) {
    double now = CACurrentMediaTime();
    Frame f;
    {
      std::lock_guard<std::mutex> g(lock);
      counters.ticks++;
      f = mailbox;
      mailbox = Frame();
    }
    if (!f.surface) {
      if (lastFrameAt > 0 && now - lastFrameAt > kIdlePauseSeconds) pauseIfIdle();
      return;
    }
    lastFrameAt = now;
    {
      std::lock_guard<std::mutex> g(lock);
      counters.ticksWithFrame++;
    }
    id<MTLTexture> tex = textureFor(f.surface);
    id<CAMetalDrawable> drawable = update.drawable;
    if (!tex || !drawable) {
      {
        std::lock_guard<std::mutex> g(lock);
        counters.importFailures++;
      }
      CFRelease(f.surface);
      notifyRelease(f.id);
      return;
    }
    MTLRenderPassDescriptor *rp = [MTLRenderPassDescriptor renderPassDescriptor];
    rp.colorAttachments[0].texture = drawable.texture;
    rp.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    rp.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLCommandBuffer> cb = [queue commandBuffer];
    id<MTLRenderCommandEncoder> enc = [cb renderCommandEncoderWithDescriptor:rp];
    [enc setRenderPipelineState:pipeline];
    [enc setFragmentTexture:tex atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [enc endEncoding];
    [cb presentDrawable:drawable];

    bool capture = captureArmed.exchange(false) && !drawable.texture.framebufferOnly;
    id<MTLTexture> drawableTexture = drawable.texture;
    auto self = shared_from_this();
    double target = update.targetPresentationTimestamp;
    Sample sample{(double)f.id, f.submittedAt, now, target, 0, 0};
    auto presentedAt = std::make_shared<std::atomic<double>>(0);
    [drawable addPresentedHandler:^(id<MTLDrawable> d) {
      presentedAt->store(d.presentedTime);
    }];
    {
      std::lock_guard<std::mutex> g(lock);
      counters.inFlight++;
      counters.maxInFlight = std::max(counters.maxInFlight, counters.inFlight);
    }
    IOSurfaceRef surface = f.surface;
    uint32_t fid = f.id;
    [cb addCompletedHandler:^(id<MTLCommandBuffer> done) {
      Sample s = sample;
      s.gpuMs = (done.GPUEndTime - done.GPUStartTime) * 1000.0;
      // presentedTime arrives after completion on some paths; poll the stamped value a moment later.
      s.presentedAt = presentedAt->load();
      if (capture) self->readback(drawableTexture);
      CFRelease(surface);
      {
        std::lock_guard<std::mutex> g(self->lock);
        self->counters.inFlight--;
        self->counters.presented++;
      }
      self->notifyRelease(fid);
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(50 * NSEC_PER_MSEC)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        Sample final = s;
        final.presentedAt = presentedAt->load();
        if (final.presentedAt <= 0) {
          std::lock_guard<std::mutex> g(self->lock);
          self->counters.notShown++;
          return;
        }
        self->record(final);
      });
    }];
    [cb commit];
  }

  void readback(id<MTLTexture> t) {
    size_t w = t.width, h = t.height;
    size_t bpp = t.pixelFormat == MTLPixelFormatRGBA16Float ? 8 : 4;
    std::vector<uint8_t> *bytes = new std::vector<uint8_t>(w * h * bpp);
    [t getBytes:bytes->data() bytesPerRow:w * bpp fromRegion:MTLRegionMake2D(0, 0, w, h) mipmapLevel:0];
    bool bgra = t.pixelFormat != MTLPixelFormatRGBA16Float;
    std::lock_guard<std::mutex> g(captureLock);
    if (!hasCapture) {
      delete bytes;
      return;
    }
    hasCapture = false;
    struct Payload {
      std::vector<uint8_t> *bytes;
      size_t w, h;
      bool bgra;
    };
    captureFn.NonBlockingCall(new Payload{bytes, w, h, bgra}, [](Napi::Env env, Napi::Function fn, Payload *p) {
      Napi::Object o = Napi::Object::New(env);
      o.Set("width", (double)p->w);
      o.Set("height", (double)p->h);
      o.Set("pixelFormat", p->bgra ? "bgra8" : "rgba16float");
      std::vector<uint8_t> *owned = p->bytes;
      o.Set("data", Napi::Buffer<uint8_t>::New(env, owned->data(), owned->size(), [](Napi::Env, uint8_t *, std::vector<uint8_t> *v) { delete v; }, owned));
      delete p;
      fn.Call({o});
    });
    captureFn.Release();
  }

  void pauseIfIdle() API_AVAILABLE(macos(14.0)) {
    linkPaused.store(true);
    {
      std::lock_guard<std::mutex> g(lock);
      if (mailbox.surface) {
        linkPaused.store(false);
        return;
      }
    }
    link.paused = YES;
  }

  void wake() {
    if (!linkPaused.exchange(false)) return;
    auto self = shared_from_this();
    CFRunLoopPerformBlock(runLoop, kCFRunLoopCommonModes, ^{
      if (@available(macOS 14.0, *)) {
        self->lastFrameAt = CACurrentMediaTime();
        self->link.paused = NO;
      }
    });
    CFRunLoopWakeUp(runLoop);
  }

  void onLinkThread(void (^block)(void)) {
    CFRunLoopPerformBlock(runLoop, kCFRunLoopCommonModes, block);
    CFRunLoopWakeUp(runLoop);
  }
};

@implementation DOLinkDelegate
- (void)metalDisplayLink:(CAMetalDisplayLink *)link needsUpdate:(CAMetalDisplayLinkUpdate *)update API_AVAILABLE(macos(14.0)) {
  core->tick(update);
}
@end

static NSDictionary *displayInfoFor(NSWindow *window) {
  NSScreen *screen = window.screen ?: NSScreen.mainScreen;
  return @{
    @"maxFps" : @((double)screen.maximumFramesPerSecond),
    @"edr" : @((double)screen.maximumExtendedDynamicRangeColorComponentValue),
    @"edrPotential" : @((double)screen.maximumPotentialExtendedDynamicRangeColorComponentValue),
    @"scale" : @((double)(window ? window.backingScaleFactor : screen.backingScaleFactor)),
    @"screen" : screen.localizedName ?: @"",
  };
}

class Presenter : public Napi::ObjectWrap<Presenter> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(env, "Presenter",
                       {InstanceMethod("submit", &Presenter::Submit), InstanceMethod("setPacing", &Presenter::SetPacing), InstanceMethod("setHdr", &Presenter::SetHdr),
                        InstanceMethod("setDisplaySync", &Presenter::SetDisplaySync), InstanceMethod("stats", &Presenter::Stats), InstanceMethod("displayInfo", &Presenter::DisplayInfo),
                        InstanceMethod("capture", &Presenter::Capture), InstanceMethod("focus", &Presenter::Focus), InstanceMethod("close", &Presenter::CloseJS)});
  }

  Presenter(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Presenter>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsObject()) {
      Napi::TypeError::New(env, "new Presenter(windowHandle: Buffer, options: object)").ThrowAsJavaScriptException();
      return;
    }
    Napi::Object opts = info[1].As<Napi::Object>();
    NSView *host = (__bridge NSView *)(*reinterpret_cast<void **>(info[0].As<Napi::Buffer<uint8_t>>().Data()));
    bool hdr = opts.Has("pixelFormat") && opts.Get("pixelFormat").ToString().Utf8Value() == "rgbaf16";
    double latency = opts.Has("frameLatency") ? opts.Get("frameLatency").ToNumber().DoubleValue() : 1.0;

    core = std::make_shared<Core>();
    core->device = MTLCreateSystemDefaultDevice();
    if (!core->device) {
      Napi::Error::New(env, "no Metal device").ThrowAsJavaScriptException();
      return;
    }
    core->queue = [core->device newCommandQueue];
    core->layerFormat = hdr ? MTLPixelFormatRGBA16Float : MTLPixelFormatBGRA8Unorm;
    NSError *err = nil;
    id<MTLLibrary> lib = [core->device newLibraryWithSource:kShader options:nil error:&err];
    if (!lib) {
      Napi::Error::New(env, std::string("shader compile failed: ") + err.localizedDescription.UTF8String).ThrowAsJavaScriptException();
      return;
    }
    MTLRenderPipelineDescriptor *pd = [MTLRenderPipelineDescriptor new];
    pd.vertexFunction = [lib newFunctionWithName:@"vs"];
    pd.fragmentFunction = [lib newFunctionWithName:@"fs"];
    pd.colorAttachments[0].pixelFormat = core->layerFormat;
    core->pipeline = [core->device newRenderPipelineStateWithDescriptor:pd error:&err];
    if (!core->pipeline) {
      Napi::Error::New(env, std::string("pipeline failed: ") + err.localizedDescription.UTF8String).ThrowAsJavaScriptException();
      return;
    }

    core->callbacks.release = Napi::ThreadSafeFunction::New(env, opts.Get("onRelease").As<Napi::Function>(), "presenter-release", 0, 1);
    if (opts.Has("onState") && opts.Get("onState").IsFunction()) {
      core->callbacks.state = Napi::ThreadSafeFunction::New(env, opts.Get("onState").As<Napi::Function>(), "presenter-state", 0, 1);
      core->callbacks.hasState = true;
    }
    if (opts.Has("onEvent") && opts.Get("onEvent").IsFunction()) {
      core->callbacks.event = Napi::ThreadSafeFunction::New(env, opts.Get("onEvent").As<Napi::Function>(), "presenter-event", 0, 1);
      core->callbacks.hasEvent = true;
    }
    core->ring.reserve(kRingCapacity);

    DOPresenterView *view = [[DOPresenterView alloc] initWithFrame:host.bounds];
    core->view = view;
    core->layer = view.metalLayer;
    CAMetalLayer *layer = core->layer;
    layer.device = core->device;
    layer.pixelFormat = core->layerFormat;
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(hdr ? kCGColorSpaceExtendedLinearSRGB : kCGColorSpaceSRGB);
    layer.colorspace = cs;
    CGColorSpaceRelease(cs);
    layer.wantsExtendedDynamicRangeContent = NO;
    layer.contentsGravity = kCAGravityResize;
    Core *raw = core.get();
    std::weak_ptr<Core> weak = core;
    view.eventSink = ^(NSDictionary *event) {
      if (auto c = weak.lock()) c->emitEvent(event);
    };
    [host addSubview:view positioned:NSWindowAbove relativeTo:nil];
    [view.window makeFirstResponder:view];

    NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
    NSWindow *window = view.window;
    NSNotificationName names[3] = {NSWindowDidChangeOcclusionStateNotification, NSWindowDidChangeScreenNotification, NSWindowDidChangeScreenProfileNotification};
    for (int i = 0; i < 3; i++) {
      core->observers[i] = [nc addObserverForName:names[i] object:window queue:nil usingBlock:^(NSNotification *) {
        auto c = weak.lock();
        if (!c) return;
        NSWindow *w = c->view.window;
        NSMutableDictionary *d = [displayInfoFor(w) mutableCopy];
        d[@"type"] = @"display";
        d[@"visible"] = @((w.occlusionState & NSWindowOcclusionStateVisible) != 0);
        c->emitState(d);
      }];
    }

    // The display link lives on its own run-loop thread so a busy main thread cannot delay a present.
    dispatch_semaphore_t ready = dispatch_semaphore_create(0);
    core->delegate = [DOLinkDelegate new];
    core->delegate->core = core;
    core->thread = [[NSThread alloc] initWithBlock:^{
      @autoreleasepool {
        NSRunLoop *rl = NSRunLoop.currentRunLoop;
        raw->runLoop = CFRunLoopGetCurrent();
        [rl addPort:NSMachPort.port forMode:NSDefaultRunLoopMode];
        if (@available(macOS 14.0, *)) {
          CAMetalDisplayLink *link = [[CAMetalDisplayLink alloc] initWithMetalLayer:raw->layer];
          link.delegate = raw->delegate;
          link.preferredFrameLatency = latency;
          link.preferredFrameRateRange = CAFrameRateRangeMake(30, 120, 120);
          raw->link = link;
          [link addToRunLoop:rl forMode:NSRunLoopCommonModes];
          link.paused = YES;
          raw->linkPaused.store(true);
        }
        dispatch_semaphore_signal(ready);
        while (!raw->closed.load()) [rl runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:1.0]];
        if (@available(macOS 14.0, *)) [raw->link invalidate];
      }
    }];
    core->thread.name = @"droid-office.presenter.link";
    core->thread.qualityOfService = NSQualityOfServiceUserInteractive;
    [core->thread start];
    dispatch_semaphore_wait(ready, DISPATCH_TIME_FOREVER);
  }

  ~Presenter() { Shutdown(); }

 private:
  std::shared_ptr<Core> core;
  bool shutdown = false;

  void Shutdown() {
    if (!core || shutdown) return;
    shutdown = true;
    core->closed.store(true);
    for (id o : core->observers)
      if (o) [NSNotificationCenter.defaultCenter removeObserver:o];
    CFRunLoopStop(core->runLoop);
    CFRunLoopWakeUp(core->runLoop);
    while (core->thread.isExecuting) usleep(1000);
    DOPresenterView *view = core->view;
    view.eventSink = nil;
    [view removeFromSuperview];
    Frame leftover;
    {
      std::lock_guard<std::mutex> g(core->lock);
      leftover = core->mailbox;
      core->mailbox = Frame();
      core->textures.clear();
    }
    if (leftover.surface) CFRelease(leftover.surface);
    {
      std::lock_guard<std::mutex> g(core->cbLock);
      core->callbacksOpen = false;
      core->callbacks.release.Release();
      if (core->callbacks.hasState) core->callbacks.state.Release();
      if (core->callbacks.hasEvent) core->callbacks.event.Release();
    }
    core->delegate->core = nullptr;
  }

  Napi::Value CloseJS(const Napi::CallbackInfo &info) {
    Shutdown();
    return info.Env().Undefined();
  }

  // submit(id: number, ioSurface: Buffer, frameCount?: number)
  Napi::Value Submit(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (shutdown) return env.Undefined();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBuffer() || info[1].As<Napi::Buffer<uint8_t>>().Length() < sizeof(void *)) {
      Napi::TypeError::New(env, "submit(id: number, ioSurface: Buffer)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    IOSurfaceRef surf = *reinterpret_cast<IOSurfaceRef *>(info[1].As<Napi::Buffer<uint8_t>>().Data());
    if (!surf) {
      Napi::Error::New(env, "null IOSurface").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    CFRetain(surf);
    Frame f;
    f.id = info[0].As<Napi::Number>().Uint32Value();
    f.frameCount = info.Length() > 2 && info[2].IsNumber() ? info[2].As<Napi::Number>().Uint32Value() : 0;
    f.surface = surf;
    f.submittedAt = CACurrentMediaTime();
    Frame old;
    {
      std::lock_guard<std::mutex> g(core->lock);
      old = core->mailbox;
      core->mailbox = f;
      core->counters.submitted++;
      if (old.surface) core->counters.dropped++;
    }
    if (old.surface) {
      CFRelease(old.surface);
      core->notifyRelease(old.id);
    }
    core->wake();
    return env.Undefined();
  }

  // setPacing({ fps: number, followDisplay: boolean }): the display link rate. fps 0 means the display's own rate.
  Napi::Value SetPacing(const Napi::CallbackInfo &info) {
    Napi::Object o = info[0].As<Napi::Object>();
    double fps = o.Has("fps") ? o.Get("fps").ToNumber().DoubleValue() : 0;
    bool follow = !o.Has("followDisplay") || o.Get("followDisplay").ToBoolean().Value();
    NSScreen *screen = core->view.window.screen ?: NSScreen.mainScreen;
    double maxFps = screen.maximumFramesPerSecond > 0 ? screen.maximumFramesPerSecond : 60;
    auto c = core;
    core->onLinkThread(^{
      if (@available(macOS 14.0, *)) {
        if (follow || fps <= 0) c->link.preferredFrameRateRange = CAFrameRateRangeMake(MIN(30, maxFps), maxFps, maxFps);
        else c->link.preferredFrameRateRange = CAFrameRateRangeMake(fps, fps, fps);
      }
    });
    return info.Env().Undefined();
  }

  Napi::Value SetHdr(const Napi::CallbackInfo &info) {
    bool on = info[0].ToBoolean().Value();
    CAMetalLayer *layer = core->layer;
    layer.wantsExtendedDynamicRangeContent = on && core->layerFormat == MTLPixelFormatRGBA16Float;
    return info.Env().Undefined();
  }

  Napi::Value SetDisplaySync(const Napi::CallbackInfo &info) {
    core->layer.displaySyncEnabled = info[0].ToBoolean().Value();
    return info.Env().Undefined();
  }

  Napi::Value Focus(const Napi::CallbackInfo &info) {
    [core->view.window makeFirstResponder:core->view];
    return info.Env().Undefined();
  }

  Napi::Value DisplayInfo(const Napi::CallbackInfo &info) {
    NSMutableDictionary *d = [displayInfoFor(core->view.window) mutableCopy];
    d[@"visible"] = @((core->view.window.occlusionState & NSWindowOcclusionStateVisible) != 0);
    d[@"pixelFormat"] = core->layerFormat == MTLPixelFormatRGBA16Float ? @"rgbaf16" : @"bgra8";
    d[@"edrActive"] = @(core->layer.wantsExtendedDynamicRangeContent);
    d[@"now"] = @(CACurrentMediaTime());
    return toJS(info.Env(), d);
  }

  // stats({ reset?: boolean }) -> counters plus `samples`, a Float64Array of presented frames in
  // order, stride 6: id, submittedAt, tickAt, targetPresentation, presentedAt, gpuMs (seconds on the CACurrentMediaTime clock, gpu in ms).
  Napi::Value Stats(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    bool reset = info.Length() > 0 && info[0].IsObject() && info[0].As<Napi::Object>().Get("reset").ToBoolean().Value();
    Counters c;
    std::vector<Sample> ordered;
    {
      std::lock_guard<std::mutex> g(core->lock);
      c = core->counters;
      if (core->ring.size() < kRingCapacity) ordered = core->ring;
      else {
        ordered.insert(ordered.end(), core->ring.begin() + core->ringNext, core->ring.end());
        ordered.insert(ordered.end(), core->ring.begin(), core->ring.begin() + core->ringNext);
      }
      if (reset) {
        core->ring.clear();
        core->ringNext = 0;
        uint32_t inFlight = core->counters.inFlight;
        core->counters = Counters();
        core->counters.inFlight = inFlight;
        core->counters.maxInFlight = inFlight;
      }
    }
    std::stable_sort(ordered.begin(), ordered.end(), [](const Sample &a, const Sample &b) { return a.presentedAt < b.presentedAt; });
    Napi::Object o = Napi::Object::New(env);
    o.Set("submitted", (double)c.submitted);
    o.Set("dropped", (double)c.dropped);
    o.Set("presented", (double)c.presented);
    o.Set("notShown", (double)c.notShown);
    o.Set("ticks", (double)c.ticks);
    o.Set("ticksWithFrame", (double)c.ticksWithFrame);
    o.Set("importFailures", (double)c.importFailures);
    o.Set("released", (double)c.released);
    o.Set("inFlight", (double)c.inFlight);
    o.Set("maxInFlight", (double)c.maxInFlight);
    o.Set("now", CACurrentMediaTime());
    Napi::Float64Array arr = Napi::Float64Array::New(env, ordered.size() * kSampleStride);
    for (size_t i = 0; i < ordered.size(); i++) {
      const Sample &s = ordered[i];
      double *p = arr.Data() + i * kSampleStride;
      p[0] = s.id;
      p[1] = s.submittedAt;
      p[2] = s.tickAt;
      p[3] = s.target;
      p[4] = s.presentedAt;
      p[5] = s.gpuMs;
    }
    o.Set("samples", arr);
    return o;
  }

  // capture(cb): reads back the next presented frame as { width, height, pixelFormat, data }. For tests and measurement only.
  Napi::Value Capture(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
      Napi::TypeError::New(env, "capture(callback)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    {
      std::lock_guard<std::mutex> g(core->captureLock);
      if (core->hasCapture) return env.Undefined();
      core->captureFn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "presenter-capture", 0, 1);
      core->hasCapture = true;
    }
    core->layer.framebufferOnly = NO;
    core->captureArmed.store(true);
    auto c = core;
    // Keep drawables readable only for the capture itself.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(500 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
      c->layer.framebufferOnly = YES;
    });
    return env.Undefined();
  }
};

static Napi::Value Probe(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object r = Napi::Object::New(env);
  id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
  if (!dev) {
    Napi::Error::New(env, "no Metal device").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  NSError *err = nil;
  id<MTLLibrary> lib = [dev newLibraryWithSource:kShader options:nil error:&err];
  if (!lib) {
    Napi::Error::New(env, std::string("shader compile failed: ") + err.localizedDescription.UTF8String).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  NSDictionary *props = @{(id)kIOSurfaceWidth : @16, (id)kIOSurfaceHeight : @16, (id)kIOSurfaceBytesPerElement : @8, (id)kIOSurfacePixelFormat : @(kPixelFormatRGBAHalf)};
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
  bool displayLink = false;
  if (@available(macOS 14.0, *)) displayLink = true;
  r.Set("device", Napi::String::New(env, dev.name.UTF8String));
  r.Set("unifiedMemory", Napi::Boolean::New(env, dev.hasUnifiedMemory));
  r.Set("ioSurfaceImport", Napi::Boolean::New(env, imported));
  r.Set("displayLink", Napi::Boolean::New(env, displayLink));
  r.Set("layer", Napi::Boolean::New(env, layer.device != nil));
  if (!imported) {
    Napi::Error::New(env, "IOSurface texture import failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return r;
}

// True when a connected screen can show brighter-than-white (EDR) content: the offscreen page then renders rgbaf16.
static Napi::Value EdrCapable(const Napi::CallbackInfo &info) {
  bool capable = false;
  for (NSScreen *s in NSScreen.screens)
    if (s.maximumPotentialExtendedDynamicRangeColorComponentValue > 1.0) capable = true;
  return Napi::Boolean::New(info.Env(), capable);
}

static Napi::Value Now(const Napi::CallbackInfo &info) { return Napi::Number::New(info.Env(), CACurrentMediaTime()); }

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("Presenter", Presenter::Define(env));
  exports.Set("probe", Napi::Function::New(env, Probe));
  exports.Set("edrCapable", Napi::Function::New(env, EdrCapable));
  exports.Set("now", Napi::Function::New(env, Now));
  DOInputRegisterExports(env, exports);
  return exports;
}
NODE_API_MODULE(presenter, Init)
