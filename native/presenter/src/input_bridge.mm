#import "input_view.h"

// JS-to-native input commands. They act on the DOPresenterView most recently put in a window, and
// run on the main-process JS thread, which is AppKit's main thread in Electron.

static DOPresenterView *View(Napi::Env env) {
  DOPresenterView *view = DOPresenterView.current;
  if (!view) Napi::Error::New(env, "no presenter view is attached to a window").ThrowAsJavaScriptException();
  return view;
}

// capture(on: boolean, raw?: boolean): boolean. Returns whether the capture in force reads the mouse raw.
static Napi::Value Capture(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  DOPresenterView *view = View(env);
  if (!view) return env.Undefined();
  bool on = info[0].ToBoolean().Value();
  bool raw = info.Length() > 1 && info[1].ToBoolean().Value();
  return Napi::Boolean::New(env, [view setPointerCaptured:on raw:raw]);
}

static Napi::Value Capabilities(const Napi::CallbackInfo &info) {
  Napi::Object r = Napi::Object::New(info.Env());
  r.Set("rawMouse", Napi::Boolean::New(info.Env(), [DOPresenterView rawMouseAvailable]));
  return r;
}

static Napi::Value SetCursor(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  DOPresenterView *view = View(env);
  if (!view) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) return env.Undefined();
  [view setCursorNamed:[NSString stringWithUTF8String:info[0].As<Napi::String>().Utf8Value().c_str()]];
  return env.Undefined();
}

// setCursorImage(png: Buffer, hotspotX, hotspotY, scale)
static Napi::Value SetCursorImage(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  DOPresenterView *view = View(env);
  if (!view) return env.Undefined();
  if (info.Length() < 4 || !info[0].IsBuffer()) return env.Undefined();
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  NSData *png = [NSData dataWithBytes:buf.Data() length:buf.Length()];
  [view setCursorImage:png hotspot:NSMakePoint(info[1].ToNumber().DoubleValue(), info[2].ToNumber().DoubleValue()) scale:info[3].ToNumber().DoubleValue()];
  return env.Undefined();
}

static Napi::Value SetTextInput(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  DOPresenterView *view = View(env);
  if (!view) return env.Undefined();
  [view setTextInputActive:info[0].ToBoolean().Value()];
  return env.Undefined();
}

// setImeRect(x, y, w, h) in view points from the top-left.
static Napi::Value SetImeRect(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  DOPresenterView *view = View(env);
  if (!view) return env.Undefined();
  [view setImeRect:NSMakeRect(info[0].ToNumber().DoubleValue(), info[1].ToNumber().DoubleValue(), info[2].ToNumber().DoubleValue(), info[3].ToNumber().DoubleValue())];
  return env.Undefined();
}

// focus(): makes the view the window's first responder.
static Napi::Value Focus(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  DOPresenterView *view = View(env);
  if (!view) return env.Undefined();
  [view.window makeFirstResponder:view];
  return env.Undefined();
}

void DOInputRegisterExports(Napi::Env env, Napi::Object exports) {
  exports.Set("inputCapture", Napi::Function::New(env, Capture));
  exports.Set("inputCapabilities", Napi::Function::New(env, Capabilities));
  exports.Set("inputSetCursor", Napi::Function::New(env, SetCursor));
  exports.Set("inputSetCursorImage", Napi::Function::New(env, SetCursorImage));
  exports.Set("inputSetTextInput", Napi::Function::New(env, SetTextInput));
  exports.Set("inputSetImeRect", Napi::Function::New(env, SetImeRect));
  exports.Set("inputFocus", Napi::Function::New(env, Focus));
}
