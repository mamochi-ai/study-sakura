import { expect, type Page } from '@playwright/test';
import path from 'node:path';

export const SAMPLE_PDF = path.join(import.meta.dirname, '../fixtures/sample.pdf');

/** 本棚を開く（毎回まっさらな状態から） */
export async function openDesk(page: Page) {
  await page.goto('./');
  await expect(page.locator('.desk-header')).toBeVisible();
}

/** 参考書を追加して、バインダーを作って開く */
export async function createBinder(page: Page, title = 'テスト') {
  await page.setInputFiles('header input[type=file][accept^="application/pdf"]', SAMPLE_PDF);
  await page.getByRole('button', { name: '＋ 新しいバインダー' }).click();
  await page.locator('.modal input').first().fill(title);
  await page.locator('.book-option:not(.add)').first().click();
  await page.getByRole('button', { name: '作成して開く' }).click();
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 20_000 });
}

/** IndexedDB の表を直接読む（保存されたかの確認用） */
export function readTable<T = Record<string, unknown>>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(
    (table) =>
      new Promise<T[]>((resolve) => {
        const req = indexedDB.open('study-sakura');
        req.onsuccess = () => {
          const db = req.result;
          const q = db.transaction(table).objectStore(table).getAll();
          q.onsuccess = () => {
            db.close();
            resolve(q.result as T[]);
          };
        };
      }),
    table,
  );
}

/** IndexedDB に直接書く（学習時間などの準備用。書いたあとは読み直す） */
export async function putRow(page: Page, table: string, row: Record<string, unknown>) {
  await page.evaluate(
    ([table, row]) =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open('study-sakura');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(table as string, 'readwrite');
          tx.objectStore(table as string).put(row);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      }),
    [table, row] as const,
  );
}
