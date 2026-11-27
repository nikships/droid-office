import assert from 'node:assert/strict';
import test from 'node:test';
import { VtScanner } from '../src/shared/vt-scanner.js';
import { suppressMirrorQueries } from '../src/client/term-mirror.js';

const esc = '\x1b';
test('C0 inside a split CSI executes in order without defeating CAN or SUB', () => {
  for (const cancel of ['\x18', '\x1a']) {
    const parser = new VtScanner();
    const params: unknown[] = [];
    parser.registerCsiHandler({ final: 'h', prefix: '?' }, (p) => {
      params.push(p);
      return true;
    });
    let native = '';
    const put = (s: string) => {
      native += s;
    };
    parser.write(`x${esc}[?20\r`, put);
    assert.equal(native, 'x\r');
    parser.write(`27${cancel}${esc}[?20\x0727h`, put);
    assert.deepEqual(params, [[2027]]);
    assert.equal(native, `x\r${esc}[?2027${cancel}\x07`);
  }
});
test('split VT hooks observe the previous text, newest first; true swallows only that sequence', () => {
  const stream = `before${esc}[?1;2:3::4h${esc}]8;;https://example.org${esc}\\${esc}P1$qhello${esc}\\${esc}_G;data${esc}\\${esc}(B${esc}[31mafter`;
  for (let split = 0; split <= stream.length; split++) {
    const scanner = new VtScanner();
    let output = '';
    const events: unknown[] = [];
    scanner.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      events.push(params);
      return true;
    });
    scanner.registerCsiHandler({ prefix: '?', final: 'h' }, () => {
      events.push(output);
      return false;
    });
    scanner.registerOscHandler(8, (data) => {
      events.push(data);
      return true;
    });
    scanner.registerDcsHandler({ intermediates: '$', final: 'q' }, (data, p) => {
      events.push(data, p);
      return true;
    });
    scanner.registerApcHandler((data) => {
      events.push(data);
      return true;
    });
    scanner.registerEscHandler({ intermediates: '(', final: 'B' }, () => {
      events.push('charset');
      return false;
    });
    for (const chunk of [stream.slice(0, split), stream.slice(split)])
      scanner.write(chunk, (s) => {
        output += s;
      });
    assert.deepEqual(events, ['before', [1, 2, [3, -1, 4]], ';https://example.org', 'hello', [1], 'G;data', 'charset']);
    assert.equal(output, `before${esc}(B${esc}[31mafter`);
  }
});

test('query suppression handles ST, BEL and C1; OSC assignments, ordinary SGR and disconnected hooks pass through', () => {
  const parser = new VtScanner();
  const off = suppressMirrorQueries({ parser });
  const chunks: string[] = [];
  const put = (s: string) => chunks.push(s);
  parser.write(`a${esc}[6n${esc}[?u\x9b>c${esc}[?12$p${esc}[18t${esc}]4;2;?\x07\x9d10;?\x9c${esc}P$qm${esc}\\z`, put);
  assert.equal(chunks.join(''), 'az');
  const ordinary = `${esc}]10;#eeddaa\x07${esc}[31mred${esc}[0m`;
  chunks.length = 0;
  parser.write(ordinary, put);
  assert.equal(chunks.join(''), ordinary);
  off();
  chunks.length = 0;
  parser.write(`${esc}[6n`, put);
  assert.deepEqual(chunks, [`${esc}[6n`]);
});

test('bounded partial strings discard to ST; cancellations and reset do not leak into following text', () => {
  const scanner = new VtScanner();
  let output = '';
  const put = (s: string) => {
    output += s;
  };
  const hook = scanner.registerApcHandler(() => {
    throw Error('cancelled APC was dispatched');
  });
  scanner.write(`${esc}_large${'x'.repeat(8 * 1024 * 1024)}`, put);
  scanner.write(esc, put);
  scanner.write('\\ok', put);
  assert.equal(output, 'ok');
  scanner.write(`${esc}_interrupted`, put);
  scanner.reset();
  scanner.write('again', put);
  assert.equal(output, 'okagain');
  scanner.write(`${esc}_abort\x18`, put);
  hook.dispose();
  scanner.write(`${esc}_untouched${esc}\\`, put);
  assert.equal(output, `okagain${esc}_abort\x18${esc}_untouched${esc}\\`);
});

test('Kitty APC accepts BEL, C1 ST and split ESC-ST; BEL inside another APC stays data', () => {
  for (const intro of [`${esc}_`, '\x9f']) {
    for (const terminator of ['\x07', '\x9c', `${esc}\\`]) {
      const stream = `a${intro}Gx${terminator}b${intro}other\x07stuff${esc}\\c`;
      for (let split = 0; split <= stream.length; split++) {
        const scanner = new VtScanner();
        const payloads: string[] = [];
        scanner.registerApcHandler((body) => {
          payloads.push(body);
          return true;
        });
        let text = '';
        for (const part of [stream.slice(0, split), stream.slice(split)])
          scanner.write(part, (s) => {
            text += s;
          });
        assert.deepEqual(payloads, ['Gx', 'other\x07stuff']);
        assert.equal(text, 'abc');
      }
    }
  }
});

test('the 16 Mi Kitty bound counts only the body after G, not the introducer or split terminator', () => {
  const body = 'z'.repeat(16 * 1024 * 1024);
  for (const intro of [`${esc}_`, '\x9f']) {
    const scanner = new VtScanner();
    const lengths: number[] = [];
    scanner.registerApcHandler((data) => {
      lengths.push(data.length - 1);
      return true;
    });
    let text = '';
    const put = (s: string) => {
      text += s;
    };
    for (const part of [intro, 'G', body, esc, '\\', 'a', intro, 'G', body, 'x', '\x07', 'b']) scanner.write(part, put);
    assert.deepEqual(lengths, [body.length]);
    assert.equal(text, 'ab');
  }
});
