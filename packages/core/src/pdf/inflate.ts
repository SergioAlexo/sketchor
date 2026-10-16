/**
 * A small synchronous DEFLATE / zlib decoder (RFC 1950/1951) for PDF
 * FlateDecode streams. Synchronous on purpose: the platform's
 * `DecompressionStream` is async-only and the PDF object graph is resolved
 * lazily from deep inside parsing. Output is capped (`maxOut`) so a
 * decompression bomb cannot exhaust memory, and a corrupt or truncated stream
 * returns what was decoded so far rather than throwing — PDFs in the wild are
 * often cut short and the first part is still useful.
 */

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huff {
  count: Uint16Array;
  symbol: Uint16Array;
}

function build(lengths: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

let fixedL: Huff | null = null;
let fixedD: Huff | null = null;

class Stop {}

/** Raw DEFLATE (no zlib header). Returns the bytes decoded, possibly partial. */
export function inflateRaw(src: Uint8Array, maxOut = 256 * 1024 * 1024): Uint8Array {
  let out = new Uint8Array(Math.min(Math.max(src.length * 4, 1024), maxOut));
  let op = 0;
  let ip = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  const bits = (need: number): number => {
    while (bitCnt < need) {
      if (ip >= src.length) throw new Stop();
      bitBuf |= src[ip++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << need) - 1);
    bitBuf >>>= need;
    bitCnt -= need;
    return v;
  };
  const put = (b: number): void => {
    if (op >= out.length) {
      if (out.length >= maxOut) throw new Stop();
      const n = new Uint8Array(Math.min(out.length * 2, maxOut));
      n.set(out);
      out = n;
    }
    out[op++] = b;
  };
  const decode = (h: Huff): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new Stop();
  };
  const codes = (lh: Huff, dh: Huff): void => {
    for (;;) {
      const sym = decode(lh);
      if (sym < 256) put(sym);
      else if (sym === 256) return;
      else {
        const s = sym - 257;
        if (s >= 29) throw new Stop();
        const len = LBASE[s] + bits(LEXT[s]);
        const ds = decode(dh);
        if (ds >= 30) throw new Stop();
        const dist = DBASE[ds] + bits(DEXT[ds]);
        if (dist > op) throw new Stop();
        for (let i = 0; i < len; i++) put(out[op - dist]);
      }
    }
  };

  try {
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitBuf = 0;
        bitCnt = 0;
        if (ip + 4 > src.length) throw new Stop();
        const len = src[ip] | (src[ip + 1] << 8);
        ip += 4;
        for (let i = 0; i < len; i++) {
          if (ip >= src.length) throw new Stop();
          put(src[ip++]);
        }
      } else if (type === 1) {
        if (!fixedL) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 144; i++) l[i] = 8;
          for (let i = 144; i < 256; i++) l[i] = 9;
          for (let i = 256; i < 280; i++) l[i] = 7;
          for (let i = 280; i < 288; i++) l[i] = 8;
          fixedL = build(l, 288);
          fixedD = build(new Uint8Array(30).fill(5), 30);
        }
        codes(fixedL, fixedD!);
      } else if (type === 2) {
        const nlen = bits(5) + 257;
        const ndist = bits(5) + 1;
        const ncode = bits(4) + 4;
        if (nlen > 286 || ndist > 30) throw new Stop();
        const lengths = new Uint8Array(320);
        for (let i = 0; i < ncode; i++) lengths[CLORDER[i]] = bits(3);
        const lenCode = build(lengths, 19);
        let idx = 0;
        const all = new Uint8Array(320);
        while (idx < nlen + ndist) {
          const sym = decode(lenCode);
          if (sym < 16) all[idx++] = sym;
          else {
            let prev = 0;
            let rep: number;
            if (sym === 16) {
              if (idx === 0) throw new Stop();
              prev = all[idx - 1];
              rep = 3 + bits(2);
            } else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (idx + rep > nlen + ndist) throw new Stop();
            while (rep--) all[idx++] = prev;
          }
        }
        codes(build(all.subarray(0, nlen), nlen), build(all.subarray(nlen, nlen + ndist), ndist));
      } else throw new Stop();
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  return out.subarray(0, op);
}

/** zlib-wrapped DEFLATE (what FlateDecode carries); tolerates a missing or bad header. */
export function inflate(src: Uint8Array, maxOut?: number): Uint8Array {
  let start = 0;
  if (src.length >= 2 && (src[0] & 0x0f) === 8 && ((src[0] << 8) | src[1]) % 31 === 0) {
    start = 2;
    if (src[1] & 0x20) start += 4;
  }
  return inflateRaw(src.subarray(start), maxOut);
}
