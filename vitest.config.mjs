// Testoppsett for claude-cowie-qeue (bare lokalt, ingen CI). Testene ligger i mal/scripts/orkestrator/**/__tests__.
// TZ settes her fordi flere regler (nattvindu, døgn, ukekvote) regnes i Europe/Oslo.
process.env.TZ = process.env.TZ || 'Europe/Oslo';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['mal/scripts/orkestrator/**/__tests__/**/*.test.{ts,mjs}'],
    testTimeout: 60000,
    pool: 'forks',
  },
});
