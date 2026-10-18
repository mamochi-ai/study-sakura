/**
 * 圧縮しない ZIP（stored）の書き出しと読み込み。
 * PDF を作業用メモリに丸ごと写さず、元の Blob を指したまま 1 つのファイルにまとめる
 * （iPad でも大きな参考書を書き出せるように）
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 一度に読む大きさ（メモリに載るのはこの分だけ） */
const CHUNK = 4 * 1024 * 1024;
const MAX_SIZE = 0xffffffff;

/** Blob の CRC-32 を少しずつ読んで計算する */
export async function crc32(blob: Blob, onBytes?: (n: number) => void): Promise<number> {
  let c = 0xffffffff;
  for (let off = 0; off < blob.size; off += CHUNK) {
    const buf = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    onBytes?.(buf.length);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Blob;
}

function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** ZIP を作る。onProgress は 0〜1 */
export async function buildZip(entries: ZipEntry[], onProgress?: (ratio: number) => void): Promise<Blob> {
  const enc = new TextEncoder();
  const total = entries.reduce((a, e) => a + e.data.size, 0) || 1;
  let done = 0;
  const { time, date } = dosTime(new Date());
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    if (e.data.size > MAX_SIZE) throw new Error(`${e.name} が大きすぎます（4GB まで）`);
    const name = enc.encode(e.name);
    const crc = await crc32(e.data, (n) => onProgress?.((done += n) / total));
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // ファイル名は UTF-8
    local.setUint16(8, 0, true); // 圧縮しない
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.size, true);
    local.setUint32(22, e.data.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, e.data);

    const c = new DataView(new ArrayBuffer(46 + name.length));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, e.data.size, true);
    c.setUint32(24, e.data.size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    new Uint8Array(c.buffer).set(name, 46);
    central.push(new Uint8Array(c.buffer));

    offset += 30 + name.length + e.data.size;
    if (offset > MAX_SIZE) throw new Error('バックアップが大きすぎます（4GB まで）');
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  onProgress?.(1);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/** ZIP の中身（ファイル名 → 元のファイルの一部を指す Blob。中身はまだ読まない） */
export async function readZip(file: Blob): Promise<Map<string, Blob>> {
  const tailSize = Math.min(file.size, 22 + 0xffff);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP ファイルではありません');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map<string, Blob>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP ファイルが壊れています');
    const method = cd.getUint16(p + 10, true);
    const size = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (method !== 0) throw new Error('このアプリで書き出した ZIP ではありません（圧縮されています）');
    const local = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
    if (local.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP ファイルが壊れています');
    const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    out.set(name, file.slice(start, start + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
