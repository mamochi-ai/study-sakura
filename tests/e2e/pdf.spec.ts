import { expect, test } from '@playwright/test';
import { createBinder, openDesk } from './helpers';

const canvas = (page: import('@playwright/test').Page) => page.locator('.pdf-page canvas').first();

test('参考書を追加してすぐ開け、ペットの部屋から戻っても、本棚から開き直しても表示される', async ({ page }) => {
  await openDesk(page);
  await createBinder(page, '何度も開く');
  await expect(canvas(page)).toBeVisible();

  // ペットの部屋へ行って戻る
  await page.locator('.mini-pet').click();
  await expect(page.locator('.pet-view')).toBeVisible();
  // ペットがいないときに開く「お迎え」の画面を閉じる（開いてから Escape を押す）
  await expect(page.locator('.modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await page.getByRole('button', { name: '← 戻る' }).click();
  await expect(canvas(page)).toBeVisible({ timeout: 20_000 });

  // 本棚へ戻ってから開き直す
  await page.getByRole('button', { name: '← 本棚' }).click();
  await page.locator('.binder-spine').first().click();
  await expect(canvas(page)).toBeVisible({ timeout: 20_000 });
});

test('以前の版で保存した参考書（Blob）も開け、新しい形に移る', async ({ page }) => {
  await openDesk(page);
  await createBinder(page, '以前の形式');
  // 以前の版と同じ形にする：中身を books.file の Blob に戻し、bookData から消す
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open('study-sakura');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['books', 'bookData'], 'readwrite');
          const data = tx.objectStore('bookData');
          data.getAll().onsuccess = (e) => {
            const row = (e.target as IDBRequest).result[0];
            const books = tx.objectStore('books');
            books.get(row.id).onsuccess = (ev) => {
              const book = (ev.target as IDBRequest).result;
              book.file = new Blob([row.data], { type: 'application/pdf' });
              books.put(book);
              data.delete(row.id);
            };
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      }),
  );
  await page.reload();
  await expect(canvas(page)).toBeVisible({ timeout: 20_000 });
  const moved = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('study-sakura');
        req.onsuccess = () => {
          const q = req.result.transaction('bookData').objectStore('bookData').count();
          q.onsuccess = () => {
            req.result.close();
            resolve(q.result);
          };
        };
      }),
  );
  expect(moved).toBe(1);
});
