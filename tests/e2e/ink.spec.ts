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

test('手書き：用紙の横の余白に手を置いても、iPad の標準スクロールにならない（ペンが取り消されない）', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  await page.locator('.note-tabs-bar summary[title="新しいノート"]').click();
  await page.getByText('✏️ 手書きノート').click();
  await expect(page.locator('.ink-paper')).toBeVisible();
  // 余白（用紙の外、スクロール枠の中）での touchstart が止められているか
  const prevented = await page.locator('.ink-scroll').evaluate((scroller) => {
    const paper = scroller.querySelector('.ink-paper')!;
    const s = scroller.getBoundingClientRect();
    const p = paper.getBoundingClientRect();
    const x = (p.right + s.right) / 2;
    const y = p.top + 200;
    const t = new Touch({ identifier: 9, target: scroller, clientX: x, clientY: y });
    const ev = new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true });
    scroller.dispatchEvent(ev);
    scroller.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
    return { prevented: ev.defaultPrevented, margin: s.right - p.right };
  });
  expect(prevented.margin).toBeGreaterThan(0);
  expect(prevented.prevented).toBe(true);
  // タイトルのボタンは指で押せる
  const titleTap = await page.locator('.ink-title-btn').evaluate((btn) => {
    const t = new Touch({ identifier: 10, target: btn, clientX: 10, clientY: 10 });
    const ev = new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    btn.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
    return ev.defaultPrevented;
  });
  expect(titleTap).toBe(false);
});

test('手書き：色を選ぶとメニューが閉じて、すぐ書ける', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  await page.locator('.note-tabs-bar summary[title="新しいノート"]').click();
  await page.getByText('✏️ 手書きノート').click();
  await page.locator('summary[title="色と太さ"]').click();
  await expect(page.locator('.ink-menu')).toBeVisible();
  await page.locator('.ink-color').nth(2).click();
  await expect(page.locator('.ink-menu')).toBeHidden();
  await page.locator('summary[title="色と太さ"]').click();
  await page.locator('.ink-width').nth(1).click();
  await expect(page.locator('.ink-menu')).toBeHidden();
  // そのまま書ける
  const box = (await page.locator('.ink-paper').boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await readTable(page, 'strokes')).length).toBe(1);
});

test('ペットの部屋から戻ったとき、ノートは前に見ていた位置のまま', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  // テキストノートを長くしてスクロール
  await page.locator('.note-content').click();
  for (let i = 0; i < 60; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('いちばん下');
  const text = page.locator('.note-scroll').first();
  await text.evaluate((el) => (el.scrollTop = 600));
  await page.waitForTimeout(400);
  // 手書きノートも長くしてスクロール
  await page.locator('.note-tabs-bar summary[title="新しいノート"]').click();
  await page.getByText('✏️ 手書きノート').click();
  const box = (await page.locator('.ink-paper').boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 1800, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await page.locator('.ink-scroll').evaluate((el) => (el.scrollTop = 500));
  await page.waitForTimeout(400);
  const inkTop = await page.locator('.ink-scroll').evaluate((el) => el.scrollTop);
  expect(inkTop).toBeGreaterThan(300);

  await page.locator('.mini-pet').click();
  await expect(page.locator('.pet-view')).toBeVisible();
  // ペットがいないときに開く「お迎え」の画面を閉じる（開いてから Escape を押す）
  await expect(page.locator('.modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await page.getByRole('button', { name: '← 戻る' }).click();
  await expect.poll(() => page.locator('.ink-scroll').evaluate((el) => el.scrollTop)).toBe(inkTop);
  // テキストノートのタブに戻っても前の位置
  await page.locator('.note-tab').first().click();
  await expect.poll(() => page.locator('.note-scroll').first().evaluate((el) => el.scrollTop)).toBe(600);
});
