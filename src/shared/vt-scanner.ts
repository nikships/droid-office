// Synchronous VT hooks for a display mirror. Unknown sequences pass through unchanged.
// Bound unfinished strings (including graphics) and discard an oversized control, never its tail as text.
interface Id {
  prefix?: string;
  intermediates?: string;
  final: string;
}
type Params = (number | number[])[];
type Handler = (data: string, params: Params) => boolean;
type State = 'text' | 'esc' | 'csi' | 'dcs' | 'osc' | 'apc' | 'opaque';
const ESC = '\x1b';
const introducers: Record<string, State> = { '[': 'csi', P: 'dcs', ']': 'osc', _: 'apc', X: 'opaque', '^': 'opaque' };
const c1: Record<string, State> = { '\x90': 'dcs', '\x98': 'opaque', '\x9b': 'csi', '\x9d': 'osc', '\x9e': 'opaque', '\x9f': 'apc' };
const idKey = (id: Id) => (id.prefix ?? '') + (id.intermediates ?? '') + id.final;
const header = /^([<=>?]?)([\d;:]*)([ -/]*)([@-~])/;

export class VtScanner {
  private handlers = new Map<string, Handler[]>();
  private state: State = 'text';
  private sequence = '';
  private oversized = false;
  private stPending = false;

  private register(key: string, handler: Handler) {
    const list = this.handlers.get(key) ?? [];
    list.push(handler);
    this.handlers.set(key, list);
    return {
      dispose: () => {
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
        if (!list.length && this.handlers.get(key) === list) this.handlers.delete(key);
      },
    };
  }
  registerCsiHandler(id: Id, fn: (params: Params) => boolean) {
    return this.register(`csi${idKey(id)}`, (_, p) => fn(p));
  }
  registerDcsHandler(id: Id, fn: (data: string, params: Params) => boolean) {
    return this.register(`dcs${idKey(id)}`, fn);
  }
  registerEscHandler(id: Id, fn: () => boolean) {
    return this.register(`esc${idKey(id)}`, fn);
  }
  registerOscHandler(id: number, fn: (data: string) => boolean) {
    return this.register(`osc${id}`, fn);
  }
  registerApcHandler(fn: (data: string) => boolean) {
    return this.register('apc', fn);
  }

  reset() {
    this.state = 'text';
    this.sequence = '';
    this.stPending = false;
    this.oversized = false;
  }

  private dispatch(terminator: number, flush: () => void) {
    const body = this.sequence.slice(this.sequence.startsWith(ESC) && this.state !== 'esc' ? 2 : 1, terminator ? -terminator : undefined);
    let key: string = this.state;
    let data = body;
    let params: Params = [];
    if (this.state === 'esc') key += body;
    else if (this.state === 'osc') {
      const split = body.indexOf(';');
      const code = split < 0 ? body : body.slice(0, split);
      if (!/^\d+$/.test(code)) return false;
      key += Number(code);
      data = split < 0 ? '' : body.slice(split + 1);
    } else if (this.state === 'csi' || this.state === 'dcs') {
      const m = header.exec(body);
      if (!m) return false;
      key += m[1] + m[3] + m[4];
      if (!this.handlers.has(key)) return false;
      params = m[2].split(';').flatMap((part): Params => {
        const [main, ...sub] = part.split(':');
        return sub.length ? [Number(main), sub.map((n) => (n ? Number(n) : -1))] : [Number(main)];
      });
      data = body.slice(m[0].length);
    }
    const matches = this.handlers.get(key);
    if (!matches) return false;
    flush();
    return matches
      .slice()
      .reverse()
      .some((fn) => fn(data, params));
  }

  /** Emit preceding text before running a hook: a cursor or mode read by that hook is current. */
  write(input: string, emit: (text: string) => void) {
    let start = 0;
    let output = '';
    const flush = () => {
      if (output) {
        emit(output);
        output = '';
      }
    };
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (this.state === 'text') {
        if (ch !== ESC && !c1[ch]) continue;
        output += input.slice(start, i);
        this.state = ch === ESC ? 'esc' : c1[ch];
        this.sequence = ch;
        start = i + 1;
        continue;
      }
      const string = this.state !== 'csi' && this.state !== 'esc';
      if (string && !this.stPending) {
        // Kitty payloads can span megabytes. Retain slices, not one string node per byte.
        const control = this.state === 'osc' ? /[\u0007\u0018\u001a\u001b\u009c]/g : /[\u0018\u001a\u001b\u009c]/g;
        control.lastIndex = i;
        const end = control.exec(input)?.index ?? input.length;
        if (end > i) {
          if (!this.oversized) {
            if (this.sequence.length + end - i > 8 * 1024 * 1024) {
              this.oversized = true;
              this.sequence = '';
            } else this.sequence += input.slice(i, end);
          }
          start = end;
          i = end - 1;
          continue;
        }
      }
      if ((ch === ESC && !string) || (this.stPending && ch !== '\\')) {
        // ESC not followed by ST aborts a string and introduces a fresh control. Cancel the
        // old sequence explicitly because the replacement may itself be swallowed.
        if (!this.oversized) output += `${this.stPending ? this.sequence.slice(0, -1) : this.sequence}\x18`;
        const replay = this.stPending;
        this.reset();
        this.state = 'esc';
        this.sequence = ESC;
        if (replay) i--;
        start = i + 1;
        continue;
      }
      if (!this.oversized) {
        this.sequence += ch;
        if (this.sequence.length > 8 * 1024 * 1024) {
          this.oversized = true;
          this.sequence = '';
        }
      }
      start = i + 1;
      if (ch === '\x18' || ch === '\x1a') {
        if (!this.oversized) output += this.sequence;
        this.reset();
      } else if (this.state === 'esc' && this.sequence.length === 2 && introducers[ch]) this.state = introducers[ch];
      else {
        const st = this.stPending && ch === '\\';
        const end = string ? st || ch === '\x9c' || (this.state === 'osc' && ch === '\x07') : ch >= (this.state === 'esc' ? '0' : '@') && ch <= '~';
        if (end) {
          if (!this.oversized && !this.dispatch(string ? (st ? 2 : 1) : 0, flush)) output += this.sequence;
          this.reset();
        } else this.stPending = ch === ESC;
      }
    }
    output += input.slice(start);
    flush();
  }
}
