import { beforeEach, describe, expect, it } from 'vitest';
import { db, today } from '../../src/db';
import { createBackup, restoreBackup } from '../../src/lib/backup';

const pdf = (text: string) => new Blob([`%PDF-1.4 ${text}`], { type: 'application/pdf' });

async function seed() {
  await db.books.add({ id: 'b1', title: '本', color: '#333', file: pdf('one'), fileName: 'one.pdf', size: 13, createdAt: 1 });
  await db.binders.add({ id: 'd1', title: 'バインダー', color: '#e0607e', bookIds: ['b1'], positions: {}, splitRatio: 0.5, createdAt: 1, updatedAt: 100 });
  await db.notes.add({ id: 'n1', binderId: 'd1', title: 'ノート', content: null, text: 'old', order: 0, createdAt: 1, updatedAt: 100 });
  await db.sessions.add({ id: `d1:${today()}`, binderId: 'd1', date: today(), seconds: 600, startedAt: 1 });
  await db.pets.add({ id: 'p1', species: 'shiba', name: 'しば', fullness: 80, fullnessAt: 1, adoptedAt: 1, order: 0 });
  await db.petWorld.add({ id: 'world', studySeconds: 3600, foodSpent: 3, unlocked: ['bed', 'bowl'], createdAt: 1, updatedAt: 1 });
}

const clearAll = () => Promise.all(db.tables.map((t) => t.clear()));

beforeEach(async () => {
  await clearAll();
});

describe('バックアップ', () => {
  it('完全版から、空の端末にすべて戻せる（参考書の中身も）', async () => {
    await seed();
    const file = await createBackup('full');
    expect(file.name).toMatch(/^my-study-\d{8}\.zip$/);
    await clearAll();
    const r = await restoreBackup(file);
    expect(r).toMatchObject({ books: 1, binders: 1, notes: 1, missingBooks: 0 });
    const book = await db.books.get('b1');
    expect(await book!.file.text()).toBe('%PDF-1.4 one');
    expect(await db.pets.count()).toBe(1);
    expect((await db.petWorld.get('world'))!.studySeconds).toBe(3600);
  });

  it('ノートだけのバックアップには参考書の中身が入らない', async () => {
    await seed();
    const file = await createBackup('notes');
    expect(file.name).toMatch(/^my-study-notes-/);
    await clearAll();
    const r = await restoreBackup(file);
    expect(r.missingBooks).toBe(1);
    expect(await db.books.count()).toBe(0);
    expect(await db.notes.count()).toBe(1);
  });

  it('復元しても、今のほうが新しいデータは残る（ノート・今日の学習時間・ペットの累積）', async () => {
    await seed();
    const file = await createBackup('notes');
    await db.notes.update('n1', { text: 'newer', updatedAt: 200 });
    await db.sessions.update(`d1:${today()}`, { seconds: 1200 });
    await db.petWorld.update('world', { studySeconds: 7200, foodSpent: 9, unlocked: ['bed', 'bowl', 'rug'] });
    const r = await restoreBackup(file);
    expect(r.kept).toBe(1);
    expect((await db.notes.get('n1'))!.text).toBe('newer');
    expect((await db.sessions.get(`d1:${today()}`))!.seconds).toBe(1200);
    const w = (await db.petWorld.get('world'))!;
    expect(w.studySeconds).toBe(7200);
    expect(w.foodSpent).toBe(9);
    expect(w.unlocked).toEqual(['bed', 'bowl', 'rug']);
  });

  it('バックアップのほうが新しければ、そちらにする', async () => {
    await seed();
    await db.notes.update('n1', { text: 'from backup', updatedAt: 300 });
    const file = await createBackup('notes');
    await db.notes.update('n1', { text: 'stale', updatedAt: 150 });
    await restoreBackup(file);
    expect((await db.notes.get('n1'))!.text).toBe('from backup');
  });

  it('以前の JSON 形式（参考書は Base64）も読める', async () => {
    const old = {
      format: 'study-sakura-backup',
      version: 1,
      books: [{ id: 'old', title: '古い本', color: '#333', fileName: 'o.pdf', size: 4, createdAt: 1, fileType: 'application/pdf', data: btoa('%PDF') }],
      binders: [],
      notes: [],
    };
    const r = await restoreBackup(new File([JSON.stringify(old)], 'old.json'));
    expect(r.books).toBe(1);
    expect(await (await db.books.get('old'))!.file.text()).toBe('%PDF');
  });

  it('項目が欠けたファイル・新しい形式・別のファイルを正しく扱う', async () => {
    await expect(restoreBackup(new File(['{"format":"study-sakura-backup"}'], 'a.json'))).resolves.toMatchObject({ books: 0 });
    await expect(restoreBackup(new File(['{"format":"study-sakura-backup","version":99}'], 'b.json'))).rejects.toThrow('アプリを更新');
    await expect(restoreBackup(new File(['{"hello":1}'], 'c.json'))).rejects.toThrow('バックアップファイルではありません');
    await expect(restoreBackup(new File(['not json'], 'd.json'))).rejects.toThrow('バックアップファイルではありません');
  });
});
