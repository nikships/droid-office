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
  // Keys get the first responder back and are returned, except a Control key down without Command, which the view takes itself so
  // performKeyEquivalent: can't swallow it (Ctrl+Return reached the view only as a key up, #299).
  const keys = routed.slice(routed.indexOf('NSEventTypeKeyDown'), routed.indexOf('NSPointInRect'));
  assert.match(keys, /makeFirstResponder:self/);
  assert.match(keys, /return e;/);
  const taken = keys.slice(keys.indexOf('if (e.type == NSEventTypeKeyDown'), keys.indexOf('return nil;'));
  assert.match(taken, /NSEventModifierFlagControl\) && !\(flags & NSEventModifierFlagCommand\)/);
  assert.match(taken, /window\.firstResponder == self/);
  assert.match(taken, /\[self keyDown:e\]/);
});

test('a mouse-moved event that reaches the view twice (first responder and tracking area) is taken once', () => {
  assert.match(body('- (void)moved:'), /if \(e\.timestamp == _lastMoveAt\) return;/);
});

test('keys the offscreen page leaves unhandled are never handed back to the app menu', () => {
  // Chromium offers them to the menu as a synthetic key down: a bare Command matched About (an item with no key equivalent) and a plain E
  // matched the fn+E Emoji & Symbols item AppKit adds to the Edit menu.
  const presenter = readFileSync(new URL('../src/desktop/presenter.ts', import.meta.url), 'utf8');
  assert.match(presenter, /this\.contents\.setIgnoreMenuShortcuts\(true\)/);
});

test("the page's HTML full screen never resizes its own invisible window", () => {
  // Made full screen, the offscreen page's window took a black Space of its own and macOS switched to it (HtmlFullScreen).
  const presenter = readFileSync(new URL('../src/desktop/presenter.ts', import.meta.url), 'utf8');
  assert.match(presenter, /disableHtmlFullscreenWindowResize: true/);
  assert.match(presenter, /this\.page\.on\('enter-html-full-screen', \(\) => this\.htmlFullScreen\.enter\(\)\)/);
  assert.match(presenter, /this\.page\.on\('leave-html-full-screen', \(\) => this\.htmlFullScreen\.leave\(\)\)/);
  assert.match(presenter, /this\.htmlFullScreen\.windowLeft\(\)/);
});
test("sandboxed frames stay in the offscreen page's process, where its input reaches them", () => {
  // In a process of their own (IsolateSandboxedIframes), a Whiteboard card's video and buttons never got a click in the Mac app.
  const main = readFileSync(new URL('../src/desktop/main.ts', import.meta.url), 'utf8');
  const model = readFileSync(new URL('../src/desktop/presenter-model.ts', import.meta.url), 'utf8');
  assert.match(model, /DISABLED_CHROMIUM_FEATURES = \['IsolateSandboxedIframes'\]/);
  const append = main.indexOf("app.commandLine.appendSwitch('disable-features', DISABLED_CHROMIUM_FEATURES.join(','))");
  assert.ok(append > 0, 'main.ts does not turn the features off');
  assert.ok(append < main.indexOf('.whenReady()'), 'the switch has to be set before the app is ready');
  assert.equal(main.match(/appendSwitch\('disable-features'/g)?.length, 1, 'a second disable-features switch would replace the first');
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

test('nothing escapes an event handler: AppKit turns an exception that does into a crash of the app', () => {
  assert.match(source, /static void Swallowed\(/);
  const routed = body('- (NSEvent *)routed:');
  assert.match(routed, /@try \{/);
  assert.match(routed, /@catch \(NSException \*ex\)/);
  for (const handler of ['- (void)keyDown:', '- (void)keyUp:', '- (void)flagsChanged:', '- (void)mouseDown:', '- (void)mouseMoved:', '- (void)scrollWheel:', '- (void)emit:']) {
    assert.match(body(handler), /@try|GUARDED\(/, `${handler} is not guarded`);
  }
  assert.match(body('- (void)keyDown:'), /_handlingKey = NO/);
});

test('key-only NSEvent properties are read for key events only: characters raises on a flags-changed event', () => {
  const describe = source.slice(source.indexOf('static NSString *Describe'), source.indexOf('static NSString *ClassOf'));
  assert.match(describe, /if \(e\.type != NSEventTypeKeyDown && e\.type != NSEventTypeKeyUp\) return head;/);
  assert.ok(describe.indexOf('return head;') < describe.indexOf('e.characters'));
  assert.doesNotMatch(body('- (void)flagsChanged:'), /\.characters|isARepeat/);
});
