import { expect, test } from '@playwright/test';
import { openDesk, SAMPLE_PDF } from './helpers';

test('追加した直後で PDF がまだ読めなくても、読み直して表示する', async ({ page }) => {
  await openDesk(page);
  // iPad で、追加したばかりの PDF がまだ書き込み中で読めない状態をまねる
  await page.evaluate(() => {
    const w = window as unknown as { __failReads: number };
    w.__failReads = 0;
    const orig = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (w.__failReads > 0 && this.type === 'application/pdf') {
        w.__failReads--;
        return Promise.reject(new DOMException('The object can not be found here.', 'NotFoundError'));
      }
      return orig.call(this);
    };
  });
  await page.setInputFiles('header input[type=file][accept^="application/pdf"]', SAMPLE_PDF);
  await page.getByRole('button', { name: '＋ 新しいバインダー' }).click();
  await page.locator('.modal input').first().fill('読み直し');
  await page.locator('.book-option:not(.add)').first().click();
  await page.evaluate(() => ((window as unknown as { __failReads: number }).__failReads = 2));
  await page.getByRole('button', { name: '作成して開く' }).click();
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 20_000 });
});

test('読み直しても読めないときは「もう一度読み込む」で開ける', async ({ page }) => {
  await openDesk(page);
  await page.evaluate(() => {
    const w = window as unknown as { __failReads: number };
    w.__failReads = 0;
    const orig = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (w.__failReads > 0 && this.type === 'application/pdf') {
        w.__failReads--;
        return Promise.reject(new DOMException('The object can not be found here.', 'NotFoundError'));
      }
      return orig.call(this);
    };
  });
  await page.setInputFiles('header input[type=file][accept^="application/pdf"]', SAMPLE_PDF);
  await page.getByRole('button', { name: '＋ 新しいバインダー' }).click();
  await page.locator('.modal input').first().fill('もう一度');
  await page.locator('.book-option:not(.add)').first().click();
  await page.evaluate(() => ((window as unknown as { __failReads: number }).__failReads = 100));
  await page.getByRole('button', { name: '作成して開く' }).click();
  await expect(page.getByRole('button', { name: 'もう一度読み込む' })).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => ((window as unknown as { __failReads: number }).__failReads = 0));
  await page.getByRole('button', { name: 'もう一度読み込む' }).click();
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 20_000 });
});
