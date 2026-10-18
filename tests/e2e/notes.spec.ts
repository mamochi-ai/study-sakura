import { expect, test } from '@playwright/test';
import { createBinder, openDesk, readTable } from './helpers';

test('テキストノート：入力してすぐ切り替えても、閉じても残る', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  await page.locator('.note-tabs-bar summary[title="新しいノート"]').click();
  await page.getByText('📝 テキストノート').click();
  await page.locator('.note-content').last().click();
  await page.keyboard.type('すぐ切り替え');
  // 自動保存（0.6 秒）より前にタブを切り替える
  await page.locator('.note-tab').first().click();
  await expect.poll(async () => (await readTable<{ text: string }>(page, 'notes')).map((n) => n.text)).toContain('すぐ切り替え');

  await page.locator('.note-tab').nth(1).click();
  await page.locator('.note-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('と本棚');
  await page.getByRole('button', { name: '← 本棚' }).click();
  await expect.poll(async () => (await readTable<{ text: string }>(page, 'notes')).map((n) => n.text)).toContain('すぐ切り替えと本棚');

  await page.reload();
  await page.locator('.binder-spine').first().click();
  await page.locator('.note-tab').nth(1).click();
  await expect(page.locator('.note-content')).toContainText('すぐ切り替えと本棚');
});

test('テキストノート：保存に失敗したら知らせて、直ったら保存する', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  await page.evaluate(() => {
    const w = window as unknown as { __fail: boolean };
    w.__fail = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a: Parameters<typeof put>) {
      if (w.__fail && this.name === 'notes') throw new DOMException('quota', 'QuotaExceededError');
      return put.apply(this, a);
    };
    const update = IDBCursor.prototype.update;
    IDBCursor.prototype.update = function (...a: Parameters<typeof update>) {
      if (w.__fail) throw new DOMException('quota', 'QuotaExceededError');
      return update.apply(this, a);
    };
  });
  await page.locator('.note-content').click();
  await page.keyboard.type('失敗テスト');
  await expect(page.locator('.note-status')).toContainText('保存できませんでした');
  await expect(page.locator('.toast').last()).toContainText('空き容量');
  await page.evaluate(() => ((window as unknown as { __fail: boolean }).__fail = false));
  await expect(page.locator('.note-status')).toContainText('保存済み', { timeout: 10_000 });
  expect((await readTable<{ text: string }>(page, 'notes')).map((n) => n.text)).toContain('失敗テスト');
});

test('ノートのタブはドラッグで並べ替えられ、再読み込みしても保たれる', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  for (const kind of ['📝 テキストノート', '✏️ 手書きノート']) {
    await page.locator('.note-tabs-bar summary[title="新しいノート"]').click();
    await page.getByText(kind).click();
  }
  const titles = async () => (await page.locator('.note-tab').allTextContents()).map((t) => t.replace(/^[📝✏️]+/u, '').trim());
  // 新しいタブが 3 つとも並んでから、最初の順番を記録する
  await expect(page.locator('.note-tab')).toHaveCount(3);
  const before = await titles();
  const first = (await page.locator('.note-tab').nth(0).boundingBox())!;
  const last = (await page.locator('.note-tab').nth(2).boundingBox())!;
  await page.mouse.move(first.x + 20, first.y + 10);
  await page.mouse.down();
  await page.mouse.move(first.x + 40, first.y + 10, { steps: 3 });
  await page.mouse.move(last.x + last.width - 5, last.y + 10, { steps: 8 });
  await page.mouse.up();
  await expect.poll(titles).toEqual([before[1], before[2], before[0]]);
  await page.reload();
  await expect.poll(titles).toEqual([before[1], before[2], before[0]]);
});
