#import "metal_view.h"

@implementation DOMetalView

- (instancetype)initWithFrame:(NSRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.wantsLayer = YES;
    self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  }
  return self;
}

- (CALayer *)makeBackingLayer {
  CAMetalLayer *layer = [CAMetalLayer layer];
  layer.device = MTLCreateSystemDefaultDevice();
  layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
  layer.framebufferOnly = YES;
  layer.displaySyncEnabled = YES;
  layer.opaque = YES;
  layer.maximumDrawableCount = 3;
  layer.presentsWithTransaction = NO;
  layer.contentsGravity = kCAGravityTopLeft;
  return layer;
}

- (BOOL)wantsUpdateLayer {
  return YES;
}

- (CAMetalLayer *)metalLayer {
  return (CAMetalLayer *)self.layer;
}

- (CGSize)backingSize {
  return [self convertSizeToBacking:self.bounds.size];
}

- (void)syncDrawableSize {
  CAMetalLayer *layer = self.metalLayer;
  CGFloat scale = self.window ? self.window.backingScaleFactor : (NSScreen.mainScreen ? NSScreen.mainScreen.backingScaleFactor : 2.0);
  layer.contentsScale = scale;
  CGSize size = self.backingSize;
  if (size.width < 1 || size.height < 1) return;
  if (!CGSizeEqualToSize(layer.drawableSize, size)) layer.drawableSize = size;
  if (self.onGeometryChange) self.onGeometryChange();
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  [self syncDrawableSize];
}

- (void)viewDidChangeBackingProperties {
  [super viewDidChangeBackingProperties];
  [self syncDrawableSize];
}

- (void)setFrameSize:(NSSize)newSize {
  [super setFrameSize:newSize];
  [self syncDrawableSize];
}

@end
