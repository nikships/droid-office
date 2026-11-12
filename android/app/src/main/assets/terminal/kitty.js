// Pure DOM-free Kitty keyboard (`CSI u`) and graphics (`APC G` + `U=1` placeholders) helpers for the
// Android terminal WebView (`terminal.js`), checked for parity with `src/shared/kitty.ts` by
// `tests/android-terminal.test.ts`.

export const KITTY_KB_ALL_FLAGS = 31;
export const ALT_BUFFER_MODES = [47, 1047, 1049];
export const KITTY_PLACEHOLDER_CHAR = '\udbfb\udeee';

export const KITTY_DIACRITICS = [
  773, 781, 782, 784, 786, 829, 830, 831, 838, 842, 843, 844, 848, 849, 850, 855, 859, 867, 868, 869, 870, 871, 872, 873, 874, 875, 876, 877, 878, 879, 1155, 1156, 1157, 1158, 1159, 1426, 1427, 1428, 1429, 1431, 1432, 1433, 1436, 1437,
  1438, 1439, 1440, 1441, 1448, 1449, 1451, 1452, 1455, 1476, 1552, 1553, 1554, 1555, 1556, 1557, 1558, 1559, 1623, 1624, 1625, 1626, 1627, 1629, 1630, 1750, 1751, 1752, 1753, 1754, 1755, 1756, 1759, 1760, 1761, 1762, 1764, 1767, 1768,
  1771, 1772, 1840, 1842, 1843, 1845, 1846, 1850, 1853, 1855, 1856, 1857, 1859, 1861, 1863, 1865, 1866, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2035, 2070, 2071, 2072, 2073, 2075, 2076, 2077, 2078, 2079, 2080, 2081, 2082, 2083, 2085,
  2086, 2087, 2089, 2090, 2091, 2092, 2093, 2385, 2387, 2388, 3970, 3971, 3974, 3975, 4957, 4958, 4959, 6109, 6458, 6679, 6773, 6774, 6775, 6776, 6777, 6778, 6779, 6780, 7019, 7021, 7022, 7023, 7024, 7025, 7026, 7027, 7376, 7377, 7378,
  7386, 7387, 7392, 7616, 7617, 7619, 7620, 7621, 7622, 7623, 7624, 7625, 7627, 7628, 7633, 7634, 7635, 7636, 7637, 7638, 7639, 7640, 7641, 7642, 7643, 7644, 7645, 7646, 7647, 7648, 7649, 7650, 7651, 7652, 7653, 7654, 7678, 8400, 8401,
  8404, 8405, 8406, 8407, 8411, 8412, 8417, 8423, 8425, 8432, 11503, 11504, 11505, 11744, 11745, 11746, 11747, 11748, 11749, 11750, 11751, 11752, 11753, 11754, 11755, 11756, 11757, 11758, 11759, 11760, 11761, 11762, 11763, 11764, 11765,
  11766, 11767, 11768, 11769, 11770, 11771, 11772, 11773, 11774, 11775, 42607, 42620, 42621, 42736, 42737, 43232, 43233, 43234, 43235, 43236, 43237, 43238, 43239, 43240, 43241, 43242, 43243, 43244, 43245, 43246, 43247, 43248, 43249, 43696,
  43698, 43699, 43703, 43704, 43710, 43711, 43713, 65056, 65057, 65058, 65059, 65060, 65061, 65062, 68111, 68152, 119173, 119174, 119175, 119176, 119177, 119210, 119211, 119212, 119213, 119362, 119363, 119364,
];

const DIACRITIC_MAP = new Map(KITTY_DIACRITICS.map((cp, idx) => [cp, idx]));
const MAX_KB_STACK = 16;
const MAX_APC_LEN = 16 * 1024 * 1024;
const MAX_STORED_IMAGES = 64;
const MAX_IMAGE_B64_CHARS = 32 * 1024 * 1024;
const MAX_STORE_B64_CHARS = 48 * 1024 * 1024;
const NUMERIC_KEYS = new Set(['f', 'i', 'I', 'p', 'q', 'm', 's', 'v', 'c', 'r', 'x', 'y', 'w', 'h', 'X', 'Y', 'C', 'z', 'U']);

export class KittyKeyboardState {
  constructor() {
    this.reset();
  }

  get flags() {
    return this.alt ? this.altFlags : this.mainFlags;
  }

  setAlternate(on) {
    this.alt = Boolean(on);
  }

  set(rawFlags = 0, mode = 1) {
    const f = rawFlags & KITTY_KB_ALL_FLAGS;
    const cur = this.flags;
    const next = mode === 2 ? (cur | f) & KITTY_KB_ALL_FLAGS : mode === 3 ? cur & ~f : mode === 1 ? f : cur;
    if (this.alt) this.altFlags = next;
    else this.mainFlags = next;
  }

  push(rawFlags = 0) {
    const stack = this.alt ? this.altStack : this.mainStack;
    stack.push(this.flags);
    if (stack.length > MAX_KB_STACK) stack.shift();
    const next = rawFlags & KITTY_KB_ALL_FLAGS;
    if (this.alt) this.altFlags = next;
    else this.mainFlags = next;
  }

  pop(rawCount = 1) {
    const count = rawCount > 0 ? rawCount : 1;
    const stack = this.alt ? this.altStack : this.mainStack;
    let next = 0;
    for (let i = 0; i < count; i++) next = stack.pop() ?? 0;
    if (this.alt) this.altFlags = next;
    else this.mainFlags = next;
  }

  reset() {
    this.mainFlags = 0;
    this.altFlags = 0;
    this.mainStack = [];
    this.altStack = [];
    this.alt = false;
  }
}

export function isKittyPlaceholderCell(chars) {
  return Boolean(chars && chars.length >= 2 && chars.charCodeAt(0) === 0xdbfb && chars.charCodeAt(1) === 0xdeee);
}

export function decodePlaceholderCell(chars, fgLow24, underlineLow24 = 0, prev = undefined) {
  if (!isKittyPlaceholderCell(chars)) return undefined;
  let dCount = 0;
  let d0 = -1;
  let d1 = -1;
  let d2 = -1;
  let i = 2;
  while (i < chars.length && dCount < 3) {
    const cp = chars.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    const idx = DIACRITIC_MAP.get(cp);
    if (idx !== undefined) {
      if (dCount === 0) d0 = idx;
      else if (dCount === 1) d1 = idx;
      else d2 = idx;
      dCount++;
    }
  }
  const baseId = fgLow24 & 0xffffff;
  const placementId = underlineLow24 & 0xffffff;
  let msb = 0;
  if (dCount >= 3) msb = d2 & 0xff;
  else if (prev && (prev.imageId & 0xffffff) === baseId && prev.placementId === placementId) msb = prev.msb;
  const imageId = (((msb & 0xff) << 24) | baseId) >>> 0;
  if (!imageId) return undefined;

  const samePrev = prev && prev.imageId === imageId && prev.placementId === placementId;
  let row = 0;
  let col = 0;
  if (dCount === 0) {
    if (samePrev) {
      row = prev.row;
      col = prev.col + 1;
    }
  } else if (dCount === 1) {
    row = d0;
    if (samePrev && prev.row === row) col = prev.col + 1;
  } else {
    row = d0;
    col = d1;
  }
  return { imageId, placementId, row, col, msb };
}

export class KittyApcSplitter {
  constructor() {
    this.reset();
  }

  reset() {
    this.state = 'ground';
    this.apcBuf = '';
  }

  feed(chunk) {
    if (!chunk) return [];
    if (this.state === 'ground' && !chunk.includes('\x1b') && !chunk.includes('\x9f')) {
      return [{ type: 'text', data: chunk }];
    }
    const out = [];
    let textStart = this.state === 'ground' ? 0 : -1;
    let prefixText = '';
    const emitText = (endIdx) => {
      const part = prefixText + (textStart >= 0 && endIdx > textStart ? chunk.slice(textStart, endIdx) : '');
      prefixText = '';
      textStart = -1;
      if (part) {
        const last = out[out.length - 1];
        if (last?.type === 'text') last.data += part;
        else out.push({ type: 'text', data: part });
      }
    };

    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      switch (this.state) {
        case 'ground':
          if (code === 0x1b) {
            emitText(i);
            this.state = 'esc';
          } else if (code === 0x9f) {
            emitText(i);
            this.state = 'apc_start';
          }
          break;
        case 'esc':
          if (code === 0x5f) this.state = 'apc_start';
          else if (code === 0x1b) prefixText += '\x1b';
          else {
            prefixText += `\x1b${chunk[i]}`;
            textStart = i + 1;
            this.state = 'ground';
          }
          break;
        case 'apc_start':
          if (code === 0x47) {
            this.apcBuf = '';
            this.state = 'apc';
          } else {
            prefixText += `\x1b_${chunk[i]}`;
            textStart = i + 1;
            this.state = 'ground';
          }
          break;
        case 'apc':
          if (code === 0x1b) this.state = 'apc_esc';
          else if (code === 0x07 || code === 0x9c) {
            out.push({ type: 'apc', body: this.apcBuf });
            this.apcBuf = '';
            textStart = i + 1;
            this.state = 'ground';
          } else {
            this.apcBuf += chunk[i];
            if (this.apcBuf.length > MAX_APC_LEN) {
              this.apcBuf = '';
              textStart = i + 1;
              this.state = 'ground';
            }
          }
          break;
        case 'apc_esc':
          if (code === 0x5c) {
            out.push({ type: 'apc', body: this.apcBuf });
            this.apcBuf = '';
            textStart = i + 1;
            this.state = 'ground';
          } else if (code === 0x1b) this.apcBuf += '\x1b';
          else {
            this.apcBuf = '';
            prefixText += `\x1b${chunk[i]}`;
            textStart = i + 1;
            this.state = 'ground';
          }
          break;
      }
    }
    if (this.state === 'ground') emitText(chunk.length);
    return out;
  }
}

export function parseKittyControl(body) {
  const semi = body.indexOf(';');
  const head = semi >= 0 ? body.slice(0, semi) : body;
  const payload = semi >= 0 ? body.slice(semi + 1) : '';
  const params = {};
  if (head) {
    for (const part of head.split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (NUMERIC_KEYS.has(k)) {
        const n = Number(v);
        if (Number.isFinite(n)) params[k] = Math.trunc(n);
      } else params[k] = v;
    }
  }
  return { params, payload };
}

const validFormat = (f) => f === undefined || f === 24 || f === 32 || f === 100;

export class KittyGraphicsStore {
  constructor() {
    this.images = new Map();
    this.reset();
  }

  reset() {
    this.images.clear();
    this.totalChars = 0;
    this.nextAutoId = 0x7f000001;
    this.pendingParams = null;
    this.pendingChunks = [];
    this.pendingChars = 0;
  }

  get(id) {
    return this.images.get(id >>> 0);
  }

  get size() {
    return this.images.size;
  }

  processApc(body) {
    const { params: cur, payload } = parseKittyControl(body);
    const cleanPayload = payload.includes('\n') || payload.includes('\r') ? payload.replace(/[\r\n]+/g, '') : payload;
    if (this.pendingParams) {
      const merged = { ...this.pendingParams };
      if (cur.q !== undefined) merged.q = cur.q;
      if (cur.m !== undefined) merged.m = cur.m;
      this.pendingChars += cleanPayload.length;
      if (this.pendingChars > MAX_IMAGE_B64_CHARS) {
        this.pendingParams = null;
        this.pendingChunks = [];
        this.pendingChars = 0;
        return { effect: { type: 'none' } };
      }
      if (cleanPayload) this.pendingChunks.push(cleanPayload);
      if ((cur.m ?? 0) === 1) {
        this.pendingParams = merged;
        return { effect: { type: 'none' } };
      }
      const fullPayload = this.pendingChunks.join('');
      this.pendingParams = null;
      this.pendingChunks = [];
      this.pendingChars = 0;
      return this.execute(merged, fullPayload);
    }
    if (cur.m === 1) {
      this.pendingParams = cur;
      this.pendingChunks = cleanPayload ? [cleanPayload] : [];
      this.pendingChars = cleanPayload.length;
      return { effect: { type: 'none' } };
    }
    return this.execute(cur, cleanPayload);
  }

  execute(p, data) {
    const action = p.a ?? 't';
    if (action === 'q') return { effect: { type: 'query' } };
    if (action === 'd') {
      const sel = p.d ?? 'a';
      const lower = sel.toLowerCase();
      const free = sel !== lower || lower === 'a';
      if (lower === 'a') {
        if (sel === 'A') {
          this.images.clear();
          this.totalChars = 0;
        }
        return { effect: { type: 'delete', selector: sel, free: sel === 'A' } };
      }
      if (lower === 'i' && p.i) {
        const id = p.i >>> 0;
        if (sel === 'I' || !p.p) this.removeImage(id);
        return { effect: { type: 'delete', selector: sel, imageId: id, placementId: p.p, free } };
      }
      if (lower === 'n' && p.I) {
        const found = this.findByNumber(p.I);
        if (found && (sel === 'N' || !p.p)) this.removeImage(found.id);
        return { effect: { type: 'delete', selector: sel, imageId: found?.id, placementId: p.p, free } };
      }
      return { effect: { type: 'delete', selector: sel, imageId: p.i, placementId: p.p, z: p.z, free } };
    }
    if (action === 'p') {
      const img = p.i ? this.images.get(p.i >>> 0) : p.I ? this.findByNumber(p.I) : undefined;
      if (!img) return { effect: { type: 'none' } };
      this.images.delete(img.id);
      this.images.set(img.id, img);
      if (p.U === 1) {
        img.unicode = true;
        if (p.c) img.cols = p.c;
        if (p.r) img.rows = p.r;
      }
      return { effect: { type: 'place', image: img, display: this.makePlaceRequest(img.id, p) } };
    }
    if (action === 'f') {
      const img = p.i ? this.images.get(p.i >>> 0) : p.I ? this.findByNumber(p.I) : undefined;
      if (!img || (p.t && p.t !== 'd')) return { effect: { type: 'none' } };
      const fmt = validFormat(p.f) ? (p.f ?? 32) : 32;
      if (img.frames.length < 120 && data) {
        img.frames.push({
          format: fmt,
          compression: p.o === 'z' ? 'z' : undefined,
          width: p.s ?? img.width,
          height: p.v ?? img.height,
          delayMs: Math.max(10, p.z ?? 100),
          data,
        });
        this.totalChars += data.length;
        this.evictIfNeeded(img.id);
      }
      return { effect: { type: 'animate', image: img } };
    }
    if (action === 'a') {
      const img = p.i ? this.images.get(p.i >>> 0) : p.I ? this.findByNumber(p.I) : undefined;
      if (!img) return { effect: { type: 'none' } };
      if (p.r === 1 && p.z !== undefined) img.rootDelayMs = Math.max(10, p.z);
      if (p.s !== undefined) img.animState = p.s;
      return { effect: { type: 'animate', image: img } };
    }
    if (action === 't' || action === 'T') {
      if ((p.t && p.t !== 'd') || !validFormat(p.f) || (p.o && p.o !== 'z')) return { effect: { type: 'none' } };
      const fmt = p.f ?? 32;
      if ((fmt === 24 || fmt === 32) && (!(p.s && p.s > 0) || !(p.v && p.v > 0))) return { effect: { type: 'none' } };
      const id = p.i && p.i > 0 ? p.i >>> 0 : this.nextAutoId++;
      const record = {
        id,
        number: p.I,
        format: fmt,
        compression: p.o === 'z' ? 'z' : undefined,
        width: p.s ?? 0,
        height: p.v ?? 0,
        cols: p.c,
        rows: p.r,
        unicode: action === 'T' && p.U === 1 ? true : undefined,
        data,
        frames: [],
      };
      this.removeImage(id);
      this.images.set(id, record);
      this.totalChars += data.length;
      this.evictIfNeeded(id);
      return { effect: { type: 'image', image: record, display: action === 'T' ? this.makePlaceRequest(id, p) : undefined } };
    }
    return { effect: { type: 'none' } };
  }

  makePlaceRequest(imageId, p) {
    return {
      imageId,
      placementId: p.p ?? 0,
      unicode: p.U === 1,
      cols: p.c,
      rows: p.r,
      noCursorMove: p.C === 1 || p.U === 1,
      z: p.z ?? 0,
    };
  }

  findByNumber(num) {
    let match;
    for (const img of this.images.values()) if (img.number === num) match = img;
    return match;
  }

  removeImage(id) {
    const prev = this.images.get(id);
    if (!prev) return;
    this.images.delete(id);
    let chars = prev.data.length;
    for (const f of prev.frames) chars += f.data.length;
    this.totalChars = Math.max(0, this.totalChars - chars);
  }

  evictIfNeeded(keepId) {
    for (const [id] of this.images) {
      if (this.images.size <= MAX_STORED_IMAGES && this.totalChars <= MAX_STORE_B64_CHARS) break;
      if (id !== keepId) this.removeImage(id);
    }
  }
}

const B64_LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  table[45] = 62;
  table[95] = 63;
  return table;
})();

export function decodeBase64(b64) {
  let cleanLen = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c < 128 && B64_LOOKUP[c] >= 0) cleanLen++;
  }
  const outLen = Math.floor((cleanLen * 3) / 4);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let pos = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    const val = c < 128 ? B64_LOOKUP[c] : -1;
    if (val < 0) continue;
    acc = (acc << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (pos < outLen) out[pos++] = (acc >> bits) & 0xff;
    }
  }
  return pos === outLen ? out : out.subarray(0, pos);
}

export function cellUnderlineId(cell) {
  const uc = cell?.hasExtendedAttrs?.() ? cell.extended?.underlineColor : 0;
  if (!uc || uc === -1 || (uc & 0x03000000) === 0) return 0;
  return (cell.getUnderlineColor?.() ?? 0) & 0xffffff;
}

export function hashKittyPayload(data) {
  let h = 0x811c9dc5;
  const len = data.length;
  const head = Math.min(len, 256);
  for (let i = 0; i < head; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  if (len > 512) {
    const step = Math.max(1, (len - 512) >> 10);
    for (let i = 256; i < len - 256; i += step) {
      h ^= data.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  const tailStart = Math.max(head, len - 256);
  for (let i = tailStart; i < len; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function kittyImageSignature(img) {
  let sig = `${img.format}:${img.compression ?? ''}:${img.width}x${img.height}:${img.data.length}:${hashKittyPayload(img.data)}`;
  if (img.frames?.length) {
    sig += `:f${img.frames.length}:${img.animState ?? 0}:${img.rootDelayMs ?? 0}`;
    for (const f of img.frames) sig += `,${f.format}@${f.delayMs}:${f.data.length}:${hashKittyPayload(f.data)}`;
  }
  return sig;
}
