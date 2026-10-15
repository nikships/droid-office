#import "input_view.h"
#import <ApplicationServices/ApplicationServices.h>
#import <GameController/GameController.h>

// Keep in step with MOD in src/desktop/input-events.ts.
static const int kModShift = 1, kModCtrl = 2, kModAlt = 4, kModMeta = 8, kModCaps = 16;

static int Mods(NSEventModifierFlags f) {
  return ((f & NSEventModifierFlagShift) ? kModShift : 0) | ((f & NSEventModifierFlagControl) ? kModCtrl : 0) |
         ((f & NSEventModifierFlagOption) ? kModAlt : 0) | ((f & NSEventModifierFlagCommand) ? kModMeta : 0) |
         ((f & NSEventModifierFlagCapsLock) ? kModCaps : 0);
}

// NSEvent.pressedMouseButtons: bit 0 left, 1 right, 2 middle.
static int Buttons(void) {
  return (int)[NSEvent pressedMouseButtons] & 7;
}

static NSString *PlainString(id s) {
  return [s isKindOfClass:NSAttributedString.class] ? [(NSAttributedString *)s string] : (NSString *)s;
}

static NSCursor *HiddenCursor(void) {
  static NSCursor *c;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSImage *img = [[NSImage alloc] initWithSize:NSMakeSize(1, 1)];
    c = [[NSCursor alloc] initWithImage:img hotSpot:NSZeroPoint];
  });
  return c;
}

static NSCursor *ResizeCursor(NSString *name) {
  if (@available(macOS 15.0, *)) {
    // The diagonal and the eight-way resize cursors are only public from macOS 15.
    NSCursorFrameResizePosition pos;
    if ([name isEqualToString:@"resizeNorthEast"]) pos = NSCursorFrameResizePositionTopRight;
    else if ([name isEqualToString:@"resizeNorthWest"]) pos = NSCursorFrameResizePositionTopLeft;
    else if ([name isEqualToString:@"resizeSouthEast"]) pos = NSCursorFrameResizePositionBottomRight;
    else if ([name isEqualToString:@"resizeSouthWest"]) pos = NSCursorFrameResizePositionBottomLeft;
    else return nil;
    return [NSCursor frameResizeCursorFromPosition:pos inDirections:NSCursorFrameResizeDirectionsAll];
  }
  if ([name hasPrefix:@"resizeNorth"] || [name hasPrefix:@"resizeSouth"]) return NSCursor.crosshairCursor;
  return nil;
}

static NSCursor *CursorNamed(NSString *name) {
  if ([name isEqualToString:@"arrow"]) return NSCursor.arrowCursor;
  if ([name isEqualToString:@"pointingHand"]) return NSCursor.pointingHandCursor;
  if ([name isEqualToString:@"iBeam"]) return NSCursor.IBeamCursor;
  if ([name isEqualToString:@"iBeamVertical"]) return NSCursor.IBeamCursorForVerticalLayout;
  if ([name isEqualToString:@"crosshair"]) return NSCursor.crosshairCursor;
  if ([name isEqualToString:@"openHand"]) return NSCursor.openHandCursor;
  if ([name isEqualToString:@"closedHand"]) return NSCursor.closedHandCursor;
  if ([name isEqualToString:@"resizeLeft"]) return NSCursor.resizeLeftCursor;
  if ([name isEqualToString:@"resizeRight"]) return NSCursor.resizeRightCursor;
  if ([name isEqualToString:@"resizeLeftRight"]) return NSCursor.resizeLeftRightCursor;
  if ([name isEqualToString:@"resizeUp"]) return NSCursor.resizeUpCursor;
  if ([name isEqualToString:@"resizeDown"]) return NSCursor.resizeDownCursor;
  if ([name isEqualToString:@"resizeUpDown"]) return NSCursor.resizeUpDownCursor;
  if ([name isEqualToString:@"notAllowed"]) return NSCursor.operationNotAllowedCursor;
  if ([name isEqualToString:@"contextMenu"]) return NSCursor.contextualMenuCursor;
  if ([name isEqualToString:@"dragCopy"]) return NSCursor.dragCopyCursor;
  if ([name isEqualToString:@"dragLink"]) return NSCursor.dragLinkCursor;
  if ([name isEqualToString:@"disappearingItem"]) return NSCursor.disappearingItemCursor;
  if ([name isEqualToString:@"hidden"]) return HiddenCursor();
  return ResizeCursor(name) ?: NSCursor.arrowCursor;
}

static __weak DOPresenterView *gCurrent;

@interface DOPresenterView () <NSTextInputClient>
@end

@implementation DOPresenterView {
  NSTrackingArea *_tracking;
  NSCursor *_cursor;
  BOOL _inside;
  BOOL _captured;
  BOOL _cursorHidden;
  BOOL _decoupled;
  BOOL _rawCapture;
  id _rawObserver;
  // The buttons that went down as a Control-click, which AppKit reports as the left button and the page expects as the right.
  BOOL _ctrlClick;
  BOOL _lastFocus;
  BOOL _focusKnown;

  BOOL _textActive;
  NSRect _imeRect;
  NSMutableString *_marked;
  NSRange _markedSel;
  // While a key goes through the input method: what it did, held back until it is known whether the key was plain.
  BOOL _handlingKey;
  NSMutableArray<NSDictionary *> *_pending;
  NSMutableArray<NSString *> *_commands;
  NSMutableArray<NSString *> *_committed;
  BOOL _composeTouched;
  NSMutableSet<NSNumber *> *_handledKeys;
}

+ (DOPresenterView *)current {
  return gCurrent;
}

- (instancetype)initWithFrame:(NSRect)frame {
  if ((self = [super initWithFrame:frame])) {
    _marked = [NSMutableString string];
    _markedSel = NSMakeRange(0, 0);
    _handledKeys = [NSMutableSet set];
    _cursor = NSCursor.arrowCursor;
  }
  return self;
}

- (void)dealloc {
  [self releaseCapture];
  [NSNotificationCenter.defaultCenter removeObserver:self];
}

#pragma mark - Responder and focus

- (BOOL)acceptsFirstResponder {
  return YES;
}

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  return YES;
}

- (BOOL)isOpaque {
  return YES;
}

- (void)emit:(NSDictionary *)event {
  void (^sink)(NSDictionary *) = self.eventSink;
  if (sink) sink(event);
}

- (void)reportFocus {
  BOOL focused = self.window.isKeyWindow && self.window.firstResponder == self;
  if (_focusKnown && focused == _lastFocus) return;
  _focusKnown = YES;
  _lastFocus = focused;
  if (!focused) {
    // Never leave the mouse captured under a window that is no longer the one being typed into.
    [self releaseCapture];
    [self cancelComposition];
  }
  [self emit:@{@"type": @"focus", @"focused": @(focused)}];
}

- (BOOL)becomeFirstResponder {
  BOOL ok = [super becomeFirstResponder];
  dispatch_async(dispatch_get_main_queue(), ^{ [self reportFocus]; });
  return ok;
}

- (BOOL)resignFirstResponder {
  BOOL ok = [super resignFirstResponder];
  dispatch_async(dispatch_get_main_queue(), ^{ [self reportFocus]; });
  return ok;
}

- (void)viewWillMoveToWindow:(NSWindow *)newWindow {
  [NSNotificationCenter.defaultCenter removeObserver:self name:NSWindowDidBecomeKeyNotification object:self.window];
  [NSNotificationCenter.defaultCenter removeObserver:self name:NSWindowDidResignKeyNotification object:self.window];
  [super viewWillMoveToWindow:newWindow];
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  if (!self.window) return;
  gCurrent = self;
  self.window.acceptsMouseMovedEvents = YES;
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(windowKeyChanged:) name:NSWindowDidBecomeKeyNotification object:self.window];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(windowKeyChanged:) name:NSWindowDidResignKeyNotification object:self.window];
  [self reportFocus];
}

- (void)windowKeyChanged:(NSNotification *)note {
  [self reportFocus];
}

#pragma mark - Tracking and cursor

- (void)updateTrackingAreas {
  if (_tracking) [self removeTrackingArea:_tracking];
  _tracking = [[NSTrackingArea alloc] initWithRect:self.bounds
                                           options:NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited | NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect
                                             owner:self
                                          userInfo:nil];
  [self addTrackingArea:_tracking];
  [super updateTrackingAreas];
}

- (void)resetCursorRects {
  [self addCursorRect:self.visibleRect cursor:_cursor];
}

- (void)applyCursor:(NSCursor *)cursor {
  _cursor = cursor ?: NSCursor.arrowCursor;
  [self.window invalidateCursorRectsForView:self];
  if (_inside && !_captured) [_cursor set];
}

- (void)setCursorNamed:(NSString *)name {
  [self applyCursor:CursorNamed(name)];
}

- (void)setCursorImage:(NSData *)png hotspot:(NSPoint)hotspot scale:(CGFloat)scale {
  NSImage *image = [[NSImage alloc] initWithData:png];
  if (!image) return [self applyCursor:NSCursor.arrowCursor];
  // The image is `scale` pixels per point.
  if (scale > 0 && scale != 1) image.size = NSMakeSize(image.size.width / scale, image.size.height / scale);
  [self applyCursor:[[NSCursor alloc] initWithImage:image hotSpot:hotspot]];
}

#pragma mark - Mouse

- (NSPoint)pointOf:(NSEvent *)e {
  NSPoint p = [self convertPoint:e.locationInWindow fromView:nil];
  return NSMakePoint(p.x, self.bounds.size.height - p.y);
}

- (void)emitMouse:(NSString *)kind event:(NSEvent *)e button:(int)button {
  NSPoint p = [self pointOf:e];
  [self emit:@{
    @"type": @"mouse", @"kind": kind, @"button": @(button), @"buttons": @(Buttons()), @"x": @(p.x), @"y": @(p.y),
    @"clickCount": @(e.type == NSEventTypeMouseEntered || e.type == NSEventTypeMouseExited || e.type == NSEventTypeMouseMoved ? 0 : e.clickCount),
    @"mods": @(Mods(e.modifierFlags)),
  }];
}

- (void)down:(NSEvent *)e button:(int)button {
  [self.window makeFirstResponder:self];
  // A Control-click is the context menu's click.
  if (button == 0 && (e.modifierFlags & NSEventModifierFlagControl)) {
    _ctrlClick = YES;
    button = 1;
  }
  [self emitMouse:@"down" event:e button:button];
}

- (void)up:(NSEvent *)e button:(int)button {
  if (button == 0 && _ctrlClick) button = 1;
  if (button == 0 || button == 1) _ctrlClick = NO;
  [self emitMouse:@"up" event:e button:button];
}

- (void)moved:(NSEvent *)e {
  if (_captured) {
    if (_rawCapture) return;
    if (e.deltaX != 0 || e.deltaY != 0) [self emitDelta:e.deltaX dy:e.deltaY raw:NO mods:Mods(e.modifierFlags)];
    return;
  }
  [self emitMouse:@"move" event:e button:0];
}

- (void)emitDelta:(double)dx dy:(double)dy raw:(BOOL)raw mods:(int)mods {
  [self emit:@{@"type": @"delta", @"dx": @(dx), @"dy": @(dy), @"raw": @(raw), @"buttons": @(Buttons()), @"mods": @(mods)}];
}

- (void)mouseDown:(NSEvent *)e { [self down:e button:0]; }
- (void)mouseUp:(NSEvent *)e { [self up:e button:0]; }
- (void)rightMouseDown:(NSEvent *)e { [self down:e button:1]; }
- (void)rightMouseUp:(NSEvent *)e { [self up:e button:1]; }
- (void)otherMouseDown:(NSEvent *)e { [self down:e button:(int)e.buttonNumber == 2 ? 2 : 3]; }
- (void)otherMouseUp:(NSEvent *)e { [self up:e button:(int)e.buttonNumber == 2 ? 2 : 3]; }
- (void)mouseMoved:(NSEvent *)e { [self moved:e]; }
- (void)mouseDragged:(NSEvent *)e { [self moved:e]; }
- (void)rightMouseDragged:(NSEvent *)e { [self moved:e]; }
- (void)otherMouseDragged:(NSEvent *)e { [self moved:e]; }

- (void)mouseEntered:(NSEvent *)e {
  _inside = YES;
  [self emitMouse:@"enter" event:e button:0];
}

- (void)mouseExited:(NSEvent *)e {
  _inside = NO;
  if (!_captured) [self emitMouse:@"leave" event:e button:0];
}

- (void)scrollWheel:(NSEvent *)e {
  NSPoint p = [self pointOf:e];
  [self emit:@{
    @"type": @"scroll", @"x": @(p.x), @"y": @(p.y), @"dx": @(e.scrollingDeltaX), @"dy": @(e.scrollingDeltaY),
    @"precise": @(e.hasPreciseScrollingDeltas), @"mods": @(Mods(e.modifierFlags)),
  }];
}

#pragma mark - Pointer capture

+ (BOOL)rawMouseAvailable {
  return GCMouse.mice.count > 0;
}

- (BOOL)pointerCaptured {
  return _captured;
}

- (BOOL)setPointerCaptured:(BOOL)captured raw:(BOOL)raw {
  if (!captured) {
    [self releaseCapture];
    return NO;
  }
  if (_captured) [self releaseCapture];
  _captured = YES;
  // The cursor stays exactly where it is, and moves again from there when the capture ends.
  CGAssociateMouseAndMouseCursorPosition(false);
  _decoupled = YES;
  [NSCursor hide];
  _cursorHidden = YES;
  _rawCapture = raw && [DOPresenterView rawMouseAvailable];
  if (_rawCapture) {
    __weak DOPresenterView *weak = self;
    void (^handler)(GCMouseInput *, float, float) = ^(GCMouseInput *, float dx, float dy) {
      DOPresenterView *view = weak;
      // GameController counts up as positive; the page counts down as positive.
      if (view && view->_captured && (dx != 0 || dy != 0)) [view emitDelta:dx dy:-dy raw:YES mods:Mods(NSEvent.modifierFlags)];
    };
    for (GCMouse *mouse in GCMouse.mice) mouse.mouseInput.mouseMovedHandler = handler;
    // A mouse plugged in while captured is read too.
    _rawObserver = [NSNotificationCenter.defaultCenter addObserverForName:GCMouseDidConnectNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
      GCMouse *mouse = note.object;
      if ([mouse isKindOfClass:GCMouse.class]) mouse.mouseInput.mouseMovedHandler = handler;
    }];
  }
  return _rawCapture;
}

- (void)releaseCapture {
  if (_rawObserver) {
    [NSNotificationCenter.defaultCenter removeObserver:_rawObserver];
    _rawObserver = nil;
  }
  if (_rawCapture) {
    for (GCMouse *mouse in GCMouse.mice) mouse.mouseInput.mouseMovedHandler = nil;
    _rawCapture = NO;
  }
  if (_decoupled) {
    CGAssociateMouseAndMouseCursorPosition(true);
    _decoupled = NO;
  }
  if (_cursorHidden) {
    [NSCursor unhide];
    _cursorHidden = NO;
  }
  _captured = NO;
}

#pragma mark - Keyboard and input method

- (void)setTextInputActive:(BOOL)active {
  if (_textActive == active) return;
  _textActive = active;
  if (!active) [self cancelComposition];
}

- (void)setImeRect:(NSRect)rect {
  _imeRect = rect;
  if (_marked.length) [self.inputContext invalidateCharacterCoordinates];
}

- (void)emitKey:(NSEvent *)e kind:(NSString *)kind handled:(BOOL)handled commands:(NSArray<NSString *> *)commands {
  [self emit:@{
    @"type": @"key", @"kind": kind, @"keyCode": @(e.keyCode), @"chars": e.characters ?: @"", @"base": e.charactersIgnoringModifiers ?: @"",
    @"mods": @(Mods(e.modifierFlags)), @"repeat": @(e.isARepeat), @"handled": @(handled), @"commands": commands ?: @[],
  }];
}

- (void)keyDown:(NSEvent *)e {
  if (!_textActive && !_marked.length) return [self emitKey:e kind:@"down" handled:NO commands:nil];
  BOOL hadMarked = _marked.length > 0;
  _handlingKey = YES;
  _pending = [NSMutableArray array];
  _commands = [NSMutableArray array];
  _committed = [NSMutableArray array];
  _composeTouched = NO;
  [self interpretKeyEvents:@[ e ]];
  _handlingKey = NO;
  BOOL composing = hadMarked || _marked.length > 0 || _composeTouched;
  // A plain key types what it says: any one-character commit of the key's own characters is the key itself, not an input method's doing.
  BOOL plain = !composing && (_committed.count == 0 || (_committed.count == 1 && [_committed[0] isEqualToString:e.characters ?: @""]));
  NSArray *pending = _pending;
  NSArray *commands = _commands;
  _pending = nil;
  _commands = nil;
  _committed = nil;
  if (plain) return [self emitKey:e kind:@"down" handled:NO commands:commands];
  for (NSDictionary *event in pending) [self emit:event];
  [_handledKeys addObject:@(e.keyCode)];
  [self emitKey:e kind:@"down" handled:YES commands:nil];
}

- (void)keyUp:(NSEvent *)e {
  BOOL handled = [_handledKeys containsObject:@(e.keyCode)];
  [_handledKeys removeObject:@(e.keyCode)];
  [self emitKey:e kind:@"up" handled:handled commands:nil];
}

- (void)flagsChanged:(NSEvent *)e {
  [self emit:@{@"type": @"flags", @"keyCode": @(e.keyCode), @"mods": @(Mods(e.modifierFlags))}];
}

// Menu key equivalents (Copy, Paste, Quit) are the menu's: the page never sees them, as in a browser.
- (BOOL)performKeyEquivalent:(NSEvent *)e {
  return NO;
}

- (void)deliver:(NSDictionary *)event {
  if (_handlingKey) [_pending addObject:event];
  else [self emit:event];
}

- (void)cancelComposition {
  if (!_marked.length) return;
  [_marked setString:@""];
  _markedSel = NSMakeRange(0, 0);
  [self.inputContext discardMarkedText];
  [self emit:@{@"type": @"composeEnd"}];
}

#pragma mark NSTextInputClient

- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {
  NSString *text = PlainString(string);
  if (_handlingKey) [_committed addObject:text];
  [_marked setString:@""];
  _markedSel = NSMakeRange(0, 0);
  [self deliver:@{@"type": @"commit", @"text": text}];
}

- (void)setMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {
  NSString *text = PlainString(string);
  _composeTouched = YES;
  if (text.length == 0) {
    BOOL had = _marked.length > 0;
    [_marked setString:@""];
    _markedSel = NSMakeRange(0, 0);
    if (had) [self deliver:@{@"type": @"composeEnd"}];
    return;
  }
  [_marked setString:text];
  _markedSel = selectedRange;
  [self deliver:@{@"type": @"compose", @"text": text, @"selStart": @(selectedRange.location), @"selEnd": @(selectedRange.location + selectedRange.length)}];
}

- (void)unmarkText {
  if (!_marked.length) return;
  NSString *text = [_marked copy];
  [_marked setString:@""];
  _markedSel = NSMakeRange(0, 0);
  _composeTouched = YES;
  [self deliver:@{@"type": @"commit", @"text": text}];
}

- (NSRange)selectedRange {
  return _marked.length ? NSMakeRange(_markedSel.location, _markedSel.length) : NSMakeRange(0, 0);
}

- (NSRange)markedRange {
  return _marked.length ? NSMakeRange(0, _marked.length) : NSMakeRange(NSNotFound, 0);
}

- (BOOL)hasMarkedText {
  return _marked.length > 0;
}

- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText {
  return @[];
}

- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
  if (!_marked.length) return nil;
  NSRange all = NSMakeRange(0, _marked.length);
  NSRange r = NSIntersectionRange(range, all);
  if (actualRange) *actualRange = r;
  return r.length ? [[NSAttributedString alloc] initWithString:[_marked substringWithRange:r]] : nil;
}

- (NSUInteger)characterIndexForPoint:(NSPoint)point {
  return 0;
}

- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
  // The page reports the caret from the top-left of the view; the screen counts from the bottom-left.
  NSRect r = NSMakeRect(_imeRect.origin.x, self.bounds.size.height - _imeRect.origin.y - _imeRect.size.height, MAX(_imeRect.size.width, 1), MAX(_imeRect.size.height, 1));
  if (actualRange) *actualRange = range;
  return [self.window convertRectToScreen:[self convertRect:r toView:nil]];
}

- (void)doCommandBySelector:(SEL)selector {
  // Only the commands a key brought (an arrow, Delete, Option-Delete) matter; the page runs them as editing commands.
  if (_handlingKey) [_commands addObject:NSStringFromSelector(selector)];
}

@end

