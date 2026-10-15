#import "metal_view.h"
#include <napi.h>

// The view the presenter installs in the BaseWindow's content view. Input/window-behavior code
// owns input_view.mm: first responder, mouse/keyboard/scroll/flags events, NSTextInputClient (IME),
// cursor rects, pointer capture. The presentation core owns everything else (metal_view.mm).
//
// Every NSEvent-derived message goes out through `eventSink` as a plain NSDictionary (NSNumber,
// NSString, NSArray, NSDictionary values only). presenter.mm turns it into a JS object and delivers
// it to the `onEvent` function given to `new Presenter(handle, { onEvent })` on the Electron
// main-process JS thread.
@interface DOPresenterView : DOMetalView
@property(nonatomic, copy) void (^eventSink)(NSDictionary *event);
@end

// Called once from the addon's Init. Register any extra exports the input code needs (for example
// pointer capture or cursor commands on the module); keep it defined even when it adds nothing.
void DOInputRegisterExports(Napi::Env env, Napi::Object exports);
