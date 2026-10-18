import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createBinder, openDesk, readTable } from './helpers';

test('バックアップ：完全版を書き出して、空の状態に戻せる', async ({ page }, info) => {
  await openDesk(page);
  await createBinder(page, '復元テスト');
  await page.locator('.note-content').click();
  await page.keyboard.type('バックアップの中身');
  await page.getByRole('button', { name: '← 本棚' }).click();

  const save = async (label: string) => {
    await page.locator('summary[aria-label="メニュー"]').click();
    await page.getByRole('button', { name: label }).click();
    await expect(page.locator('.modal h2')).toHaveText('バックアップの準備ができました', { timeout: 30_000 });
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.modal .btn.primary').click()]);
    const file = info.outputPath(download.suggestedFilename());
    await download.saveAs(file);
    return file;
  };
  const full = await save('💾 バックアップを書き出す（参考書も）');
  const notesOnly = await save('📝 ノートだけ書き出す（軽い）');
  expect(full).toMatch(/my-study-\d{8}\.zip$/);
  expect(notesOnly).toMatch(/my-study-notes-\d{8}\.zip$/);

  // 新しい端末と同じ状態にする
  await page.evaluate(() => new Promise((r) => (indexedDB.deleteDatabase('study-sakura').onsuccess = r)));
  await page.reload();
  await expect(page.getByText('バインダー ＝ 参考書とノートのセット')).toBeVisible();

  // ファイルの中身を渡す（保存先のパスに全角文字が入ると、テスト用の受け渡しで読めないことがあるため）
  await page.setInputFiles('header input[type=file][accept*="zip"]', { name: path.basename(full), mimeType: 'application/zip', buffer: fs.readFileSync(full) });
  await page.getByRole('button', { name: '復元する' }).click();
  await expect(page.locator('.toast').last()).toContainText('復元しました（参考書 1・バインダー 1・ノート 1）');
  expect((await readTable<{ text: string }>(page, 'notes')).map((n) => n.text)).toContain('バックアップの中身');
  await page.locator('.binder-spine').first().click();
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 20_000 });
});
