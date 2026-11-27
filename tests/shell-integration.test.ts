import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as pty from '@lydell/node-pty';
import { interactiveShell } from '../src/server/shell-integration.js';

const zsh = '/bin/zsh';
const mark = /\x1b\]133;([^\x07]*)\x07/g;
const marks = (text: string) => [...text.matchAll(mark)].map((m) => m[1]);

// Wait for the actual ZLE bracketed-paste enable on each prompt, not a
// timer. Keep the full PTY stream for byte comparison with an unwrapped zsh.
async function session(home: string, wrapped: boolean, commands: string[], extra: Record<string, string> = {}) {
  const { file, args } = wrapped ? interactiveShell(zsh, ['-l'], true) : { file: zsh, args: ['-l'] };
  const proc = pty.spawn(file, args, { cwd: home, cols: 100, rows: 24, env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C', ...extra } });
  let chunk = '';
  const prompts: string[] = [];
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`zsh did not reach prompt ${prompts.length}: ${JSON.stringify(chunk)}`));
    }, 6000);
    proc.onData((s) => {
      chunk += s;
      if (!chunk.includes('\x1b[?2004h')) return;
      prompts.push(chunk);
      chunk = '';
      proc.write(`${commands[prompts.length - 1] ?? 'exit 0'}\r`);
    });
    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0 && prompts.length === commands.length + 1) resolve(prompts);
      else reject(new Error(`zsh exit ${exitCode} after ${prompts.length} prompts: ${JSON.stringify(chunk)}`));
    });
  });
}

test('only the final interactive zsh is wrapped, and the off switch bypasses the handoff', () => {
  for (const file of ['/bin/bash', '/bin/sh', '/usr/bin/fish', '/path/to/droid']) assert.deepEqual(interactiveShell(file, ['-l'], true), { file, args: ['-l'] });
  assert.deepEqual(interactiveShell(zsh, ['-l'], false), { file: zsh, args: ['-l'] });
});

test('real zsh login prompts and status equal native, apart from the semantic marks', { skip: !existsSync(zsh) }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-shell-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const commands = ['(exit 7)', `print -r -- "result=$?"`, '', 'false | true', 'print -r -- "pipeline=$pipestatus"'];
  const compare = async (env: Record<string, string> = {}) => {
    const native = await session(home, false, commands, env);
    const office = await session(home, true, commands, env);
    assert.deepEqual(
      office.map((x) => x.replace(mark, '')),
      native,
    );
    assert.deepEqual(office.map(marks), [
      ['A', 'B'],
      ['C', 'D;7', 'A', 'B'],
      ['C', 'D;0', 'A', 'B'],
      ['A', 'B'],
      ['C', 'D;0', 'A', 'B'],
      ['C', 'D;0', 'A', 'B'],
    ]);
    assert.match(office[2], /result=7\r\n/);
    assert.match(office[5], /pipeline=1 0\r\n/);
  };
  await compare();
  const initial = path.join(home, 'initial config'),
    config = path.join(home, 'final config');
  await mkdir(initial);
  await mkdir(config);
  await writeFile(path.join(initial, '.zshenv'), `print -r -- "$ZDOTDIR:$ZSH_EVAL_CONTEXT" >> "$HOME/startup"\nexport ZDOTDIR="$HOME/final config"\n`);
  for (const stage of ['.zprofile', '.zlogin', '.zlogout']) await writeFile(path.join(config, stage), `print -r -- '${stage}' >> "$HOME/startup"\n`);
  await writeFile(
    path.join(config, '.zshrc'),
    `print -r -- '.zshrc' >> "$HOME/startup"
setopt promptsubst
precmd() {
    local last=$?
    PS1='%F{blue}custom %~%f ['"$last"']> '
}
preexec() { print -r -- "user preexec: $1" >> "$HOME/hooks"; }
`,
  );
  await compare({ ZDOTDIR: initial });
  const stages = ['.zprofile', '.zshrc', '.zlogin', '.zlogout'];
  assert.deepEqual((await readFile(path.join(home, 'startup'), 'utf8')).trimEnd().split('\n'), [`${initial}:file`, ...stages, `${initial}:file:file`, ...stages]);
  const hooks = (await readFile(path.join(home, 'hooks'), 'utf8')).trimEnd().split('\n');
  assert.deepEqual(hooks.slice(0, hooks.length / 2), hooks.slice(hooks.length / 2));
});

test('already-marked prompts and recognized external integration keep their own marks', { skip: !existsSync(zsh) }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'office-shell-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cases = [
    `PS1=$'%{\\e]133;A\\a%}user> %{\\e]133;B\\a%}'`,
    'ITERM_SHELL_INTEGRATION_INSTALLED=Yes',
    'VSCODE_SHELL_INTEGRATION=1',
    '_ghostty_state=0',
    '_ksi_state=0',
    'prompt_starship_precmd() { :; }; precmd_functions+=(prompt_starship_precmd)',
    "later() { PS1=$'%{\\e]133;A\\a%}theme> %{\\e]133;B\\a%}'; }; precmd_functions+=(later)",
    'readonly PS1="fixed> "',
    'unsetopt promptpercent',
  ];
  for (const setup of cases) {
    await writeFile(path.join(home, '.zshrc'), `${setup}\n`);
    assert.deepEqual(await session(home, true, ['false']), await session(home, false, ['false']), setup);
  }
});
