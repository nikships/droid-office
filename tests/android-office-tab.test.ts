import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const home = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/ui/home/HomeScreen.kt', import.meta.url), 'utf8');

test('the Office tab hires from a round orange + button labelled Hire', () => {
  const fab = home.match(/FloatingActionButton\(\n([\s\S]*?)\{ Icon\(([^)]*)\) \}/);
  assert.ok(fab, 'the Office tab has a FloatingActionButton with an icon');
  assert.doesNotMatch(home, /ExtendedFloatingActionButton/);
  const [, args, icon] = fab;
  assert.match(args, /shape = CircleShape/);
  assert.match(args, /containerColor = Palette\.Accent/);
  assert.match(args, /\.align\(Alignment\.BottomEnd\)/);
  assert.match(args, /\.tagged\(Tags\.Home\.HIRE\)/);
  // No size override: Material's FloatingActionButton is 56dp, above the 48dp tap target.
  assert.doesNotMatch(args, /\.size\(|sizeIn|requiredSize/);
  assert.doesNotMatch(args, /Text\(/);
  assert.equal(icon, 'Icons.Default.Add, "Hire"');
});

test('swiping the Office tab changes floors the same way a floor chip tap does', () => {
  assert.match(home, /Column\(Modifier\.fillMaxSize\(\)\.floorSwipe\(data\.floors\.map \{ it\.id \}, data\.floorId, onFloor\)\)/);
  assert.match(home, /onFloor = connection::goFloor/);
  const swipe = home.match(/private fun Modifier\.floorSwipe\([\s\S]*?\n {4}\}\n/)?.[0];
  assert.ok(swipe, 'floorSwipe is defined');
  assert.match(swipe, /FloorSwipe\.target\(floors, current, dx, dy, distance\)\?\.let\(onFloor\)/);
  assert.match(swipe, /if \(!swiping && change\.isConsumed\) break/);
  assert.match(swipe, /FloorSwipe\.claims\(dx, dy, viewConfiguration\.touchSlop\)/);
});
