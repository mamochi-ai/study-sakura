import { expect, test } from '@playwright/test';
import { openDesk, putRow, readTable } from './helpers';

test('ペット：迎えて、家具が解放され、ごはんをあげると食べに行く', async ({ page }) => {
  await openDesk(page);
  // 3 時間ぶんの学習記録 → 餌 36 個、寝床・餌皿・ラグ・おもちゃ
  await putRow(page, 'sessions', { id: 'old:2026-10-01', binderId: 'old', date: '2026-10-01', seconds: 3 * 3600, startedAt: 0 });
  await page.getByRole('button', { name: '🐾 ペットの部屋' }).click();
  await page.locator('.species-card', { hasText: 'マーモット' }).click();
  await page.locator('.modal input').fill('もち');
  await page.getByRole('button', { name: 'この子を迎える' }).click();

  await expect(page.locator('.pet-card')).toContainText('もち');
  await expect(page.locator('.pet-stats')).toContainText('36個');
  const furniture = await page.locator('.room-item').evaluateAll((l) => l.map((i) => (i as HTMLImageElement).src.split('/').pop()));
  expect(furniture.sort()).toEqual(['ball.webp', 'bed.webp', 'bowl.webp', 'mouse.webp', 'rug.webp']);
  // 画像がすべて読み込める
  await expect.poll(() => page.locator('.room img').evaluateAll((l) => l.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);

  await page.locator('.feed-all').click();
  await expect(page.locator('.pet-stats')).toContainText('33個');
  await expect(page.locator('.pet-card')).toContainText('100');
  await expect(page.locator('.room-pet')).toHaveAttribute('data-state', 'eat', { timeout: 20_000 });

  await page.reload();
  expect((await readTable<{ name: string }>(page, 'pets')).map((p) => p.name)).toEqual(['もち']);
});
