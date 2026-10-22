/**
 * Store-only ZIP writer (RN-41), so "all sheets" can be one download of one
 * DXF per sheet. Ported from the Sheet Nesting Calculator by Oleksandr
 * Borenko (`crc32` / `makeZip`), reworked to be pure (the timestamp is a
 * parameter) and to also expose `readZip` for the round-trip test.
 *
 * Why it matters: a wrong CRC or central-directory offset yields an archive
 * that "opens" in some tools and is reported damaged in others, weeks later,
 * on a shop-floor PC. `zip.test.ts` writes, parses back and compares bytes.
 */

export interface ZipFile {
  name: string;
  data: Uint8Array | string;
}

let crcTable: Uint32Array | null = null;

export function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time words for a Date (local time, 1980 epoch, 2 s resolution). */
function dosStamp(d: Date): { date: number; time: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/**
 * Builds a store-only (method 0) ZIP. Names are always UTF-8; the
 * general-purpose "language encoding" flag (bit 11) is set only when a name
 * contains a non-ASCII character, so plain archives stay maximally portable.
 */
export function makeZip(files: ZipFile[], now: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { date, time } = dosStamp(now);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const flags = name.some((b) => b > 0x7f) ? 0x0800 : 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, flags, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, flags, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const csize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  utf8Flag: boolean;
}

/**
 * Reads back a store-only archive through its central directory. Never
 * throws: malformed or truncated input yields `null`.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] | null {
  if (bytes.length < 22) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) return null;
    const flags = dv.getUint16(p + 8, true);
    if (dv.getUint16(p + 10, true) !== 0) return null;
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    if (p + 46 + nlen > bytes.length || lho + 30 > bytes.length || dv.getUint32(lho, true) !== 0x04034b50) return null;
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    if (start + size > bytes.length) return null;
    out.push({ name, data: bytes.slice(start, start + size), crc, utf8Flag: (flags & 0x0800) !== 0 });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
