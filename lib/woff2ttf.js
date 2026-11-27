const zlib = require('zlib');
// WOFF (v1) → TTF/OTF: inflate each table and rebuild the sfnt header
module.exports = function woffToSfnt(buf) {
  if (buf.readUInt32BE(0) !== 0x774f4646) throw new Error('not WOFF');
  const flavor = buf.readUInt32BE(4), n = buf.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const p = 44 + i * 20;
    const tag = buf.readUInt32BE(p), off = buf.readUInt32BE(p + 4), comp = buf.readUInt32BE(p + 8), orig = buf.readUInt32BE(p + 12), sum = buf.readUInt32BE(p + 16);
    const raw = buf.subarray(off, off + comp);
    tables.push({ tag, sum, data: comp < orig ? zlib.inflateSync(raw) : Buffer.from(raw) });
  }
  let es = 0; while ((1 << (es + 1)) <= n) es++;
  const sr = (1 << es) * 16;
  const head = Buffer.alloc(12 + 16 * n);
  head.writeUInt32BE(flavor, 0); head.writeUInt16BE(n, 4); head.writeUInt16BE(sr, 6); head.writeUInt16BE(es, 8); head.writeUInt16BE(n * 16 - sr, 10);
  let off = head.length; const parts = [head];
  tables.forEach((t, i) => {
    const p = 12 + i * 16;
    head.writeUInt32BE(t.tag, p); head.writeUInt32BE(t.sum, p + 4); head.writeUInt32BE(off, p + 8); head.writeUInt32BE(t.data.length, p + 12);
    const pad = (4 - (t.data.length % 4)) % 4;
    parts.push(t.data, Buffer.alloc(pad)); off += t.data.length + pad;
  });
  return Buffer.concat(parts);
};
