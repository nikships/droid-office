#import <AppKit/AppKit.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>

// The CAMetalLayer-backed view the presenter draws into. Owned by the presentation core
// (metal_view.mm, presenter.mm); the input/window-behavior code builds on it via DOPresenterView.
@interface DOMetalView : NSView
@property(nonatomic, readonly) CAMetalLayer *metalLayer;
// Backing size in pixels (bounds * backingScaleFactor); the layer's drawableSize follows it.
@property(nonatomic, readonly) CGSize backingSize;
// Called on the main thread after the view's size, scale or screen changed and drawableSize was updated.
@property(nonatomic, copy) void (^onGeometryChange)(void);
@end
