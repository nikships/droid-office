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

test('the Office tab slides between floors on a pager that follows the finger', () => {
  assert.doesNotMatch(home, /floorSwipe|FloorSwipe/, 'the release-only swipe is gone');
  const pager = home.match(/HorizontalPager\(\n([\s\S]*?)\n {16}\) \{ page ->\n([\s\S]*?)\n {16}\}/);
  assert.ok(pager, 'HomeScreen lays the floors out on a HorizontalPager');
  const [, args, page] = pager;
  assert.match(args, /state = pager/);
  assert.match(args, /\.tagged\(Tags\.Home\.PAGER\)/);
  assert.match(args, /key = \{ ids\[it\] \}/);
  // Each page draws its own floor, so the neighbour under the finger shows that floor's workers.
  assert.match(page, /FloorPage\(data\.floors\[page\], data,/);
  assert.match(home, /onFloor = connection::goFloor/);
  // The office is asked to move only once the pager settles, and chips slide the same pager.
  assert.match(home, /snapshotFlow \{ pager\.settledPage \}\.collect \{ page ->\n\s*val id = FloorPager\.request\(ids, page, office, requested\)/);
  assert.match(home, /FloorChips\(data, slideTo, highlight = ids\.getOrNull\(pager\.currentPage\) \?: data\.floorId\)/);
  assert.match(home, /if \(at == null\) onFloor\(id\) else scope\.launch \{ pager\.animateScrollToPage\(at\) \}/);
});
