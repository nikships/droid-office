import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The native view cannot run in Node, so these hold the parts of `input_view.mm` that were once missing and left the window deaf to
// clicks and scrolling (hover still worked): see the "routed:" comment there.
const source = readFileSync(new URL('../native/presenter/src/input_view.mm', import.meta.url), 'utf8');
const body = (signature: string): string => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is missing`);
  return source.slice(start, source.indexOf('\n}\n', start));
};

test('clicks and scrolls that the content view took are given to the presenter view by a local monitor', () => {
  const install = body('- (void)installEventMonitor');
  for (const mask of ['LeftMouseDown', 'LeftMouseUp', 'LeftMouseDragged', 'RightMouseDown', 'RightMouseUp', 'OtherMouseDown', 'OtherMouseUp', 'ScrollWheel', 'KeyDown'])
    assert.match(install, new RegExp(`NSEventMask${mask}`), `${mask} is not monitored`);
  assert.match(install, /addLocalMonitorForEventsMatchingMask/);
  const routed = body('- (NSEvent *)routed:');
  for (const call of ['mouseDown:', 'mouseUp:', 'rightMouseDown:', 'otherMouseDown:', 'scrollWheel:']) assert.match(routed, new RegExp(`\\[self ${call}e\\]`), `${call} is not forwarded`);
});

test('the monitor leaves the window frame, other windows, sheets and menu key equivalents alone', () => {
  const routed = body('- (NSEvent *)routed:');
  assert.match(routed, /e\.window != window/);
  assert.match(routed, /attachedSheet/);
  assert.match(routed, /modalWindow/);
  // Only what the content view itself took is redirected: the title bar, traffic lights and resize edges belong to the frame.
  assert.match(routed, /hit == content \|\| \[hit isDescendantOf:content\]/);
  // Keys only get the first responder back; they are returned, never consumed.
  const keys = routed.slice(routed.indexOf('NSEventTypeKeyDown'), routed.indexOf('NSPointInRect'));
  assert.match(keys, /makeFirstResponder:self/);
  assert.match(keys, /return e;/);
  assert.doesNotMatch(keys, /return nil/);
});

test('the monitor is installed once per window and removed when the view leaves it or is released', () => {
  assert.match(body('- (void)viewDidMoveToWindow'), /installEventMonitor/);
  assert.match(body('- (void)viewWillMoveToWindow:'), /removeEventMonitor/);
  assert.match(body('- (void)dealloc'), /removeEventMonitor/);
  assert.match(body('- (void)installEventMonitor'), /if \(_eventMonitor\) return;/);
});

test('text the input system hands over is copied: an attributed string is emptied by AppKit once insertText: returns', () => {
  const text = source.slice(source.indexOf('static NSString *PlainString'), source.indexOf('static NSCursor *HiddenCursor'));
  assert.match(text, /\[text copy\]/);
  assert.match(body('- (void)insertText:'), /PlainString\(string\)/);
  assert.match(body('- (void)setMarkedText:'), /PlainString\(string\)/);
});
