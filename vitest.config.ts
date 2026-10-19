import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { include: ['tests/**/*.test.ts'], env: { BCRYPT_COST: '4' }, testTimeout: 30000, hookTimeout: 60000, fileParallelism: true },
});
