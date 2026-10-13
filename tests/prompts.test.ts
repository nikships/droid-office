import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROMPTS, PROMPT_IDS, PROMPT_MAX, fillPrompt, issuePromptVars, mergeCommand, placeholders, promptText, pullPromptVars, shipPromptVars } from '../src/shared/prompts.js';
import { OfficePrompts, officePrompt, type PromptSource } from '../src/server/prompts.js';
import { stationBrief } from '../src/server/stations.js';
import type { AgentChoice, PromptsState } from '../src/shared/protocol.js';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-prompts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('placeholders are filled in once, unknown ones stay, and a line with nothing to say goes', () => {
  assert.equal(fillPrompt('Fix #{{number}}: {{ title }}', { number: 12, title: 'The dog' }), 'Fix #12: The dog');
  assert.equal(fillPrompt('Keep {{this}} as it is', { number: 1 }), 'Keep {{this}} as it is');
  // What goes in isn't looked at again.
  assert.equal(fillPrompt('"{{title}}" by {{who}}', { title: '{{who}}', who: 'Ada' }), '"{{who}}" by Ada');
  assert.equal(fillPrompt('About:\n{{about}}\n\n{{pr}}\n\n{{issue}}\n\nHow it runs.\n\n{{where}}', { about: 'X', pr: '', issue: 'Issue #3.', where: '' }), 'About:\nX\n\nIssue #3.\n\nHow it runs.');
  // Empty in the middle of a line is just empty.
  assert.equal(fillPrompt("Don't change it.{{before}} List them.", { before: '' }), "Don't change it. List them.");
  assert.deepEqual(placeholders('{{a}} {{ b }} {{a}} {{9x}}'), ['a', 'b']);
});

test('every default only uses placeholders it says it has, and names the ones the office counts on', () => {
  for (const id of PROMPT_IDS) {
    const def = PROMPTS[id];
    for (const name of placeholders(def.text)) assert.ok(name in def.vars, `${id} uses {{${name}}}`);
    for (const name of def.needs ?? []) assert.ok(placeholders(def.text).includes(name), `${id} needs {{${name}}}`);
    assert.ok(def.text.trim().length > 0, id);
  }
});

test('the editor names no prompt with an emoji', () => {
  for (const id of PROMPT_IDS) assert.doesNotMatch(PROMPTS[id].label, /\p{Extended_Pictographic}/u, id);
});

test('Commit & open PR asks the worker to ship its checkout, from its task card, on either forge', () => {
  const github = fillPrompt(PROMPTS['changes.ship'].text, shipPromptVars('github', { title: 'Fix Login Redirect', summary: 'Tracing why expired sessions still reach the dashboard', branch: 'office/pixel-1', base: 'main' }));
  assert.equal(
    github,
    [
      'Commit your work in your checkout and open a pull request for it.',
      '',
      'Your task, as the card above your desk sums it up: "Fix Login Redirect"',
      '',
      'Tracing why expired sessions still reach the dashboard',
      '',
      '1. Look over what is uncommitted (`git status`, `git diff`) and commit it on `office/pixel-1` with a message that says what changed and why. Leave out anything that should not be committed, like build output or secrets, and say what you left out.',
      '2. Push `office/pixel-1` to origin.',
      '3. Open a pull request against `main` with `gh`. Title it after the task, and say in the description what changed, why, and how you checked it.',
      '4. Reply with its link.',
    ].join('\n'),
  );

  // Across repositories, with a merge request already open and no summary: the empty line goes.
  const gitlab = fillPrompt(PROMPTS['changes.ship'].text, shipPromptVars('gitlab', { title: 'Add Dark Mode', branch: 'office/nova-2', base: 'develop', folder: 'web', pr: 9 }));
  assert.match(gitlab, /^Commit your work in the `web` folder of your workspace and open a merge request for it\.\n\nYour task, as the card above your desk sums it up: "Add Dark Mode"\n\n1\. /);
  assert.match(gitlab, /3\. Merge request !9 is already open for `office\/nova-2`, so the push updates it\. If its description no longer says what the branch does, update it with `glab`\./);
});

// What the boards sent before their prompts could be rewritten, word for word, on each forge.
const GITHUB_PULL = { number: 5, title: 'Fix "{{title}}" the dog', url: 'https://github.com/o/r/pull/5', headRefName: 'feat/dog', baseRefName: 'main' };
const GITLAB_PULL = { number: 9, title: 'Fix the cat', url: 'https://gitlab.example.com/grp/sub/proj/-/merge_requests/9', headRefName: 'feat/cat', baseRefName: 'develop' };
const GITLAB_PROJECT = 'https://gitlab.example.com/grp/sub/proj';

test('the boards send what they always did on a GitHub floor', () => {
  const issue = issuePromptVars('github', { number: 7, title: 'Dog barks', url: 'https://github.com/o/r/issues/7' });
  assert.equal(
    fillPrompt(PROMPTS['issue.work'].text, issue),
    'Work on GitHub issue #7: "Dog barks".\n\nRead it first with `gh issue view 7 --comments`. Create a new branch, implement the change, verify it, then open a pull request that closes #7.',
  );
  assert.equal(fillPrompt(PROMPTS['issue.ask'].text, issue), 'This is about GitHub issue #7 "Dog barks" (https://github.com/o/r/issues/7). Read it with `gh issue view 7 --comments`.');

  const pull = pullPromptVars('github', GITHUB_PULL, 'o/r', 'o/r');
  assert.equal(
    fillPrompt(PROMPTS['pull.review'].text, pull),
    'Review pull request #5: "Fix "{{title}}" the dog".\n\nUse `gh pr view 5 --comments` and `gh pr diff 5`. Look for bugs, risky changes and missing tests, then give me a short summary with concrete suggestions. Don\'t push any commits.',
  );
  assert.equal(
    fillPrompt(PROMPTS['pull.ask'].text, pull),
    'This is about pull request #5 "Fix "{{title}}" the dog" (https://github.com/o/r/pull/5), branch `feat/dog` into `main`. Read it with `gh pr view 5 --comments` and see its changes with `gh pr diff 5`.',
  );
  const checkout =
    '1. Get onto its branch: `gh pr checkout 5`. If git says `feat/dog` is already checked out in another worktree, use `git fetch origin feat/dog && git checkout --detach FETCH_HEAD` instead and push with `git push origin HEAD:feat/dog`.';
  assert.equal(
    fillPrompt(PROMPTS['pull.fixMerge'].text, { ...pull, merge: mergeCommand('github', 5, 'squash', true, 'o/r', 'o/r') }),
    [
      'Get pull request #5 "Fix "{{title}}" the dog" (https://github.com/o/r/pull/5) ready and merge it.',
      '',
      checkout,
      '2. Read all the feedback: `gh pr view 5 --comments`, and the comments on lines of code with `gh api repos/o/r/pulls/5/comments`.',
      '3. Address every review comment that is still open: fix it, or if you disagree, reply on the PR saying why. If the branch conflicts with `main`, merge `main` in and resolve the conflicts.',
      '4. Verify your changes the way this project does (build, typecheck, tests), then commit and push.',
      '5. Wait for the checks with `gh pr checks 5 --watch` and fix anything that fails.',
      '6. When the checks pass and no feedback is left, merge it: `gh pr merge 5 --squash --delete-branch --repo o/r`. If something only a person can decide is in the way, stop and tell me instead of merging.',
      '7. Once it has merged, leave your checkout on the latest `main` for the next worker: `git fetch origin && git switch main && git pull --ff-only`. If git says `main` is checked out in another worktree, run `git fetch origin && git switch --detach origin/main` instead.',
    ].join('\n'),
  );
  assert.equal(
    fillPrompt(PROMPTS['pull.fixConflicts'].text, { ...pull, merge: mergeCommand('github', 5, 'rebase', false, 'o/r', 'o/r') }),
    [
      'Pull request #5 "Fix "{{title}}" the dog" (https://github.com/o/r/pull/5) has merge conflicts with `main`. Resolve them and merge it.',
      '',
      checkout,
      '2. Bring in the latest `main`: `git fetch origin main && git merge origin/main`.',
      "3. Resolve every conflict so both sides' changes survive. Read the PR (`gh pr view 5`) and the `main` commits that touched the same code to see what each side meant; don't just take one side.",
      '4. Verify the result the way this project does (build, typecheck, tests), then commit the merge and push.',
      '5. Wait for the checks with `gh pr checks 5 --watch` and fix anything that fails.',
      '6. When the checks pass, merge it: `gh pr merge 5 --rebase --repo o/r`. If a conflict needs a decision only a person can make, stop and tell me instead of merging.',
      '7. Once it has merged, leave your checkout on the latest `main` for the next worker: `git fetch origin && git switch main && git pull --ff-only`. If git says `main` is checked out in another worktree, run `git fetch origin && git switch --detach origin/main` instead.',
    ].join('\n'),
  );
});

test('the boards send what they always did on a GitLab floor', () => {
  const issue = issuePromptVars('gitlab', { number: 3, title: 'Cat meows', url: 'https://gitlab.example.com/grp/sub/proj/-/issues/3' });
  assert.equal(
    fillPrompt(PROMPTS['issue.work'].text, issue),
    'Work on GitLab issue #3: "Cat meows".\n\nRead it first with `glab issue view 3 --comments`. Create a new branch, implement the change, verify it, then open a merge request with `glab mr create` whose description says "Closes #3".',
  );
  assert.equal(fillPrompt(PROMPTS['issue.ask'].text, issue), 'This is about GitLab issue #3 "Cat meows" (https://gitlab.example.com/grp/sub/proj/-/issues/3). Read it with `glab issue view 3 --comments`.');

  const pull = pullPromptVars('gitlab', GITLAB_PULL, 'grp/sub/proj', GITLAB_PROJECT);
  assert.equal(
    fillPrompt(PROMPTS['pull.review'].text, pull),
    'Review merge request !9: "Fix the cat".\n\nUse `glab mr view 9 --comments` and `glab mr diff 9`. Look for bugs, risky changes and missing tests, then give me a short summary with concrete suggestions. Don\'t push any commits.',
  );
  assert.equal(
    fillPrompt(PROMPTS['pull.ask'].text, pull),
    'This is about merge request !9 "Fix the cat" (https://gitlab.example.com/grp/sub/proj/-/merge_requests/9), branch `feat/cat` into `develop`. Read it with `glab mr view 9 --comments` and see its changes with `glab mr diff 9`.',
  );
  const checkout =
    '1. Get onto its branch: `glab mr checkout 9`. If git says `feat/cat` is already checked out in another worktree, use `git fetch origin feat/cat && git checkout --detach FETCH_HEAD` instead and push with `git push origin HEAD:feat/cat`.';
  assert.equal(
    fillPrompt(PROMPTS['pull.fixMerge'].text, { ...pull, merge: mergeCommand('gitlab', 9, 'squash', true, 'grp/sub/proj', GITLAB_PROJECT) }),
    [
      'Get merge request !9 "Fix the cat" (https://gitlab.example.com/grp/sub/proj/-/merge_requests/9) ready and merge it.',
      '',
      checkout,
      '2. Read all the feedback: `glab mr view 9 --comments`, and the threads on lines of code with `glab mr note list 9 --type diff --state unresolved`.',
      '3. Address every review comment that is still open: fix it, or if you disagree, reply on the MR saying why. If the branch conflicts with `develop`, merge `develop` in and resolve the conflicts.',
      '4. Verify your changes the way this project does (build, typecheck, tests), then commit and push.',
      '5. Wait for the checks with `glab ci status --branch feat/cat --wait` and fix anything that fails.',
      '6. When the checks pass and no feedback is left, merge it: `glab mr merge 9 --squash --remove-source-branch --auto-merge=false --yes --repo https://gitlab.example.com/grp/sub/proj`. If something only a person can decide is in the way, stop and tell me instead of merging.',
      '7. Once it has merged, leave your checkout on the latest `develop` for the next worker: `git fetch origin && git switch develop && git pull --ff-only`. If git says `develop` is checked out in another worktree, run `git fetch origin && git switch --detach origin/develop` instead.',
    ].join('\n'),
  );
  assert.equal(
    fillPrompt(PROMPTS['pull.fixConflicts'].text, { ...pull, merge: mergeCommand('gitlab', 9, 'merge', false, 'grp/sub/proj', GITLAB_PROJECT) }),
    [
      'Merge request !9 "Fix the cat" (https://gitlab.example.com/grp/sub/proj/-/merge_requests/9) has merge conflicts with `develop`. Resolve them and merge it.',
      '',
      checkout,
      '2. Bring in the latest `develop`: `git fetch origin develop && git merge origin/develop`.',
      "3. Resolve every conflict so both sides' changes survive. Read the MR (`glab mr view 9 --comments`) and the `develop` commits that touched the same code to see what each side meant; don't just take one side.",
      '4. Verify the result the way this project does (build, typecheck, tests), then commit the merge and push.',
      '5. Wait for the checks with `glab ci status --branch feat/cat --wait` and fix anything that fails.',
      '6. When the checks pass, merge it: `glab mr merge 9 --auto-merge=false --yes --repo https://gitlab.example.com/grp/sub/proj`. If a conflict needs a decision only a person can make, stop and tell me instead of merging.',
      '7. Once it has merged, leave your checkout on the latest `develop` for the next worker: `git fetch origin && git switch develop && git pull --ff-only`. If git says `develop` is checked out in another worktree, run `git fetch origin && git switch --detach origin/develop` instead.',
    ].join('\n'),
  );
});

test('a rewritten board prompt fills in the floor it is sent on', () => {
  const text = 'Merge {{ref}} with `{{merge}}` via {{cli}}';
  const gh = pullPromptVars('github', GITHUB_PULL, 'o/r', 'o/r');
  const gl = pullPromptVars('gitlab', GITLAB_PULL, 'grp/sub/proj', GITLAB_PROJECT);
  assert.equal(fillPrompt(text, { ...gh, merge: mergeCommand('github', 5, 'merge', true, 'o/r', 'o/r') }), 'Merge #5 with `gh pr merge 5 --merge --delete-branch --repo o/r` via gh');
  assert.equal(
    fillPrompt(text, { ...gl, merge: mergeCommand('gitlab', 9, 'merge', true, 'grp/sub/proj', GITLAB_PROJECT) }),
    `Merge !9 with \`glab mr merge 9 --remove-source-branch --auto-merge=false --yes --repo ${GITLAB_PROJECT}\` via glab`,
  );
});

test('the board agents are briefed for their forge on both forges', () => {
  for (const forge of ['github', 'gitlab'] as const) {
    const [site, cli, pull] = forge === 'gitlab' ? ['GitLab', 'glab', 'merge request'] : ['GitHub', 'gh', 'pull request'];
    for (const kind of ['issues', 'pulls', 'actions'] as const) {
      const b = stationBrief(kind, forge);
      assert.doesNotMatch(b, /\{\{/, `${forge} ${kind}`);
      assert.doesNotMatch(b, /task queue|office-queue/, `${forge} ${kind}`);
      assert.match(b, new RegExp(`to open a ${pull}\\.`), `${forge} ${kind}`);
      assert.ok(b.endsWith('The request:'));
    }
    assert.match(stationBrief('issues', forge), new RegExp(`${site} issues with the ${cli} CLI`));
  }
  assert.match(stationBrief('pulls', 'gitlab'), /merge requests with the glab CLI: sum them up and review them \(glab mr view --comments, glab mr diff, glab ci status\)/);
  assert.equal(
    stationBrief('issues', 'github').split('\n\n')[1],
    "You look after this repository's GitHub issues with the gh CLI: file new ones (a clear title, what's wrong or wanted, and how to reproduce it when that applies), find and sum them up, triage, label, comment on, close and reopen them.",
  );
});

test('a rewritten prompt is kept, used, and put back to the default', (t) => {
  const dir = scratch(t);
  const told: PromptsState[] = [];
  const book = new OfficePrompts(dir, (s) => told.push(s));
  assert.equal(book.setPrompt('issue.work', 'Just do #{{number}}\r\n', 'Ada'), undefined);
  assert.equal(book.text('issue.work'), 'Just do #{{number}}');
  assert.equal(book.state().custom['issue.work']?.by, 'Ada');
  assert.equal(told.length, 1);

  // It's there after a restart.
  const again = new OfficePrompts(dir, () => {});
  assert.equal(officePrompt(again, 'issue.work', { number: 4 }), 'Just do #4');

  // The default's own text, or null, puts the default back.
  assert.equal(book.setPrompt('issue.work', PROMPTS['issue.work'].text, 'Ada'), undefined);
  assert.equal(book.state().custom['issue.work'], undefined);
  book.setPrompt('pull.review', 'Look at it', 'Ada');
  assert.equal(book.setPrompt('pull.review', null, 'Grace'), undefined);
  assert.equal(book.text('pull.review'), PROMPTS['pull.review'].text);

  // Empty only where empty means "send nothing"; never too long, never an unknown prompt.
  assert.match(book.setPrompt('issue.work', '  ', 'Ada') ?? '', /can’t be empty/);
  assert.equal(book.setPrompt('issue.ask', '', 'Ada'), undefined);
  assert.equal(book.text('issue.ask'), '');
  assert.match(book.setPrompt('issue.work', 'x'.repeat(PROMPT_MAX + 1), 'Ada') ?? '', /at most/);
  assert.match(book.setPrompt('nope', 'x', 'Ada') ?? '', /Unknown prompt/);
  assert.match(book.setPrompt('constructor', 'x', 'Ada') ?? '', /Unknown prompt/);
  assert.equal(promptText(book.state().custom, 'office.namer'), PROMPTS['office.namer'].text);
});

test('the default worker is checked before it is kept, and one the office can no longer start is forgotten', (t) => {
  const dir = scratch(t);
  const book = new OfficePrompts(dir, () => {});
  assert.equal(book.agent(), undefined);
  assert.match(book.setAgent({ model: 'has a space' }, 'Ada') ?? '', /Invalid Droid model/);
  assert.match(book.setAgent({ model: 'glm-5.3-flash', effort: 'turbo' } as unknown as AgentChoice, 'Ada') ?? '', /Invalid effort/);
  assert.equal(book.setAgent({ model: 'custom:droidproxy:opus-5-5', effort: 'high' }, 'Ada'), undefined);
  assert.deepEqual(book.agent(), { model: 'custom:droidproxy:opus-5-5', effort: 'high' });
  assert.equal(book.state().agent?.by, 'Ada');
  assert.deepEqual(new OfficePrompts(dir, () => {}).agent(), { model: 'custom:droidproxy:opus-5-5', effort: 'high' });
  assert.equal(book.setAgent({ model: 'opus', effort: 'high' }, 'Ada'), undefined);
  assert.deepEqual(book.agent(), { model: 'opus', effort: 'high' });
  assert.equal(book.setAgent(null, 'Ada'), undefined);
  assert.equal(book.agent(), undefined);

  const file = path.join(dir, 'prompts.json');
  writeFileSync(file, JSON.stringify({ custom: {}, agent: { model: 'opus', by: 'Ada', at: 1 } }));
  assert.deepEqual(new OfficePrompts(dir, () => {}).agent(), { model: 'opus' });
  // A broken file is the defaults.
  writeFileSync(file, '{nope');
  assert.deepEqual(new OfficePrompts(dir, () => {}).state(), { custom: {} });
  assert.ok(readFileSync(file, 'utf8'));
});

test('a board agent is told its rewritten brief, with the floor filled in', () => {
  const source: PromptSource = { text: (id) => (id === 'station.pulls' ? 'You review {{pullName}}s with {{site}}. The request:' : PROMPTS[id].text), agent: () => undefined };
  assert.equal(stationBrief('pulls', 'github', source), 'You review pull requests with GitHub. The request:');
  assert.equal(stationBrief('pulls', 'gitlab', source), 'You review merge requests with GitLab. The request:');
  assert.equal(stationBrief('issues', 'gitlab', source), stationBrief('issues', 'gitlab'));
});
