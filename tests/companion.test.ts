import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPANION_PATH, companionLink, originKind } from '../src/shared/devices.js';
import { ORCHESTRATOR_ID, type MissionControlState } from '../src/shared/mission-control.js';
import { FLAG_BOLD, FLAG_DIM, FLAG_INVERSE, FLAG_INVISIBLE, FLAG_ITALIC, FLAG_STRIKE, FLAG_UNDERLINE, RGB_FLAG, type Run, type WorkerInfo } from '../src/shared/protocol.js';
import { buildingRoster } from '../src/client/dashboard-building.js';
import { buildingWaitingCount, companionDocumentTitle } from '../src/client/dashboard-title.js';
import { previewRows, runColor } from '../src/client/screen-preview.js';
import { TERM_THEME } from '../src/client/term-theme.js';
import { officeStatus } from '../src/server/office-status.js';
import { WebCompanion } from '../src/server/web-companion.js';

function worker(id: string, status: WorkerInfo['status'], fields: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, name: id, kind: 'agent', deskId: '', color: '#eee', status, acked: false, createdBy: '', createdAt: 0, cols: 0, rows: 0, open: false, ...fields };
}

test('the companion title identifies its surface and only prefixes positive waiting counts', () => {
  assert.equal(companionDocumentTitle('Droid Office', 0, true), 'Droid Office · Companion');
  assert.equal(companionDocumentTitle('Studio', 4, true), '(4) Studio · Companion');
  assert.equal(companionDocumentTitle('Studio', 1, false), '(1) Studio · Web companion');
  assert.equal(companionDocumentTitle('Studio', 0, false), 'Studio · Web companion');
});

test('the title waiting count matches the badge across live and background floors', () => {
  const local = [worker('question', 'needs_input', { lead: 'lead', acked: true }), worker('shell', 'needs_input', { kind: 'shell' })];
  const other = [worker('finished', 'done', { kind: 'cloud' }), worker('acknowledged', 'done', { acked: true }), worker('subagent-finished', 'done', { lead: 'lead' }), worker('lead', 'working')];
  const building = new Map([
    ['local', { floor: 'local', workers: [worker('gone', 'needs_input')], pulls: [] }],
    ['other', { floor: 'other', workers: other, pulls: [] }],
  ]);
  const buildingRows = buildingRoster({ floors: [], building, currentFloor: 'local', workers: local });
  const status = officeStatus(
    [
      { id: 'local', name: 'Local', workers: local },
      { id: 'other', name: 'Other', workers: other },
    ],
    [],
  );
  assert.equal(status.needsInput + status.done, 2);
  assert.equal(buildingWaitingCount({ buildingRows }), status.needsInput + status.done);
});

test('Mission Control counts its Orchestrator once, with or without a team, and does not count bots', () => {
  const team = [{ id: 'teammate', name: 'Teammate', floor: 'local', floorName: 'Local', status: 'working' as const }];
  const orchestrator = worker(ORCHESTRATOR_ID, 'done');
  const mission: MissionControlState = {
    orchestrator: { settings: { on: true }, team: [], agent: { worker: orchestrator, team: [] } },
    bots: [{ worker: worker('bot', 'needs_input'), team }],
  };
  const rows = () => buildingRoster({ floors: [], building: new Map(), currentFloor: null, workers: [], mission });
  assert.deepEqual(
    rows().map((row) => row.worker.id),
    ['bot'],
  );
  assert.equal(buildingWaitingCount({ buildingRows: rows(), mission }), 1);
  mission.orchestrator.team = team;
  assert.ok(rows().some((row) => row.worker.id === ORCHESTRATOR_ID));
  const remote = { worker: worker('remote', 'needs_input', { remote: true }), kind: 'desk' as const, floorId: 'local', floorName: 'Local', depth: 0 };
  assert.equal(buildingWaitingCount({ buildingRows: [...rows(), remote], mission }), 1);
  orchestrator.acked = true;
  assert.equal(buildingWaitingCount({ buildingRows: rows(), mission }), 0);
  orchestrator.status = 'needs_input';
  assert.equal(buildingWaitingCount({ buildingRows: rows(), mission }), 1);
  mission.orchestrator.settings.on = false;
  assert.equal(buildingWaitingCount({ buildingRows: rows(), mission }), 0);
});

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
  assert.deepEqual(
    previewRows(
      [
        [
          ['👩‍💻', -1, -1, FLAG_ITALIC | FLAG_UNDERLINE | FLAG_STRIKE, 4],
          ['界𠮷', -1, -1, FLAG_ITALIC, 4, 2],
          ['secret', -1, 1, FLAG_INVISIBLE],
        ],
        [['  ', -1, -1, FLAG_UNDERLINE]],
      ],
      2,
      2,
    ),
    [
      [
        { text: '👩‍💻', cols: 4, italic: true, decoration: 'underline line-through' },
        { text: '界', cols: 2, italic: true },
        { text: '𠮷', cols: 2, italic: true },
        { text: '      ', background: TERM_THEME.red },
      ],
      [{ text: '  ', decoration: 'underline' }],
    ],
  );
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
