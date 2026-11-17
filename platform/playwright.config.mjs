import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-test', workers: 1, fullyParallel: false, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:8798', channel: 'msedge', headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'node server/index.mjs', url: 'http://127.0.0.1:8798/health', reuseExistingServer: false,
    env: { PV_PORT: '8798', PV_HOST: '127.0.0.1', PV_SIMULATE: '1', PV_ROLE: 'gateway', PV_CLOUD_PROVIDER: 'mqtt',
      PV_PASSWORD: 'Browser-Test-Password-2026', PV_DATA_DIR: '../.build/browser-data' } }
});
