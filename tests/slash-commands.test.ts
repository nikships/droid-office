import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SLASH_COMMANDS, slashCommands, slashKind, slashOf, slashRefusal, slashSuggestions } from '../src/shared/slash-commands.js';

test('the Android app lists the same slash commands', () => {
  const kotlin = readFileSync(new URL('../android/app/src/main/java/ai/factory/droidoffice/core/SlashCommands.kt', import.meta.url), 'utf8');
  const parsed = [...kotlin.matchAll(/Command\("([^"]+)", "([^"]+)", Kind\.(\w+)(?:, listOf\(([^)]*)\))?\)/g)].map((m) => ({
    name: m[1],
    description: m[2],
    kind: m[3].toLowerCase(),
    aliases: m[4] ? [...m[4].matchAll(/"([^"]+)"/g)].map((a) => a[1]) : [],
  }));
  assert.deepEqual(
    parsed,
    SLASH_COMMANDS.map((c) => ({ name: c.name, description: c.description, kind: c.kind, aliases: [...(c.aliases ?? [])] })),
  );
});

test('reads the command a draft asks for, by name or alias', () => {
  assert.equal(slashOf('hello'), undefined);
  assert.deepEqual(slashOf('  /Model gpt'), { name: 'model', command: SLASH_COMMANDS.find((c) => c.name === 'model') });
  assert.equal(slashOf('/exit')?.command?.name, 'quit');
  assert.equal(slashOf('/my-skill do it')?.command, undefined);
  assert.equal(slashOf('/my-skill do it')?.name, 'my-skill');
  assert.equal(slashKind('/status'), 'tty');
  assert.equal(slashKind('/compact keep the plan'), 'thread');
  assert.equal(slashKind('/quit'), 'blocked');
  assert.equal(slashKind('/my-skill'), 'thread');
  assert.equal(slashKind('plain text'), 'thread');
});

test('suggests names that start with what is typed, then aliases, then names containing it', () => {
  assert.deepEqual(
    slashSuggestions('/st').map((c) => c.name),
    ['status', 'stats', 'statusline', 'fast'],
  );
  assert.deepEqual(
    slashSuggestions('/res').map((c) => c.name),
    ['sessions', 'compress'],
  );
  assert.equal(slashSuggestions('/').length, 8);
  assert.equal(slashSuggestions('/', SLASH_COMMANDS, 100).length, SLASH_COMMANDS.length);
  assert.deepEqual(slashSuggestions('/model '), []);
  assert.deepEqual(slashSuggestions('model'), []);
  assert.equal(slashSuggestions('/tus')[0].name, 'status');
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
  assert.deepEqual(all.slice(SLASH_COMMANDS.length), [
    { name: 'review', description: 'Custom command: review', kind: 'thread', source: 'command' },
    { name: 'security-review', description: 'Security-focused code review', kind: 'thread', source: 'skill', argumentHint: '[path]' },
  ]);
  assert.deepEqual(slashCommands(), [...SLASH_COMMANDS]);
  assert.equal(slashOf('/Security-Review the diff', all)?.command?.source, 'skill');
  assert.equal(slashOf('/security-review', SLASH_COMMANDS)?.command, undefined);
  assert.deepEqual(
    slashSuggestions('/rev', all).map((c) => c.name),
    ['review', 'security-review'],
  );
});

test('refuses ending the CLI, and any command while a turn runs', () => {
  assert.equal(slashRefusal('hello', 'Byte', true), undefined);
  assert.equal(slashRefusal('/status', 'Byte', false), undefined);
  assert.equal(slashRefusal('/my-skill', 'Byte', false), undefined);
  assert.match(slashRefusal('/exit', 'Byte', false) ?? '', /^\/exit would end Byte’s Droid/);
  assert.match(slashRefusal('/status', 'Byte', true) ?? '', /once Byte finishes this turn/);
});
