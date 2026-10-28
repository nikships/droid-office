import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cleanToolArgs, isAllowedToolRequest, isExternalUrl, TOOL_JSON_MAX, TOOL_PASSTHROUGH_PREFIXES, TOOL_UPLOAD_MAX } from '../src/shared/companion-tools.js';

// JUnit reads this exact resource, not a generated copy of either policy implementation.
const fixture = JSON.parse(readFileSync(new URL('../android/app/src/test/resources/companion-tool-policy.json', import.meta.url), 'utf8')) as {
  requests: { method: string; path: string; allowed: boolean }[];
  external: { url: string; allowed: boolean }[];
  passthroughPrefixes: string[];
  passthrough: { path: string; allowed: boolean }[];
  args: { input: unknown; expected: unknown }[];
};

test('TypeScript and Kotlin share every allowed management route and rejection fixture', () => {
  assert.ok(fixture.requests.length >= 60);
  for (const { method, path, allowed } of fixture.requests) assert.equal(isAllowedToolRequest(method, path), allowed, `${method} ${JSON.stringify(path)}`);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const suffix of ['../x', '%2e%2e/x', '%252e%252e/x', 'a%2Fb', 'a%5Cb', 'a\\b', 'a//b', 'a?x=1', 'a#x', 'a\nb']) {
      assert.equal(isAllowedToolRequest(method, `/api/factory/${suffix}`), false, `${method} ${suffix}`);
    }
    assert.equal(isAllowedToolRequest(method, `/api/factory/${'a'.repeat(499)}`), true);
    assert.equal(isAllowedToolRequest(method, `/api/factory/${'a'.repeat(500)}`), false);
  }
});

test('external links, passthrough prefixes and tool arguments stay in parity', () => {
  for (const { url, allowed } of fixture.external) assert.equal(isExternalUrl(url), allowed, url);
  assert.deepEqual(TOOL_PASSTHROUGH_PREFIXES, fixture.passthroughPrefixes);
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
