import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Building, type FloorDef } from '../src/server/building.js';
import { MAX_FLOORS } from '../src/shared/floors.js';
import { suggestedFolder } from '../src/server/config.js';

function office(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-building-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, '.droid-office');
  mkdirSync(dataDir);
  const floor = (id: string, palette: number): FloorDef => {
    const dir = path.join(root, 'acme', id);
    mkdirSync(dir, { recursive: true });
    return { id, name: id, repo: `acme/${id}`, dir, palette, addedBy: 'Sam', addedAt: 1 };
  };
  const defs = [floor('api', 0), floor('web', 1), floor('docs', 2)];
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify(defs));
  return { root, dataDir, defs };
}

const saved = (dataDir: string) => (JSON.parse(readFileSync(path.join(dataDir, 'floors.json'), 'utf8')) as FloorDef[]).map((d) => d.id);

test('a floor comes off the building and stays off, with its checkout left where it was', (t) => {
  const { root, dataDir, defs } = office(t);
  const building = new Building(dataDir, root);

  const r = building.remove('web');
  assert.equal(typeof r, 'object');
  assert.equal((r as FloorDef).dir, defs[1].dir);
  assert.deepEqual(
    building.list().map((d) => d.id),
    ['api', 'docs'],
  );
  assert.deepEqual(saved(dataDir), ['api', 'docs']);
  assert.ok(existsSync(defs[1].dir), 'the checkout stays on disk');

  // After a restart it's still gone.
  assert.deepEqual(
    new Building(dataDir, root).list().map((d) => d.id),
    ['api', 'docs'],
  );
});

test("floors that aren't there can't be taken off", (t) => {
  const { root, dataDir } = office(t);
  const building = new Building(dataDir, root);

  assert.equal(building.remove('nope'), 'No such floor');
  assert.deepEqual(saved(dataDir), ['api', 'web', 'docs']);
});

for (const [forge, origin] of [
  ['GitHub', 'https://github.com/acme/api.git'],
  ['GitLab', 'https://gitlab.com/acme/platform/api.git'],
] as const) {
  test(`the floor the office was started in comes off too, stays off after a restart, and moves back in when its ${forge} checkout is added again`, (t) => {
    const { root, dataDir, defs } = office(t);
    // The office's own checkout, with its origin (how it's recognised once it's no longer a floor).
    execFileSync('git', ['init', '-q', defs[0].dir]);
    execFileSync('git', ['-C', defs[0].dir, 'remote', 'add', 'origin', origin]);
    // The started-in floor is recorded as its origin's repository, not the one the fixture wrote.
    writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify(defs.slice(1)));
    const building = new Building(dataDir, root);
    const local = building.ensureLocal(defs[0].dir, 'the office');
    assert.ok(local && building.isLocal(local.id));
    assert.ok(!building.isLocal('web'));

    const r = building.remove((local as FloorDef).id, 'Sam');
    assert.equal((r as FloorDef).id, 'api');
    assert.ok(!building.isLocal('api'));
    assert.deepEqual(saved(dataDir), ['web', 'docs']);
    assert.ok(existsSync(defs[0].dir), 'the checkout stays on disk');

    // The next start doesn't put it back.
    const again = new Building(dataDir, root);
    assert.equal(again.ensureLocal(defs[0].dir, 'the office'), undefined);
    assert.deepEqual(
      again.list().map((d) => d.id),
      ['web', 'docs'],
    );
    assert.deepEqual(saved(dataDir), ['web', 'docs']);

    // Adding it again uses the checkout it always was.
    const back = again.add(defs[0].dir, 'Sam');
    assert.equal(typeof back, 'object', String(back));
    assert.equal((back as FloorDef).dir, defs[0].dir);
    assert.ok(again.isLocal((back as FloorDef).id));
    assert.deepEqual(saved(dataDir), ['web', 'docs', 'api']);
    assert.ok(!existsSync(path.join(dataDir, 'local-floor.json')));

    // ...and it's a floor again at the next start.
    const third = new Building(dataDir, root);
    assert.equal(third.ensureLocal(defs[0].dir, 'the office')?.id, 'api');
    assert.deepEqual(
      third.list().map((d) => d.id),
      ['web', 'docs', 'api'],
    );
  });
}

test('the workspace folder defaults to a code folder that is already in the home folder, else the fallback', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'droid-office-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fallback = path.join(home, '.droid-office', 'projects');
  assert.equal(suggestedFolder(fallback, home), fallback);
  writeFileSync(path.join(home, 'code'), 'a file, not a folder');
  assert.equal(suggestedFolder(fallback, home), fallback);
  mkdirSync(path.join(home, 'projects'));
  assert.equal(suggestedFolder(fallback, home), path.join(home, 'projects'));
  mkdirSync(path.join(home, 'Workspace'));
  assert.equal(suggestedFolder(fallback, home), path.join(home, 'Workspace'));
});

/** A workspace folder with a few git checkouts in it, laid out the way people keep them. */
function workspace(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'office', '.droid-office');
  mkdirSync(dataDir, { recursive: true });
  const work = path.join(root, 'repos');
  const checkout = (rel: string, origin?: string) => {
    const dir = path.join(work, rel);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
    return dir;
  };
  const api = checkout('acme/api', 'git@github.com:acme/api.git');
  const notes = checkout('notes');
  mkdirSync(path.join(work, 'node_modules', 'dep', '.git'), { recursive: true });
  mkdirSync(path.join(work, '.hidden', 'repo', '.git'), { recursive: true });
  mkdirSync(path.join(api, 'vendor', 'nested', '.git'), { recursive: true });
  const outside = path.join(root, 'elsewhere', 'stray');
  mkdirSync(outside, { recursive: true });
  execFileSync('git', ['init', '-q', outside]);
  const building = new Building(dataDir, work);
  return { root, work, dataDir, api, notes, outside, building };
}

test('the workspace folder is searched for existing checkouts, without going into any of them', async (t) => {
  const { building, api, notes } = workspace(t);
  const found = await building.repos();
  assert.deepEqual(found.map((r) => r.dir).sort(), [api, notes].sort());
  const repo = found.find((r) => r.dir === api);
  assert.equal(repo?.name, 'acme/api');
  assert.equal(repo?.repo, 'acme/api');
  assert.equal(repo?.forge, 'github');
  assert.equal(found.find((r) => r.dir === notes)?.name, 'notes', 'no GitHub or GitLab origin: named for its folder');
});

test('adding a checkout uses it where it is: nothing is cloned, copied or written into it', (t) => {
  const { building, dataDir, work, api } = workspace(t);
  const before = execFileSync('find', [work, '-not', '-path', '*/.git/*'], { encoding: 'utf8' });
  const r = building.add(api, 'Sam');
  assert.equal(typeof r, 'object', String(r));
  assert.equal((r as FloorDef).dir, api);
  assert.equal((r as FloorDef).repo, 'acme/api');
  assert.equal((r as FloorDef).name, 'api');
  assert.equal(execFileSync('find', [work, '-not', '-path', '*/.git/*'], { encoding: 'utf8' }), before, 'the workspace folder is untouched');
  assert.deepEqual(saved(dataDir), ['api']);
});

test('a checkout can only be added once, and only if it is a checkout in the workspace folder', (t) => {
  const { building, work, api, outside } = workspace(t);
  assert.equal(typeof building.add(api, 'Sam'), 'object');
  assert.match(building.add(api, 'Sam') as string, /already has a floor/);
  assert.match(building.add(outside, 'Sam') as string, /isn't in the workspace folder/);
  assert.match(building.add(path.join(work, 'acme'), 'Sam') as string, /isn't a git checkout/);
  assert.match(building.add(path.join(work, 'missing'), 'Sam') as string, /doesn't exist/);
  assert.match(building.add('acme/api', 'Sam') as string, /full path/);
  assert.match(building.add('', 'Sam') as string, /Pick a checkout/);
  assert.match(building.add(path.join(work, '..', 'elsewhere', 'stray'), 'Sam') as string, /isn't in the workspace folder/);
});

test('the workspace folder has to be an existing folder, and moving it changes what is offered', async (t) => {
  const { building, root, notes } = workspace(t);
  assert.match(building.setProjectsDir(path.join(root, 'nope'), 'Sam') ?? '', /isn't a folder/);
  assert.match(building.setProjectsDir('relative/path', 'Sam') ?? '', /full path/);
  assert.equal(building.setProjectsDir(path.join(root, 'elsewhere'), 'Sam'), undefined);
  assert.deepEqual(
    (await building.repos()).map((r) => r.name),
    ['stray'],
  );
  assert.equal(building.projectsDirState().custom, true);
  assert.match(building.add(notes, 'Sam') as string, /isn't in the workspace folder/);
});

test("the home folder is always a floor, added after the others, once, and can't be taken off", (t) => {
  const { root, dataDir } = office(t);
  const home = path.join(root, 'home');
  mkdirSync(home);
  const building = new Building(dataDir, root);

  const def = building.ensureHome(home);
  assert.equal(def?.name, 'Home');
  assert.equal(def?.dir, home);
  assert.deepEqual(saved(dataDir), ['api', 'web', 'docs', 'home']);
  assert.ok(building.isHome('home'));
  assert.ok(!building.isHome('api'));
  assert.equal(building.ensureHome(home)?.id, 'home');
  assert.deepEqual(saved(dataDir), ['api', 'web', 'docs', 'home']);

  assert.match(building.remove('home') as string, /always in the building/);
  assert.deepEqual(saved(dataDir), ['api', 'web', 'docs', 'home']);

  // It's still there at the next start, even if nothing else is.
  const again = new Building(dataDir, root);
  assert.equal(again.ensureHome(home)?.id, 'home');
  assert.equal(again.list().length, 4);
});

test('a home floor with no projects does not count as the office having any', (t) => {
  const { root, dataDir } = office(t);
  writeFileSync(path.join(dataDir, 'floors.json'), '[]');
  const home = path.join(root, 'home');
  mkdirSync(home);
  const building = new Building(dataDir, root);
  building.ensureHome(home);
  assert.equal(building.list().length, 1);
  assert.equal(building.hasProjects(), false);
});

test('a home folder that was already added by hand is the home floor', (t) => {
  const { root, dataDir, defs } = office(t);
  const building = new Building(dataDir, root);
  assert.equal(building.ensureHome(defs[1].dir)?.id, 'web');
  assert.ok(building.isHome('web'));
  assert.match(building.remove('web') as string, /always in the building/);
  assert.deepEqual(saved(dataDir), ['api', 'web', 'docs']);
});

/** One checkout, a symlink to it inside the workspace, another checkout, and a symlink that points outside. */
function linked(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'office', '.droid-office');
  mkdirSync(dataDir, { recursive: true });
  const work = path.join(root, 'repos');
  const real = path.join(work, 'acme', 'api');
  mkdirSync(real, { recursive: true });
  execFileSync('git', ['init', '-q', real]);
  const alias = path.join(work, 'api-link');
  symlinkSync(real, alias);
  const other = path.join(work, 'acme', 'web');
  mkdirSync(other, { recursive: true });
  execFileSync('git', ['init', '-q', other]);
  const outside = path.join(root, 'elsewhere', 'secret');
  mkdirSync(outside, { recursive: true });
  execFileSync('git', ['init', '-q', outside]);
  const outsideLink = path.join(work, 'escape');
  symlinkSync(outside, outsideLink);
  const decor = path.join(real, '.droid-office', 'decor.json');
  mkdirSync(path.dirname(decor), { recursive: true });
  const pictures = '[{"id":"pic"}]';
  writeFileSync(decor, pictures);
  return { root, dataDir, work, real, alias, other, outsideLink, decor, pictures };
}

test('a symlink to a checkout that already has a floor is that floor, and the saved path stays', (t) => {
  const { dataDir, work, real, alias, decor, pictures } = linked(t);
  const building = new Building(dataDir, work);
  const first = building.add(real, 'Sam');
  assert.equal(typeof first, 'object', String(first));
  assert.equal((first as FloorDef).dir, real);
  assert.match(building.add(alias, 'Sam') as string, /already has a floor/);
  assert.deepEqual(
    building.list().map((d) => d.dir),
    [real],
  );
  assert.equal(readFileSync(decor, 'utf8'), pictures, 'the checkout’s pictures are left alone');
});

test('adding the real checkout after its symlink alias is the same floor, stored as the alias path', (t) => {
  const { dataDir, work, real, alias, decor, pictures } = linked(t);
  const building = new Building(dataDir, work);
  const first = building.add(alias, 'Sam');
  assert.equal(typeof first, 'object', String(first));
  assert.equal((first as FloorDef).dir, alias, 'the path as given is what is saved');
  assert.match(building.add(real, 'Sam') as string, /already has a floor/);
  assert.deepEqual(
    building.list().map((d) => d.dir),
    [alias],
  );
  assert.equal(readFileSync(decor, 'utf8'), pictures);
});

test('two different checkouts are still two floors', (t) => {
  const { dataDir, work, real, other } = linked(t);
  const building = new Building(dataDir, work);
  assert.equal(typeof building.add(real, 'Sam'), 'object');
  assert.equal(typeof building.add(other, 'Sam'), 'object');
  assert.deepEqual(
    building.list().map((d) => d.dir),
    [real, other],
  );
});

test('a symlink in the workspace folder that points outside it is still refused', (t) => {
  const { dataDir, work, outsideLink } = linked(t);
  const building = new Building(dataDir, work);
  assert.match(building.add(outsideLink, 'Sam') as string, /isn't in the workspace folder/);
  assert.equal(building.list().length, 0);
  assert.equal(existsSync(path.join(dataDir, 'floors.json')), false);
});

test('an alias already saved stays in floors.json and is not opened as a second floor', (t) => {
  const { dataDir, work, real, alias, other, decor, pictures } = linked(t);
  const file = path.join(dataDir, 'floors.json');
  const defs: FloorDef[] = [
    { id: 'api', name: 'api', dir: real, palette: 0, addedBy: 'Sam', addedAt: 1 },
    { id: 'api-link', name: 'api-link', dir: alias, palette: 1, addedBy: 'Sam', addedAt: 2 },
  ];
  writeFileSync(file, JSON.stringify(defs));
  const before = readFileSync(file, 'utf8');

  const building = new Building(dataDir, work);
  assert.deepEqual(
    building.list().map((d) => d.id),
    ['api'],
  );
  assert.equal(readFileSync(file, 'utf8'), before, 'loading does not rewrite the saved alias away');
  assert.match(building.add(alias, 'Sam') as string, /already has a floor/);
  assert.equal(readFileSync(file, 'utf8'), before);

  // A restart still opens one floor and still keeps both saved paths.
  const restarted = new Building(dataDir, work);
  assert.deepEqual(
    restarted.list().map((d) => d.id),
    ['api'],
  );
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(typeof restarted.add(other, 'Sam'), 'object');
  assert.deepEqual(
    restarted.list().map((d) => d.id),
    ['api', 'web'],
  );
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as FloorDef[];
  assert.deepEqual(
    onDisk.map((d) => d.id),
    ['api', 'api-link', 'web'],
  );
  assert.equal(onDisk.find((d) => d.id === 'api')?.dir, real);
  assert.equal(onDisk.find((d) => d.id === 'api-link')?.dir, alias);

  assert.equal(typeof restarted.remove('api', 'Sam'), 'object');
  assert.deepEqual(
    restarted.list().map((d) => d.id),
    ['web'],
  );
  assert.deepEqual(saved(dataDir), ['web']);
  assert.equal(readFileSync(decor, 'utf8'), pictures, 'taking the floor off does not touch the checkout');
  // The server does not open a replacement. A restart must not find the alias and start one.
  const after = new Building(dataDir, work);
  assert.deepEqual(
    after.list().map((d) => d.id),
    ['web'],
  );
  const back = after.add(alias, 'Sam');
  assert.equal(typeof back, 'object', String(back));
  assert.equal((back as FloorDef).dir, alias);
  assert.match(after.add(real, 'Sam') as string, /already has a floor/);
  assert.deepEqual(
    after.list().map((d) => d.dir),
    [other, alias],
  );
});

test('starting in a symlink of a floor already there uses that floor', (t) => {
  const { dataDir, work, real, alias } = linked(t);
  const added = new Building(dataDir, work).add(real, 'Sam');
  assert.equal(typeof added, 'object', String(added));
  const again = new Building(dataDir, work);
  const local = again.ensureLocal(alias, 'the office');
  assert.equal(local?.id, (added as FloorDef).id);
  assert.equal(local?.dir, real);
  assert.ok(local && again.isLocal(local.id));
  assert.deepEqual(
    again.list().map((d) => d.dir),
    [real],
  );
});

test('taking off the open floor drops its saved aliases and stays off through either path', (t) => {
  const { dataDir, work, real, alias, decor, pictures } = linked(t);
  const second = path.join(work, 'api-link-2');
  symlinkSync(real, second);
  writeFileSync(
    path.join(dataDir, 'floors.json'),
    JSON.stringify([
      { id: 'api', name: 'api', dir: real, palette: 0, addedBy: 'Sam', addedAt: 1 },
      { id: 'api-link', name: 'api-link', dir: alias, palette: 1, addedBy: 'Sam', addedAt: 2 },
      { id: 'api-link-2', name: 'api-link-2', dir: second, palette: 2, addedBy: 'Sam', addedAt: 3 },
    ]),
  );
  const building = new Building(dataDir, work);
  assert.equal(building.ensureLocal(real, 'the office')?.id, 'api');
  assert.deepEqual(
    building.list().map((d) => d.id),
    ['api'],
  );
  assert.equal(typeof building.remove('api', 'Sam'), 'object');
  assert.equal(building.list().length, 0);
  assert.deepEqual(saved(dataDir), []);
  assert.ok(existsSync(real));
  assert.equal(readFileSync(decor, 'utf8'), pictures);

  const again = new Building(dataDir, work);
  assert.equal(again.ensureLocal(alias, 'the office'), undefined);
  assert.equal(again.ensureLocal(second, 'the office'), undefined);
  assert.equal(again.list().length, 0);
  assert.deepEqual(saved(dataDir), []);
  assert.equal(readFileSync(decor, 'utf8'), pictures);
});

test('removing a suppressed alias drops only that row', (t) => {
  const { dataDir, work, real, alias, decor, pictures } = linked(t);
  writeFileSync(
    path.join(dataDir, 'floors.json'),
    JSON.stringify([
      { id: 'api', name: 'api', dir: real, palette: 0, addedBy: 'Sam', addedAt: 1 },
      { id: 'api-link', name: 'api-link', dir: alias, palette: 1, addedBy: 'Sam', addedAt: 2 },
    ]),
  );
  const building = new Building(dataDir, work);
  assert.equal(typeof building.remove('api-link', 'Sam'), 'object');
  assert.deepEqual(
    building.list().map((d) => d.id),
    ['api'],
  );
  assert.deepEqual(saved(dataDir), ['api']);
  assert.equal(readFileSync(decor, 'utf8'), pictures);
  assert.deepEqual(
    new Building(dataDir, work).list().map((d) => d.id),
    ['api'],
  );
});

test('a saved alias does not fill the building', (t) => {
  const { dataDir, work, real, alias, other } = linked(t);
  const extra = path.join(work, 'acme', 'extra');
  mkdirSync(extra, { recursive: true });
  execFileSync('git', ['init', '-q', extra]);
  const fillers: FloorDef[] = Array.from({ length: MAX_FLOORS - 1 }, (_, i) => {
    const id = `slot-${i}`;
    return { id, name: id, dir: path.join(work, 'filled', id), palette: 0, addedBy: 'Sam', addedAt: 1 };
  });
  fillers[0] = { id: 'api', name: 'api', dir: real, palette: 0, addedBy: 'Sam', addedAt: 1 };
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify([...fillers, { id: 'api-link', name: 'api-link', dir: alias, palette: 1, addedBy: 'Sam', addedAt: 2 }]));
  const building = new Building(dataDir, work);
  assert.equal(building.list().length, MAX_FLOORS - 1);
  assert.equal(
    building.list().some((d) => d.id === 'api-link'),
    false,
  );
  assert.equal(typeof building.add(other, 'Sam'), 'object', 'the alias does not consume the last slot');
  assert.equal(building.list().length, MAX_FLOORS);
  assert.match(building.add(extra, 'Sam') as string, /full/);
  assert.equal(
    building.list().some((d) => d.id === 'api-link'),
    false,
  );
});

test('a checkout taken off stays off when the office is started through a symlink to it', (t) => {
  const { dataDir, work, real, alias } = linked(t);
  const building = new Building(dataDir, work);
  const local = building.ensureLocal(real, 'the office');
  assert.ok(local);
  assert.equal(typeof building.remove(local.id, 'Sam'), 'object');
  const again = new Building(dataDir, work);
  assert.equal(again.ensureLocal(alias, 'the office'), undefined);
  assert.equal(again.list().length, 0);
  assert.ok(existsSync(path.join(dataDir, 'local-floor.json')));
});

test('the home floor is the same directory when it was saved through another path', (t) => {
  const { root, dataDir, work } = linked(t);
  const home = path.join(root, 'home');
  mkdirSync(home);
  const link = path.join(root, 'home-link');
  symlinkSync(home, link);
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify([{ id: 'home', name: 'Home', dir: link, palette: 0, addedBy: 'Sam', addedAt: 1 }]));
  const building = new Building(dataDir, work);
  assert.equal(building.ensureHome(home)?.id, 'home');
  assert.equal(building.list().length, 1);
  assert.equal(building.list()[0].dir, link);
  assert.ok(building.isHome('home'));
  assert.equal(building.hasProjects(), false);
  assert.match(building.remove('home') as string, /always in the building/);
  assert.deepEqual(saved(dataDir), ['home']);
});
