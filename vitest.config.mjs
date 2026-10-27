// Test setup for claude-cowie-qeue (local only, no CI). The tests live in template/scripts/orchestrator/**/__tests__.
// TZ is set here because several rules (night window, day, weekly quota) are computed in Europe/Oslo.
process.env.TZ = process.env.TZ || 'Europe/Oslo';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['template/scripts/orchestrator/**/__tests__/**/*.test.{ts,mjs}'],
    testTimeout: 60000,
    pool: 'forks',
  },
});
