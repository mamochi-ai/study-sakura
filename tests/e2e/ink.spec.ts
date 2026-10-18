import { expect, test } from '@playwright/test';
import { createBinder, openDesk, readTable } from './helpers';

test('手書きノート：書いた線が保存され、2 本指で触れても元に戻らない', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  await page.locator('.note-tabs-bar summary[title="新しいノート"]').click();
  await page.getByText('✏️ 手書きノート').click();
  const paper = page.locator('.ink-paper');
  await expect(paper).toBeVisible();
  const box = (await paper.boundingBox())!;
  for (const y of [80, 140]) {
    await page.mouse.move(box.x + 60, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + y + 10, { steps: 6 });
    await page.mouse.up();
  }
  await expect.poll(async () => (await readTable(page, 'strokes')).length).toBe(2);

  // 2 本・3 本の指で軽く触れる（以前は元に戻す・やり直すだった）
  await page.waitForTimeout(700);
  for (const n of [2, 3]) {
    await paper.evaluate(async (el, n) => {
      const r = el.getBoundingClientRect();
      const ts = Array.from({ length: n }, (_, i) => new Touch({ identifier: i + 1, target: el, clientX: r.left + 150 + i * 40, clientY: r.top + 200 }));
      const fire = (type: string, touches: Touch[], changed: Touch[]) =>
        el.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: changed, bubbles: true, cancelable: true }));
      fire('touchstart', ts, ts);
      await new Promise((r) => setTimeout(r, 60));
      fire('touchend', [], ts);
    }, n);
  }
  await page.waitForTimeout(500);
  expect((await readTable(page, 'strokes')).length).toBe(2);

  // 再読み込みすると、開いていたバインダーがそのまま開く
  await page.reload();
  await expect(page.locator('.ink-paper')).toBeVisible();
  expect((await readTable(page, 'strokes')).length).toBe(2);
});
