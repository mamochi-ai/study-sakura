import { defineConfig } from '@playwright/test';

// 画面操作のテスト。ビルドしたアプリを GitHub Pages と同じパスで動かし、iPad（横向き）と同じ大きさで確かめる
const BASE = '/study-sakura/';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:4173${BASE}`,
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    acceptDownloads: true,
    // Service Worker の更新でページが読み直されないように
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    env: { BASE_PATH: BASE },
    url: `http://localhost:4173${BASE}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
