import { describe, expect, it } from 'vitest';
import { buildZip, crc32, readZip } from '../../src/lib/zip';

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe('zip', () => {
  it('CRC-32 は標準の値になる', async () => {
    expect(await crc32(new Blob(['123456789']))).toBe(0xcbf43926);
  });

  it('書き出した ZIP を読み戻すと同じ中身になる（日本語のファイル名・4MB を超えるデータ）', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const zip = await buildZip([
      { name: 'data.json', data: new Blob(['{"a":1}']) },
      { name: 'books/参考書.pdf', data: new Blob([big]) },
      { name: 'empty.txt', data: new Blob([]) },
    ]);
    const files = await readZip(zip);
    expect([...files.keys()]).toEqual(['data.json', 'books/参考書.pdf', 'empty.txt']);
    expect(await files.get('data.json')!.text()).toBe('{"a":1}');
    // 大きな配列は要素ごとの比較が遅いので、Buffer で比べる
    expect(Buffer.from(await bytes(files.get('books/参考書.pdf')!)).equals(Buffer.from(big))).toBe(true);
    expect(files.get('empty.txt')!.size).toBe(0);
  });

  it('ZIP でないファイルはエラーにする', async () => {
    await expect(readZip(new Blob(['hello']))).rejects.toThrow('ZIP');
  });
});
