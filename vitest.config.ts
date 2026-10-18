import { defineConfig } from 'vitest/config';

// 単体テスト（PWA などのプラグインは使わない）。IndexedDB は fake-indexeddb で代わりに動かす
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['fake-indexeddb/auto'],
  },
});
