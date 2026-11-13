import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(`../android/app/src/main/java/ai/factory/droidoffice/ui/${path}`, import.meta.url), 'utf8');
const home = read('home/HomeScreen.kt');
const workers = read('workers/WorkersScreen.kt');
const components = read('components/Components.kt');

test('the shared Hire FAB is a round orange + button labelled Hire', () => {
  const fab = components.match(/fun BoxScope\.HireFab\(tag: String, onClick: \(\) -> Unit\) \{\n {4}FloatingActionButton\(\n([\s\S]*?)\{ Icon\(([^)]*)\) \}/);
  assert.ok(fab, 'Components.kt defines HireFab as a FloatingActionButton with an icon');
  const [, args, icon] = fab;
  assert.match(args, /onClick = onClick/);
  assert.match(args, /shape = CircleShape/);
  assert.match(args, /containerColor = Palette\.Accent/);
  assert.match(args, /\.align\(Alignment\.BottomEnd\)/);
  assert.match(args, /\.tagged\(tag\)/);
  // No size override: Material's FloatingActionButton is 56dp, above the 48dp tap target.
  assert.doesNotMatch(args, /\.size\(|sizeIn|requiredSize/);
  assert.doesNotMatch(args, /Text\(/);
  assert.equal(icon, 'Icons.Default.Add, "Hire"');
});

for (const [tab, source, call] of [
  ['Office', home, 'HireFab(Tags.Home.HIRE) { hiring = true }'],
  ['Workers', workers, 'HireFab(Tags.Workers.HIRE, onHire)'],
] as const) {
  test(`the ${tab} tab hires from the shared round + button with its own tag`, () => {
    assert.ok(source.includes(call), `${tab} tab calls ${call}`);
    assert.doesNotMatch(source, /FloatingActionButton\(/, `${tab} tab has no FAB of its own`);
  });
}

test('swiping the Office tab changes floors the same way a floor chip tap does', () => {
  assert.match(home, /Column\(Modifier\.fillMaxSize\(\)\.floorSwipe\(data\.floors\.map \{ it\.id \}, data\.floorId, onFloor\)\)/);
  assert.match(home, /onFloor = connection::goFloor/);
  const swipe = home.match(/private fun Modifier\.floorSwipe\([\s\S]*?\n {4}\}\n/)?.[0];
  assert.ok(swipe, 'floorSwipe is defined');
  assert.match(swipe, /FloorSwipe\.target\(floors, current, dx, dy, distance\)\?\.let\(onFloor\)/);
  assert.match(swipe, /if \(!swiping && change\.isConsumed\) break/);
  assert.match(swipe, /FloorSwipe\.claims\(dx, dy, viewConfiguration\.touchSlop\)/);
});
