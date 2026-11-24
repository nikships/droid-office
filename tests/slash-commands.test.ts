import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applySlash, findSlashQuery, nativeCopy, nativeLimits, sideQuestion, SLASH_COMMANDS, slashCommands, slashKind, slashOf, slashRefusal, slashSuggestions } from '../src/shared/slash-commands.js';

test('the Android app lists the same slash commands', () => {
  const kotlin = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/core/SlashCommands.kt', import.meta.url), 'utf8');
  const parsed = [...kotlin.matchAll(/Command\("([^"]+)", "([^"]+)", Kind\.(\w+)(?:, listOf\(([^)]*)\))?(, midTurn = true)?\)/g)].map((m) => ({
    name: m[1],
    description: m[2],
    kind: m[3].toLowerCase(),
    aliases: m[4] ? [...m[4].matchAll(/"([^"]+)"/g)].map((a) => a[1]) : [],
    midTurn: !!m[5],
  }));
  assert.deepEqual(
    parsed,
    SLASH_COMMANDS.map((c) => ({ name: c.name, description: c.description, kind: c.kind, aliases: [...(c.aliases ?? [])], midTurn: !!c.midTurn })),
  );
});

test('reads the command a draft asks for, by name or alias', () => {
  assert.equal(slashOf('hello'), undefined);
  assert.equal(slashOf('/etc/hosts is wrong'), undefined);
  assert.equal(slashRefusal('/etc/hosts is wrong', 'Byte', true), undefined);
  assert.deepEqual(slashOf('  /Model gpt'), { name: 'model', command: SLASH_COMMANDS.find((c) => c.name === 'model') });
  assert.equal(slashOf('/exit')?.command?.name, 'quit');
  assert.equal(slashOf('/my-skill do it')?.command, undefined);
  assert.equal(slashOf('/my-skill do it')?.name, 'my-skill');
  assert.equal(slashKind('/settings'), 'tty');
  for (const removed of ['status', 'context', 'stats', 'rename', 'fork', 'cost', 'help']) assert.equal(slashOf(`/${removed}`)?.command, undefined, `/${removed} is not offered`);
  assert.equal(slashOf('/side what now')?.command?.name, 'btw');
  assert.equal(slashOf('/workstreams')?.command?.name, 'missions');
  assert.equal(slashKind('/compact keep the plan'), 'thread');
  assert.equal(slashKind('/quit'), 'blocked');
  assert.equal(slashKind('/my-skill'), 'thread');
  assert.equal(slashKind('plain text'), 'thread');
});

test('limits opens natively whenever Factory is connected, including unknown and inapplicable windows', () => {
  assert.equal(nativeLimits('/limits', true), true);
  assert.equal(nativeLimits('  /LIMITS ', true), true);
  assert.equal(nativeLimits('/limits', false), false);
  assert.equal(slashKind('/limits'), 'tty', 'disconnected clients retain the CLI fallback');
  assert.equal(nativeLimits('/model', true), false);
  assert.equal(nativeLimits('/limits/file', true), false);
  assert.equal(nativeLimits('show /limits', true), false);
});

test('suggests names that start with what is typed, then aliases, then names containing it', () => {
  assert.deepEqual(
    slashSuggestions('/st').map((c) => c.name),
    ['statusline', 'fast', 'install-code-review', 'diagnostics', 'install-slack-app'],
  );
  assert.deepEqual(
    slashSuggestions('/res').map((c) => c.name),
    ['sessions', 'compress', 'setup-incident-response'],
  );
  assert.deepEqual(slashSuggestions('/'), SLASH_COMMANDS);
  assert.deepEqual(slashSuggestions('/model '), []);
  assert.deepEqual(slashSuggestions('model'), []);
  assert.equal(slashSuggestions('/tus')[0].name, 'statusline');
});

test('adds the worker’s skills and custom commands after the built-in ones, never shadowing one', () => {
  const all = slashCommands([
    { name: 'review', description: 'Custom command: review', source: 'command' },
    { name: 'Compact', description: 'A skill named like an alias', source: 'skill' },
    { name: 'model', description: 'A skill named like a built-in', source: 'skill' },
    { name: 'security-review', description: 'Security-focused code review', source: 'skill', argumentHint: '[path]' },
    { name: 'review', description: 'The built-in review skill', source: 'skill' },
    { name: 'odd', description: 'From an unknown place', source: 'plugin' as 'skill' },
  ]);
  assert.deepEqual(all.slice(0, SLASH_COMMANDS.length), [...SLASH_COMMANDS]);
  assert.deepEqual(all.slice(SLASH_COMMANDS.length), [{ name: 'security-review', description: 'Security-focused code review', kind: 'thread', source: 'skill', argumentHint: '[path]' }]);
  assert.deepEqual(slashCommands(), [...SLASH_COMMANDS]);
  assert.deepEqual(slashSuggestions('/', all), all, 'skills and custom commands remain reachable beyond the first eight rows');
  assert.equal(slashOf('/Security-Review the diff', all)?.command?.source, 'skill');
  assert.equal(slashOf('/security-review', SLASH_COMMANDS)?.command, undefined);
  assert.deepEqual(
    slashSuggestions('/rev', all).map((c) => c.name),
    ['review', 'install-code-review', 'security-review'],
  );
});

test('refuses ending the CLI, and while a turn runs every command Droid would not run mid-turn', () => {
  assert.equal(slashRefusal('hello', 'Byte', true), undefined);
  assert.equal(slashRefusal('/new', 'Byte', false), undefined);
  assert.equal(slashRefusal('/my-skill', 'Byte', false), undefined);
  assert.match(slashRefusal('/exit', 'Byte', false) ?? '', /^\/exit would end Byte’s Droid/);
  assert.equal(slashRefusal('/new', 'Byte', true), '/new runs once Byte finishes this turn. Stop it to run it now.');
  assert.match(slashRefusal('/my-skill', 'Byte', true) ?? '', /^\/my-skill runs once Byte finishes/, 'Droid cannot resolve a queued skill');
  for (const draft of ['/model', '/settings', '/copy', '/btw what is this?', '/side huh', '/mcp', '/review', '/favorite']) assert.equal(slashRefusal(draft, 'Byte', true), undefined, draft);
  for (const draft of ['/tree', '/fast', '/archive', '/compress', '/rewind-conversation', '/cd ..', '/handoff']) assert.ok(slashRefusal(draft, 'Byte', true), draft);
  const custom = slashCommands([{ name: 'deploy', description: 'Ship it', source: 'command' }]);
  assert.ok(slashRefusal('/deploy', 'Byte', true, custom));
});

test('a bare /copy opens the Thread’s copy menu and /btw asks its side question', () => {
  assert.equal(nativeCopy('/copy'), true);
  assert.equal(nativeCopy('  /COPY  '), true);
  assert.equal(nativeCopy('/copy 3'), false, 'arguments go to Droid');
  assert.equal(nativeCopy('/copyright'), false);
  assert.equal(sideQuestion('/btw what is this repo?'), 'what is this repo?');
  assert.equal(sideQuestion('/side  why?'), 'why?');
  assert.equal(sideQuestion('/btw'), '');
  assert.equal(sideQuestion('what /btw'), undefined);
  assert.equal(sideQuestion('/model'), undefined);
});

test('findSlashQuery, applySlash, and mid-prompt slashSuggestions offer skills in place and ignore paths/URLs/comments', () => {
  const all = slashCommands([
    { name: 'deploy', description: 'Custom command: deploy', source: 'command' },
    { name: 'full-send', description: 'Drive a change end-to-end', source: 'skill' },
    { name: 'full-stop', description: 'Drive a change and stop', source: 'skill' },
    { name: 'full', description: 'Short exact skill', source: 'skill' },
    { name: 'sol-loop', description: 'Run a Sol review loop', source: 'skill' },
  ]);

  assert.deepEqual(findSlashQuery('/full', 5), { start: 0, end: 5, query: 'full', atStart: true });
  assert.deepEqual(findSlashQuery('  /full', 7), { start: 2, end: 7, query: 'full', atStart: true });
  assert.deepEqual(findSlashQuery('fix bug /full', 13), { start: 8, end: 13, query: 'full', atStart: false });
  assert.deepEqual(findSlashQuery('fix bug\n\n/', 10), { start: 9, end: 10, query: '', atStart: false });
  assert.deepEqual(findSlashQuery('fix /full-send now', 7), { start: 4, end: 14, query: 'fu', atStart: false });

  // Paths, URLs, comments, JSX, mid-word slashes, and trailing spaces return null.
  for (const sample of ['https://example.com/full', 'src/client/ui', 'UI/UX', '1/2', '(/full', '"/full', 'fix /etc/hosts', 'fix //comment', 'fix /*', '<Tag />', '/full ', '']) {
    assert.equal(findSlashQuery(sample, sample.length), null, `expected null for ${JSON.stringify(sample)}`);
  }
  assert.equal(findSlashQuery('/etc/hosts', 4), null);
  assert.equal(findSlashQuery('//', 1), null);
  assert.equal(findSlashQuery('/full', 0), null);

  // Mid-prompt offers skills only (never built-ins or custom commands), with exact match first.
  assert.deepEqual(
    slashSuggestions('fix bug\n\n/', all).map((c) => c.name),
    ['full-send', 'full-stop', 'full', 'sol-loop'],
  );
  assert.deepEqual(
    slashSuggestions('fix bug /full', all).map((c) => c.name),
    ['full', 'full-send', 'full-stop'],
  );
  assert.deepEqual(slashSuggestions('fix bug /dep', all), []);
  assert.deepEqual(slashSuggestions('fix bug /mod', all), []);

  // Leading non-skill slash command owns the message; leading skill or plain unresolved path allows inline skills.
  assert.deepEqual(slashSuggestions('/model /full', all), []);
  assert.deepEqual(slashSuggestions('/deploy /full', all), []);
  assert.deepEqual(
    slashSuggestions('/tmp is where logs are; /full', all).map((c) => c.name),
    ['full', 'full-send', 'full-stop'],
  );
  assert.deepEqual(
    slashSuggestions('/full-send then /sol', all).map((c) => c.name),
    ['sol-loop'],
  );
  assert.deepEqual(
    slashSuggestions('/etc/hosts is wrong, /sol', all).map((c) => c.name),
    ['sol-loop'],
  );

  // inlineOnly (e.g. Ask modal with prepended context) treats the whole draft as inline skills.
  assert.deepEqual(
    slashSuggestions('/model and then /full', all, undefined, true).map((c) => c.name),
    ['full', 'full-send', 'full-stop'],
  );
  assert.deepEqual(slashSuggestions('/mod', all, undefined, true), []);

  // Cursor inside an earlier slash token replaces only that token without duplicating spaces.
  assert.deepEqual(
    slashSuggestions('fix /fu please', all, 7).map((c) => c.name),
    ['full-send', 'full-stop', 'full'],
  );
  assert.deepEqual(applySlash('fix bug\n\n/full', 9, 14, 'full-send'), { value: 'fix bug\n\n/full-send ', cursor: 20 });
  assert.deepEqual(applySlash('fix /fu please', 4, 7, 'full-send'), { value: 'fix /full-send please', cursor: 15 });
  assert.deepEqual(applySlash('/full-sen check', 0, 9, 'full-send'), { value: '/full-send check', cursor: 11 });
});
