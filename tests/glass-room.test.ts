import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DESK_BY_ID, GLASS_ROOM, GLASS_ROOM_BOARD, GLASS_ROOM_CHAIRS, GLASS_ROOM_TABLE, LOFT } from '../src/shared/layout.js';
import { PROMPT_IDS } from '../src/shared/prompts.js';
import { glassRoomTexture } from '../src/client/world/glass-room.js';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('the glass room keeps its footprint and furnishings, but none are worker seats', () => {
  assert.equal(GLASS_ROOM.minX, LOFT.minX + 0.15);
  assert.equal(GLASS_ROOM.minZ, LOFT.minZ + 0.15);
  assert.deepEqual(GLASS_ROOM.door, { x0: 10, x1: 11.4 });
  assert.deepEqual(GLASS_ROOM_TABLE, { x: 13.7, z: 10.55, width: 3.6, depth: 1.2, height: 0.76 });
  assert.equal(GLASS_ROOM_CHAIRS.length, 5);
  assert.equal(GLASS_ROOM_BOARD.width, 3.6);
  for (let i = 1; i <= 5; i++) assert.equal(DESK_BY_ID.has(`meeting-${i}`), false);
});

test('meeting runtime, commands, menus, state, prompts and styles are removed', () => {
  for (const file of ['src/server/meetings.ts', 'src/shared/meetings.ts', 'src/client/ui/meeting.ts', 'src/client/world/meeting.ts']) assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), false, file);
  for (const file of [
    'src/shared/protocol.ts',
    'src/server/server.ts',
    'src/server/floor.ts',
    'src/client/main.ts',
    'src/client/state.ts',
    'src/client/automation.ts',
    'src/client/ui/boards.ts',
    'src/client/ui/pull.ts',
    'src/client/ui/menu.ts',
    'src/client/style.css',
  ])
    assert.doesNotMatch(source(file), /meeting|Meeting|MEETING|Review panel|pull\.panel/, file);
  assert.ok(PROMPT_IDS.every((id) => !id.includes('meeting') && id !== 'pull.panel'));
  const room = source('src/client/world/office.ts').split('function buildGlassRoom(')[1].split('/** The materials')[0];
  assert.doesNotMatch(room, /interact|DeskView|laptopAnchor|seatAnchor|stage|vacancy/);
  assert.match(room, /doors\.push/);
  assert.match(room, /MISSION CONTROL/);
});

test('the decorative screens keep their artwork without advertising actions', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const text: string[] = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 0, height: 0, getContext: () => context };
        const context = new Proxy({ canvas, fillText: (s: string) => text.push(s) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
        return canvas;
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  for (const kind of ['board', 'sign'] as const) {
    const texture = glassRoomTexture(kind);
    assert.deepEqual([texture.image.width, texture.image.height], kind === 'board' ? [1500, 500] : [500, 800]);
    texture.dispose();
  }
  assert.ok(text.includes('MISSION CONTROL'));
  assert.ok(text.includes('The table is free'));
  assert.ok(text.includes('FREE'));
  assert.doesNotMatch(text.join(' '), /Press|meeting|round|review/i);
});
