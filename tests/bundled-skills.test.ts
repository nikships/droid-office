import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BUNDLED_SKILL_MARK, BundledSkills, defaultCompatSkillDirs, discoverBundledSkills, findBundledSkillsDir, parseSkillFrontmatter, removeManagedSkill, syncBundledSkills, withManagedMark } from '../src/server/bundled-skills.js';
import type { BundledSkillsState } from '../src/shared/protocol.js';

const EXPECTED_SKILLS = ['babysit-pr', 'council', 'file-pr', 'full-send', 'full-stop', 'leaving-pr-comments', 'modernize', 'sol-loop', 'takeover'] as const;

function tempRig(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-bundled-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const home = path.join(root, 'home');
  const skillsDir = path.join(home, '.factory', 'skills');
  const agentsSkillsDir = path.join(home, '.agents', 'skills');
  const agentSkillsDir = path.join(home, '.agent', 'skills');
  mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, home, skillsDir, agentsSkillsDir, agentSkillsDir };
}

test('bundled skills directory ships all nine skills with valid frontmatter and executable pr-wait', () => {
  const sourceDir = findBundledSkillsDir();
  assert.ok(sourceDir, 'skills/ directory should be found next to package.json');
  assert.equal(existsSync(path.join(sourceDir, 'LICENSE')), true, 'MIT license attribution is bundled');

  const specs = discoverBundledSkills(sourceDir);
  assert.deepEqual(
    specs.map((s) => s.name),
    [...EXPECTED_SKILLS],
  );

  for (const spec of specs) {
    assert.ok(spec.description.length > 10, `${spec.name} has a routing description`);
    assert.equal(spec.userInvocable, spec.name !== 'leaving-pr-comments', `${spec.name} userInvocable`);
    const skillMd = spec.files.find((f) => f.relPath === 'SKILL.md');
    assert.ok(skillMd, `${spec.name} ships SKILL.md`);
    const text = skillMd.content.toString('utf8');
    assert.ok(text.startsWith('---\n'), `${spec.name} keeps YAML frontmatter on line 1`);
    assert.ok(text.includes(BUNDLED_SKILL_MARK), `${spec.name} carries the Droid Office managed marker`);
  }

  const babysit = specs.find((s) => s.name === 'babysit-pr')!;
  const prWait = babysit.files.find((f) => f.relPath === 'scripts/pr-wait');
  assert.ok(prWait, 'babysit-pr ships scripts/pr-wait');
  assert.equal(prWait.executable, true, 'scripts/pr-wait is executable');

  const scriptPath = path.join(sourceDir, 'babysit-pr', 'scripts', 'pr-wait');
  const help = execFileSync('python3', [scriptPath, '--help'], { encoding: 'utf8' });
  assert.match(help, /Watch a GitHub PR until ready or blocked/);
});

test('packaging manifests include bundled skills', () => {
  const root = new URL('../', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { files?: string[] };
  assert.ok(pkg.files?.includes('skills'), 'package.json files includes skills');
  const builder = readFileSync(new URL('electron-builder.yml', root), 'utf8');
  assert.match(builder, /^\s*-\s+skills\/\*\*\/\*\s*$/m, 'electron-builder.yml files includes skills/**/*');
});

test('parseSkillFrontmatter and withManagedMark preserve line-1 frontmatter cleanly', () => {
  const raw = '---\nname: sample\ndescription: "Run sample workflow."\nuser-invocable: false\n---\n\n# Sample\nBody\n';
  const parsed = parseSkillFrontmatter(raw);
  assert.ok(parsed);
  assert.equal(parsed.name, 'sample');
  assert.equal(parsed.description, 'Run sample workflow.');
  assert.equal(parsed.userInvocable, false);

  const marked = withManagedMark(raw);
  assert.ok(marked.startsWith('---\n'));
  assert.equal(withManagedMark(marked), marked, 'marking is idempotent');
  assert.equal(parseSkillFrontmatter(marked)?.name, 'sample');
});

test('syncBundledSkills installs all skills, preserves +x on pr-wait, and is idempotent', (t) => {
  const rig = tempRig(t);
  const first = syncBundledSkills({ skillsDir: rig.skillsDir, on: true, disabled: [] });
  assert.deepEqual(first.problems, []);
  assert.equal(first.entries.length, EXPECTED_SKILLS.length);
  for (const entry of first.entries) {
    assert.equal(entry.status, 'installed', entry.name);
    assert.equal(existsSync(path.join(rig.skillsDir, entry.name, 'SKILL.md')), true);
    assert.ok(readFileSync(path.join(rig.skillsDir, entry.name, 'SKILL.md'), 'utf8').includes(BUNDLED_SKILL_MARK));
  }

  const installedPrWait = path.join(rig.skillsDir, 'babysit-pr', 'scripts', 'pr-wait');
  assert.equal(existsSync(installedPrWait), true);
  assert.notEqual(statSync(installedPrWait).mode & 0o111, 0, 'installed pr-wait keeps executable bit');

  const mtimeBefore = statSync(installedPrWait).mtimeMs;
  const second = syncBundledSkills({ skillsDir: rig.skillsDir, on: true, disabled: [] });
  assert.deepEqual(second.problems, []);
  assert.equal(statSync(installedPrWait).mtimeMs, mtimeBefore, 'unchanged files are not rewritten');
});

test('syncBundledSkills never overwrites unmarked user skills and respects ~/.agents/skills overrides without shadowing', (t) => {
  const rig = tempRig(t);
  assert.deepEqual(defaultCompatSkillDirs(rig.skillsDir), [rig.agentsSkillsDir, rig.agentSkillsDir]);

  // First install everything normally.
  syncBundledSkills({ skillsDir: rig.skillsDir, on: true, disabled: [] });
  assert.equal(existsSync(path.join(rig.skillsDir, 'full-send', 'SKILL.md')), true);

  // User adds their own copy of full-send in ~/.agents/skills and custom file-pr directly in ~/.factory/skills.
  mkdirSync(path.join(rig.agentsSkillsDir, 'full-send'), { recursive: true });
  writeFileSync(path.join(rig.agentsSkillsDir, 'full-send', 'SKILL.md'), '---\nname: full-send\ndescription: My custom full-send\n---\nCustom\n');

  const customFilePr = path.join(rig.skillsDir, 'file-pr', 'SKILL.md');
  writeFileSync(customFilePr, '---\nname: file-pr\ndescription: My custom file-pr\n---\nMine\n');

  const res = syncBundledSkills({ skillsDir: rig.skillsDir, on: true, disabled: [] });
  assert.deepEqual(res.problems, []);

  // full-send managed copy is removed from ~/.factory/skills so it does not shadow ~/.agents/skills/full-send!
  assert.equal(existsSync(path.join(rig.skillsDir, 'full-send')), false);
  const fullSend = res.entries.find((e) => e.name === 'full-send');
  assert.equal(fullSend?.status, 'overridden');
  assert.equal(fullSend?.overriddenBy, path.join(rig.agentsSkillsDir, 'full-send'));

  // file-pr unmarked copy in ~/.factory/skills stays untouched.
  assert.equal(readFileSync(customFilePr, 'utf8'), '---\nname: file-pr\ndescription: My custom file-pr\n---\nMine\n');
  const filePr = res.entries.find((e) => e.name === 'file-pr');
  assert.equal(filePr?.status, 'overridden');
  assert.equal(filePr?.overriddenBy, path.join(rig.skillsDir, 'file-pr'));
});

test('disabling individual skills or the whole pack removes only Droid Office-managed files', (t) => {
  const rig = tempRig(t);
  const states: BundledSkillsState[] = [];
  const controller = new BundledSkills(rig.dataDir, rig.skillsDir, (s) => states.push(s));
  assert.deepEqual(controller.sync(), []);

  // Drop an unrelated user note inside babysit-pr; turning babysit-pr off must keep that user note!
  const userNote = path.join(rig.skillsDir, 'babysit-pr', 'my-notes.md');
  writeFileSync(userNote, 'keep me');

  assert.deepEqual(controller.set({ disabled: ['babysit-pr', 'unknown-skill'] }, 'Nik'), []);
  assert.deepEqual(controller.state().disabled, ['babysit-pr']);
  assert.equal(existsSync(path.join(rig.skillsDir, 'babysit-pr', 'SKILL.md')), false);
  assert.equal(existsSync(path.join(rig.skillsDir, 'babysit-pr', 'scripts', 'pr-wait')), false);
  assert.equal(existsSync(path.join(rig.skillsDir, 'babysit-pr', 'scripts')), false);
  assert.equal(readFileSync(userNote, 'utf8'), 'keep me');
  assert.equal(existsSync(path.join(rig.skillsDir, 'council', 'SKILL.md')), true);

  // Turn the whole pack off.
  assert.deepEqual(controller.set({ on: false }, 'Nik'), []);
  assert.equal(controller.on, false);
  assert.equal(existsSync(path.join(rig.skillsDir, 'council')), false);
  assert.equal(readFileSync(userNote, 'utf8'), 'keep me');
  assert.equal(states.at(-1)?.by, 'Nik');

  // Persists across restart, and corrupt JSON falls back to defaults.
  const reloaded = new BundledSkills(rig.dataDir, rig.skillsDir, () => {});
  assert.equal(reloaded.on, false);
  assert.deepEqual(reloaded.state().disabled, ['babysit-pr']);

  writeFileSync(path.join(rig.dataDir, 'bundled-skills.json'), '{not valid json');
  const recovered = new BundledSkills(rig.dataDir, undefined, () => {});
  assert.equal(recovered.on, true);
  assert.deepEqual(recovered.state().disabled, []);
});

test('syncBundledSkills without skillsDir does not touch disk, and removeManagedSkill ignores unmanaged folders', (t) => {
  const rig = tempRig(t);
  const res = syncBundledSkills({ skillsDir: undefined, on: true, disabled: ['council'] });
  assert.deepEqual(res.problems, []);
  assert.equal(existsSync(rig.skillsDir), false);
  assert.equal(res.entries.find((e) => e.name === 'council')?.status, 'disabled');
  assert.equal(res.entries.find((e) => e.name === 'full-send')?.status, 'installed');

  const unmanaged = path.join(rig.root, 'unmanaged');
  mkdirSync(unmanaged, { recursive: true });
  writeFileSync(path.join(unmanaged, 'SKILL.md'), 'user authored');
  assert.equal(removeManagedSkill(unmanaged), undefined);
  assert.equal(readFileSync(path.join(unmanaged, 'SKILL.md'), 'utf8'), 'user authored');

  // If the user overwrote SKILL.md with an unmarked copy while a stale manifest remains, leave everything untouched.
  const replaced = path.join(rig.root, 'replaced');
  mkdirSync(path.join(replaced, 'scripts'), { recursive: true });
  writeFileSync(path.join(replaced, 'SKILL.md'), 'user replaced');
  writeFileSync(path.join(replaced, 'scripts', 'pr-wait'), 'custom script');
  writeFileSync(path.join(replaced, '.droid-office-managed.json'), JSON.stringify({ version: 1, files: { 'SKILL.md': 'a', 'scripts/pr-wait': 'b' } }));
  assert.equal(removeManagedSkill(replaced), undefined);
  assert.equal(readFileSync(path.join(replaced, 'SKILL.md'), 'utf8'), 'user replaced');
  assert.equal(readFileSync(path.join(replaced, 'scripts', 'pr-wait'), 'utf8'), 'custom script');
});
