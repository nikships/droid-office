import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { cleanToolArgs, isAllowedToolRequest, isExternalUrl, TOOL_JSON_MAX, TOOL_PASSTHROUGH_PREFIXES, TOOL_UPLOAD_MAX } from '../src/shared/companion-tools.js';
import { CARD_SANDBOX } from '../src/shared/whiteboard-bridge.js';

// JUnit reads this exact resource, not a generated copy of either policy implementation.
const fixture = JSON.parse(readFileSync(new URL('../android/app/src/test/resources/companion-tool-policy.json', import.meta.url), 'utf8')) as {
  requests: { method: string; path: string; allowed: boolean }[];
  external: { url: string; allowed: boolean }[];
  passthroughPrefixes: string[];
  passthroughSandbox: string;
  passthrough: { path: string; allowed: boolean }[];
  args: { input: unknown; expected: unknown }[];
};

test('TypeScript and Kotlin share every allowed management route and rejection fixture', () => {
  assert.ok(fixture.requests.length >= 60);
  for (const { method, path, allowed } of fixture.requests) assert.equal(isAllowedToolRequest(method, path), allowed, `${method} ${JSON.stringify(path)}`);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const suffix of ['.', './x', 'x/.', '../x', '%2e%2e/x', '%252e%252e/x', 'a%2Fb', 'a%5Cb', 'a\\b', 'a//b', 'a?x=1', 'a#x', 'a\nb']) {
      assert.equal(isAllowedToolRequest(method, `/api/factory/${suffix}`), false, `${method} ${suffix}`);
    }
    assert.equal(isAllowedToolRequest(method, `/api/factory/${'a'.repeat(499)}`), true);
    assert.equal(isAllowedToolRequest(method, `/api/factory/${'a'.repeat(500)}`), false);
  }
});

const nativeView = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/rn/ManagementView.kt', import.meta.url), 'utf8');

test('native host permits HTTPS document images without widening active-content policy', () => {
  const policy = nativeView.match(/private const val HOST_CSP = "([^"]+)"/)?.[1];
  assert.ok(policy);
  const directives = new Map(
    policy.split(';').map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources.join(' ')];
    }),
  );
  assert.equal(directives.get('img-src'), "'self' https: data: blob:");
  assert.equal(directives.get('frame-src'), "'self' blob:");
  assert.equal(directives.get('script-src'), "'self'");
  for (const directive of ['default-src', 'connect-src', 'worker-src', 'object-src']) assert.equal(directives.get(directive), "'none'");
});

test('native download fallback consumes only a fresh trusted same-origin anchor click', () => {
  // Exercise the exact native-injected helper, not a second implementation. This is a DOM-event
  // unit test, not a claim of WebView/provider runtime acceptance (owned by emulator checks).
  const script = nativeView.match(/private val INSTALL_DOWNLOAD_INTENT = """([\s\S]*?)"""\.trimIndent\(\)/)?.[1];
  assert.ok(script);
  const origin = 'https://appassets.androidplatform.net';
  const target = `${origin}/api/factory/wiki/runs/run/export`;
  let now = 0;
  let listeners = 0;
  class LinkElement {
    constructor(
      readonly href: string,
      readonly download = true,
    ) {}
    closest(selector: string) {
      assert.equal(selector, 'a[href][download]');
      return this.download ? this : null;
    }
  }
  type Click = { isTrusted: boolean; defaultPrevented: boolean; target: unknown };
  let click: (event: Click) => void = () => {
    throw new Error('Click listener was not installed');
  };
  const window: { droidOfficeDownloadIntent?: (url: string) => boolean } = {};
  const context = {
    window,
    Element: LinkElement,
    URL,
    location: { origin, href: `${origin}/assets/companion-tools/index.html` },
    performance: { now: () => now },
    document: {
      addEventListener(name: string, listener: (event: Click) => void, capture: boolean) {
        assert.equal(name, 'click');
        assert.equal(capture, true);
        listeners++;
        click = listener;
      },
    },
  };
  runInNewContext(script, context);
  runInNewContext(script, context);
  assert.equal(listeners, 1);
  const take = (url = target) => {
    assert.ok(window.droidOfficeDownloadIntent);
    return window.droidOfficeDownloadIntent(url);
  };
  const fire = (options: Partial<Click> = {}) => click({ isTrusted: true, defaultPrevented: false, target: new LinkElement(target), ...options });
  assert.equal(take(), false);
  fire({ isTrusted: false });
  assert.equal(take(), false);
  fire({ defaultPrevented: true });
  assert.equal(take(), false);
  fire({ target: new LinkElement(target, false) });
  assert.equal(take(), false);
  fire({ target: new LinkElement('https://example.com/export') });
  assert.equal(take('https://example.com/export'), false);
  fire({ target: {} });
  assert.equal(take(), false);
  fire();
  assert.equal(take(), true);
  assert.equal(take(), false);
  fire();
  assert.equal(take(`${target}?other=1`), false);
  assert.equal(take(), false);
  fire();
  now = 2001;
  assert.equal(take(), false);
  fire();
  assert.equal(take(), true);
});

test('external links, passthrough prefixes and tool arguments stay in parity', () => {
  for (const { url, allowed } of fixture.external) assert.equal(isExternalUrl(url), allowed, url);
  assert.deepEqual(TOOL_PASSTHROUGH_PREFIXES, fixture.passthroughPrefixes);
  assert.equal(fixture.passthroughSandbox, `sandbox ${CARD_SANDBOX}`);
  for (const { path, allowed } of fixture.passthrough) {
    if (allowed)
      assert.ok(
        TOOL_PASSTHROUGH_PREFIXES.some((prefix) => path.startsWith(prefix)),
        path,
      );
  }
  for (const { input, expected } of fixture.args) assert.deepEqual(cleanToolArgs(input), expected);
  for (const [key, max] of Object.entries({ workerId: 64, repo: 200, card: 200, pane: 40, deskId: 32 })) {
    assert.deepEqual(cleanToolArgs({ [key]: 'x'.repeat(max) }), { [key]: 'x'.repeat(max) });
    assert.deepEqual(cleanToolArgs({ [key]: 'x'.repeat(max + 1) }), {});
  }
  assert.equal(TOOL_UPLOAD_MAX, 25 * 1024 * 1024);
  assert.equal(TOOL_JSON_MAX, 3 * 1024 * 1024);
});
