/**
 * F-11: a minimal ZIP writer — what a 3MF package needs (stored or deflated
 * entries, CRC-32, central directory), with no dependency. Deflate uses the
 * platform's `CompressionStream`, so writing is async.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < b.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b[i]) & 0xff];
  return ~crc >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

export interface ZipWriteOptions {
  /** Deflate entries (default true); an entry that wouldn't shrink is stored. */
  deflate?: boolean;
}

/** Files (name → bytes or UTF-8 text), in order, as one ZIP archive. */
export async function writeZip(files: Record<string, Uint8Array | string>, opts: ZipWriteOptions = {}): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const names = Object.keys(files);
  if (names.length > 0xffff) throw new Error("too many files for a ZIP without ZIP64");
  for (const name of names) {
    const v = files[name];
    const data = typeof v === "string" ? enc.encode(v) : v;
    let body = data;
    let method = 0;
    if (opts.deflate !== false && data.length > 64) {
      const d = await deflateRaw(data);
      if (d.length < data.length) {
        body = d;
        method = 8;
      }
    }
    if (offset + body.length > 0xffffffff) throw new Error("archive too large for a ZIP without ZIP64");
    const n = enc.encode(name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true); // version needed
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, n.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, n.length, true);
    cd.setUint32(42, offset, true);
    chunks.push(new Uint8Array(lh.buffer), n, body);
    central.push(new Uint8Array(cd.buffer), n);
    offset += 30 + n.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, names.length, true);
  end.setUint16(10, names.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
