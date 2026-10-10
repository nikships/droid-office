import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Arcade, ScreenZoom } from '../src/client/ui/arcade.js';
import { Cabinet } from '../src/client/ui/cabinet.js';
import { Blocks } from '../src/client/ui/blocks.js';

function zoom() {
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9));
  const view = new ScreenZoom(screen);
  const camera = new THREE.PerspectiveCamera();
  const settle = (on: boolean) => {
    for (let i = 0; i < 120; i++) view.update(camera, 1 / 60, on);
  };
  return { view, settle };
}

test('a settled screen zoom remains zoomed but stops counting as camera motion', () => {
  const { view, settle } = zoom();
  assert.equal(view.moving(false), false);
  assert.equal(view.moving(true), true);
  settle(true);
  assert.equal(view.zoomed, true, 'hands remain hidden');
  assert.equal(view.moving(true), false);
  assert.equal(view.moving(false), true, 'closing must animate even before the first update');
  settle(false);
  assert.equal(view.zoomed, false);
  assert.equal(view.moving(false), false);
});

test('Minesweeper idles at its screen, while BLOCKFALL stays full rate only during play or a zoom', () => {
  const { view, settle } = zoom();
  const arcade = Object.create(Arcade.prototype) as Arcade;
  const cabinet = Object.create(Cabinet.prototype) as Cabinet;
  for (const game of [arcade, cabinet]) {
    Reflect.set(game, 'view', view);
    Reflect.set(game, 'modal', {});
  }
  assert.equal(arcade.animating, true);
  settle(true);
  assert.equal(arcade.animating, false);
  Reflect.set(cabinet, 'mode', 'play');
  const game = new Blocks();
  Reflect.set(cabinet, 'game', game);
  assert.equal(cabinet.animating, true);
  game.pause(true);
  assert.equal(cabinet.animating, false);
  game.state = 'over';
  assert.equal(cabinet.animating, false);
  for (const game of [arcade, cabinet]) {
    Reflect.set(game, 'modal', null);
    assert.equal(game.animating, true, 'the trip back from the screen is still moving');
  }
  settle(false);
  assert.equal(arcade.animating, false);
  assert.equal(cabinet.animating, false);
});
