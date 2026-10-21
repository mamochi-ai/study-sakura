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

test('手書き：手のひらのタッチは止めない（止めるとペンが届かなくなる）。標準のスクロールは CSS で止め、ペンのタッチは止める', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  await page.locator('.note-tabs-bar summary[title="新しいノート"]').click();
  await page.getByText('✏️ 手書きノート').click();
  await expect(page.locator('.ink-paper')).toBeVisible();
  const r = await page.locator('.ink-scroll').evaluate((scroller) => {
    const paper = scroller.querySelector<HTMLElement>('.ink-paper')!;
    const s = scroller.getBoundingClientRect();
    const p = paper.getBoundingClientRect();
    const touch = (target: Element, x: number, y: number, pen: boolean) => {
      const t = new Touch({ identifier: pen ? 2 : 1, target, clientX: x, clientY: y });
      if (pen) Object.defineProperty(t, 'touchType', { value: 'stylus' });
      const ev = new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      target.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
      return ev.defaultPrevented;
    };
    return {
      margin: s.right - p.right,
      // 余白（用紙の外、スクロール枠の中）と用紙の上の手のひら
      palmMargin: touch(scroller, (p.right + s.right) / 2, p.top + 200, false),
      palmPaper: touch(paper, p.left + 200, p.top + 200, false),
      pen: touch(paper, p.left + 200, p.top + 300, true),
      touchAction: [getComputedStyle(scroller).touchAction, getComputedStyle(paper).touchAction],
    };
  });
  expect(r.margin).toBeGreaterThan(0);
  expect(r.palmMargin).toBe(false);
  expect(r.palmPaper).toBe(false);
  expect(r.pen).toBe(true);
  // iPad の標準スクロール（ペンを取り消す）は CSS で止めている
  expect(r.touchAction).toEqual(['none', 'none']);
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

test('手書き：手のひらが軽く触れてすぐペンが来たら、指のタップとして扱わない', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  await page.locator('.note-tabs-bar summary[title="新しいノート"]').click();
  await page.getByText('✏️ 手書きノート').click();
  const paper = page.locator('.ink-paper');
  await expect(paper).toBeVisible();
  await page.locator('button[title^="復習マーク"]').click();

  const tap = (withPen: boolean) =>
    paper.evaluate(async (el, withPen) => {
      const r = el.getBoundingClientRect();
      const t = new Touch({ identifier: 1, target: el, clientX: r.left + 300, clientY: r.top + 300 });
      const fire = (type: string, touches: Touch[]) =>
        el.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: [t], bubbles: true, cancelable: true }));
      fire('touchstart', [t]);
      await new Promise((res) => setTimeout(res, 60));
      fire('touchend', []);
      if (!withPen) return;
      // 手のひらが離れた直後にペンで書き始める
      await new Promise((res) => setTimeout(res, 80));
      const pen = (type: string, x: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: r.left + x, clientY: r.top + 120, pressure: 0.5, bubbles: true, cancelable: true }));
      pen('pointerdown', 100);
      pen('pointermove', 200);
      pen('pointerup', 200);
    }, withPen);

  await tap(true);
  await page.waitForTimeout(600);
  await expect(page.locator('.modal')).toHaveCount(0);

  // ペンから少し経ってからの指のタップは、今までどおり効く
  await page.waitForTimeout(1500);
  await tap(false);
  await expect(page.locator('.modal')).toBeVisible();
});

test('手書き：ペンの信号（pointerdown）が来なくても、ペンのタッチの信号で書ける。両方来ても線は 1 本', async ({ page }) => {
  await openDesk(page);
  await createBinder(page);
  await page.locator('.note-tabs-bar summary[title="新しいノート"]').click();
  await page.getByText('✏️ 手書きノート').click();
  const paper = page.locator('.ink-paper');
  await expect(paper).toBeVisible();
  await page.locator('summary[title="用紙（罫線）"]').click();
  await page.getByRole('button', { name: /ペンの信号を表示/ }).click();
  await expect(page.locator('.ink-debug')).toBeVisible();

  /** order：touch＝タッチの信号だけ／touchFirst・penFirst＝両方（先に来るほうが違う） */
  const draw = (order: 'touch' | 'touchFirst' | 'penFirst', y: number) =>
    paper.evaluate(
      async (el, { order, y }) => {
        const r = el.getBoundingClientRect();
        const palm = new Touch({ identifier: 1, target: el, clientX: r.left + 500, clientY: r.top + y + 80 });
        // Chromium の Touch は touchType を受け付けないので、iPad と同じ印を付ける
        const pt = (x: number) =>
          Object.defineProperty(new Touch({ identifier: 2, target: el, clientX: r.left + x, clientY: r.top + y, force: 0.5 }), 'touchType', { value: 'stylus' });
        const touch = (type: string, x: number, touches: Touch[]) =>
          el.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: [pt(x)], bubbles: true, cancelable: true }));
        const pen = (type: string, x: number) =>
          el.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'pen', isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: 0.5, bubbles: true, cancelable: true }));
        // 手のひらを置いたまま
        el.dispatchEvent(new TouchEvent('touchstart', { touches: [palm], targetTouches: [palm], changedTouches: [palm], bubbles: true, cancelable: true }));
        const withPen = order !== 'touch';
        if (order === 'penFirst') pen('pointerdown', 60);
        touch('touchstart', 60, [palm, pt(60)]);
        if (order === 'touchFirst') pen('pointerdown', 60);
        for (let x = 80; x <= 300; x += 20) {
          if (withPen) pen('pointermove', x);
          touch('touchmove', x, [palm, pt(x)]);
          await new Promise((res) => setTimeout(res, 10));
        }
        if (withPen) pen('pointerup', 300);
        touch('touchend', 300, [palm]);
        el.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [palm], bubbles: true, cancelable: true }));
      },
      { order, y },
    );

  await draw('touch', 100);
  await expect.poll(async () => (await readTable(page, 'strokes')).length).toBe(1);
  await expect(page.locator('.ink-debug')).toContainText('タッチの信号で書き始め');
  await draw('touchFirst', 200);
  await expect.poll(async () => (await readTable(page, 'strokes')).length).toBe(2);
  await draw('penFirst', 300);
  await expect.poll(async () => (await readTable(page, 'strokes')).length).toBe(3);
  await page.waitForTimeout(500);
  const strokes = await readTable<{ points: number[] }>(page, 'strokes');
  expect(strokes).toHaveLength(3);
  // どの線も最初から最後まで同じ長さでつながっている（途中で別の線に分かれていない）
  const spans = strokes.map((s) => {
    const xs = s.points.filter((_, i) => i % 3 === 0);
    return Math.max(...xs) - Math.min(...xs);
  });
  for (const w of spans) expect(Math.abs(w - spans[0])).toBeLessThan(2);
  expect(spans[0]).toBeGreaterThan(100);
});
