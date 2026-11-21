import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The native Metal presenter requires an Electron BaseWindow/NSView to instantiate, so these guards lock in the
// `presenter.mm` link-thread invariants that prevent crashing when `direct` or `paced` mode has no display-link run loop.
const source = readFileSync(new URL('../native/presenter/src/presenter.mm', import.meta.url), 'utf8');

function body(signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is missing`);
  const brace = source.indexOf('{', start);
  assert.ok(brace >= 0, `${signature} has no opening brace`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(brace, i + 1);
  }
  assert.fail(`${signature} has no matching closing brace`);
}

test('SetPacing is a no-op when there is no display-link run loop (direct/paced modes or after Shutdown)', () => {
  const setPacing = body('Napi::Value SetPacing(const Napi::CallbackInfo &info)');
  assert.match(setPacing, /if\s*\(!core\s*\|\|\s*shutdown\s*\|\|\s*core->direct\s*\|\|\s*!core->runLoop\)\s*return info\.Env\(\)\.Undefined\(\);/);
});

test('onLinkThread guards against a null or closed run loop and wake routes through it', () => {
  const onLinkThread = body('void onLinkThread(void (^block)(void))');
  assert.match(onLinkThread, /if\s*\(closed\.load\(\)\s*\|\|\s*!runLoop\)\s*return;/);
  assert.ok(onLinkThread.indexOf('!runLoop') < onLinkThread.indexOf('CFRunLoopPerformBlock'));

  const wake = body('void wake()');
  assert.match(wake, /if\s*\(direct\s*\|\|\s*!linkPaused\.exchange\(false\)\)\s*return;/);
  assert.match(wake, /onLinkThread\(/);
  assert.doesNotMatch(wake, /CFRunLoopPerformBlock/);

  const shutdown = body('void Shutdown()');
  const totalCalls = (source.match(/CFRunLoopPerformBlock/g) ?? []).length;
  const guardedCalls = (onLinkThread.match(/CFRunLoopPerformBlock/g) ?? []).length + (shutdown.match(/CFRunLoopPerformBlock/g) ?? []).length;
  assert.equal(totalCalls, guardedCalls, 'every CFRunLoopPerformBlock call must be guarded by a runLoop check');
});

test('Shutdown clears core->runLoop after the link thread exits so it cannot dangle', () => {
  const shutdown = body('void Shutdown()');
  const wait = shutdown.indexOf('core->thread.isExecuting');
  const clear = shutdown.indexOf('core->runLoop = nullptr;');
  assert.ok(wait >= 0, 'Shutdown must wait for the link thread to stop');
  assert.ok(clear > wait, 'Shutdown must clear core->runLoop after the link thread finishes');
});
