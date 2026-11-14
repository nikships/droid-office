import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandPastes, insertQuote, isLargePaste, livePastes, PASTE_CHIP_CHARS, PASTE_CHIP_LINES, pastedText, quoteLines, replacePaste } from '../src/client/ui/thread-compose.js';

test('a paste becomes a chip only past the character or line threshold', () => {
  assert.equal(isLargePaste('x'.repeat(PASTE_CHIP_CHARS)), false);
  assert.equal(isLargePaste('x'.repeat(PASTE_CHIP_CHARS + 1)), true);
  assert.equal(isLargePaste(Array.from({ length: PASTE_CHIP_LINES }, (_, i) => `l${i}`).join('\n')), false);
  assert.equal(isLargePaste(Array.from({ length: PASTE_CHIP_LINES + 1 }, (_, i) => `l${i}`).join('\n')), true);
  // Windows line endings count as one break each.
  assert.equal(isLargePaste(Array.from({ length: PASTE_CHIP_LINES }, () => 'l').join('\r\n')), false);
  assert.equal(isLargePaste(''), false);
});

test('pasted text tokens name the paste and its size, and expand back in place', () => {
  const log = pastedText(1, 'a\r\nb\r\nc');
  assert.deepEqual(log, { id: 1, text: 'a\nb\nc', lines: 3, token: '[Pasted text #1 · 3 lines]' });
  const blob = pastedText(2, 'y'.repeat(1234));
  assert.equal(blob.token, '[Pasted text #2 · 1,234 chars]');

  const draft = `Look at ${log.token} and ${blob.token} please`;
  assert.equal(expandPastes(draft, [log, blob]), `Look at a\nb\nc and ${'y'.repeat(1234)} please`);
  assert.deepEqual(livePastes(draft, [log, blob]), [log, blob]);
  assert.deepEqual(livePastes(draft.replace(log.token, ''), [log, blob]), [blob]);
  // Only pastes still in the draft expand; a second copy of a token stays literal text.
  assert.equal(expandPastes(`${log.token} ${log.token}`, [log]), `a\nb\nc ${log.token}`);
  assert.equal(expandPastes('no tokens', [log]), 'no tokens');
});

test('expanding is one pass, so pasted text containing a token is kept verbatim', () => {
  const inner = pastedText(2, 'second');
  const outer = pastedText(1, `first mentions ${inner.token}`);
  assert.equal(expandPastes(`${outer.token} then ${inner.token}`, [outer, inner]), `first mentions ${inner.token} then second`);
  // Special replacement patterns in pasted text are not interpreted.
  const dollars = pastedText(3, "$& $' $1");
  assert.equal(expandPastes(`<${dollars.token}>`, [dollars]), "<$& $' $1>");
});

test('a paste chip can be expanded into the draft or removed', () => {
  const paste = pastedText(4, 'line1\nline2');
  const draft = `before ${paste.token} after`;
  assert.deepEqual(replacePaste(draft, paste, paste.text), { value: 'before line1\nline2 after', cursor: 'before line1\nline2'.length });
  assert.deepEqual(replacePaste(draft, paste, ''), { value: 'before  after', cursor: 'before '.length });
  assert.equal(replacePaste('gone', paste, ''), null);
});

test('quoted selections become Markdown quote lines', () => {
  assert.equal(quoteLines('one\ntwo'), '> one\n> two');
  assert.equal(quoteLines('\n\n  keep indent  \r\n\r\nlast\u00a0word\n\n'), '>   keep indent\n>\n> last word');
  assert.equal(quoteLines(' \n\n'), '');
});

test('a quote goes on its own lines at the cursor with a blank line before the reply', () => {
  assert.deepEqual(insertQuote('', 0, 0, 'a\nb'), { value: '> a\n> b\n\n', cursor: '> a\n> b\n\n'.length });
  // Mid-paragraph: the quote starts a new block and the rest of the draft follows the blank line.
  const mid = insertQuote('Hello world', 5, 5, 'quoted');
  assert.deepEqual(mid, { value: 'Hello\n\n> quoted\n\n world', cursor: 'Hello\n\n> quoted\n\n'.length });
  // Existing line breaks around the cursor are reused rather than doubled.
  assert.deepEqual(insertQuote('Intro\n', 6, 6, 'q'), { value: 'Intro\n\n> q\n\n', cursor: 'Intro\n\n> q\n\n'.length });
  assert.deepEqual(insertQuote('Intro\n\n', 7, 7, 'q'), { value: 'Intro\n\n> q\n\n', cursor: 'Intro\n\n> q\n\n'.length });
  assert.deepEqual(insertQuote('A\n\nB', 1, 1, 'q'), { value: 'A\n\n> q\n\nB', cursor: 'A\n\n> q\n\n'.length });
  // A selected range in the draft is replaced, whichever way round it was selected.
  assert.equal(insertQuote('keep DROP keep', 9, 5, 'q')?.value, 'keep \n\n> q\n\n keep');
  assert.equal(insertQuote('draft', 2, 2, '  \n '), null);
});
