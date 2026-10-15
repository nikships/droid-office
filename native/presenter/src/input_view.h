#import "metal_view.h"
#include <napi.h>

// The view the presenter installs in the BaseWindow's content view. Input/window-behavior code
// owns input_view.mm: first responder, mouse/keyboard/scroll/flags events, NSTextInputClient (IME),
// cursor, pointer capture. The presentation core owns everything else (metal_view.mm).
//
// Every NSEvent-derived message goes out through `eventSink` as a plain NSDictionary (NSNumber,
// NSString, NSArray, NSDictionary values only). presenter.mm turns it into a JS object and delivers
// it to the `onEvent` function given to `new Presenter(handle, { onEvent })` on the Electron
// main-process JS thread. The schema is `NativeEvent` in src/desktop/input-events.ts: positions are
// DIPs from the top-left.
@interface DOPresenterView : DOMetalView
@property(nonatomic, copy) void (^eventSink)(NSDictionary *event);

// The view most recently put in a window, which the commands in input_bridge.mm act on.
+ (DOPresenterView *)current;

// Captures the mouse for looking around: hides the cursor, freezes it in place and reports relative
// motion as "delta" events. `raw` reads the device with no pointer acceleration (GameController);
// returns whether that is what is in force. Asking for raw with no mouse attached returns NO and
// still captures with acceleration, so the caller decides whether that is acceptable.
- (BOOL)setPointerCaptured:(BOOL)captured raw:(BOOL)raw;
@property(nonatomic, readonly) BOOL pointerCaptured;
// Whether a mouse (not a trackpad) that can report raw motion is attached.
+ (BOOL)rawMouseAvailable;

// Cursor by name (see input_view.mm), or a custom image (PNG data, hotspot in points, scale of the image).
- (void)setCursorNamed:(NSString *)name;
- (void)setCursorImage:(NSData *)png hotspot:(NSPoint)hotspot scale:(CGFloat)scale;

// Whether a text field has focus in the page. Only then do key presses go through the input method;
// otherwise the keys that move you around never wait on it.
- (void)setTextInputActive:(BOOL)active;
// Where the caret is (view points from the top-left), for the input method's candidate window.
- (void)setImeRect:(NSRect)rect;
@end

// Registers the input commands (input_bridge.mm) on the addon's exports. Called from Init in presenter.mm.
void DOInputRegisterExports(Napi::Env env, Napi::Object exports);
