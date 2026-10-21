import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPANION_PATH, companionLink, originKind } from '../src/shared/devices.js';
import { FLAG_BOLD, FLAG_DIM, FLAG_INVERSE, RGB_FLAG, type Run } from '../src/shared/protocol.js';
import { previewRows, runColor } from '../src/client/screen-preview.js';
import { TERM_THEME } from '../src/client/term-theme.js';
import { WebCompanion } from '../src/server/web-companion.js';

test('a page knows how it reached the office from its host name', () => {
  for (const host of ['localhost', 'LOCALHOST', 'office.localhost', '127.0.0.1', '127.4.5.6', '::1', '[::1]']) assert.equal(originKind(host), 'local', host);
  for (const host of ['nikhils-macbook-pro-2.tail08b849.ts.net', '100.96.217.59', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::734:d93c', '[fd7a:115c:a1e0::734:d93c]']) assert.equal(originKind(host), 'tailscale', host);
  for (const host of ['192.168.0.148', '10.0.0.4', '100.63.0.1', '100.128.0.1', 'my-mac.local', '127.0.0.1.example.com']) assert.equal(originKind(host), 'lan', host);
});

test('companion links point at /dashboard and carry the start token only when given', () => {
  assert.equal(COMPANION_PATH, '/dashboard');
  assert.equal(companionLink('http://localhost:4600'), 'http://localhost:4600/dashboard');
  assert.equal(companionLink('http://192.168.0.148:4600/'), 'http://192.168.0.148:4600/dashboard');
  assert.equal(companionLink('https://nikhils-macbook-pro-2.tail08b849.ts.net:4600', 'a+b/c='), 'https://nikhils-macbook-pro-2.tail08b849.ts.net:4600/dashboard?t=a%2Bb%2Fc%3D');
  assert.equal(companionLink('http://100.96.217.59:4600', ''), 'http://100.96.217.59:4600/dashboard');
});

test('screen previews keep the terminal colors and drop the blank rows below the output', () => {
  assert.equal(runColor(-1), undefined);
  assert.equal(runColor(1), TERM_THEME.red);
  assert.equal(runColor(15), TERM_THEME.brightWhite);
  assert.equal(runColor(16), '#000000');
  assert.equal(runColor(196), '#ff0000');
  assert.equal(runColor(231), '#ffffff');
  assert.equal(runColor(232), '#080808');
  assert.equal(runColor(255), '#eeeeee');
  assert.equal(runColor(256), undefined);
  assert.equal(runColor(RGB_FLAG | 0xee6018), '#ee6018');
  assert.equal(runColor(1.5), undefined);
  const lines: Run[][] = [
    [['first', -1, -1, 0]],
    [
      ['  ok ', 2, -1, FLAG_BOLD],
      ['dim', -1, -1, FLAG_DIM],
    ],
    [
      ['sel', -1, -1, FLAG_INVERSE],
      ['x', 4, 0, FLAG_INVERSE],
    ],
    [['   ', -1, -1, 0]],
    [],
  ];
  assert.deepEqual(previewRows(lines, 5, 10), [
    [{ text: 'first' }],
    [
      { text: '  ok ', color: TERM_THEME.green, bold: true },
      { text: 'dim', dim: true },
    ],
    [
      { text: 'sel', color: TERM_THEME.background, background: TERM_THEME.foreground },
      { text: 'x', color: TERM_THEME.black, background: TERM_THEME.blue },
    ],
  ]);
  assert.deepEqual(
    previewRows(lines, 5, 2).map((r) => r[0].text),
    ['  ok ', 'sel'],
  );
  assert.deepEqual(previewRows([undefined, [['   ', -1, -1, 0]]], 2, 4), []);
  assert.deepEqual(previewRows(lines, 1, 4), [[{ text: 'first' }]], 'rows past the screen height are ignored');
});

test('the web companion is on until the owner turns it off, and stays as set', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const heard: boolean[] = [];
  const first = new WebCompanion(dir, (s) => heard.push(s.on));
  assert.equal(first.on, true);
  first.set(false, 'owner');
  assert.deepEqual(heard, [false]);
  assert.equal(new WebCompanion(dir).on, false);
  writeFileSync(path.join(dir, 'web-companion.json'), 'not json');
  assert.equal(new WebCompanion(dir).on, true);
});
